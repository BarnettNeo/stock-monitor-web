import json
from contextlib import asynccontextmanager
from typing import Any, Dict, List

from fastapi import FastAPI

from core.config import (
    APP_NAME,
    SYSTEM_PROMPT,
    _env,
    _history_limit,
    _llm_config,
    _port,
    _guess_provider_for_model,
    _sanitize_model,
    _sanitize_provider,
)
from core.models import AgentChatRequest, AgentChatResponse, AttributionRequest, AttributionResponse
from domain.attribution import attribution_rag
from domain.context_memory import resolve_effective_message
from infrastructure.memory import memory
from llm.langchain_integration import langchain_agent
from llm.llm import build_decision_prompt, call_openai_compatible, extract_json_object, heuristic_tool_calls
from llm.tools import (
    format_tool_results,
    parse_final_reply_from_llm_response,
    parse_tool_calls_from_llm_response,
)


async def _update_state_from_message(
    user_id: str, message: str, state: Dict[str, Any], resolved_symbol: str = ""
) -> Dict[str, Any]:
    """
    Persist light user state for better follow-ups:
      - lastSymbol
      - lastStockName (best-effort)
    """
    st = dict(state or {})
    try:
        from domain.strategy import extract_symbols_from_text, extract_stock_names_from_text

        codes = extract_symbols_from_text(message)
        if codes:
            st["lastSymbol"] = codes[0]
        elif resolved_symbol:
            st["lastSymbol"] = resolved_symbol

        names = extract_stock_names_from_text(message)
        if names:
            st["lastStockName"] = names[0]
    except Exception:
        if resolved_symbol:
            st["lastSymbol"] = resolved_symbol

    if user_id:
        await memory.save_state(user_id, st)
    return st


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    print(f"Stock Monitor Agents 2026 startup complete (loaded from: {__file__})")
    yield
    # 关闭共享 HTTP 连接池
    from llm.llm import close_shared_client
    await close_shared_client()
    print("Stock Monitor Agents 2026 shutdown")


app = FastAPI(title=APP_NAME, lifespan=lifespan)

print(f"开始, port={_port()}")

# A2A multi-agent routes (ingest/retrieval/thinking)
try:
    from a2a.api import router as a2a_router

    app.include_router(a2a_router)
except Exception as _e:
    # Keep legacy endpoints available even if optional deps (feedparser/bs4) are missing.
    print(f"[WARN] A2A router not loaded: {_e}")


@app.get("/health")
def health() -> Dict[str, Any]:
    """健康检查接口"""
    cfg = _llm_config()
    return {
        "ok": True,
        "service": APP_NAME,
        "version": "2026.1.0",
        "features": [
            "8个用户意图支持",
            "通义千问Qwen3-Max集成",
            "ReAct模式工具调用",
            "钉钉/企微通知",
            "LangChain风格架构",
        ],
        "llm": {
            "configured": bool(cfg.get("base_url") and cfg.get("api_key")),
            "base_url": cfg.get("base_url") or "",
            "model": cfg.get("model") or "",
        },
        # _history_limit is a legacy config; short-term limit is in memory.get_storage_info().
        "memory": {"redis": bool(_env("REDIS_URL", "")), "historyLimit": _history_limit()},
    }


@app.get("/tools")
def get_available_tools():
    """获取可用工具列表"""
    return {"ok": True, "tools": langchain_agent.get_tool_spec()}


@app.get("/storage/info")
async def get_storage_info():
    """获取存储信息"""
    return await memory.get_storage_info()


@app.post("/analysis/attribution", response_model=AttributionResponse)
async def analysis_attribution(payload: AttributionRequest) -> AttributionResponse:
    """
    RAG 异动归因分析：检索近窗口新闻（Milvus）并调用大模型生成一句话原因 + 关注点。
    """
    r = await attribution_rag(
        symbol=payload.symbol,
        stock_name=payload.stockName,
        event_reason=payload.eventReason,
        snapshot=payload.snapshot,
        window_minutes=payload.windowMinutes,
    )
    citations = r.get("citations") if isinstance(r.get("citations"), list) else []
    return AttributionResponse(
        ok=bool(r.get("ok", True)),
        summary=str(r.get("summary") or ""),
        followUps=[str(x) for x in (r.get("followUps") or []) if str(x).strip()],
        confidence=float(r.get("confidence") or 0.0),
        citations=[
            {
                "title": str(c.get("title") or ""),
                "source": str(c.get("source") or ""),
                "publishedAt": str(c.get("publishedAt") or ""),
                "url": str(c.get("url") or ""),
            }
            for c in citations
            if isinstance(c, dict) and str(c.get("title") or "").strip()
        ],
        meta=r.get("meta") if isinstance(r.get("meta"), dict) else {},
    )


@app.post("/agent/chat", response_model=AgentChatResponse)
async def agent_chat(payload: AgentChatRequest) -> AgentChatResponse:
    """聊天接口"""
    message = payload.message.strip()
    user_id = str((payload.user or {}).get("userId") or "")
    tool_results = payload.toolResults or []

    ctx = payload.context if isinstance(payload.context, dict) else {}
    req_model = _sanitize_model(ctx.get("model"))
    req_provider = _sanitize_provider(ctx.get("provider")) or _guess_provider_for_model(req_model)

    history = await memory.load(user_id)
    print(f"普通聊天: {req_model}")
    # 1) toolResults -> summarize tool results into final reply
    if tool_results:
        from skills.compact import compact_tool_results_for_prompt

        HISTORY_FOR_TOOL_SUMMARY_LIMIT = 6
        messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]

        history_for_prompt = history[-HISTORY_FOR_TOOL_SUMMARY_LIMIT:] if isinstance(history, list) else []
        for m in history_for_prompt:
            if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
                messages.append({"role": m["role"], "content": m["content"]})

        messages.append({"role": "user", "content": message})
        messages.append(
            {
                "role": "system",
                "content": f"工具执行结果（JSON）：{json.dumps(compact_tool_results_for_prompt(tool_results), ensure_ascii=False)}",
            }
        )
        messages.append({"role": "user", "content": "请基于工具结果，给出最终答复。"})

        llm = await call_openai_compatible(messages, model_override=req_model, provider_override=req_provider)
        if not llm.get("ok"):
            return AgentChatResponse(reply=format_tool_results(tool_results), toolCalls=[], meta={"mode": "no-llm"})

        reply = str(llm.get("reply") or "").strip() or "(empty reply)"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})

        cfg = _llm_config()
        return AgentChatResponse(
            reply=reply,
            toolCalls=[],
            meta={
                "mode": "llm",
                "model": req_model or cfg.get("model"),
                "historyUsed": len(history_for_prompt),
                "toolResults": len(tool_results),
                "promptCompaction": True,
            },
        )

    # 2) no toolResults -> decide tool calls vs final answer
    cfg = _llm_config()
    state = await memory.load_state(user_id) if user_id else {}

    resolved = await resolve_effective_message(
        user_id=user_id,
        message=message,
        history=history if isinstance(history, list) else [],
        state=state if isinstance(state, dict) else {},
    )
    # effective_message：可能被追加“上下文检索推断结果”（symbol），用于减少追问时的歧义
    # memory_snippets：如果来自 Milvus 长期记忆，会在后续 decision prompt 中作为 RAG 上下文提供给模型
    effective_message = str(resolved.get("effective_message") or message).strip()
    resolved_symbol = str(resolved.get("resolved_symbol") or "").strip()
    memory_snippets = resolved.get("memory_snippets") if isinstance(resolved.get("memory_snippets"), list) else []

    if user_id:
        state = await _update_state_from_message(
            user_id,
            message,  # store raw user message for state extraction
            state if isinstance(state, dict) else {},
            resolved_symbol=resolved_symbol,
        )
        await memory.append(user_id, {"role": "user", "content": message})

    # Prefer skill business flows (CRUD APIs etc.)
    from skills.router import select_skill

    skill = select_skill(effective_message, state if isinstance(state, dict) else {})
    auth_info = payload.auth if isinstance(payload.auth, dict) else {}
    print("当前 skill", skill)

    # Skill 处理使用子模型（qwen-turbo）加速
    from core.config import _llm_config_sub
    sub_cfg = _llm_config_sub()
    skill_model = sub_cfg.get("model") or req_model

    if skill and skill.executor == "strategy_management":
        from skills.strategy_management import handle_strategy_management_skill

        return await handle_strategy_management_skill(
            user_id=user_id,
            current_user=payload.user or {},
            auth=auth_info,
            message=effective_message,
            req_model=skill_model,
            cfg_ok=bool(cfg.get("base_url") and cfg.get("api_key")),
        )

    if skill and skill.executor == "subscription_management":
        from skills.subscription_management import handle_subscription_management_skill

        return await handle_subscription_management_skill(
            user_id=user_id,
            current_user=payload.user or {},
            auth=auth_info,
            message=effective_message,
            req_model=skill_model,
            cfg_ok=bool(cfg.get("base_url") and cfg.get("api_key")),
        )

    # No LLM: heuristic tool calls
    if not (cfg.get("base_url") and cfg.get("api_key")):
        calls = heuristic_tool_calls(effective_message)
        if calls:
            return AgentChatResponse(reply="", toolCalls=calls, meta={"mode": "no-llm", "decision": "tool_calls"})
        return AgentChatResponse(
            reply=f"(agents) LLM未配置：请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。\n\n你刚才说：{effective_message}",
            toolCalls=[],
            meta={"mode": "no-llm", "decision": "final"},
        )

    # With LLM: JSON decision
    from skills.specs import compact_tools_spec

    tools_override = None
    skill_hint = ""
    if skill and skill.tool_name:
        tools_override = compact_tools_spec([skill.tool_name])
        skill_hint = f"当前 skill：{skill.name}。{skill.hint}".strip()

    HISTORY_FOR_DECISION_LIMIT = 8
    decision_messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]

    history_for_prompt = history[-HISTORY_FOR_DECISION_LIMIT:] if isinstance(history, list) else []
    for m in history_for_prompt:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            decision_messages.append({"role": m["role"], "content": m["content"]})

    if isinstance(state, dict) and state.get("lastSymbol"):
        decision_messages.append({"role": "system", "content": f"上下文提示：lastSymbol={state.get('lastSymbol')}"})

    if memory_snippets:
        snip_txt = "\n".join([str(x) for x in memory_snippets[:5] if str(x).strip()])
        if snip_txt.strip():
            decision_messages.append({"role": "system", "content": f"长期记忆检索（仅供参考）：\n{snip_txt}"})

    decision_messages.append(
        {
            "role": "user",
            "content": build_decision_prompt(
                effective_message,
                has_tool_results=False,
                tools_spec_override=tools_override,
                skill_hint=skill_hint,
            ),
        }
    )

    # 决策阶段使用子模型（qwen-turbo ~1.6s，比用户模型快 5x）
    from core.config import _llm_config_sub as _sub_cfg
    _sub = _sub_cfg()
    decision_model = _sub.get("model") or req_model

    llm = await call_openai_compatible(
        decision_messages,
        model_override=decision_model,
        json_mode=True,
        provider_override=req_provider,
        max_tokens=1024,
    )
    print(f"LLM response: {req_model}")
    if not llm.get("ok"):
        return AgentChatResponse(reply=f"(agents) LLM 调用失败：{llm.get('error')}", toolCalls=[], meta={"mode": "llm_error"})

    raw = str(llm.get("reply") or "").strip()
    obj = extract_json_object(raw) or {}
    typ = str(obj.get("type") or "final")

    if typ == "tool_calls":
        from core.models import ToolCall

        tool_calls_raw = parse_tool_calls_from_llm_response(raw)
        calls: List[ToolCall] = []
        for item in tool_calls_raw:
            calls.append(ToolCall(id=item["id"], name=item["name"], arguments=item["arguments"]))

        if calls:
            return AgentChatResponse(reply="", toolCalls=calls, meta={"mode": "llm", "decision": "tool_calls"})

        return AgentChatResponse(
            reply="我需要先调用工具，但当前工具请求解析失败。请换个说法或直接告诉我你要做什么（例如：列出策略 / 新增策略 sh600519）。",
            toolCalls=[],
            meta={"mode": "llm", "decision": "tool_calls_parse_failed", "raw": raw},
        )

    reply = parse_final_reply_from_llm_response(raw)
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})

    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "llm", "decision": "final"})


# ── 流式聊天端点（SSE）──────────────────────────────────────

from fastapi.responses import StreamingResponse
from llm.llm import call_openai_compatible_stream


@app.post("/agent/chat/stream")
async def agent_chat_stream(payload: AgentChatRequest):
    """
    流式聊天端点（SSE）。
    - 如果 LLM 返回 tool_calls → 回退为普通 JSON 响应（工具调用不流式）
    - 如果 LLM 返回 final → SSE 逐 token 流式输出
    """
    message = payload.message.strip()
    user_id = str((payload.user or {}).get("userId") or "")
    tool_results = payload.toolResults or []

    ctx = payload.context if isinstance(payload.context, dict) else {}
    req_model = _sanitize_model(ctx.get("model"))
    req_provider = _sanitize_provider(ctx.get("provider")) or _guess_provider_for_model(req_model)

    history = await memory.load(user_id)
    cfg = _llm_config()

    print(f"流式聊天LLM model: {req_model},req_provider:{req_provider}")

    # toolResults → 流式总结
    if tool_results:
        from skills.compact import compact_tool_results_for_prompt
        messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
        history_for_prompt = history[-6:] if isinstance(history, list) else []
        for m in history_for_prompt:
            if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
                messages.append({"role": m["role"], "content": m["content"]})
        messages.append({"role": "user", "content": message})
        messages.append({"role": "system", "content": f"工具执行结果（JSON）：{json.dumps(compact_tool_results_for_prompt(tool_results), ensure_ascii=False)}"})
        messages.append({"role": "user", "content": "请基于工具结果，用自然语言直接回复用户。不要输出JSON格式，简洁友好地总结结果。"})

        # 工具结果总结也用子模型（快速响应）
        from core.config import _llm_config_sub
        sub_cfg = _llm_config_sub()
        summary_model = sub_cfg.get("model") or req_model

        async def stream_final():
            full_reply = []
            async for token in call_openai_compatible_stream(messages, model_override=summary_model, provider_override=req_provider, max_tokens=2048):
                full_reply.append(token)
                yield f"data: {json.dumps({'token': token}, ensure_ascii=False)}\n\n"
            # 结束事件，携带完整回复用于记忆存储
            final_text = "".join(full_reply)
            if user_id:
                await memory.append(user_id, {"role": "assistant", "content": final_text})
            yield f"data: {json.dumps({'done': True, 'reply': final_text}, ensure_ascii=False)}\n\n"

        return StreamingResponse(stream_final(), media_type="text/event-stream")

    # 无 toolResults → 决策阶段
    state = await memory.load_state(user_id) if user_id else {}
    resolved = await resolve_effective_message(user_id=user_id, message=message, history=history if isinstance(history, list) else [], state=state if isinstance(state, dict) else {})
    effective_message = str(resolved.get("effective_message") or message).strip()
    resolved_symbol = str(resolved.get("resolved_symbol") or "").strip()
    memory_snippets = resolved.get("memory_snippets") if isinstance(resolved.get("memory_snippets"), list) else []

    if user_id:
        state = await _update_state_from_message(user_id, message, state if isinstance(state, dict) else {}, resolved_symbol=resolved_symbol)
        await memory.append(user_id, {"role": "user", "content": message})

    # Skill 处理 → 结果通过 LLM 流式输出
    from skills.router import select_skill
    from core.config import _llm_config_sub
    sub_cfg = _llm_config_sub()
    skill_model = sub_cfg.get("model") or req_model
    skill = select_skill(effective_message, state if isinstance(state, dict) else {})
    auth_info = payload.auth if isinstance(payload.auth, dict) else {}

    # 防止 pending 状态"吞噬"所有消息：如果 skill 仅因 pending 匹配，但消息本身不属于该 skill 流程，清除 pending 并走 LLM
    if skill and skill.executor in ("strategy_management", "subscription_management"):
        pending = (state or {}).get("pending")
        if isinstance(pending, dict) and pending.get("type") == skill.executor:
            # 检查消息是否真的属于该 skill（排除 pending 匹配）
            from skills.strategy_management import looks_like_strategy_management
            from skills.subscription_management import looks_like_subscription_management
            state_without_pending = dict(state or {})
            state_without_pending.pop("pending", None)
            if skill.executor == "strategy_management":
                real_match = looks_like_strategy_management(effective_message, state_without_pending)
            else:
                real_match = looks_like_subscription_management(effective_message, state_without_pending)
            if not real_match:
                # 消息不属于该 skill，清除 pending，走 LLM 通用回复
                from skills.strategy_management import _clear_pending as _clear_strat_pending
                from skills.subscription_management import _clear_pending as _clear_sub_pending
                if skill.executor == "strategy_management":
                    await _clear_strat_pending(user_id)
                else:
                    await _clear_sub_pending(user_id)
                skill = None

    if skill and skill.executor in ("strategy_management", "subscription_management"):
        if skill.executor == "strategy_management":
            from skills.strategy_management import handle_strategy_management_skill
            result = await handle_strategy_management_skill(user_id=user_id, current_user=payload.user or {}, auth=auth_info, message=effective_message, req_model=skill_model, cfg_ok=bool(cfg.get("base_url") and cfg.get("api_key")))
        else:
            from skills.subscription_management import handle_subscription_management_skill
            result = await handle_subscription_management_skill(user_id=user_id, current_user=payload.user or {}, auth=auth_info, message=effective_message, req_model=skill_model, cfg_ok=bool(cfg.get("base_url") and cfg.get("api_key")))

        result_dict = result.model_dump() if hasattr(result, 'model_dump') else result.__dict__
        result_reply = str(result_dict.get("reply") or "").strip()
        result_meta = result_dict.get("meta") or {}
        result_tool_calls = result_dict.get("toolCalls") or []

        # 有 toolCalls → 返回 JSON（Node 网关执行工具）
        if result_tool_calls:
            return result_dict

        # 有 reply → 通过 LLM 流式输出（真正的逐 token 效果）
        if result_reply:
            stream_messages = [
                {"role": "system", "content": "你是股票监控 AI 助手。请根据以下工具执行结果，用自然语言简洁友好地回复用户。不要输出 JSON，直接回复。"},
                {"role": "user", "content": f"用户问题：{message}\n\n工具执行结果：{result_reply}"},
            ]

            async def stream_skill():
                full_reply = []
                async for token in call_openai_compatible_stream(stream_messages, model_override=skill_model, provider_override=req_provider, max_tokens=2048):
                    full_reply.append(token)
                    yield f"data: {json.dumps({'token': token}, ensure_ascii=False)}\n\n"
                final_text = "".join(full_reply)
                if user_id and final_text:
                    await memory.append(user_id, {"role": "assistant", "content": final_text})
                yield f"data: {json.dumps({'done': True, 'reply': final_text, 'meta': result_meta}, ensure_ascii=False)}\n\n"

            return StreamingResponse(stream_skill(), media_type="text/event-stream")

        # 无 reply 且无 toolCalls → 直接返回
        return result_dict

    # 无 LLM → 启发式
    if not (cfg.get("base_url") and cfg.get("api_key")):
        calls = heuristic_tool_calls(effective_message)
        return {"reply": "", "toolCalls": [tc.__dict__ for tc in calls], "meta": {"mode": "no-llm"}}

    # LLM 决策
    from skills.specs import compact_tools_spec
    tools_override = None
    skill_hint = ""
    if skill and skill.tool_name:
        tools_override = compact_tools_spec([skill.tool_name])
        skill_hint = f"当前 skill：{skill.name}。{skill.hint}".strip()

    decision_messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    history_for_prompt = history[-8:] if isinstance(history, list) else []
    for m in history_for_prompt:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            decision_messages.append({"role": m["role"], "content": m["content"]})
    if isinstance(state, dict) and state.get("lastSymbol"):
        decision_messages.append({"role": "system", "content": f"上下文提示：lastSymbol={state.get('lastSymbol')}"})
    if memory_snippets:
        snip_txt = "\n".join([str(x) for x in memory_snippets[:5] if str(x).strip()])
        if snip_txt.strip():
            decision_messages.append({"role": "system", "content": f"长期记忆检索（仅供参考）：\n{snip_txt}"})
    decision_messages.append({"role": "user", "content": build_decision_prompt(effective_message, has_tool_results=False, tools_spec_override=tools_override, skill_hint=skill_hint)})

    # 决策阶段使用轻量子模型（qwen-turbo, ~1.6s），避免主模型（qwen3.6-plus, ~8s）的延迟
    # tool_calls → 返回 JSON；final → SSE 逐 token 流式输出
    from core.models import ToolCall
    from core.config import _llm_config_sub
    sub_cfg = _llm_config_sub()
    decision_model = sub_cfg.get("model") or req_model

    async def stream_decision():
        accumulated = []
        type_detected = None
        in_reply = False
        reply_streamed = []

        async for token in call_openai_compatible_stream(decision_messages, model_override=decision_model, provider_override=req_provider, max_tokens=1024):
            accumulated.append(token)

            # 从累积文本中提前检测 type（通常在前 3-5 个 token 内出现）
            if type_detected is None:
                check = "".join(accumulated)
                if '"type"' in check:
                    if '"final"' in check:
                        type_detected = "final"
                    elif '"tool_calls"' in check:
                        type_detected = "tool_calls"
                        break  # tool_calls 需要完整 JSON，停止流式

            # type=final 时，从 token 流中提取 reply 内容并逐 token 推送
            if type_detected == "final":
                if not in_reply:
                    # 等待 "reply" 字段出现
                    check = "".join(accumulated)
                    idx = check.find('"reply"')
                    if idx >= 0:
                        in_reply = True
                        # 提取 "reply": " 之后的内容
                        after = check[idx + 7:].lstrip()
                        if after.startswith(':'):
                            after = after[1:].lstrip()
                        if after.startswith('"'):
                            after = after[1:]
                        # 可能已经有部分 reply 内容
                        if after:
                            clean = after.rstrip()
                            if clean.endswith('"'):
                                clean = clean[:-1]
                            if clean:
                                reply_streamed.append(clean)
                                yield f"data: {json.dumps({'token': clean}, ensure_ascii=False)}\n\n"
                else:
                    # 已在 reply 流中，逐 token 推送（跳过结尾的 "} 等 JSON 闭合）
                    clean = token
                    if '}' in clean:
                        # JSON 闭合：提取 } 之前的内容，去掉尾部引号
                        clean = clean.split('}')[0].rstrip('"').rstrip('\\"')
                        if clean:
                            reply_streamed.append(clean)
                            yield f"data: {json.dumps({'token': clean}, ensure_ascii=False)}\n\n"
                        break
                    if clean:
                        reply_streamed.append(clean)
                        yield f"data: {json.dumps({'token': clean}, ensure_ascii=False)}\n\n"

        full_raw = "".join(accumulated).strip()

        if type_detected == "tool_calls":
            # tool_calls → 返回 JSON（Node 网关会解析并执行工具）
            obj = extract_json_object(full_raw) or {}
            tool_calls_raw = obj.get("toolCalls") or obj.get("tool_calls") or []
            calls = []
            for i, tc in enumerate(tool_calls_raw[:5]):
                if isinstance(tc, dict) and tc.get("name"):
                    calls.append(ToolCall(id=tc.get("id") or f"t{i+1}", name=tc["name"], arguments=tc.get("arguments") or {}))
            yield json.dumps({"reply": "", "toolCalls": [tc.__dict__ for tc in calls], "meta": {"mode": "llm", "decision": "tool_calls"}}, ensure_ascii=False)
        elif type_detected == "final":
            # final → 发送完成事件
            reply = "".join(reply_streamed).strip()
            if not reply:
                reply = parse_final_reply_from_llm_response(full_raw)
            if user_id and reply:
                await memory.append(user_id, {"role": "assistant", "content": reply})
            yield f"data: {json.dumps({'done': True, 'reply': reply}, ensure_ascii=False)}\n\n"
        else:
            # 未检测到 type → 兜底解析
            reply = parse_final_reply_from_llm_response(full_raw)
            if user_id and reply:
                await memory.append(user_id, {"role": "assistant", "content": reply})
            yield f"data: {json.dumps({'token': reply, 'done': True, 'reply': reply}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream_decision(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=_port(), reload=True)
