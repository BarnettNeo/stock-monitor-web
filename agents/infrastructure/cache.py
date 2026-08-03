"""
简单内存 TTL 缓存
用于缓存 LLM 意图抽取结果和 Embedding 向量，避免重复请求。
"""

import hashlib
import time
from threading import Lock
from typing import Any, Optional


class TTLCache:
    """线程安全的 TTL 缓存（LRU 淘汰）"""

    def __init__(self, max_size: int = 256, ttl_seconds: int = 300):
        self._store: dict[str, tuple[float, Any]] = {}
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._lock = Lock()

    def _key(self, text: str) -> str:
        return hashlib.md5(text.encode("utf-8")).hexdigest()

    def get(self, text: str) -> Optional[Any]:
        key = self._key(text)
        with self._lock:
            entry = self._store.get(key)
            if not entry:
                return None
            ts, value = entry
            if time.time() - ts > self._ttl:
                del self._store[key]
                return None
            return value

    def set(self, text: str, value: Any) -> None:
        key = self._key(text)
        with self._lock:
            # 淘汰过期和超限
            if len(self._store) >= self._max_size:
                self._evict()
            self._store[key] = (time.time(), value)

    def _evict(self) -> None:
        now = time.time()
        # 先淘汰过期的
        expired = [k for k, (ts, _) in self._store.items() if now - ts > self._ttl]
        for k in expired:
            del self._store[k]
        # 还是超限就淘汰最旧的
        if len(self._store) >= self._max_size:
            oldest = min(self._store, key=lambda k: self._store[k][0])
            del self._store[oldest]

    def clear(self) -> None:
        with self._lock:
            self._store.clear()

    def stats(self) -> dict:
        with self._lock:
            return {"size": len(self._store), "max_size": self._max_size, "ttl": self._ttl}


# ── 全局缓存实例 ─────────────────────────────────────────

# 意图抽取缓存（5 分钟 TTL，256 条上限）
intent_cache = TTLCache(max_size=256, ttl_seconds=300)

# Embedding 缓存（30 分钟 TTL，512 条上限）
embedding_cache = TTLCache(max_size=512, ttl_seconds=1800)
