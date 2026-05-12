from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from core.config import _env
import hashlib
import time


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

    # 确保新闻集合存在
    def _ensure_collection(self, dim: int) -> bool:
        """
        Ensure the target collection exists with an expected schema.

        This is intentionally conservative: it creates the collection only if missing,
        and otherwise assumes an existing compatible schema.
        """
        if not self._ensure_ready():
            return False

        try:
            from pymilvus import (  # type: ignore
                Collection,
                CollectionSchema,
                DataType,
                FieldSchema,
                utility,
            )

            if utility.has_collection(self._collection_name, using=self._alias):
                return True

            dim = max(1, int(dim))

            fields = [
                FieldSchema(name=_env("MILVUS_NEWS_ID_FIELD", "doc_id"), dtype=DataType.VARCHAR, is_primary=True, max_length=128),
                FieldSchema(name="symbol", dtype=DataType.VARCHAR, max_length=32),
                FieldSchema(name="ts", dtype=DataType.INT64),
                FieldSchema(name="title", dtype=DataType.VARCHAR, max_length=1024),
                FieldSchema(name="url", dtype=DataType.VARCHAR, max_length=2048),
                FieldSchema(name="source", dtype=DataType.VARCHAR, max_length=256),
                FieldSchema(name="published_at", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=65535),
                FieldSchema(
                    name=_env("MILVUS_NEWS_VECTOR_FIELD", "embedding"),
                    dtype=DataType.FLOAT_VECTOR,
                    dim=dim,
                ),
            ]

            schema = CollectionSchema(fields, description="News chunks for stock-monitor")
            col = Collection(self._collection_name, schema=schema, using=self._alias)

            # Create index for vector search
            index_params = {
                "metric_type": _env("MILVUS_METRIC", "COSINE"),
                "index_type": _env("MILVUS_NEWS_INDEX_TYPE", "HNSW"),
                "params": {"M": 16, "efConstruction": 200},
            }
            col.create_index(field_name=_env("MILVUS_NEWS_VECTOR_FIELD", "embedding"), index_params=index_params)

            # Helpful scalar indexes
            try:
                col.create_index(field_name="symbol", index_name="idx_symbol", index_params={"index_type": "INVERTED"})
                col.create_index(field_name="ts", index_name="idx_ts", index_params={"index_type": "STL_SORT"})
            except Exception:
                # Non-fatal (depends on Milvus version / index support)
                pass

            col.load()
            self._collection = col
            return True
        except Exception as e:
            self._err = str(e)
            return False

    # 获取新闻集合信息
    def info(self) -> Dict[str, Any]:
        return {
            "configured": bool(_env("MILVUS_URI", "") or _env("MILVUS_HOST", "")),
            "collection": self._collection_name,
            "ready": self._ready,
            "error": self._err,
        }

    # 构建新闻文档ID
    @staticmethod
    def _build_doc_id(symbol: str, url: str, published_at: str, title: str, text: str, dedup_hint: str = "") -> str:
        base = "|".join(
            [
                (symbol or "").strip(),
                (url or "").strip(),
                (published_at or "").strip(),
                (title or "").strip(),
                (dedup_hint or "").strip(),
            ]
        ).strip()
        if not base:
            base = (text or "")[:2000]
        h = hashlib.sha256(base.encode("utf-8", errors="ignore")).hexdigest()
        return h[:64]

    # 插入或替换新闻文档
    def upsert_chunks(
        self,
        symbol: str,
        chunks: List[NewsChunk],
        embeddings: List[List[float]],
        ts_unix_seconds: Optional[int] = None,
        dedup_hint: str = "",
    ) -> Dict[str, Any]:
        """
        Insert/replace news chunks for a symbol.

        Notes:
        - Uses `doc_id` as the primary key (stable hash).
        - Deletes by primary key (expr) before inserting to keep idempotency.
        """
        if not self._ensure_ready():
            return {"ok": False, "error": self._err or "milvus not ready", "inserted": 0}

        sym = (symbol or "").strip()
        if not sym:
            return {"ok": False, "error": "missing symbol", "inserted": 0}

        if not chunks or not embeddings or len(chunks) != len(embeddings):
            return {"ok": False, "error": "chunk/embedding mismatch", "inserted": 0}

        dim = len(embeddings[0]) if embeddings and isinstance(embeddings[0], list) else 0
        if dim <= 0:
            return {"ok": False, "error": "invalid embedding dim", "inserted": 0}

        if not self._ensure_collection(dim):
            return {"ok": False, "error": self._err or "ensure collection failed", "inserted": 0}

        now = int(time.time())
        ts = int(ts_unix_seconds or now)
        id_field = _env("MILVUS_NEWS_ID_FIELD", "doc_id")
        vec_field = _env("MILVUS_NEWS_VECTOR_FIELD", "embedding")

        rows: List[Dict[str, Any]] = []
        doc_ids: List[str] = []
        for c, vec in zip(chunks, embeddings):
            text = (c.text or "").strip()
            if not text:
                continue
            doc_id = self._build_doc_id(sym, c.url, c.published_at, c.title, text, dedup_hint=dedup_hint)
            doc_ids.append(doc_id)
            rows.append(
                {
                    id_field: doc_id,
                    "symbol": sym,
                    "ts": ts,
                    "title": (c.title or "")[:1024],
                    "url": (c.url or "")[:2048],
                    "source": (c.source or "")[:256],
                    "published_at": (c.published_at or "")[:64],
                    "text": text[:65535],
                    vec_field: [float(x) for x in vec],
                }
            )

        if not rows:
            return {"ok": True, "inserted": 0}

        try:
            # Best-effort delete existing docs with same ids.
            # Milvus supports expr like: doc_id in ["a","b"]
            try:
                quoted = ",".join([f"\"{x}\"" for x in doc_ids[:1024]])
                self._collection.delete(expr=f"{id_field} in [{quoted}]")
            except Exception:
                pass

            self._collection.insert(rows)
            try:
                self._collection.flush()
            except Exception:
                pass

            return {"ok": True, "inserted": len(rows)}
        except Exception as e:
            return {"ok": False, "error": str(e), "inserted": 0}

    # 搜索最近新闻
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

