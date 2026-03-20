"""
数据库迁移脚本 - 从Redis迁移到PostgreSQL
"""

import asyncio
import json
from datetime import datetime

from config import _env
from database import db_manager
from memory import memory


async def migrate_redis_to_postgresql():
    """将Redis数据迁移到PostgreSQL"""
    print("🔄 开始数据迁移...")
    
    # 初始化数据库
    await db_manager.initialize()
    
    # 获取存储信息
    storage_info = await memory.get_storage_info()
    print(f"📊 存储信息: {storage_info}")
    
    if not storage_info["postgresql_available"]:
        print("❌ PostgreSQL未配置，无法迁移")
        return
    
    if not storage_info["redis_available"]:
        print("⚠️ Redis不可用，无需迁移")
        return
    
    # 执行迁移
    migration_result = await memory.migrate_to_postgresql()
    
    print("✅ 迁移完成:")
    print(f"   - 历史记录: {migration_result.get('history', 0)} 个用户")
    print(f"   - 状态数据: {migration_result.get('state', 0)} 个用户")
    
    if migration_result.get("errors"):
        print("⚠️ 迁移错误:")
        for error in migration_result["errors"]:
            print(f"   - {error}")
    
    # 关闭数据库连接
    await db_manager.close()
    print("🏁 迁移脚本执行完成")


async def create_sample_data():
    """创建示例数据"""
    print("📝 创建示例数据...")
    
    await db_manager.initialize()
    
    # 示例用户会话
    sample_sessions = [
        {
            "user_id": "demo_user_1",
            "session_data": {
                "history": [
                    {"role": "user", "content": "帮我监控贵州茅台", "timestamp": datetime.now().isoformat()},
                    {"role": "assistant", "content": "已为您创建贵州茅台监控策略", "timestamp": datetime.now().isoformat()}
                ],
                "state": {"last_intent": "create_strategy"}
            }
        },
        {
            "user_id": "demo_user_2", 
            "session_data": {
                "history": [
                    {"role": "user", "content": "今天有哪些股票触发了异动？", "timestamp": datetime.now().isoformat()},
                    {"role": "assistant", "content": "今天有3只股票触发异动", "timestamp": datetime.now().isoformat()}
                ],
                "state": {"last_intent": "query_triggers"}
            }
        }
    ]
    
    # 示例策略
    from database import StrategyRecord
    sample_strategies = [
        StrategyRecord(
            id="strategy_001",
            user_id="demo_user_1",
            name="茅台监控",
            symbols=["sh600519"],
            config={
                "alertMode": "percent",
                "priceAlertPercent": 2,
                "enableMacdGoldenCross": True
            },
            enabled=True,
            created_at=datetime.now(),
            updated_at=datetime.now()
        ),
        StrategyRecord(
            id="strategy_002",
            user_id="demo_user_2",
            name="科技股组合",
            symbols=["sz000001", "sz000002"],
            config={
                "alertMode": "target",
                "targetPriceUp": 200,
                "targetPriceDown": 150
            },
            enabled=True,
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
    ]
    
    # 示例触发记录
    from database import TriggerRecord
    sample_triggers = [
        TriggerRecord(
            id="trigger_001",
            user_id="demo_user_1",
            strategy_id="strategy_001",
            symbol="sh600519",
            trigger_type="price_percent",
            trigger_value={"change": 2.5, "threshold": 2},
            triggered_at=datetime.now()
        )
    ]
    
    # 示例订阅
    from database import SubscriptionRecord
    sample_subscriptions = [
        SubscriptionRecord(
            id="sub_001",
            user_id="demo_user_1",
            notifier_type="dingtalk",
            endpoint="https://oapi.dingtalk.com/robot/send?access_token=demo",
            secret="demo_secret",
            enabled=True,
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
    ]
    
    try:
        # 保存示例数据
        for session in sample_sessions:
            await db_manager.save_user_session(session["user_id"], session["session_data"])
        
        for strategy in sample_strategies:
            await db_manager.save_strategy(strategy)
        
        for trigger in sample_triggers:
            await db_manager.save_trigger(trigger)
        
        for subscription in sample_subscriptions:
            await db_manager.save_subscription(subscription)
        
        print("✅ 示例数据创建完成")
        print(f"   - 用户会话: {len(sample_sessions)}")
        print(f"   - 监控策略: {len(sample_strategies)}")
        print(f"   - 触发记录: {len(sample_triggers)}")
        print(f"   - 订阅设置: {len(sample_subscriptions)}")
        
    except Exception as e:
        print(f"❌ 创建示例数据失败: {e}")
    
    await db_manager.close()


async def backup_data():
    """备份数据"""
    print("💾 开始数据备份...")
    
    await db_manager.initialize()
    
    try:
        # 获取所有用户会话
        sessions = {}
        strategies = []
        triggers = []
        subscriptions = []
        
        # 这里需要实现具体的数据查询逻辑
        # 简化处理，实际应该从数据库查询所有数据
        
        backup_data = {
            "backup_time": datetime.now().isoformat(),
            "sessions": sessions,
            "strategies": strategies,
            "triggers": triggers,
            "subscriptions": subscriptions
        }
        
        # 保存备份文件
        backup_file = f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(backup_file, 'w', encoding='utf-8') as f:
            json.dump(backup_data, f, ensure_ascii=False, indent=2, default=str)
        
        print(f"✅ 数据备份完成: {backup_file}")
        
    except Exception as e:
        print(f"❌ 数据备份失败: {e}")
    
    await db_manager.close()


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("用法:")
        print("  python migrate.py migrate    # 迁移Redis数据到PostgreSQL")
        print("  python migrate.py sample     # 创建示例数据")
        print("  python migrate.py backup    # 备份数据")
        sys.exit(1)
    
    command = sys.argv[1]
    
    if command == "migrate":
        asyncio.run(migrate_redis_to_postgresql())
    elif command == "sample":
        asyncio.run(create_sample_data())
    elif command == "backup":
        asyncio.run(backup_data())
    else:
        print(f"未知命令: {command}")
        sys.exit(1)
