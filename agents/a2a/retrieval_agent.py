from __future__ import annotations

from typing import Any, Dict

from domain.attribution import attribution_rag


class RetrievalAttributionAgent:
    """
    Wrap the existing RAG + attribution logic as an A2A worker.
    """

    def __init__(self, model: str = "", provider: str = "") -> None:
        self.model = model
        self.provider = provider

    async def run(
        self,
        symbol: str,
        stock_name: str,
        event_reason: str,
        window_minutes: int,
        snapshot: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        return await attribution_rag(
            symbol=symbol,
            stock_name=stock_name,
            event_reason=event_reason,
            snapshot=snapshot,
            window_minutes=window_minutes,
            model_override=self.model or None,
            provider_override=self.provider or None,
        )
