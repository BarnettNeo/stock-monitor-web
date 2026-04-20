from __future__ import annotations

import json
import time
from typing import Any, Dict, List

from core.config import _env, _history_limit


def _short_term_turns() -> int:
    """
    Short-term memory in Redis.
    Default: keep last 5 turns (a turn ~= user+assistant).
    """
    try:
        return max(1, int(_env("MEMORY_SHORT_TURNS", "5")))
    except Exception:
        return 5


def _short_term_msg_limit() -> int:
    return max(2, _short_term_turns() * 2)


class Memory:
    """
    Memory system:
      - Short-term: Redis list keeps last N turns (default 5 turns = 10 messages).
      - Long-term: overflow messages are embedded and stored into Milvus (chat_memory collection).
    """

    def __init__(self) -> None:
        self._inmem: Dict[str, List[Dict[str, Any]]] = {}
        self._state_inmem: Dict[str, Dict[str, Any]] = {}
        self._redis: Any = None
        self._redis_prefix: str = "agents:history:"
        self._redis_state_prefix: str = "agents:state:"

        # Long-term memory config (Milvus)
        self._milvus_enabled = bool(_env("MILVUS_URI", "") or _env("MILVUS_HOST", ""))

        redis_url = _env("REDIS_URL", "").strip()
        if redis_url:
            try:
                import redis.asyncio as redis  # type: ignore

                self._redis = redis.Redis.from_url(url=redis_url, decode_responses=True)
            except Exception:
                self._redis = None

    def _key(self, user_id: str) -> str:
        """生成历史记录键"""
        return f"{self._redis_prefix}{user_id}"

    def _state_key(self, user_id: str) -> str:
        return f"{self._redis_state_prefix}{user_id}"

    async def load(self, user_id: str) -> List[Dict[str, Any]]:
        """
        Load recent short-term messages.
        Note: long-term memories are stored in Milvus and retrieved via retrieve_long_term().
        """
        if not user_id:
            return []

        limit = _short_term_msg_limit()
        if self._redis is not None:
            try:
                raw = await self._redis.lrange(self._key(user_id), -limit, -1)
                out: List[Dict[str, Any]] = []
                for s in raw:
                    try:
                        obj = json.loads(s)
                        if isinstance(obj, dict):
                            out.append(obj)
                    except Exception:
                        continue
                return out
            except Exception:
                pass

        # 2. 从内存加载
        return (self._inmem.get(user_id) or [])[-limit:]

    async def append(self, user_id: str, msg: Dict[str, Any]) -> None:
        """
        Append one message into short-term memory. If Redis overflows, push overflow to Milvus.
        This is best-effort and must never break the chat flow.
        """
        if not user_id:
            return

        short_limit = _short_term_msg_limit()
        if short_limit <= 0:
            return

        # In-memory mirror (when Redis is down)
        arr = self._inmem.setdefault(user_id, [])
        arr.append(msg)
        if len(arr) > short_limit:
            self._inmem[user_id] = arr[-short_limit:]

        overflow: List[Dict[str, Any]] = []
        if self._redis is not None:
            try:
                key = self._key(user_id)
                await self._redis.rpush(key, json.dumps(msg, ensure_ascii=False))
                n = int(await self._redis.llen(key))
                if n > short_limit:
                    # Redis 只保留最近 short_limit 条，超出的旧消息会作为“长期记忆候选”
                    # 注意：这里取的是最旧的一段消息（列表头部），写入 Milvus 后再 trim 掉
                    cut = n - short_limit
                    raw = await self._redis.lrange(key, 0, max(0, cut - 1))
                    for s in raw:
                        try:
                            obj = json.loads(s)
                            if isinstance(obj, dict):
                                overflow.append(obj)
                        except Exception:
                            continue
                await self._redis.ltrim(key, -short_limit, -1)
            except Exception:
                overflow = []

        if overflow and self._milvus_enabled:
            # 长期记忆写入是 best-effort：失败也不能影响主流程
            await self._save_long_term(user_id, overflow)

    async def _save_long_term(self, user_id: str, msgs: List[Dict[str, Any]]) -> None:
        try:
            from infrastructure.milvus_memory import milvus_memory
            from llm.embeddings import embed_texts

            texts: List[str] = []
            metas: List[Dict[str, Any]] = []
            now = int(time.time())
            for m in msgs:
                role = str(m.get("role") or "").strip() or "unknown"
                content = str(m.get("content") or "").strip()
                if not content:
                    continue
                # embedding 文本包含 role 前缀，能提高检索时“对话结构”的可读性
                texts.append(f"{role}: {content}")
                metas.append(
                    {
                        "role": role,
                        "content": content,
                        "ts": int(m.get("ts") or now),
                    }
                )

            if not texts:
                return

            emb = await embed_texts(texts)
            if not emb.get("ok"):
                return
            vectors = emb.get("vectors") or []
            if not isinstance(vectors, list) or len(vectors) != len(metas):
                return

            await milvus_memory.insert_messages(user_id=user_id, metas=metas, vectors=vectors)
        except Exception:
            return

    async def retrieve_long_term(self, user_id: str, query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        if not user_id:
            return []
        if not self._milvus_enabled:
            return []
        q = (query or "").strip()
        if not q:
            return []

        try:
            from infrastructure.milvus_memory import milvus_memory
            from llm.embeddings import embed_text

            emb = await embed_text(q)
            if not emb.get("ok") or not emb.get("vector"):
                return []
            return milvus_memory.search(user_id=user_id, query_vector=emb["vector"], top_k=top_k)
        except Exception:
            return []

    async def load_state(self, user_id: str) -> Dict[str, Any]:
        """加载用户状态 - 优先级：Redis > 内存"""
        if not user_id:
            return {}

        # 1. 尝试从Redis加载
        if self._redis is not None:
            try:
                raw = await self._redis.get(self._state_key(user_id))
                if not raw:
                    return {}
                obj = json.loads(raw)
                return obj if isinstance(obj, dict) else {}
            except Exception:
                pass

        # 2. 从内存加载
        return dict(self._state_inmem.get(user_id) or {})

    async def save_state(self, user_id: str, state: Dict[str, Any]) -> None:
        """保存用户状态 - 多存储同步"""
        if not user_id:
            return

        # 1. 更新内存存储
        self._state_inmem[user_id] = dict(state or {})

        # 2. 更新Redis存储
        if self._redis is not None:
            try:
                await self._redis.set(self._state_key(user_id), json.dumps(state or {}, ensure_ascii=False))
            except Exception:
                pass

    async def clear_state(self, user_id: str) -> None:
        """清除用户状态 - 多存储同步"""
        if not user_id:
            return

        # 1. 清除内存存储
        self._state_inmem.pop(user_id, None)

        # 2. 清除Redis存储
        if self._redis is not None:
            try:
                await self._redis.delete(self._state_key(user_id))
            except Exception:
                pass

    async def get_storage_info(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {
            "redis_available": self._redis is not None,
            "memory_users": len(self._inmem),
            "state_users": len(self._state_inmem),
            "short_term_turns": _short_term_turns(),
            "short_term_msg_limit": _short_term_msg_limit(),
            # _history_limit is still used by other parts; keep it visible for debugging.
            "history_limit_config": _history_limit(),
            "milvus_enabled": self._milvus_enabled,
        }

        if self._redis:
            try:
                info["redis_info"] = await self._redis.info()
            except Exception:
                info["redis_info"] = "unavailable"

        return info


# 全局内存实例
memory = Memory()
