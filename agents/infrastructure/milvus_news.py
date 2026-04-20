from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from core.config import _env


@dataclass
class NewsChunk:
    text: str
    title: str = ""
    url: str = ""
    source: str = ""
    published_at: str = ""


class MilvusNewsStore:
    """
    Minimal Milvus search wrapper.

    Expected collection schema (recommended):
      - embedding: FloatVector
      - symbol: VarChar
      - ts: Int64 (unix seconds) or published_at: VarChar (ISO string)
      - text/title/url/source/published_at fields
    """

    def __init__(self) -> None:
        self._ready: bool = False
        self._err: str = ""
        self._collection_name: str = _env("MILVUS_NEWS_COLLECTION", "news_chunks")
        self._alias: str = "default"
        self._collection: Any = None

    def _ensure_ready(self) -> bool:
        if self._ready:
            return True

        uri = _env("MILVUS_URI", "")
        host = _env("MILVUS_HOST", "")
        port = _env("MILVUS_PORT", "")
        db_name = _env("MILVUS_DB", "")

        if not uri and not host:
            self._err = "milvus not configured"
            return False

        try:
            from pymilvus import connections, Collection  # type: ignore

            if uri:
                connections.connect(alias=self._alias, uri=uri, db_name=db_name or None)
            else:
                connections.connect(
                    alias=self._alias,
                    host=host,
                    port=int(port or "19530"),
                    db_name=db_name or None,
                )

            self._collection = Collection(self._collection_name, using=self._alias)
            self._collection.load()

            self._ready = True
            return True
        except Exception as e:
            self._err = str(e)
            return False

    def info(self) -> Dict[str, Any]:
        return {
            "configured": bool(_env("MILVUS_URI", "") or _env("MILVUS_HOST", "")),
            "collection": self._collection_name,
            "ready": self._ready,
            "error": self._err,
        }

    def search_recent(
        self,
        symbol: str,
        query_vector: List[float],
        since_unix_seconds: Optional[int],
        top_k: int = 8,
    ) -> List[NewsChunk]:
        if not self._ensure_ready():
            return []

        sym = (symbol or "").strip()
        if not sym:
            return []

        expr_parts: List[str] = [f'symbol == "{sym}"']
        # If the collection has a numeric ts field, expr will work; if not, search without time filter.
        if since_unix_seconds is not None:
            expr_parts.append(f"ts >= {int(since_unix_seconds)}")
        expr = " and ".join(expr_parts)

        try:
            res = self._collection.search(
                data=[query_vector],
                anns_field=_env("MILVUS_NEWS_VECTOR_FIELD", "embedding"),
                param={"metric_type": _env("MILVUS_METRIC", "COSINE"), "params": {"nprobe": 16}},
                limit=max(1, min(int(top_k), 20)),
                expr=expr,
                output_fields=[
                    _env("MILVUS_NEWS_TEXT_FIELD", "text"),
                    _env("MILVUS_NEWS_TITLE_FIELD", "title"),
                    _env("MILVUS_NEWS_URL_FIELD", "url"),
                    _env("MILVUS_NEWS_SOURCE_FIELD", "source"),
                    _env("MILVUS_NEWS_PUBLISHED_FIELD", "published_at"),
                ],
            )
        except Exception:
            # Fallback without time filter (schema might not have ts)
            try:
                res = self._collection.search(
                    data=[query_vector],
                    anns_field=_env("MILVUS_NEWS_VECTOR_FIELD", "embedding"),
                    param={"metric_type": _env("MILVUS_METRIC", "COSINE"), "params": {"nprobe": 16}},
                    limit=max(1, min(int(top_k), 20)),
                    expr=f'symbol == "{sym}"',
                    output_fields=[
                        _env("MILVUS_NEWS_TEXT_FIELD", "text"),
                        _env("MILVUS_NEWS_TITLE_FIELD", "title"),
                        _env("MILVUS_NEWS_URL_FIELD", "url"),
                        _env("MILVUS_NEWS_SOURCE_FIELD", "source"),
                        _env("MILVUS_NEWS_PUBLISHED_FIELD", "published_at"),
                    ],
                )
            except Exception:
                return []

        chunks: List[NewsChunk] = []
        try:
            hits = res[0] if isinstance(res, list) and res else res
            for h in hits:
                ent = getattr(h, "entity", None) or {}
                get = ent.get if isinstance(ent, dict) else getattr(ent, "get", None)
                if not callable(get):
                    continue
                text = str(get(_env("MILVUS_NEWS_TEXT_FIELD", "text")) or "").strip()
                if not text:
                    continue
                chunks.append(
                    NewsChunk(
                        text=text,
                        title=str(get(_env("MILVUS_NEWS_TITLE_FIELD", "title")) or "").strip(),
                        url=str(get(_env("MILVUS_NEWS_URL_FIELD", "url")) or "").strip(),
                        source=str(get(_env("MILVUS_NEWS_SOURCE_FIELD", "source")) or "").strip(),
                        published_at=str(get(_env("MILVUS_NEWS_PUBLISHED_FIELD", "published_at")) or "").strip(),
                    )
                )
        except Exception:
            return []

        return chunks


milvus_news = MilvusNewsStore()

