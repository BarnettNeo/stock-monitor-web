"""
PostgreSQL数据库模块 - 持久化存储
"""

import asyncio
from datetime import datetime
from typing import Any, Dict, List, Optional

import asyncpg
from pydantic import BaseModel

from config import _env


class DatabaseConfig:
    """数据库配置"""
    
    def __init__(self):
        self.host = _env("DB_HOST", "localhost")
        self.port = int(_env("DB_PORT", "5432"))
        self.database = _env("DB_NAME", "stock_monitor")
        self.username = _env("DB_USER", "postgres")
        self.password = _env("DB_PASSWORD", "")
        self.pool_size = int(_env("DB_POOL_SIZE", "10"))
        self.max_connections = int(_env("DB_MAX_CONNECTIONS", "20"))


class UserSession(BaseModel):
    """用户会话模型"""
    user_id: str
    session_data: Dict[str, Any]
    created_at: datetime
    updated_at: datetime


class StrategyRecord(BaseModel):
    """策略记录模型"""
    id: str
    user_id: str
    name: str
    symbols: List[str]
    config: Dict[str, Any]
    enabled: bool
    created_at: datetime
    updated_at: datetime


class TriggerRecord(BaseModel):
    """触发记录模型"""
    id: str
    user_id: str
    strategy_id: str
    symbol: str
    trigger_type: str
    trigger_value: Any
    triggered_at: datetime
    resolved: bool = False


class SubscriptionRecord(BaseModel):
    """订阅记录模型"""
    id: str
    user_id: str
    notifier_type: str
    endpoint: str
    secret: Optional[str] = None
    enabled: bool = True
    created_at: datetime
    updated_at: datetime


class DatabaseManager:
    """数据库管理器"""
    
    def __init__(self):
        self.config = DatabaseConfig()
        self.pool: Optional[asyncpg.Pool] = None
    
    async def initialize(self):
        """初始化数据库连接池"""
        try:
            self.pool = await asyncpg.create_pool(
                host=self.config.host,
                port=self.config.port,
                database=self.config.database,
                user=self.config.username,
                password=self.config.password,
                min_size=2,
                max_size=self.config.max_connections,
                command_timeout=60
            )
            print("✅ PostgreSQL连接池初始化成功")
            await self._create_tables()
        except Exception as e:
            print(f"❌ PostgreSQL连接失败: {e}")
            self.pool = None
    
    async def _create_tables(self):
        """创建数据表"""
        if not self.pool:
            return
        
        async with self.pool.acquire() as conn:
            # 用户会话表
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS user_sessions (
                    user_id VARCHAR(255) PRIMARY KEY,
                    session_data JSONB,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # 策略记录表
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS strategies (
                    id VARCHAR(255) PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    symbols TEXT[] NOT NULL,
                    config JSONB NOT NULL,
                    enabled BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # 触发记录表
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS triggers (
                    id VARCHAR(255) PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    strategy_id VARCHAR(255) NOT NULL,
                    symbol VARCHAR(20) NOT NULL,
                    trigger_type VARCHAR(100) NOT NULL,
                    trigger_value JSONB,
                    triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    resolved BOOLEAN DEFAULT FALSE
                )
            """)
            
            # 订阅记录表
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id VARCHAR(255) PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    notifier_type VARCHAR(50) NOT NULL,
                    endpoint TEXT NOT NULL,
                    secret TEXT,
                    enabled BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # 创建索引
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_strategies_user_id ON strategies(user_id)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_triggers_user_id ON triggers(user_id)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_triggers_triggered_at ON triggers(triggered_at)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)")
            
            print("✅ 数据表创建完成")
    
    async def save_user_session(self, user_id: str, session_data: Dict[str, Any]):
        """保存用户会话"""
        if not self.pool:
            return False
        
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO user_sessions (user_id, session_data, updated_at)
                    VALUES ($1, $2, CURRENT_TIMESTAMP)
                    ON CONFLICT (user_id) 
                    DO UPDATE SET session_data = $2, updated_at = CURRENT_TIMESTAMP
                """, user_id, session_data)
            return True
        except Exception as e:
            print(f"❌ 保存用户会话失败: {e}")
            return False
    
    async def load_user_session(self, user_id: str) -> Optional[Dict[str, Any]]:
        """加载用户会话"""
        if not self.pool:
            return None
        
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT session_data FROM user_sessions WHERE user_id = $1",
                    user_id
                )
                return dict(row["session_data"]) if row else None
        except Exception as e:
            print(f"❌ 加载用户会话失败: {e}")
            return None
    
    async def save_strategy(self, strategy: StrategyRecord):
        """保存策略"""
        if not self.pool:
            return False
        
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO strategies (id, user_id, name, symbols, config, enabled, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                    ON CONFLICT (id) 
                    DO UPDATE SET name = $3, symbols = $4, config = $5, enabled = $6, updated_at = CURRENT_TIMESTAMP
                """, strategy.id, strategy.user_id, strategy.name, strategy.symbols, 
                    strategy.config, strategy.enabled)
            return True
        except Exception as e:
            print(f"❌ 保存策略失败: {e}")
            return False
    
    async def get_user_strategies(self, user_id: str, enabled_only: bool = False) -> List[StrategyRecord]:
        """获取用户策略列表"""
        if not self.pool:
            return []
        
        try:
            async with self.pool.acquire() as conn:
                query = "SELECT * FROM strategies WHERE user_id = $1"
                if enabled_only:
                    query += " AND enabled = TRUE"
                query += " ORDER BY created_at DESC"
                
                rows = await conn.fetch(query, user_id)
                return [StrategyRecord(**dict(row)) for row in rows]
        except Exception as e:
            print(f"❌ 获取策略列表失败: {e}")
            return []
    
    async def save_trigger(self, trigger: TriggerRecord):
        """保存触发记录"""
        if not self.pool:
            return False
        
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO triggers (id, user_id, strategy_id, symbol, trigger_type, trigger_value, triggered_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                """, trigger.id, trigger.user_id, trigger.strategy_id, trigger.symbol,
                    trigger.trigger_type, trigger.trigger_value, trigger.triggered_at)
            return True
        except Exception as e:
            print(f"❌ 保存触发记录失败: {e}")
            return False
    
    async def get_user_triggers(self, user_id: str, date_range: str = "today", limit: int = 50) -> List[TriggerRecord]:
        """获取用户触发记录"""
        if not self.pool:
            return []
        
        try:
            async with self.pool.acquire() as conn:
                # 根据日期范围构建查询条件
                where_clause = "WHERE user_id = $1"
                params = [user_id]
                
                if date_range == "today":
                    where_clause += " AND DATE(triggered_at) = CURRENT_DATE"
                elif date_range == "week":
                    where_clause += " AND triggered_at >= CURRENT_DATE - INTERVAL '7 days'"
                elif date_range == "month":
                    where_clause += " AND triggered_at >= CURRENT_DATE - INTERVAL '30 days'"
                
                query = f"""
                    SELECT * FROM triggers 
                    {where_clause} 
                    ORDER BY triggered_at DESC 
                    LIMIT ${len(params) + 1}
                """
                params.append(limit)
                
                rows = await conn.fetch(query, *params)
                return [TriggerRecord(**dict(row)) for row in rows]
        except Exception as e:
            print(f"❌ 获取触发记录失败: {e}")
            return []
    
    async def save_subscription(self, subscription: SubscriptionRecord):
        """保存订阅设置"""
        if not self.pool:
            return False
        
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO subscriptions (id, user_id, notifier_type, endpoint, secret, enabled, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                    ON CONFLICT (id) 
                    DO UPDATE SET notifier_type = $3, endpoint = $4, secret = $5, enabled = $6, updated_at = CURRENT_TIMESTAMP
                """, subscription.id, subscription.user_id, subscription.notifier_type,
                    subscription.endpoint, subscription.secret, subscription.enabled)
            return True
        except Exception as e:
            print(f"❌ 保存订阅设置失败: {e}")
            return False
    
    async def get_user_subscriptions(self, user_id: str) -> List[SubscriptionRecord]:
        """获取用户订阅设置"""
        if not self.pool:
            return []
        
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT * FROM subscriptions WHERE user_id = $1 AND enabled = TRUE ORDER BY created_at DESC",
                    user_id
                )
                return [SubscriptionRecord(**dict(row)) for row in rows]
        except Exception as e:
            print(f"❌ 获取订阅设置失败: {e}")
            return []
    
    async def close(self):
        """关闭数据库连接池"""
        if self.pool:
            await self.pool.close()
            print("✅ PostgreSQL连接池已关闭")


# 全局数据库管理器
db_manager = DatabaseManager()
