from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from llm.llm import call_openai_compatible


class ThinkingReplyAgent:
    """
    Convert attribution result + citations into a final user-facing answer.
    """

    def __init__(self, model: str = "", provider: str = "") -> None:
        self.model = model
        self.provider = provider

    async def run(self, user_message: str, attribution: Dict[str, Any]) -> Dict[str, Any]:
        citations = attribution.get("citations") if isinstance(attribution, dict) else []
        summary = str(attribution.get("summary") or "") if isinstance(attribution, dict) else ""

        # Deterministic fallback if no LLM configured.
        if not self.model:
            reply = summary or "暂无足够新闻线索可归因。"
            return {"ok": True, "reply": reply, "meta": {"mode": "no-llm"}}

        prompt = (
            "你是股票新闻归因与解读助手。你会收到：用户问题、归因摘要、新闻引用（可能为空）。\n"
            "请输出给用户的最终答复，要求：\n"
            "1) 先给结论/主要原因（不夸大、不编造）\n"
            "2) 再给要点条列（2-5条）\n"
            "3) 最后给1-2个追问建议\n"
            "4) 如果引用为空或不足，请明确说明“不足以确定”，并给出下一步建议\n"
            "\n"
            f"用户问题：{user_message}\n\n"
            f"归因摘要：{summary}\n\n"
            f"引用（JSON）：{json.dumps(citations, ensure_ascii=False)[:2000]}\n"
        )

        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": "你输出简洁、可执行、避免臆测的中文回答。"},
            {"role": "user", "content": prompt},
        ]
        llm = await call_openai_compatible(messages, model_override=self.model, provider_override=self.provider or None)
        if not llm.get("ok"):
            reply = summary or "暂无足够新闻线索可归因。"
            return {"ok": True, "reply": reply, "meta": {"mode": "llm-failed", "error": llm.get("error", "")}}

        return {
            "ok": True,
            "reply": str(llm.get("reply") or "").strip() or (summary or ""),
            "meta": {"mode": "llm", "model": self.model, "provider": self.provider},
        }
