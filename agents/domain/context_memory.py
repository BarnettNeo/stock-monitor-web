from __future__ import annotations

from typing import Any, Dict, List

from infrastructure.memory import memory


def _cosine(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += float(x) * float(y)
        na += float(x) * float(x)
        nb += float(y) * float(y)
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / ((na**0.5) * (nb**0.5))


async def resolve_effective_message(
    *,
    user_id: str,
    message: str,
    history: List[Dict[str, Any]],
    state: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Resolve follow-up context WITHOUT hardcoded intent keywords.

    Strategy:
      1) If message contains explicit symbol -> use it.
      2) Else: scan short-term cache (Redis history) to infer the referenced symbol.
         - If only 1 distinct symbol appears in last 5 turns -> use it.
         - If multiple symbols -> use embeddings similarity between current message and cached messages to pick best match.
      3) Else: retrieve from long-term vector memory (Milvus chat_memory) and infer symbol from top hits.
      4) Else: fallback to state.lastSymbol (still user cache).

    设计目标（中文说明）：
      - 不在 main.py 写死“继续/深入/详情”这种关键词，而是通过“检索”做上下文联动。
      - 优先使用用户最近对话（Redis 短期缓存），再用 Milvus 长期记忆兜底。
      - 返回 effective_message 会附带“检索推断来源”，方便调试和解释。
      - Redis→embedding disambiguation→Milvus→state 
    """
    from domain.strategy import extract_symbols_from_text

    msg = (message or "").strip()
    if not msg:
        return {"effective_message": message, "resolved_symbol": "", "memory_snippets": [], "source": ""}

    # 1) 用户本轮消息里已经包含股票代码：直接用，不需要上下文联动
    try:
        codes = extract_symbols_from_text(msg)
        if codes:
            return {"effective_message": msg, "resolved_symbol": codes[0], "memory_snippets": [], "source": "explicit"}
    except Exception:
        pass

    # 2) Redis 短期缓存检索：反向扫描最近对话，收集出现过的 symbol 作为候选
    candidates: List[Dict[str, str]] = []
    try:
        for m in reversed(history or []):
            if not isinstance(m, dict):
                continue
            content = m.get("content")
            if not isinstance(content, str) or not content.strip():
                continue
            codes = extract_symbols_from_text(content)
            if not codes:
                continue
            candidates.append({"symbol": codes[0], "text": content})
            if len(candidates) >= 8:
                break
    except Exception:
        candidates = []

    distinct_syms = list(dict.fromkeys([c["symbol"] for c in candidates]))
    if len(distinct_syms) == 1:
        # 最近 5 轮只出现过 1 个股票代码：可以非常稳定地做上下文联动
        sym = distinct_syms[0]
        eff = f"{msg}\n\n(上下文检索：从最近对话推断你指的是 {sym})"
        return {"effective_message": eff, "resolved_symbol": sym, "memory_snippets": [], "source": "redis_unique"}

    if candidates:
        # 2b) multiple candidates: use embedding similarity to match the most relevant cached message
        try:
            from llm.embeddings import embed_texts

            # 用 embedding 相似度在多个候选之间做 disambiguation。
            # 阈值 0.35 是经验值：太低会误匹配，太高会频繁回退到 Milvus/state。
            texts = [msg] + [c["text"][:600] for c in candidates[:6]]
            emb = await embed_texts(texts)
            if emb.get("ok"):
                vecs = emb.get("vectors") or []
                if isinstance(vecs, list) and len(vecs) == len(texts):
                    qv = vecs[0]
                    best_i = -1
                    best_s = -1.0
                    for i in range(1, len(vecs)):
                        s = _cosine(qv, vecs[i])
                        if s > best_s:
                            best_s = s
                            best_i = i
                    if best_i >= 1 and best_s >= 0.35:
                        # 相似度达到阈值：用该候选消息提到的 symbol 作为上下文补全
                        sym = candidates[best_i - 1]["symbol"]
                        eff = f"{msg}\n\n(上下文检索：从最近对话相似度匹配推断你指的是 {sym})"
                        return {
                            "effective_message": eff,
                            "resolved_symbol": sym,
                            "memory_snippets": [],
                            "source": "redis_sim",
                        }
        except Exception:
            pass

    # 3) Milvus 长期记忆兜底：当 Redis 的最近对话不足以推断 symbol 时使用
    memory_snips: List[str] = []
    try:
        hits = await memory.retrieve_long_term(user_id, msg, top_k=5)
        if isinstance(hits, list) and hits:
            sym_counts: Dict[str, int] = {}
            for h in hits[:5]:
                if not isinstance(h, dict):
                    continue
                role = str(h.get("role") or "").strip() or "unknown"
                content = str(h.get("content") or "").strip()
                if not content:
                    continue
                memory_snips.append(f"{role}: {content}")
                try:
                    codes = extract_symbols_from_text(content)
                    for c in codes:
                        sym_counts[c] = sym_counts.get(c, 0) + 1
                except Exception:
                    continue

            if sym_counts:
                # 从 top hits 里统计出现频率最高的 symbol 作为推断结果（简单可控）
                sym = sorted(sym_counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
                eff = f"{msg}\n\n(上下文检索：从长期记忆检索推断你指的是 {sym})"
                return {
                    "effective_message": eff,
                    "resolved_symbol": sym,
                    "memory_snippets": memory_snips[:5],
                    "source": "milvus",
                }
    except Exception:
        pass

    # 4) 最后兜底：使用 state.lastSymbol（这是用户状态缓存，不是关键词规则）
    st_sym = str((state or {}).get("lastSymbol") or "").strip()
    if st_sym:
        eff = f"{msg}\n\n(上下文检索：从用户状态缓存推断你指的是 {st_sym})"
        return {"effective_message": eff, "resolved_symbol": st_sym, "memory_snippets": [], "source": "state_hint"}

    return {"effective_message": msg, "resolved_symbol": "", "memory_snippets": [], "source": ""}
