import json
from typing import Any, Dict, List

from config import _env, _history_limit


class Memory:
    """内存管理类，支持Redis、PostgreSQL和内存存储的混合架构"""
    
    def __init__(self) -> None:
        self._inmem: Dict[str, List[Dict[str, Any]]] = {}
        self._state_inmem: Dict[str, Dict[str, Any]] = {}
        self._redis: Any = None
        self._redis_prefix: str = "agents:history:"
        self._redis_state_prefix: str = "agents:state:"
        self._use_postgresql = False

        # 初始化Redis
        redis_url = _env("REDIS_URL", "")
        if redis_url:
            try:
                import redis.asyncio as redis  # type: ignore
                self._redis = redis.Redis.from_url(url=redis_url, decode_responses=True)
            except Exception:
                self._redis = None
        
        # 检查是否启用PostgreSQL
        db_host = _env("DB_HOST", "")
        if db_host:
            self._use_postgresql = True

    def _key(self, user_id: str) -> str:
        """生成历史记录键"""
        return f"{self._redis_prefix}{user_id}"

    async def load(self, user_id: str) -> List[Dict[str, Any]]:
        """加载用户历史记录 - 优先级：PostgreSQL > Redis > 内存"""
        if not user_id:
            return []
        limit = _history_limit()
        if limit <= 0:
            return []

        # 1. 尝试从PostgreSQL加载
        if self._use_postgresql:
            try:
                from database import db_manager
                session_data = await db_manager.load_user_session(user_id)
                if session_data and "history" in session_data:
                    return session_data["history"][-limit:]
            except Exception:
                pass

        # 2. 尝试从Redis加载
        if self._redis is not None:
            try:
                raw = await self._redis.lrange(self._key(user_id), -limit, -1)
                out: List[Dict[str, Any]] = []
                for s in raw:
                    try:
                        out.append(json.loads(s))
                    except Exception:
                        continue
                
                # 同步到PostgreSQL
                if self._use_postgresql and out:
                    try:
                        from database import db_manager
                        session_data = {"history": out}
                        await db_manager.save_user_session(user_id, session_data)
                    except Exception:
                        pass
                
                return out
            except Exception:
                pass

        # 3. 从内存加载
        return (self._inmem.get(user_id) or [])[-limit:]

    async def append(self, user_id: str, msg: Dict[str, Any]) -> None:
        """追加消息到历史记录 - 多存储同步"""
        if not user_id:
            return
        limit = _history_limit()
        if limit <= 0:
            return

        # 1. 更新内存存储
        arr = self._inmem.setdefault(user_id, [])
        arr.append(msg)
        if len(arr) > limit:
            self._inmem[user_id] = arr[-limit:]

        # 2. 更新Redis存储
        if self._redis is not None:
            try:
                key = self._key(user_id)
                await self._redis.rpush(key, json.dumps(msg, ensure_ascii=False))
                await self._redis.ltrim(key, -limit, -1)
            except Exception:
                pass

        # 3. 更新PostgreSQL存储
        if self._use_postgresql:
            try:
                from database import db_manager
                session_data = await db_manager.load_user_session(user_id) or {}
                history = session_data.get("history", [])
                history.append(msg)
                if len(history) > limit:
                    history = history[-limit:]
                session_data["history"] = history
                await db_manager.save_user_session(user_id, session_data)
            except Exception:
                pass

    def _state_key(self, user_id: str) -> str:
        """生成状态键"""
        return f"{self._redis_state_prefix}{user_id}"

    async def load_state(self, user_id: str) -> Dict[str, Any]:
        """加载用户状态 - 优先级：PostgreSQL > Redis > 内存"""
        if not user_id:
            return {}

        # 1. 尝试从PostgreSQL加载
        if self._use_postgresql:
            try:
                from database import db_manager
                session_data = await db_manager.load_user_session(user_id)
                if session_data and "state" in session_data:
                    return session_data["state"]
            except Exception:
                pass

        # 2. 尝试从Redis加载
        if self._redis is not None:
            try:
                raw = await self._redis.get(self._state_key(user_id))
                if not raw:
                    return {}
                obj = json.loads(raw)
                state = obj if isinstance(obj, dict) else {}
                
                # 同步到PostgreSQL
                if self._use_postgresql and state:
                    try:
                        from database import db_manager
                        session_data = await db_manager.load_user_session(user_id) or {}
                        session_data["state"] = state
                        await db_manager.save_user_session(user_id, session_data)
                    except Exception:
                        pass
                
                return state
            except Exception:
                pass

        # 3. 从内存加载
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

        # 3. 更新PostgreSQL存储
        if self._use_postgresql:
            try:
                from database import db_manager
                session_data = await db_manager.load_user_session(user_id) or {}
                session_data["state"] = state
                await db_manager.save_user_session(user_id, session_data)
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

        # 3. 清除PostgreSQL存储
        if self._use_postgresql:
            try:
                from database import db_manager
                session_data = await db_manager.load_user_session(user_id) or {}
                session_data.pop("state", None)
                if session_data:
                    await db_manager.save_user_session(user_id, session_data)
                else:
                    # 如果session_data为空，可以考虑删除整个记录
                    pass
            except Exception:
                pass

    async def get_storage_info(self) -> Dict[str, Any]:
        """获取存储信息"""
        info = {
            "redis_available": self._redis is not None,
            "postgresql_available": self._use_postgresql,
            "memory_users": len(self._inmem),
            "state_users": len(self._state_inmem)
        }
        
        # 获取Redis信息
        if self._redis:
            try:
                info["redis_info"] = await self._redis.info()
            except Exception:
                info["redis_info"] = "unavailable"
        
        return info

    async def migrate_to_postgresql(self) -> Dict[str, Any]:
        """将现有数据迁移到PostgreSQL"""
        if not self._use_postgresql:
            return {"error": "PostgreSQL not configured"}
        
        migrated = {"history": 0, "state": 0, "errors": []}
        
        try:
            from database import db_manager
            
            # 迁移历史记录
            for user_id, history in self._inmem.items():
                if history:
                    try:
                        session_data = {"history": history}
                        await db_manager.save_user_session(user_id, session_data)
                        migrated["history"] += 1
                    except Exception as e:
                        migrated["errors"].append(f"History migration failed for {user_id}: {e}")
            
            # 迁移状态数据
            for user_id, state in self._state_inmem.items():
                if state:
                    try:
                        session_data = {"state": state}
                        await db_manager.save_user_session(user_id, session_data)
                        migrated["state"] += 1
                    except Exception as e:
                        migrated["errors"].append(f"State migration failed for {user_id}: {e}")
            
            return migrated
        except Exception as e:
            return {"error": str(e)}


# 全局内存实例
memory = Memory()
