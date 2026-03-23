import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional

import httpx

from core.config import _env


class DingTalkNotifier:
    """钉钉机器人通知"""
    
    def __init__(self, webhook_url: str, secret: Optional[str] = None):
        self.webhook_url = webhook_url
        self.secret = secret
    
    def _generate_sign(self, timestamp: int) -> str:
        """生成钉钉加签"""
        if not self.secret:
            return ""
        
        string_to_sign = f"{timestamp}\n{self.secret}"
        hmac_code = hmac.new(
            self.secret.encode('utf-8'),
            string_to_sign.encode('utf-8'),
            digestmod=hashlib.sha256
        ).digest()
        
        return hmac_code.hex()
    
    async def send_message(self, message: str, msg_type: str = "text") -> Dict[str, Any]:
        """发送钉钉消息"""
        if not self.webhook_url:
            return {"ok": False, "error": "Webhook URL not configured"}
        
        # 构建基础payload
        payload = {"msgtype": msg_type}
        
        if msg_type == "text":
            payload["text"] = {"content": message}
        elif msg_type == "markdown":
            payload["markdown"] = {"title": "股票监控通知", "text": message}
        
        # 添加加签参数
        if self.secret:
            timestamp = int(round(time.time() * 1000))
            sign = self._generate_sign(timestamp)
            url = f"{self.webhook_url}&timestamp={timestamp}&sign={sign}"
        else:
            url = self.webhook_url
        
        try:
            timeout = httpx.Timeout(10.0, connect=5.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.post(url, json=payload)
                r.raise_for_status()
                data = r.json()
                
                if data.get("errcode") == 0:
                    return {"ok": True, "data": data}
                else:
                    return {"ok": False, "error": data.get("errmsg", "Unknown error")}
        except Exception as e:
            return {"ok": False, "error": str(e)}


class WeChatWorkNotifier:
    """企业微信机器人通知"""
    
    def __init__(self, webhook_url: str):
        self.webhook_url = webhook_url
    
    async def send_message(self, message: str, msg_type: str = "text") -> Dict[str, Any]:
        """发送企业微信消息"""
        if not self.webhook_url:
            return {"ok": False, "error": "Webhook URL not configured"}
        
        # 构建基础payload
        payload = {"msgtype": msg_type}
        
        if msg_type == "text":
            payload["text"] = {"content": message}
        elif msg_type == "markdown":
            payload["markdown"] = {"content": message}
        
        try:
            timeout = httpx.Timeout(10.0, connect=5.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.post(self.webhook_url, json=payload)
                r.raise_for_status()
                data = r.json()
                
                if data.get("errcode") == 0:
                    return {"ok": True, "data": data}
                else:
                    return {"ok": False, "error": data.get("errmsg", "Unknown error")}
        except Exception as e:
            return {"ok": False, "error": str(e)}


class NotificationManager:
    """通知管理器"""
    
    def __init__(self):
        self._notifiers: Dict[str, Any] = {}
    
    def register_dingtalk(self, user_id: str, webhook_url: str, secret: Optional[str] = None):
        """注册钉钉通知器"""
        self._notifiers[f"{user_id}_dingtalk"] = DingTalkNotifier(webhook_url, secret)
    
    def register_wechat_work(self, user_id: str, webhook_url: str):
        """注册企业微信通知器"""
        self._notifiers[f"{user_id}_wechat"] = WeChatWorkNotifier(webhook_url)
    
    async def send_notification(self, user_id: str, message: str, notifier_type: str = "auto") -> Dict[str, Any]:
        """发送通知"""
        if notifier_type == "auto":
            # 自动选择可用的通知器
            for key in [f"{user_id}_dingtalk", f"{user_id}_wechat"]:
                if key in self._notifiers:
                    return await self._notifiers[key].send_message(message)
            return {"ok": False, "error": "No notifier configured"}
        else:
            key = f"{user_id}_{notifier_type}"
            if key in self._notifiers:
                return await self._notifiers[key].send_message(message)
            return {"ok": False, "error": f"{notifier_type} notifier not configured"}
    
    def format_stock_alert(self, symbol: str, alert_type: str, value: Any, timestamp: str) -> str:
        """格式化股票预警消息"""
        return f"""📈 **股票监控提醒**

**股票代码**: {symbol}
**预警类型**: {alert_type}
**触发值**: {value}
**触发时间**: {timestamp}

请及时关注市场动态！"""
    
    def format_strategy_report(self, strategies: list, triggers: list) -> str:
        """格式化策略报告"""
        strategy_count = len(strategies)
        trigger_count = len(triggers)
        
        return f"""📊 **监控策略报告**

**策略总数**: {strategy_count}
**今日触发**: {trigger_count}

📋 **策略列表**:
{chr(10).join([f"• {s.get('name', 'Unknown')} ({s.get('symbols', 'N/A')})" for s in strategies[:5]])}

🔔 **触发记录**:
{chr(10).join([f"• {t.get('symbol', 'Unknown')} - {t.get('type', 'Unknown')}" for t in triggers[:5]])}

详细数据请查看系统报告。"""


# 全局通知管理器
notification_manager = NotificationManager()
