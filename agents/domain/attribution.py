from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from core.config import _llm_config
from llm.llm import call_openai_compatible, extract_json_object
from llm.embeddings import embed_text
from infrastructure.milvus_news import milvus_news, NewsChunk


def _build_query_text(symbol: str, stock_name: str, event_reason: str) -> str:
    parts = []
    if stock_name:
        parts.append(stock_name)
    if symbol:
        parts.append(symbol)
    if event_reason:
        parts.append(event_reason)
    return " ".join([p for p in parts if p]).strip()


def _format_news_for_prompt(items: List[NewsChunk], max_items: int = 8, max_chars: int = 1200) -> str:
    out: List[str] = []
    total = 0
    for n in items[:max_items]:
        title = n.title or ""
        meta = " ".join([x for x in [n.source, n.published_at] if x]).strip()
        head = title if title else (n.text[:60] + ("..." if len(n.text) > 60 else ""))
        line = f"- {head}{f' ({meta})' if meta else ''}"
        if n.url:
            line += f" {n.url}"
        # Add a short snippet for grounding
        snippet = n.text.strip().replace("\n", " ")
        snippet = snippet[:200] + ("..." if len(snippet) > 200 else "")
        line += f"\n  摘要: {snippet}"
        out.append(line)
        total += len(line)
        if total >= max_chars:
            break
    return "\n".join(out).strip()


async def attribution_rag(
    symbol: str,
    stock_name: str,
    event_reason: str,
    snapshot: Optional[Dict[str, Any]],
    window_minutes: int = 10,
) -> Dict[str, Any]:
    sym = (symbol or "").strip()
    name = (stock_name or "").strip()
    reason = (event_reason or "").strip()

    query_text = _build_query_text(sym, name, reason)
    since = int(time.time()) - max(1, int(window_minutes)) * 60

    citations: List[Dict[str, Any]] = []
    news_items: List[NewsChunk] = []

    emb = await embed_text(query_text)
    if emb.get("ok") and emb.get("vector"):
        news_items = milvus_news.search_recent(sym, emb["vector"], since_unix_seconds=since, top_k=8)
        for n in news_items[:5]:
            if n.title or n.url:
                citations.append(
                    {
                        "title": n.title or (n.text[:60] + ("..." if len(n.text) > 60 else "")),
                        "source": n.source or "",
                        "url": n.url or "",
                        "publishedAt": n.published_at or "",
                    }
                )

    news_block = _format_news_for_prompt(news_items)
    snapshot_json = snapshot or {}

    prompt = (
        "你是一个资深财经分析师。请根据给定的异动信息与相关新闻摘要，给出简洁的归因结论。\n"
        "要求：\n"
        "1) 只输出 JSON，不要输出其它文本。\n"
        "2) summary 用一句话解释最可能的原因，禁止编造；若缺少证据请明确写“暂无明确新闻归因”。\n"
        "3) followUps 给 2-4 条后续关注点。\n"
        "4) citations 输出 0-5 条引用（title/source/publishedAt/url），必须来自输入的新闻列表；没有就输出空数组。\n"
        "\n"
        f"股票: {name} ({sym})\n"
        f"异动: {reason}\n"
        f"触发快照(摘要): {str(snapshot_json)[:1200]}\n"
        f"相关新闻(近{window_minutes}分钟):\n{news_block if news_block else '(无)'}\n"
        "\n"
        "JSON 输出格式：\n"
        '{\n'
        '  "summary": "...",\n'
        '  "followUps": ["..."],\n'
        '  "confidence": 0.0,\n'
        '  "citations": [{"title":"...","source":"...","publishedAt":"...","url":"..."}]\n'
        '}\n'
    )

    messages = [{"role": "system", "content": "你是专业、谨慎的财经分析师。"}, {"role": "user", "content": prompt}]
    llm = await call_openai_compatible(messages, json_mode=True)
    if not llm.get("ok"):
        # Fallback: return a deterministic response even without LLM, for pipeline stability.
        return {
            "ok": True,
            "summary": "暂无明确新闻归因（RAG/LLM 未就绪）",
            "followUps": ["关注后续公告/业绩披露", "关注资金流向与成交量变化"],
            "confidence": 0.1,
            "citations": citations,
            "meta": {"milvus": milvus_news.info(), "embeddingOk": bool(emb.get("ok")), "llmOk": False},
        }

    raw = str(llm.get("reply") or "").strip()
    obj = extract_json_object(raw) or {}
    summary = str(obj.get("summary") or "").strip()
    follow_ups = obj.get("followUps") if isinstance(obj.get("followUps"), list) else []
    confidence = obj.get("confidence")
    out_citations = obj.get("citations") if isinstance(obj.get("citations"), list) else citations

    if not summary:
        summary = "暂无明确新闻归因"

    return {
        "ok": True,
        "summary": summary,
        "followUps": [str(x).strip() for x in follow_ups if str(x).strip()][:5],
        "confidence": float(confidence) if isinstance(confidence, (int, float)) else 0.3,
        "citations": out_citations[:5] if isinstance(out_citations, list) else [],
        "meta": {"milvus": milvus_news.info(), "embeddingOk": bool(emb.get("ok")), "model": _llm_config().get("model", "")},
    }

