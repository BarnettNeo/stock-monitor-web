import json
import re
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from core.config import _llm_config, _llm_config_for_provider, TOOLS_SPEC

# ── 全局 HTTP 连接池（复用 TCP+TLS 连接，减少每次请求 100-300ms 握手开销）──
_shared_client: Optional[httpx.AsyncClient] = None


def get_shared_client() -> httpx.AsyncClient:
    """获取全局共享的 httpx.AsyncClient（懒初始化，应用生命周期内复用）"""
    global _shared_client
    if _shared_client is None or _shared_client.is_closed:
        _shared_client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _shared_client


async def close_shared_client():
    """应用关闭时调用，释放连接池"""
    global _shared_client
    if _shared_client and not _shared_client.is_closed:
        await _shared_client.aclose()
        _shared_client = None


def extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    """从文本中提取JSON对象"""
    s = (text or "").strip()
    if not s:
        return None

    # 去掉 ```json ... ```
    s = re.sub(r"^```(?:json)?\s*", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"```$", "", s).strip()

    # 尝试直接解析
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass

    # 兜底：截取第一个 { 到最后一个 }
    i = s.find("{")
    j = s.rfind("}")
    if i >= 0 and j > i:
        try:
            obj = json.loads(s[i : j + 1])
            if isinstance(obj, dict):
                return obj
        except Exception:
            return None

    return None


async def call_openai_compatible(
    messages: List[Dict[str, Any]],
    model_override: Optional[str] = None,
    json_mode: bool = False,
    provider_override: Optional[str] = None,
    max_tokens: Optional[int] = None,
) -> Dict[str, Any]:
    """调用OpenAI兼容的LLM接口 - 支持通义千问Qwen3-Max"""
    cfg = _llm_config_for_provider(provider_override)
    base_url = cfg["base_url"].rstrip("/")
    api_key = cfg["api_key"]
    model = model_override or cfg["model"]

    if not base_url or not api_key:
        return {"ok": False, "error": "LLM not configured"}

    # 检测是否为通义千问DashScope API
    is_dashscope = "dashscope" in base_url.lower() or "aliyun" in base_url.lower()
    is_compatible_endpoint = "compatible-mode" in base_url.lower()
    
    # 构建请求URL
    if is_dashscope:
        # 通义千问DashScope API - base_url已包含完整路径
        if base_url.endswith("/chat/completions"):
            url = base_url
        elif base_url.endswith("/"):
            url = f"{base_url}chat/completions"
        else:
            url = f"{base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
    else:
        # 标准OpenAI兼容接口
        if base_url.endswith("/v1"):
            url = f"{base_url}/chat/completions"
        else:
            url = f"{base_url}/v1/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}"}
    
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
    }

    # max_tokens 限制生成长度，减少不必要的生成时间
    if max_tokens:
        payload["max_tokens"] = max_tokens

    # JSON mode：要求模型只输出 JSON（OpenAI-compatible）
    # DashScope 的 compatible-mode 同样支持该参数，因此统一走 response_format。
    if json_mode:
        payload["response_format"] = {"type": "json_object"}


    def _extract_openai_like_message(obj: Dict[str, Any]) -> Dict[str, Any]:
        # OpenAI-compatible: { choices: [ { message: {...} } ] }
        if isinstance(obj.get("choices"), list) and obj["choices"]:
            ch0 = obj["choices"][0]
            msg = ch0.get("message") if isinstance(ch0, dict) else None
            return msg if isinstance(msg, dict) else {}
        # DashScope 非兼容形态（兜底）：{ output: { choices: [ { message: {...} } ] } }
        out = obj.get("output")
        if isinstance(out, dict) and isinstance(out.get("choices"), list) and out["choices"]:
            ch0 = out["choices"][0]
            msg = ch0.get("message") if isinstance(ch0, dict) else None
            return msg if isinstance(msg, dict) else {}
        return {}

    try:
        client = get_shared_client()
        r = await client.post(url, json=payload, headers=headers)
        r.raise_for_status()
        data = r.json()
    except httpx.TimeoutException as e:
        return {"ok": False, "error": f"LLM 请求超时: {str(e)}", "raw": {}}
    except httpx.HTTPStatusError as e:
        # 获取详细错误信息
        try:
            error_detail = e.response.json()
        except Exception:
            error_detail = e.response.text or str(e)

        # DashScope 某些环境可能不支持 response_format，兜底重试一次（仅 json_mode）
        if json_mode and is_dashscope:
            try:
                payload2 = dict(payload)
                payload2.pop("response_format", None)
                # 只有在非 compatible-mode 终端时才添加 result_format，否则会导致 400 错误
                if not is_compatible_endpoint:
                    payload2["result_format"] = "message"
                
                payload2["tools"] = [
                    {
                        "type": "function",
                        "function": {
                            "name": "json_response",
                            "description": "返回JSON格式的响应",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string"},
                                    "reply": {"type": "string"},
                                    "toolCalls": {"type": "array"},
                                    "tool_calls": {"type": "array"},
                                },
                            },
                        },
                    }
                ]
                r2 = await client.post(url, json=payload2, headers=headers)
                r2.raise_for_status()
                data = r2.json()
            except Exception as e2:
                # 如果重试也失败，返回更有参考价值的原始错误信息
                return {"ok": False, "error": f"LLM 请求异常 (重试也失败): {error_detail}", "raw": {}}
        else:
            return {"ok": False, "error": f"LLM 请求异常: {error_detail}", "raw": {}}
    except Exception as e:
        return {"ok": False, "error": f"LLM 请求异常: {str(e)}", "raw": {}}

    try:
        msg = _extract_openai_like_message(data)
        content = str(msg.get("content") or "")
        if content.strip():
            return {"ok": True, "reply": content, "raw": data}

        # 某些 JSON/函数调用模式会把结果塞到 tool_calls 里
        tool_calls = msg.get("tool_calls") or msg.get("toolCalls")
        if isinstance(tool_calls, list) and tool_calls:
            tc0 = tool_calls[0] if isinstance(tool_calls[0], dict) else {}
            fn = tc0.get("function") if isinstance(tc0, dict) else None
            if isinstance(fn, dict):
                args = fn.get("arguments")
                if isinstance(args, str) and args.strip():
                    return {"ok": True, "reply": args, "raw": data}

        # 兜底：有些实现可能直接给 output_text
        out_text = data.get("output_text")
        if isinstance(out_text, str) and out_text.strip():
            return {"ok": True, "reply": out_text, "raw": data}

        return {"ok": False, "error": "empty llm reply", "raw": data}
    except Exception:
        return {"ok": False, "error": "invalid llm response", "raw": data}


async def call_openai_compatible_stream(
    messages: List[Dict[str, Any]],
    model_override: Optional[str] = None,
    provider_override: Optional[str] = None,
    max_tokens: Optional[int] = None,
) -> AsyncIterator[str]:
    """
    流式调用 LLM，逐 token yield。
    用于最终回复阶段，实现 TTFA < 1s 的感知延迟。
    """
    cfg = _llm_config_for_provider(provider_override)
    base_url = cfg["base_url"].rstrip("/")
    api_key = cfg["api_key"]
    model = model_override or cfg["model"]

    if not base_url or not api_key:
        yield "[LLM 未配置]"
        return

    is_dashscope = "dashscope" in base_url.lower() or "aliyun" in base_url.lower()

    if is_dashscope:
        if base_url.endswith("/chat/completions"):
            url = base_url
        elif base_url.endswith("/"):
            url = f"{base_url}chat/completions"
        else:
            url = f"{base_url}/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    else:
        if base_url.endswith("/v1"):
            url = f"{base_url}/chat/completions"
        else:
            url = f"{base_url}/v1/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}"}

    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "stream": True,
    }
    if max_tokens:
        payload["max_tokens"] = max_tokens

    # 流式调用使用独立 client（避免共享连接池的缓冲问题）
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data_str)
                        choices = chunk.get("choices") or []
                        if choices:
                            delta = choices[0].get("delta") or {}
                            content = delta.get("content") or ""
                            if content:
                                yield content
                    except json.JSONDecodeError:
                        continue
    except Exception as e:
        yield f"\n[流式生成异常: {e}]"



def heuristic_tool_calls(message: str) -> List[Any]:
    """基于规则的工具调用（兜底方案，仅非策略类工具）。"""

    from core.models import ToolCall
    
    m = message.strip()
    if not m:
        return []

    # 1. 查询触发记录

    # NOTE: 不能仅凭“本周/本月”触发，否则“生成本周监控报告”会被误当成触发查询
    if any(x in m for x in ["触发", "异动", "提醒", "今天", "哪些股票"]):
        time_range = "today"
        if any(x in m for x in ["本周", "这周"]):
            time_range = "week"
        elif any(x in m for x in ["本月", "这月"]):
            time_range = "month"
        
        from domain.strategy import extract_symbols_from_text
        codes = extract_symbols_from_text(m)
        args: Dict[str, Any] = {"dateRange": time_range}
        if codes:
            args["symbols"] = codes
        return [ToolCall(id="t1", name="query_triggers", arguments=args)]

    # 2. 获取诊断详情

    if any(x in m for x in ["诊断", "详情", "分析", "什么情况", "为什么"]):
        from domain.strategy import extract_symbols_from_text
        codes = extract_symbols_from_text(m)
        if codes:
            return [ToolCall(id="t1", name="get_diagnostic", arguments={"symbol": codes[0]})]

    # 3. 订阅管理

    if any(x in m for x in ["钉钉", "企微", "企业微信", "推送", "绑定", "订阅"]):
        sub_type = "dingtalk" if "钉钉" in m else "wechat" if "企微" in m or "企业微信" in m else "email"
        # 尽量从消息中提取 webhook URL 作为 endpoint
        import re

        endpoint_match = re.search(r"https?://[^\s]+", m)
        args: Dict[str, Any] = {"type": sub_type}
        if endpoint_match:
            endpoint = endpoint_match.group(0).rstrip("。,.!！？")
            args["endpoint"] = endpoint

        return [ToolCall(id="t1", name="update_subscription", arguments=args)]

    # 4. 查询股价信息

    if any(x in m for x in ["价格", "多少钱", "股价", "现在", "当前", "涨跌"]):
        from domain.strategy import extract_symbols_from_text, extract_stock_names_from_text

        # 优先提取明确的股票代码
        codes = extract_symbols_from_text(m)
        if codes:
            return [ToolCall(id="t1", name="get_stock_info", arguments={"symbols": codes})]

        # 兜底：仅给了中文名称（例如：洲际油气）
        names = extract_stock_names_from_text(m)
        if names:
            return [ToolCall(id="t1", name="get_stock_info", arguments={"symbols": names})]


    # 5. 生成报告

    if any(x in m for x in ["报告", "汇总", "总结", "周报", "月报", "日报"]):
        report_type = "daily"
        if any(x in m for x in ["周报", "本周"]):
            report_type = "weekly"
        elif any(x in m for x in ["月报", "本月"]):
            report_type = "monthly"
        return [ToolCall(id="t1", name="generate_report", arguments={"reportType": report_type})]

    return []


def build_decision_prompt(
    user_message: str,
    has_tool_results: bool,
    tools_spec_override: Optional[List[Dict[str, Any]]] = None,
    skill_hint: str = "",
) -> str:
    """构建决策提示词（支持按 skill 注入最小工具集合以节省 token）"""

    tools = tools_spec_override if tools_spec_override is not None else TOOLS_SPEC
    tools_text = json.dumps(tools, ensure_ascii=False)

    hint = (skill_hint or "").strip()
    hint_block = f"\n当前场景提示：{hint}\n" if hint else ""

    return (
        "你将输出一个 JSON 对象，且只能输出 JSON（不要输出其它文本）。\n"
        "如果需要调用工具，请输出：\n"
        "{\"type\":\"tool_calls\",\"toolCalls\":[{\"id\":\"t1\",\"name\":\"query_triggers\",\"arguments\":{...}}]}\n"

        "如果可以直接回复用户，请输出：\n"
        "{\"type\":\"final\",\"reply\":\"...\"}\n\n"
        f"可用工具如下（JSON）：{tools_text}\n"
        f"{hint_block}\n"
        "注意：\n"
        "- 不要编造系统里的策略/日志数据；如需要数据必须先调用工具。\n"
        "- 一次可以调用多个工具，但尽量少。\n"
        "- 删除/写入类操作（例如删除策略、绑定推送）在信息不足时，优先先问 1-2 个澄清问题（final）。\n"
        f"当前是否已提供工具执行结果：{str(has_tool_results).lower()}\n\n"
        f"用户消息：{user_message}"
    )

