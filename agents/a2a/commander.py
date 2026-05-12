from __future__ import annotations

from typing import Any, Dict, Optional

from core.config import _env
from .ingest_agent import NewsIngestAgent
from .retrieval_agent import RetrievalAttributionAgent
from .thinking_agent import ThinkingReplyAgent


def _model(name: str, fallback: str = "") -> str:
    # allow request context override via sanitize_model in API layer
    return _env(name, fallback).strip()


class CommanderAgent:
    """
    Commander-Worker (recommended) A2A pipeline:
      1) (optional) ingest worker: crawl/clean/upsert
      2) retrieval worker: RAG search + attribution
      3) thinking worker: final user reply

    Model routing (per-worker env):
      - A2A_MODEL_INGEST   (optional; currently reserved)
      - A2A_MODEL_RETRIEVAL
      - A2A_MODEL_THINKING
    """

    def __init__(self) -> None:
        cfg = self._load_agent_yaml() or {}

        ingest_model = _model("A2A_MODEL_INGEST", "") or str(cfg.get("ingest_model") or "")
        retrieval_model = _model("A2A_MODEL_RETRIEVAL", "") or str(cfg.get("retrieval_model") or "")
        thinking_model = _model("A2A_MODEL_THINKING", "") or str(cfg.get("thinking_model") or "")

        retrieval_provider = str(cfg.get("retrieval_provider") or "")
        thinking_provider = str(cfg.get("thinking_provider") or "")

        self.ingest = NewsIngestAgent(model=ingest_model)
        self.retrieval = RetrievalAttributionAgent(model=retrieval_model, provider=retrieval_provider)
        self.thinking = ThinkingReplyAgent(model=thinking_model, provider=thinking_provider)

    def _load_agent_yaml(self) -> Dict[str, str]:
        """
        Load per-agent model/provider from agents/a2a/agent.yaml.

        Expected shape:
          agents:
            ingest_worker: { model: "...", provider: "..." }
            retrieval_worker: { model: "...", provider: "..." }
            thinking_worker: { model: "...", provider: "..." }
        """
        try:
            from pathlib import Path

            import yaml  # type: ignore

            p = Path(__file__).resolve().parent / "agent.yaml"
            if not p.exists():
                return {}
            obj = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            agents = obj.get("agents") if isinstance(obj, dict) else None
            if not isinstance(agents, dict):
                return {}

            def _get(section: str, key: str) -> str:
                sec = agents.get(section)
                if not isinstance(sec, dict):
                    return ""
                v = sec.get(key)
                return str(v).strip() if isinstance(v, str) else ""

            return {
                "ingest_model": _get("ingest_worker", "model"),
                "retrieval_model": _get("retrieval_worker", "model"),
                "thinking_model": _get("thinking_worker", "model"),
                "retrieval_provider": _get("retrieval_worker", "provider"),
                "thinking_provider": _get("thinking_worker", "provider"),
            }
        except Exception:
            return {}

    async def run_chat(
        self,
        message: str,
        symbol: str,
        stock_name: str,
        event_reason: str,
        window_minutes: int,
        *,
        snapshot: Optional[Dict[str, Any]] = None,
        force_ingest: bool = False,
    ) -> Dict[str, Any]:
        meta: Dict[str, Any] = {"pipeline": "commander-worker", "forceIngest": force_ingest}

        if force_ingest:
            ingest_r = await self.ingest.run(symbols=[symbol] if symbol else [], since_minutes=window_minutes, max_items=30, dry_run=False)
            meta["ingest"] = ingest_r

        attrib = await self.retrieval.run(
            symbol=symbol,
            stock_name=stock_name,
            event_reason=event_reason,
            window_minutes=window_minutes,
            snapshot=snapshot,
        )
        meta["retrievalModel"] = self.retrieval.model

        think = await self.thinking.run(message, attrib if isinstance(attrib, dict) else {})
        meta["thinkingModel"] = self.thinking.model

        return {"ok": True, "reply": think.get("reply", ""), "attribution": attrib if isinstance(attrib, dict) else {}, "meta": meta}
