import json
from typing import Any, Dict, List

from fastapi import FastAPI, HTTPException
from contextlib import asynccontextmanager

from core.config import (
    APP_NAME,
    SYSTEM_PROMPT,
    _env,
    _history_limit,
    _llm_config,
    _port,
    _sanitize_model,
)
from llm.langchain_integration import langchain_agent
from llm.llm import build_decision_prompt, call_openai_compatible, extract_json_object, heuristic_tool_calls
from infrastructure.memory import memory
from core.models import AgentChatRequest, AgentChatResponse
from domain.strategy import handle_create_strategy_flow, looks_like_create_strategy
from llm.tools import format_tool_results, parse_final_reply_from_llm_response, parse_tool_calls_from_llm_response

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    print("Stock Monitor Agents 2026 startup complete")
    yield
    print("Stock Monitor Agents 2026 shutdown")


app = FastAPI(title=APP_NAME, lifespan=lifespan)


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
            "LangChain风格架构"
        ],
        "llm": {
            "configured": bool(cfg.get("base_url") and cfg.get("api_key")),
            "base_url": cfg.get("base_url") or "",
            "model": cfg.get("model") or "",
        },
        "memory": {"redis": bool(_env("REDIS_URL", "")), "historyLimit": _history_limit()},
    }


@app.get("/tools")
def get_available_tools():
    """获取可用工具列表"""
    return {
        "ok": True,
        "tools": langchain_agent.get_tool_spec()
    }


@app.get("/storage/info")
async def get_storage_info():
    """获取存储信息"""
    return await memory.get_storage_info()






@app.post("/agent/chat", response_model=AgentChatResponse)
async def agent_chat(payload: AgentChatRequest) -> AgentChatResponse:
    """聊天接口"""
    message = payload.message.strip()
    user_id = str((payload.user or {}).get("userId") or "")
    tool_results = payload.toolResults or []

    req_model = _sanitize_model((payload.context or {}).get("model") if isinstance(payload.context, dict) else None)

    history = await memory.load(user_id)
    print(f"history: {history}")

    # 1) 若已经有 toolResults：直接让 LLM 基于工具结果生成最终回复
    if tool_results:
        messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
        for m in history:
            if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
                messages.append({"role": m["role"], "content": m["content"]})

        messages.append({"role": "user", "content": message})
        messages.append(
            {
                "role": "system",
                "content": f"工具执行结果（JSON）：{json.dumps([tr.model_dump() for tr in tool_results], ensure_ascii=False)}",
            }
        )
        messages.append({"role": "user", "content": "请基于工具结果，给出最终答复。"})

        llm = await call_openai_compatible(messages, model_override=req_model)
        if not llm.get("ok"):
            return AgentChatResponse(reply=format_tool_results(tool_results), toolCalls=[], meta={"mode": "no-llm"})

        reply = str(llm.get("reply") or "").strip() or "(empty reply)"

        # 写入记忆：只在最终回复时写 assistant
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})

        cfg = _llm_config()
        print(f"LLM: {reply}")
        return AgentChatResponse(
            reply=reply,
            toolCalls=[],
            meta={
                "mode": "llm",
                "model": req_model or cfg.get("model"),
                "historyUsed": len(history),
                "toolResults": len(tool_results),
            },
        )

    # 2) 无 toolResults：决定直接回复还是发起 toolCalls
    #    先把 user 消息写入记忆（只写一次）
    if user_id:
        await memory.append(user_id, {"role": "user", "content": message})

    # 无 LLM 时，先用规则兜底出 toolCalls
    cfg = _llm_config()

    if not (cfg.get("base_url") and cfg.get("api_key")):
        # 创建策略：即使无 LLM 也尽量做缺参追问/规则抽取
        state = await memory.load_state(user_id) if user_id else {}
        pending = state.get("pending") if isinstance(state, dict) else None
        has_pending_create = bool(isinstance(pending, dict) and pending.get("type") == "create_strategy")
        if has_pending_create or looks_like_create_strategy(message):
            return await handle_create_strategy_flow(user_id=user_id, message=message, req_model=req_model, cfg_ok=False)

        calls = heuristic_tool_calls(message)
        if calls:
            return AgentChatResponse(reply="", toolCalls=calls, meta={"mode": "no-llm", "decision": "tool_calls"})
        return AgentChatResponse(
            reply=f"(agents) LLM未配置：请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。\n\n你刚才说：{message}",
            toolCalls=[],
            meta={"mode": "no-llm", "decision": "final"},
        )

    # 创建策略：走"字段抽取 + 缺参追问 + 补齐后再创建"的专用流程
    state = await memory.load_state(user_id) if user_id else {}
    pending = state.get("pending") if isinstance(state, dict) else None
    has_pending_create: bool = bool(isinstance(pending, dict) and pending.get("type") == "create_strategy")
    if has_pending_create or looks_like_create_strategy(message):
        return await handle_create_strategy_flow(user_id=user_id, message=message, req_model=req_model, cfg_ok=True)

    # 有 LLM：用 JSON decision
    decision_messages: List[Dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_decision_prompt(message, has_tool_results=False)},
    ]

    llm = await call_openai_compatible(decision_messages, model_override=req_model, json_mode=True)

    if not llm.get("ok"):
        return AgentChatResponse(
            reply=f"(agents) LLM 调用失败：{llm.get('error')}",
            toolCalls=[],
            meta={"mode": "llm_error"},
        )

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

        # tool_calls 但解析不到，兜底 final
        return AgentChatResponse(
            reply="我需要先调用工具，但当前工具请求解析失败。请换个说法或直接告诉我你要做什么（例如：列出策略 / 新增策略 sh600519）。",
            toolCalls=[],
            meta={"mode": "llm", "decision": "tool_calls_parse_failed", "raw": raw},
        )

    # final
    reply = parse_final_reply_from_llm_response(raw)

    # 写入记忆：final 才写 assistant
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})

    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "llm", "decision": "final"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=_port(), reload=True)
