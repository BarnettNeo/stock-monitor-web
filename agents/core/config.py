import os
import re
from pathlib import Path
from typing import Dict, Optional


def load_env():
    """加载环境变量"""
    try:
        from dotenv import load_dotenv  # type: ignore

        _ROOT = Path(__file__).resolve().parents[2]
        load_dotenv(_ROOT / '.env', override=False)
        load_dotenv(Path(__file__).resolve().parents[1] / '.env', override=False)
    except Exception:
        pass


def _env(name: str, default: str = "") -> str:
    """获取环境变量"""
    return str(os.getenv(name, default) or "").strip()


def _history_limit() -> int:
    """获取历史记录限制"""
    try:
        v = int(_env("AGENTS_HISTORY_LIMIT", "12"))
        return max(0, min(v, 50))
    except Exception:
        return 12


def _llm_config() -> Dict[str, str]:
    """获取LLM配置 - 支持通义千问Qwen3-Max"""
    base_url = _env("LLM_BASE_URL", "")
    api_key = _env("LLM_API_KEY", "")
    model = _env("LLM_MODEL", "")
    
    # 默认支持通义千问Qwen3-Max
    if not model:
        if "dashscope" in base_url.lower() or "aliyun" in base_url.lower():
            model = "qwen3-max"
        else:
            model = "qwen-plus"
    
    return {
        "base_url": base_url,
        "api_key": api_key,
        "model": model,
    }


def _sanitize_model(value: any) -> Optional[str]:
    """清理模型名称"""
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s or len(s) > 80:
        return None
    # 简单白名单：避免奇怪字符进入下游请求
    if not re.match(r"^[A-Za-z0-9_.:-]+$", s):
        return None
    return s


def _port() -> int:
    """获取服务端口"""
    try:
        return int(os.getenv("AGENTS_PORT", "8008"))
    except Exception:
        return 8008


# 系统提示词 - 优化中文自然语言理解
SYSTEM_PROMPT = (
    "你是股票监控AI助手，专门帮助用户管理股票监控策略和分析市场异动。\n"
    "核心能力：\n"
    "1. 策略管理：创建、查询、删除监控策略\n"
    "2. 异动监控：查询触发记录、诊断详情\n"
    "3. 订阅管理：钉钉、企微推送设置\n"
    "4. 市场查询：实时股价、涨跌幅等信息\n"
    "5. 报告生成：日、周、月监控报告\n\n"
    "重要原则：\n"
    "- 必须通过工具获取真实数据，严禁编造\n"
    "- 理解中文表达，支持同义词和口语化表达\n"
    "- 输出简洁专业，提供可执行建议\n"
    "- 优先使用通义千问Qwen3-Max的强函数调用能力\n"
)

# 工具规格定义 - 支持8个用户意图
TOOLS_SPEC = [
    {
        "name": "list_strategies",
        "description": "获取当前用户的策略列表（只读）",
        "args": {
            "name": "可选，按名称模糊过滤",
            "enabledOnly": "可选，true=只返回启用策略",
            "limit": "可选，返回数量（1~50）",
        },
    },
    {
        "name": "create_strategy",
        "description": "创建一条监控策略（写入）",
        "args": {
            "name": "策略名称（必填；未给时你可以合理生成）",
            "symbols": "股票代码，字符串或数组，例如 'sh600519,sz000001' 或 ['sh600519']（必填）",
            "enabled": "可选，默认 true",
            "marketTimeOnly": "可选，仅交易时间监控（默认 true）",
            "subscriptionIds": "可选，订阅ID数组（默认 []）",

            "alertMode": "可选，'percent' 或 'target'（默认 percent）",
            "priceAlertPercent": "可选，percent 模式下的阈值（单位：百分比数字，例如 2 表示 2%）",
            "targetPriceUp": "可选，target 模式上行目标价（数字）",
            "targetPriceDown": "可选，target 模式下行目标价（数字）",

            "intervalMinutes": "可选，扫描间隔分钟（默认 1）",
            "cooldownMinutes": "可选，冷却分钟（默认 60）",

            "enableMacdGoldenCross": "可选，默认 true",
            "enableRsiOversold": "可选，默认 true",
            "enableRsiOverbought": "可选，默认 true",
            "enableMovingAverages": "可选，默认 false",
            "enablePatternSignal": "可选，默认 true",
        },
    },
    {
        "name": "delete_strategy",
        "description": "删除指定的监控策略",
        "args": {
            "strategyId": "可选，策略ID（推荐；精确删除）",
            "symbols": "可选，股票代码（逗号分隔字符串或数组，用于辅助定位；谨慎使用）",
            "name": "可选，策略名称（用于确认/辅助定位）",
        },
    },
    {
        "name": "query_triggers",
        "description": "查询指定时间范围内的股票触发记录",
        "args": {
            "dateRange": "可选，时间范围：today/week/month，默认today",
            "symbols": "可选，股票代码过滤",
            "limit": "可选，返回数量（1~100）",
        },
    },
    {
        "name": "get_diagnostic",
        "description": "获取指定股票的异动诊断详情",
        "args": {
            "symbol": "股票代码（必填）",
            "timeRange": "可选，时间范围：1d/3d/7d，默认1d",
        },
    },
    {
        "name": "update_subscription",
        "description": "更新用户订阅设置（钉钉、企微等）",
        "args": {
            "type": "订阅类型：dingtalk/wechat/email",
            "endpoint": "推送地址（webhook URL或邮箱）",
            "secret": "可选，钉钉加签密钥",
            "enabled": "可选，是否启用，默认true",
        },
    },
    {
        "name": "get_stock_info",
        "description": "获取股票实时信息（价格、涨跌幅等）",
        "args": {
            "symbols": "股票代码，单个或多个（必填）",
            "fields": "可选，返回字段：price,change,volume等，默认全部",
        },
    },
    {
        "name": "generate_report",
        "description": "生成监控报告（日、周、月报）",
        "args": {
            "reportType": "报告类型：daily/weekly/monthly（必填）",
            "dateRange": "可选，指定日期范围，默认当前周期",
            "format": "可选，输出格式：text/json/html，默认text",
        },
    },
]

# 应用名称
APP_NAME = "stock-monitor-agents"

# 初始化环境变量
load_env()
