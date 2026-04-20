from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: Dict[str, Any] = Field(default_factory=dict)


class ToolResult(BaseModel):
    id: str
    name: str
    ok: bool
    result: Optional[Any] = None
    error: Optional[str] = None


class AgentChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="User message")
    user: Optional[Dict[str, Any]] = Field(default=None, description="User context forwarded from gateway")
    context: Optional[Dict[str, Any]] = Field(default=None, description="Optional extra context")
    auth: Optional[Dict[str, Any]] = Field(default=None, description="Forwarded auth info (e.g. Authorization header)")
    toolResults: Optional[List[ToolResult]] = Field(default=None, description="Tool execution results from Node gateway")


class AgentChatResponse(BaseModel):
    # 当 toolCalls 非空时，reply 通常为空字符串；
    # 当 toolCalls 为空时，reply 为最终回复。
    reply: str = ""
    toolCalls: List[ToolCall] = Field(default_factory=list)
    meta: Dict[str, Any] = Field(default_factory=dict)


class AttributionRequest(BaseModel):
    symbol: str = Field(..., description="Stock symbol/code, e.g. sh600519")
    stockName: str = Field(default="", description="Stock name (optional)")
    eventReason: str = Field(default="", description="Trigger reason text (optional)")
    snapshot: Optional[Dict[str, Any]] = Field(default=None, description="Trigger snapshot payload (optional)")
    windowMinutes: int = Field(default=10, ge=1, le=120, description="Search window in minutes")
    userId: Optional[str] = Field(default=None, description="User id (optional, for future memory)")


class AttributionCitation(BaseModel):
    title: str
    source: str = ""
    publishedAt: str = ""
    url: str = ""


class AttributionResponse(BaseModel):
    ok: bool = True
    summary: str = ""
    followUps: List[str] = Field(default_factory=list)
    confidence: float = 0.0
    citations: List[AttributionCitation] = Field(default_factory=list)
    meta: Dict[str, Any] = Field(default_factory=dict)
