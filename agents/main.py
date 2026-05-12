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

    if skill and skill.executor == "strategy_management":
        from skills.strategy_management import handle_strategy_management_skill

        return await handle_strategy_management_skill(
            user_id=user_id,
            current_user=payload.user or {},
            auth=auth_info,
            message=effective_message,
            req_model=req_model,
            cfg_ok=bool(cfg.get("base_url") and cfg.get("api_key")),
        )

    if skill and skill.executor == "subscription_management":
        from skills.subscription_management import handle_subscription_management_skill

        return await handle_subscription_management_skill(
            user_id=user_id,
            current_user=payload.user or {},
            auth=auth_info,
            message=effective_message,
            req_model=req_model,
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

    llm = await call_openai_compatible(
        decision_messages,
        model_override=req_model,
        json_mode=True,
        provider_override=req_provider,
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=_port(), reload=True)
