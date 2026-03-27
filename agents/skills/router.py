from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from llm.llm import heuristic_tool_calls
from skills.strategy_management import looks_like_strategy_management, strategy_skill_hint
from skills.subscription_management import (
    looks_like_subscription_management,
    subscription_skill_hint,
)


@dataclass(frozen=True)
class Skill:
    """A minimal intent profile for token-efficient decision prompting."""

    name: str
    tool_name: Optional[str]
    hint: str = ""
    executor: Optional[str] = None


_SKILLS: Dict[str, Skill] = {
    "subscription_management": Skill(
        name="订阅管理",
        tool_name=None,
        hint=subscription_skill_hint(),
        executor="subscription_management",
    ),
    "strategy_management": Skill(
        name="策略管理",
        tool_name=None,
        hint=strategy_skill_hint(),
        executor="strategy_management",
    ),
    "query_triggers": Skill(
        name="触发查询",
        tool_name="query_triggers",
        hint="用户想看触发/异动记录，dateRange 默认 today，可按本周/本月调整。",
    ),
    "get_diagnostic": Skill(
        name="异动诊断",
        tool_name="get_diagnostic",
        hint="用户想看某只股票诊断；缺 symbol 时先追问。",
    ),
    "update_subscription": Skill(
        name="订阅更新",
        tool_name="update_subscription",
        hint="用户想快速绑定/更新推送；缺 endpoint(webhook) 时先追问。",
    ),
    "get_stock_info": Skill(
        name="行情查询",
        tool_name="get_stock_info",
        hint="用户想查询实时价格；symbols 可是代码或中文名。",
    ),
    "generate_report": Skill(
        name="报告生成",
        tool_name="generate_report",
        hint="用户要日报/周报/月报，reportType=daily/weekly/monthly。",
    ),
}


def select_skill(message: str, state: Dict[str, Any]) -> Optional[Skill]:
    """Select a skill for the incoming user message.

    Priority:
    1) Pending skill flow (subscription/strategy)
    2) looks_like_subscription_management / looks_like_strategy_management
    3) heuristic_tool_calls -> tool name mapping

    This keeps the router deterministic and avoids extra LLM calls.
    """

    pending = state.get("pending") if isinstance(state, dict) else None
    if isinstance(pending, dict) and pending.get("type") == "subscription_management":
        return _SKILLS.get("subscription_management")
    if isinstance(pending, dict) and pending.get("type") == "strategy_management":
        return _SKILLS.get("strategy_management")

    if looks_like_strategy_management(message, state):
        return _SKILLS.get("strategy_management")
    if looks_like_subscription_management(message, state):
        return _SKILLS.get("subscription_management")

    calls = heuristic_tool_calls(message)
    if not calls:
        return None

    try:
        tool_name = str(getattr(calls[0], "name", "") or "").strip()
    except Exception:
        tool_name = ""

    if not tool_name:
        return None

    return _SKILLS.get(tool_name)
