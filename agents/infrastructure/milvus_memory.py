from __future__ import annotations

from typing import Any, Dict, List, Optional

from core.config import _env


class MilvusMemoryStore:
    """
    Long-term memory store in Milvus.

    Collection (default: chat_memory) schema created on demand:
      - id: Int64 (auto_id primary key)
      - user_id: VarChar
      - role: VarChar
      - content: VarChar
      - ts: Int64 (unix seconds)
      - embedding: FloatVector(dim)
    """

    def __init__(self) -> None:
        self._ready: bool = False
        self._err: str = ""
        self._alias: str = "default"
        self._collection: Any = None
        self._collection_name: str = _env("MILVUS_MEMORY_COLLECTION", "chat_memory")
        self._dim: Optional[int] = None

    def info(self) -> Dict[str, Any]:
        return {
            "configured": bool(_env("MILVUS_URI", "") or _env("MILVUS_HOST", "")),
            "collection": self._collection_name,
            "ready": self._ready,
            "error": self._err,
            "dim": self._dim,
        }

    def _connect(self) -> bool:
        if self._ready and self._collection is not None:
            return True

        uri = _env("MILVUS_URI", "")
        host = _env("MILVUS_HOST", "")
        port = _env("MILVUS_PORT", "")
        db_name = _env("MILVUS_DB", "")

        if not uri and not host:
            self._err = "milvus not configured"
            return False

        try:
            from pymilvus import Collection, connections  # type: ignore

            if uri:
                connections.connect(alias=self._alias, uri=uri, db_name=db_name or None)
            else:
                connections.connect(alias=self._alias, host=host, port=int(port or "19530"), db_name=db_name or None)

            # Collection may not exist yet; we bind it after ensure_collection().
            self._ready = True
            return True
        except Exception as e:
            self._err = str(e)
            return False

    def _ensure_collection(self, dim: int) -> bool:
        if not self._connect():
            return False

        if self._collection is not None:
            return True

        try:
            from pymilvus import (  # type: ignore
                Collection,
                CollectionSchema,
                DataType,
                FieldSchema,
                utility,
            )

            name = self._collection_name
            if not utility.has_collection(name, using=self._alias):
                # 自动建表：首次写入长期记忆时创建 chat_memory
                # 说明：content 这里用 VarChar(4096)，足够存储一段对话；更长内容建议分片存储。
                fields = [
                    FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
                    FieldSchema(name="user_id", dtype=DataType.VARCHAR, max_length=128),
                    FieldSchema(name="role", dtype=DataType.VARCHAR, max_length=32),
                    FieldSchema(name="content", dtype=DataType.VARCHAR, max_length=4096),
                    FieldSchema(name="ts", dtype=DataType.INT64),
                    FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=int(dim)),
                ]
                schema = CollectionSchema(fields=fields, description="chat long-term memory")
                col = Collection(name=name, schema=schema, using=self._alias)

                # Index (best-effort)
                try:
                    # 这里用 IVF_FLAT + COSINE：实现简单、兼容性好（Milvus Lite/standalone 都能跑）
                    col.create_index(
                        field_name="embedding",
                        index_params={
                            "index_type": "IVF_FLAT",
                            "metric_type": _env("MILVUS_METRIC", "COSINE"),
                            "params": {"nlist": 1024},
                        },
                    )
                except Exception:
                    pass

            self._collection = Collection(name, using=self._alias)
            try:
                self._collection.load()
            except Exception:
                pass

            self._dim = int(dim)
            return True
        except Exception as e:
            self._err = str(e)
            return False

    async def insert_messages(self, user_id: str, metas: List[Dict[str, Any]], vectors: List[List[float]]) -> None:
        """
        Insert messages. metas item: {role, content, ts}
        """
        uid = (user_id or "").strip()
        if not uid:
            return
        if not metas or not vectors or len(metas) != len(vectors):
            return

        dim = len(vectors[0]) if vectors and isinstance(vectors[0], list) else 0
        if dim <= 0:
            return

        if not self._ensure_collection(dim):
            return

        try:
            # Column-based insert
            user_ids: List[str] = []
            roles: List[str] = []
            contents: List[str] = []
            tss: List[int] = []
            embs: List[List[float]] = []

            for meta, vec in zip(metas, vectors):
                role = str(meta.get("role") or "unknown")[:32]
                content = str(meta.get("content") or "")[:4096]
                ts = int(meta.get("ts") or 0)
                if not content:
                    continue
                user_ids.append(uid)
                roles.append(role)
                contents.append(content)
                tss.append(ts)
                embs.append([float(x) for x in vec])

            if not contents:
                return

            self._collection.insert([user_ids, roles, contents, tss, embs])
        except Exception as e:
            self._err = str(e)

    def search(self, user_id: str, query_vector: List[float], top_k: int = 5) -> List[Dict[str, Any]]:
        """
        Search long-term memories for a given user.
        Return list of {role, content, ts, score}.
        """
        uid = (user_id or "").strip()
        if not uid:
            return []
        if not query_vector:
            return []

        if not self._connect():
            return []

        # Ensure collection exists; if not, nothing to search.
        try:
            from pymilvus import Collection, utility  # type: ignore

            if not utility.has_collection(self._collection_name, using=self._alias):
                return []
            if self._collection is None:
                self._collection = Collection(self._collection_name, using=self._alias)
                try:
                    self._collection.load()
                except Exception:
                    pass
        except Exception as e:
            self._err = str(e)
            return []

        try:
            res = self._collection.search(
                data=[query_vector],
                anns_field="embedding",
                param={"metric_type": _env("MILVUS_METRIC", "COSINE"), "params": {"nprobe": 16}},
                limit=max(1, min(int(top_k), 20)),
                expr=f'user_id == "{uid}"',
                output_fields=["role", "content", "ts"],
            )
        except Exception as e:
            self._err = str(e)
            return []

        out: List[Dict[str, Any]] = []
        try:
            hits = res[0] if isinstance(res, list) and res else res
            for h in hits:
                ent = getattr(h, "entity", None) or {}
                get = ent.get if isinstance(ent, dict) else getattr(ent, "get", None)
                if not callable(get):
                    continue
                out.append(
                    {
                        "role": str(get("role") or "").strip(),
                        "content": str(get("content") or "").strip(),
                        "ts": int(get("ts") or 0),
                        # For COSINE, higher is better. For other metrics, treat as score anyway.
                        "score": float(getattr(h, "score", 0.0) or 0.0),
                    }
                )
        except Exception:
            return []

        return out


milvus_memory = MilvusMemoryStore()
