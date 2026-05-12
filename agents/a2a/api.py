from __future__ import annotations

from fastapi import APIRouter, Header

from core.config import _sanitize_model, _sanitize_provider
from .commander import CommanderAgent
from .ingest_agent import NewsIngestAgent
from .models import A2AChatRequest, A2AChatResponse, IngestRunRequest, IngestRunResponse


router = APIRouter(prefix="/a2a", tags=["a2a"])

_commander = CommanderAgent()
_ingest = NewsIngestAgent()


@router.post("/ingest/run", response_model=IngestRunResponse)
async def ingest_run(payload: IngestRunRequest, x_trace_id: str | None = Header(default=None)) -> IngestRunResponse:
    r = await _ingest.run(
        symbols=payload.symbols,
        feeds=payload.feeds or None,
        since_minutes=payload.sinceMinutes,
        max_items=payload.maxItems,
        dry_run=payload.dryRun,
        trace_id=str(x_trace_id or "").strip(),
    )
    return IngestRunResponse(
        ok=bool(r.get("ok", False)),
        fetched=int(r.get("fetched") or 0),
        processed=int(r.get("processed") or 0),
        inserted=int(r.get("inserted") or 0),
        errors=[str(x) for x in (r.get("errors") or []) if str(x).strip()],
        meta=r.get("meta") if isinstance(r.get("meta"), dict) else {},
    )


@router.post("/chat", response_model=A2AChatResponse)
async def a2a_chat(payload: A2AChatRequest) -> A2AChatResponse:
    # Optional request-level model overrides (safe allowlist) that flow to workers.
    # Note: commander reads env by default; we allow a single request to override via context keys.
    ctx = payload.context if isinstance(payload.context, dict) else {}
    retrieval_model = _sanitize_model(ctx.get("retrievalModel"))
    thinking_model = _sanitize_model(ctx.get("thinkingModel"))
    retrieval_provider = _sanitize_provider(ctx.get("retrievalProvider"))
    thinking_provider = _sanitize_provider(ctx.get("thinkingProvider"))
    if retrieval_model:
        _commander.retrieval.model = retrieval_model
    if thinking_model:
        _commander.thinking.model = thinking_model
    if retrieval_provider:
        _commander.retrieval.provider = retrieval_provider
    if thinking_provider:
        _commander.thinking.provider = thinking_provider

    r = await _commander.run_chat(
        message=payload.message,
        symbol=payload.symbol.strip(),
        stock_name=payload.stockName.strip(),
        event_reason=payload.eventReason.strip(),
        window_minutes=int(payload.windowMinutes),
        snapshot=None,
        force_ingest=bool(ctx.get("forceIngest", False)),
    )
    return A2AChatResponse(
        ok=bool(r.get("ok", True)),
        reply=str(r.get("reply") or ""),
        attribution=r.get("attribution") if isinstance(r.get("attribution"), dict) else {},
        meta=r.get("meta") if isinstance(r.get("meta"), dict) else {},
    )
