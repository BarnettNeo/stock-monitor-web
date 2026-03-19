from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field


APP_NAME = "stock-monitor-agents"


class AgentChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="User message")
    user: Optional[Dict[str, Any]] = Field(default=None, description="User context forwarded from gateway")
    context: Optional[Dict[str, Any]] = Field(default=None, description="Optional extra context")


class AgentChatResponse(BaseModel):
    reply: str
    meta: Dict[str, Any] = Field(default_factory=dict)


app = FastAPI(title=APP_NAME)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": APP_NAME}


@app.post("/agent/chat", response_model=AgentChatResponse)
def agent_chat(payload: AgentChatRequest) -> AgentChatResponse:
    # NOTE: 这是“脚手架”占位实现：
    # - 后续可在这里接入 LLM（如 Qwen3）
    # - 增加 tools 调用（策略/订阅/日志等）
    # - 接入 Redis 记忆（用户状态）
    message = payload.message.strip()
    return AgentChatResponse(
        reply=f"(agents stub) 收到：{message}",
        meta={"mode": "stub", "user": payload.user or {}},
    )


def _port() -> int:
    try:
        return int(os.getenv("AGENTS_PORT", "8008"))
    except Exception:
        return 8008


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=_port(), reload=True)
