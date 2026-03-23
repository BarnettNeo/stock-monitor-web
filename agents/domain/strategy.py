import json
import re
from typing import Any, Dict, List, Optional

from llm.llm import call_openai_compatible
from infrastructure.memory import memory
from core.models import AgentChatResponse, ToolCall


def looks_like_create_strategy(message: str) -> bool:
    """判断是否像创建策略的请求"""
    m = (message or "").strip()
    if not m:
        return False

    # 避免“监控报告/汇总/总结”等意图被误判为“新增监控策略”
    if any(k in m for k in ["报告", "汇总", "总结", "日报", "周报", "月报"]):
        return False
    # 避免“删除/移除/取消监控”被误判成创建策略（创建流程内部也会尝试追问缺参）
    if any(k in m for k in ["删除", "移除", "取消监控", "删除监控", "移除监控", "删除策略", "移除策略"]):
        return False
    return any(
        k in m
        for k in [
            "新增策略",
            "创建策略",
            "添加策略",
            "新建策略",
            "建策略",
            "监控",
            "报警",
            "告警",
            "阈值",
            "目标价",
            "涨到",
            "跌到",
            "跌破",
            "突破",
        ]
    )


def normalize_symbol(sym: str) -> Optional[str]:
    """规范化股票代码"""
    s = (sym or "").strip().lower()
    if not s:
        return None

    s = s.replace(".", "").replace(" ", "")

    m = re.fullmatch(r"(sh|sz)(\d{6})", s)
    if m:
        return f"{m.group(1)}{m.group(2)}"

    # 仅给了 6 位数字：按 A 股常见规则推断
    m2 = re.fullmatch(r"(\d{6})", s)
    if m2:
        code = m2.group(1)
        if code.startswith("6"):
            return f"sh{code}"
        if code.startswith(("0", "3")):
            return f"sz{code}"

    return None


def extract_symbols_from_text(text: str) -> List[str]:
    """从文本中提取股票代码"""
    t = (text or "").lower()
    out: List[str] = []

    # sh600519 / sz000001
    # NOTE: 不使用 \b，避免代码后面直接跟中文字符时无法命中
    for x in re.findall(r"(?:sh|sz)\d{6}", t, flags=re.IGNORECASE):
        n = normalize_symbol(x)
        if n and n not in out:
            out.append(n)

    # 6-digit codes
    # 仅在“非数字边界”处抽取，避免误把阈值/百分比数字当作股票代码
    for x in re.findall(r"(?<!\d)\d{6}(?!\d)", t):
        n = normalize_symbol(x)
        if n and n not in out:
            out.append(n)

    return out


def extract_percent_from_text(text: str) -> Optional[float]:
    """从文本中提取百分比"""
    # 支持 2% / 2.5％
    m = re.search(r"(\d+(?:\.\d+)?)\s*[%％]", text or "")
    if not m:
        return None
    try:
        return float(m.group(1))
    except Exception:
        return None


def extract_target_prices_from_text(text: str) -> Dict[str, Any]:
    """从文本中提取目标价格"""
    # 解析"跌到/跌破/涨到/突破 + 数字 + 元/块"等表达
    t = text or ""
    patch: Dict[str, Any] = {}

    m_down = re.search(r"(?:跌到|跌破|低于|小于|<=|≤)\s*(?:股价|价格)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?", t)
    m_up = re.search(r"(?:涨到|突破|高于|大于|>=|≥)\s*(?:股价|价格)?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?", t)

    if m_down or m_up or any(k in t for k in ["目标价", "到价", "到价提醒", "到价报警"]):
        patch["alertMode"] = "target"

    if m_down:
        try:
            patch["targetPriceDown"] = float(m_down.group(1))
        except Exception:
            pass

    if m_up:
        try:
            patch["targetPriceUp"] = float(m_up.group(1))
        except Exception:
            pass

    return patch


def extract_minutes_from_text(text: str, kind: str) -> Optional[int]:
    """从文本中提取分钟数"""
    # kind: interval/cooldown
    t = text or ""

    if kind == "interval":
        patterns = [
            r"每\s*(\d+)\s*分钟",
            r"间隔\s*(\d+)\s*分钟",
            r"(\d+)\s*分钟\s*(?:一次|一遍)",
        ]
    else:
        patterns = [
            r"冷却\s*(\d+)\s*分钟",
            r"(\d+)\s*分钟\s*内不再",
        ]

    for p in patterns:
        m = re.search(p, t)
        if not m:
            continue
        try:
            v = int(m.group(1))
            return v if v > 0 else None
        except Exception:
            continue

    return None


def merge_args(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    """合并参数"""
    out = dict(base or {})
    for k, v in (patch or {}).items():
        if v is None:
            continue
        # 空字符串不覆盖
        if isinstance(v, str) and not v.strip():
            continue
        out[k] = v
    return out


def build_create_strategy_questions(missing: List[str]) -> str:
    """构建创建策略的追问"""
    qs: List[str] = []
    if "symbols" in missing:
        qs.append("你要监控哪些股票代码？例如：sh600519, sz000001")
    if "conditionType" in missing:
        qs.append("你想按什么条件提醒：涨跌幅百分比（例如 2%）还是目标价（例如 跌到 6 元）？")
    if "priceAlertPercent" in missing:
        qs.append("阈值是多少？例如 2%（不填我可以按默认 2% 创建）")
    if "targetPrice" in missing:
        qs.append("目标价怎么设？请给一个或两个：上行目标价/下行目标价（例如 涨到 200 或 跌破 180）")

    # 只问 1~2 个关键问题，避免打扰
    return "\n".join(qs[:2])


async def llm_extract_create_strategy_args(
    user_message: str,
    current_args: Dict[str, Any],
    model_override: Optional[str],
) -> Dict[str, Any]:
    """使用LLM提取创建策略参数"""
    # 用 LLM 做字段抽取（JSON）
    prompt = {
        "instruction": "从用户自然语言中抽取创建股票监控策略所需参数。只输出 JSON。",
        "output": {
            "args": {
                "name": "string | null",
                "symbols": "string[] | string | null",
                "enabled": "boolean | null",
                "marketTimeOnly": "boolean | null",
                "subscriptionIds": "string[] | null",
                "alertMode": "'percent'|'target'|null",
                "priceAlertPercent": "number | null  # 单位：百分比数字，例如 2 表示 2%",
                "targetPriceUp": "number | null",
                "targetPriceDown": "number | null",
                "intervalMinutes": "integer | null",
                "cooldownMinutes": "integer | null",
                "enableMacdGoldenCross": "boolean | null",
                "enableRsiOversold": "boolean | null",
                "enableRsiOverbought": "boolean | null",
                "enableMovingAverages": "boolean | null",
                "enablePatternSignal": "boolean | null",
            }
        },
        "notes": [
            "如果用户只给了 6 位数字代码（如 600519），请保留为该数字字符串或推断 sh/sz（优先按 6->sh, 0/3->sz）。",
            "当用户表达 '阈值 2%'、'涨跌幅 2%' 等，填 priceAlertPercent=2。",
            "当用户表达 '涨到 200'/'跌破 180'/'目标价'，倾向 alertMode='target' 并填 targetPriceUp/targetPriceDown。",
            "不要编造未提及的数据；未知字段输出 null。",
        ],
        "currentArgs": current_args or {},
        "userMessage": user_message,
    }

    messages = [
        {"role": "system", "content": "你是一个信息抽取器，只输出 JSON。"},
        {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
    ]

    llm = await call_openai_compatible(messages, model_override=model_override, json_mode=True)
    if not llm.get("ok"):
        return {}

    from llm.llm import extract_json_object
    obj = extract_json_object(str(llm.get("reply") or "")) or {}
    args = obj.get("args") if isinstance(obj, dict) else None
    return args if isinstance(args, dict) else {}


async def handle_create_strategy_flow(
    *,
    user_id: str,
    message: str,
    req_model: Optional[str],
    cfg_ok: bool,
) -> AgentChatResponse:
    """处理创建策略流程"""
    # 取消/退出
    if any(k in message for k in ["取消", "算了", "退出", "不创建"]):
        if user_id:
            await memory.clear_state(user_id)
            await memory.append(user_id, {"role": "assistant", "content": "好的，我已取消创建策略。"})
        return AgentChatResponse(reply="好的，我已取消创建策略。", toolCalls=[], meta={"mode": "llm", "intent": "create_strategy", "state": "cancelled"})

    state = await memory.load_state(user_id) if user_id else {}
    pending = state.get("pending") if isinstance(state, dict) else None
    pending_args: Dict[str, Any] = {}
    if isinstance(pending, dict) and pending.get("type") == "create_strategy":
        if isinstance(pending.get("args"), dict):
            pending_args = dict(pending.get("args") or {})

    # 先做规则抽取，给 LLM 一个更好的起点
    patch: Dict[str, Any] = {}
    syms = extract_symbols_from_text(message)
    if syms:
        patch["symbols"] = syms

    target_patch = extract_target_prices_from_text(message)
    if target_patch:
        patch = merge_args(patch, target_patch)

    pct = extract_percent_from_text(message)
    if pct is not None:
        patch["alertMode"] = "percent"
        patch["priceAlertPercent"] = pct

    interval = extract_minutes_from_text(message, "interval")
    if interval is not None:
        patch["intervalMinutes"] = interval

    cooldown = extract_minutes_from_text(message, "cooldown")
    if cooldown is not None:
        patch["cooldownMinutes"] = cooldown

    # 缺省名：后面如果 symbols 补齐再生成
    merged = merge_args(pending_args, patch)

    # LLM 抽取（如果可用）
    if cfg_ok:
        llm_patch = await llm_extract_create_strategy_args(message, merged, req_model)
        if isinstance(llm_patch, dict):
            merged = merge_args(merged, llm_patch)

    # symbols 兜底规范化
    symbols = merged.get("symbols")
    if isinstance(symbols, list):
        normed = []
        for x in symbols:
            if not isinstance(x, str):
                continue
            n = normalize_symbol(x) or x.strip().lower()
            if n and n not in normed:
                normed.append(n)
        if normed:
            merged["symbols"] = normed

    # name 兜底生成
    if not isinstance(merged.get("name"), str) or not str(merged.get("name") or "").strip():
        sy = merged.get("symbols")
        if isinstance(sy, list) and sy:
            merged["name"] = f"监控 {','.join(sy[:3])}" + (" 等" if len(sy) > 3 else "")
        else:
            merged["name"] = "新策略"

    default_ok = any(k in message for k in ["默认", "都行", "随便", "按默认"])

    # 如果用户没有明确给出"百分比阈值/目标价"条件，先追问条件类型（除非用户说默认）
    has_percent = isinstance(merged.get("priceAlertPercent"), (int, float))
    has_target = isinstance(merged.get("targetPriceUp"), (int, float)) or isinstance(merged.get("targetPriceDown"), (int, float))
    has_alert_mode = str(merged.get("alertMode") or "").strip() in ("percent", "target")
    condition_specified = has_percent or has_target or ("%" in message or "％" in message) or any(k in message for k in ["目标价", "跌到", "跌破", "涨到", "突破"])

    missing: List[str] = []

    # symbols 必填
    symbols = merged.get("symbols")
    symbols_ok = False
    if isinstance(symbols, list):
        symbols_ok = len([x for x in symbols if isinstance(x, str) and x.strip()]) > 0
    elif isinstance(symbols, str):
        symbols_ok = bool(symbols.strip())
    if not symbols_ok:
        missing.append("symbols")

    # 条件类型/阈值
    if not has_alert_mode:
        if condition_specified:
            # 有条件表达，但没给 alertMode：按是否出现 target 字段推断
            merged["alertMode"] = "target" if has_target else "percent"
        elif default_ok:
            merged["alertMode"] = "percent"
            merged["priceAlertPercent"] = 2
        else:
            missing.append("conditionType")

    alert_mode = str(merged.get("alertMode") or "percent")
    if alert_mode == "percent":
        if not isinstance(merged.get("priceAlertPercent"), (int, float)):
            if default_ok:
                merged["priceAlertPercent"] = 2
            else:
                missing.append("priceAlertPercent")
    else:
        if not isinstance(merged.get("targetPriceUp"), (int, float)) and not isinstance(merged.get("targetPriceDown"), (int, float)):
            missing.append("targetPrice")

    # 仍缺参：追问并保存 pending
    if missing:
        q = build_create_strategy_questions(missing)
        reply = "创建策略还差一点关键信息：\n" + q
        if user_id:
            await memory.save_state(user_id, {"pending": {"type": "create_strategy", "args": merged, "missing": missing}})
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "llm" if cfg_ok else "no-llm", "intent": "create_strategy", "state": "asking", "missing": missing})

    # 参数齐全：清 state，发起工具调用
    if user_id:
        await memory.clear_state(user_id)

    return AgentChatResponse(
        reply="",
        toolCalls=[ToolCall(id="t1", name="create_strategy", arguments=merged)],
        meta={"mode": "llm" if cfg_ok else "no-llm", "intent": "create_strategy", "state": "tool_calls"},
    )
