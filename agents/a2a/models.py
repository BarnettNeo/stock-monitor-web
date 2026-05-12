from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class IngestRunRequest(BaseModel):
    symbols: List[str] = Field(default_factory=list, description="Target symbols to ingest, e.g. ['sh600519']")
    feeds: List[str] = Field(default_factory=list, description="Optional RSS/Atom feed URLs override")
    sinceMinutes: int = Field(default=180, ge=1, le=7 * 24 * 60, description="Only ingest items published recently")
    maxItems: int = Field(default=30, ge=1, le=200, description="Max feed items to process")
    dryRun: bool = Field(default=False, description="Fetch/clean only; do not write to Milvus")


class IngestRunResponse(BaseModel):
    ok: bool = True
    fetched: int = 0
    processed: int = 0
    inserted: int = 0
    errors: List[str] = Field(default_factory=list)
    meta: Dict[str, Any] = Field(default_factory=dict)


class A2AChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="User question")
    symbol: str = Field(default="", description="Optional explicit symbol, e.g. sh600519")
    stockName: str = Field(default="", description="Optional stock name")
    eventReason: str = Field(default="", description="Optional event reason / trigger text")
    windowMinutes: int = Field(default=30, ge=1, le=24 * 60, description="News retrieval window (minutes)")
    context: Dict[str, Any] = Field(default_factory=dict, description="Optional context passthrough")


class A2AChatResponse(BaseModel):
    ok: bool = True
    reply: str = ""
    attribution: Dict[str, Any] = Field(default_factory=dict)
    meta: Dict[str, Any] = Field(default_factory=dict)

