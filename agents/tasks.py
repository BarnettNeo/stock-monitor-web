"""
Celery任务队列模块 - 异步长任务处理
"""

import asyncio
from datetime import datetime, timedelta
from typing import Any, Dict, List

from celery import Celery
from celery.schedules import crontab

from config import _env
from database import db_manager, TriggerRecord
from notifications import notification_manager


# Celery配置
celery_app = Celery(
    'stock_monitor_agents',
    broker=_env('CELERY_BROKER_URL', 'redis://localhost:6379/1'),
    backend=_env('CELERY_RESULT_BACKEND', 'redis://localhost:6379/2'),
    include=['tasks']
)

# Celery配置
celery_app.conf.update(
    task_serializer='json',
    accept_content=['json'],
    result_serializer='json',
    timezone='Asia/Shanghai',
    enable_utc=True,
    task_track_started=True,
    task_time_limit=30 * 60,  # 30分钟超时
    task_soft_time_limit=25 * 60,  # 25分钟软超时
    worker_prefetch_multiplier=1,
    worker_max_tasks_per_child=1000,
)

# 定时任务配置
celery_app.conf.beat_schedule = {
    # 每分钟检查股票价格
    'check-stock-prices': {
        'task': 'tasks.check_stock_prices',
        'schedule': crontab(minute='*'),
    },
    # 每小时清理过期数据
    'cleanup-expired-data': {
        'task': 'tasks.cleanup_expired_data',
        'schedule': crontab(minute=0, hour='*/1'),
    },
    # 每日生成报告
    'generate-daily-report': {
        'task': 'tasks.generate_daily_report',
        'schedule': crontab(minute=0, hour=8),  # 每天8点
    },
    # 每周生成报告
    'generate-weekly-report': {
        'task': 'tasks.generate_weekly_report',
        'schedule': crontab(minute=0, hour=9, day_of_week=1),  # 周一9点
    },
}


@celery_app.task(bind=True, max_retries=3)
def send_notification_async(self, user_id: str, message: str, notifier_type: str = "auto"):
    """异步发送通知"""
    try:
        # 在异步任务中运行异步代码
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            result = loop.run_until_complete(
                notification_manager.send_notification(user_id, message, notifier_type)
            )
            return result
        finally:
            loop.close()
            
    except Exception as exc:
        # 重试机制
        raise self.retry(exc=exc, countdown=60)


@celery_app.task(bind=True, max_retries=3)
def save_trigger_async(self, trigger_data: Dict[str, Any]):
    """异步保存触发记录"""
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            trigger = TriggerRecord(**trigger_data)
            success = loop.run_until_complete(db_manager.save_trigger(trigger))
            
            if success:
                # 发送通知
                message = notification_manager.format_stock_alert(
                    symbol=trigger.symbol,
                    alert_type=trigger.trigger_type,
                    value=trigger.trigger_value,
                    timestamp=trigger.triggered_at.strftime("%Y-%m-%d %H:%M:%S")
                )
                
                # 异步发送通知
                send_notification_async.delay(trigger.user_id, message)
                
            return {"success": success}
        finally:
            loop.close()
            
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60)


@celery_app.task
def check_stock_prices():
    """检查股票价格 - 定时任务"""
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # 获取所有启用的策略
            strategies = loop.run_until_complete(db_manager.get_all_active_strategies())
            
            for strategy in strategies:
                # 检查每个策略的股票
                for symbol in strategy.symbols:
                    # 异步检查股票价格
                    check_single_stock.delay(strategy.id, symbol, strategy.config)
                    
            return {"checked_strategies": len(strategies)}
        finally:
            loop.close()
            
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(bind=True, max_retries=2)
def check_single_stock(self, strategy_id: str, symbol: str, config: Dict[str, Any]):
    """检查单个股票"""
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # 获取股票实时价格（这里需要调用实际的股票API）
            stock_data = loop.run_until_complete(get_stock_data(symbol))
            
            if not stock_data:
                return {"error": f"无法获取{symbol}数据"}
            
            # 检查各种触发条件
            triggers = []
            
            # 1. 价格百分比触发
            if config.get('alertMode') == 'percent':
                threshold = config.get('priceAlertPercent', 2)
                current_price = stock_data.get('price')
                # 这里需要获取基准价格，简化处理
                if current_price:
                    # 实际应该从数据库获取买入价或昨日收盘价
                    change_percent = stock_data.get('changePercent', 0)
                    if abs(change_percent) >= threshold:
                        triggers.append({
                            'type': 'price_percent',
                            'value': f"{change_percent}%",
                            'threshold': f"{threshold}%"
                        })
            
            # 2. 目标价格触发
            elif config.get('alertMode') == 'target':
                current_price = stock_data.get('price')
                target_up = config.get('targetPriceUp')
                target_down = config.get('targetPriceDown')
                
                if target_up and current_price >= target_up:
                    triggers.append({
                        'type': 'target_price_up',
                        'value': current_price,
                        'target': target_up
                    })
                elif target_down and current_price <= target_down:
                    triggers.append({
                        'type': 'target_price_down',
                        'value': current_price,
                        'target': target_down
                    })
            
            # 3. 技术指标触发
            if config.get('enableMacdGoldenCross'):
                # 检查MACD金叉（需要技术分析库）
                macd_signal = loop.run_until_complete(check_macd_signal(symbol))
                if macd_signal == 'golden_cross':
                    triggers.append({
                        'type': 'macd_golden_cross',
                        'value': '金叉信号'
                    })
            
            # 保存触发记录
            strategy = loop.run_until_complete(db_manager.get_strategy(strategy_id))
            if strategy and triggers:
                for trigger in triggers:
                    trigger_record = TriggerRecord(
                        id=f"{strategy_id}_{symbol}_{int(datetime.now().timestamp())}",
                        user_id=strategy.user_id,
                        strategy_id=strategy_id,
                        symbol=symbol,
                        trigger_type=trigger['type'],
                        trigger_value=trigger,
                        triggered_at=datetime.now()
                    )
                    
                    # 异步保存触发记录
                    save_trigger_async.delay(trigger_record.dict())
            
            return {"symbol": symbol, "triggers": len(triggers)}
        finally:
            loop.close()
            
    except Exception as exc:
        raise self.retry(exc=exc, countdown=30)


@celery_app.task
def cleanup_expired_data():
    """清理过期数据"""
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # 清理30天前的触发记录
            cutoff_date = datetime.now() - timedelta(days=30)
            deleted_count = loop.run_until_complete(
                db_manager.cleanup_old_triggers(cutoff_date)
            )
            
            return {"deleted_triggers": deleted_count}
        finally:
            loop.close()
            
    except Exception as e:
        return {"error": str(e)}


@celery_app.task
def generate_daily_report():
    """生成每日报告"""
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # 获取所有用户
            users = loop.run_until_complete(db_manager.get_all_active_users())
            
            for user_id in users:
                # 生成用户日报
                report_data = loop.run_until_complete(
                    generate_user_report(user_id, "daily")
                )
                
                if report_data:
                    message = f"""📊 **每日监控报告 - {datetime.now().strftime('%Y-%m-%d')}**

策略总数: {report_data.get('strategy_count', 0)}
今日触发: {report_data.get('trigger_count', 0)}
活跃股票: {report_data.get('active_symbols', 0)}

详细数据请查看系统报告。"""
                    
                    # 发送报告
                    send_notification_async.delay(user_id, message)
            
            return {"generated_reports": len(users)}
        finally:
            loop.close()
            
    except Exception as e:
        return {"error": str(e)}


@celery_app.task
def generate_weekly_report():
    """生成每周报告"""
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            users = loop.run_until_complete(db_manager.get_all_active_users())
            
            for user_id in users:
                report_data = loop.run_until_complete(
                    generate_user_report(user_id, "weekly")
                )
                
                if report_data:
                    message = f"""📈 **每周监控报告 - {datetime.now().strftime('%Y年第%W周')}**

本周策略表现:
• 策略总数: {report_data.get('strategy_count', 0)}
• 触发次数: {report_data.get('trigger_count', 0)}
• 最活跃股票: {report_data.get('most_active_symbol', 'N/A')}
• 收益表现: {report_data.get('performance', 'N/A')}

建议: {report_data.get('suggestions', '继续观察')}"""
                    
                    send_notification_async.delay(user_id, message)
            
            return {"generated_reports": len(users)}
        finally:
            loop.close()
            
    except Exception as e:
        return {"error": str(e)}


# 异步辅助函数
async def get_stock_data(symbol: str) -> Dict[str, Any]:
    """获取股票数据（需要实现实际的API调用）"""
    # 这里应该调用实际的股票API，如新浪、东方财富等
    # 返回模拟数据
    return {
        "symbol": symbol,
        "price": 100.0,
        "change": 2.5,
        "changePercent": 2.5,
        "volume": 1000000,
        "timestamp": datetime.now()
    }


async def check_macd_signal(symbol: str) -> str:
    """检查MACD信号（需要技术分析库）"""
    # 这里应该使用技术分析库计算MACD指标
    # 返回模拟数据
    import random
    return random.choice(['golden_cross', 'death_cross', 'hold'])


async def generate_user_report(user_id: str, report_type: str) -> Dict[str, Any]:
    """生成用户报告"""
    strategies = await db_manager.get_user_strategies(user_id, enabled_only=True)
    
    date_range = "today" if report_type == "daily" else "week"
    triggers = await db_manager.get_user_triggers(user_id, date_range, limit=100)
    
    # 统计活跃股票
    symbols = set()
    for trigger in triggers:
        symbols.add(trigger.symbol)
    
    # 计算最活跃股票
    symbol_counts = {}
    for trigger in triggers:
        symbol_counts[trigger.symbol] = symbol_counts.get(trigger.symbol, 0) + 1
    
    most_active = max(symbol_counts.items(), key=lambda x: x[1])[0] if symbol_counts else "N/A"
    
    return {
        "strategy_count": len(strategies),
        "trigger_count": len(triggers),
        "active_symbols": len(symbols),
        "most_active_symbol": most_active,
        "performance": "+2.5%" if report_type == "weekly" else "N/A",
        "suggestions": "继续观察" if len(triggers) < 5 else "建议调整策略"
    }


# 扩展数据库管理器方法
async def get_all_active_strategies(self) -> List[Any]:
    """获取所有启用的策略"""
    if not self.pool:
        return []
    
    try:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM strategies WHERE enabled = TRUE ORDER BY created_at DESC"
            )
            return rows
    except Exception as e:
        print(f"❌ 获取活跃策略失败: {e}")
        return []


async def get_strategy(self, strategy_id: str) -> Optional[Any]:
    """获取单个策略"""
    if not self.pool:
        return None
    
    try:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM strategies WHERE id = $1", strategy_id
            )
            return row
    except Exception as e:
        print(f"❌ 获取策略失败: {e}")
        return None


async def get_all_active_users(self) -> List[str]:
    """获取所有活跃用户"""
    if not self.pool:
        return []
    
    try:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT user_id FROM strategies WHERE enabled = TRUE"
            )
            return [row['user_id'] for row in rows]
    except Exception as e:
        print(f"❌ 获取活跃用户失败: {e}")
        return []


async def cleanup_old_triggers(self, cutoff_date: datetime) -> int:
    """清理过期触发记录"""
    if not self.pool:
        return 0
    
    try:
        async with self.pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM triggers WHERE triggered_at < $1", cutoff_date
            )
            # PostgreSQL返回 "DELETE n" 格式，提取数字
            return int(result.split()[-1]) if result else 0
    except Exception as e:
        print(f"❌ 清理过期数据失败: {e}")
        return 0


# 动态添加方法到数据库管理器
db_manager.get_all_active_strategies = get_all_active_strategies.__get__(db_manager)
db_manager.get_strategy = get_strategy.__get__(db_manager)
db_manager.get_all_active_users = get_all_active_users.__get__(db_manager)
db_manager.cleanup_old_triggers = cleanup_old_triggers.__get__(db_manager)
