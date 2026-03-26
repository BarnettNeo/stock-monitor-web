from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from domain.strategy import looks_like_create_strategy
from llm.llm import heuristic_tool_calls


@dataclass(frozen=True)
class Skill:
    """A minimal intent profile for token-efficient decision prompting."""

    name: str
    tool_name: Optional[str]
    hint: str = ""


_SKILLS: Dict[str, Skill] = {
    "list_strategies": Skill(
        name="策略查询",
        tool_name="list_strategies",
        hint="用户想查看当前策略；若需要过滤条件可追问 name/enabledOnly。",
    ),
    "delete_strategy": Skill(
        name="策略删除",
        tool_name="delete_strategy",
        hint="删除有风险：若缺少 strategyId 或唯一定位信息，优先追问确认（final）。",
    ),
    "query_triggers": Skill(
        name="触发查询",
        tool_name="query_triggers",
        hint="用户想看触发/异动记录；dateRange 默认 today，可按 本周/本月调整。",
    ),
    "get_diagnostic": Skill(
        name="异动诊断",
        tool_name="get_diagnostic",
        hint="用户想看某只股票诊断；缺 symbol 时先追问。",
    ),
    "update_subscription": Skill(
        name="订阅管理",
        tool_name="update_subscription",
        hint="用户想绑定/更新推送；缺 endpoint(webhook) 时先追问。",
    ),
    "get_stock_info": Skill(
        name="行情查询",
        tool_name="get_stock_info",
        hint="用户想查询实时价格；symbols 可是代码或中文名。",
    ),
    "generate_report": Skill(
        name="报告生成",
        tool_name="generate_report",
        hint="用户要日报/周报/月报；reportType= daily/weekly/monthly。",
    ),
}


def select_skill(message: str, state: Dict[str, Any]) -> Optional[Skill]:
    """Select a skill for the incoming user message.

    Priority:
    1) Pending create_strategy flow (handled elsewhere, but we keep a fast signal)
    2) looks_like_create_strategy (also handled elsewhere)
    3) heuristic_tool_calls -> tool name mapping

    This keeps the router deterministic and avoids extra LLM calls.
    """

    pending = state.get("pending") if isinstance(state, dict) else None
    if isinstance(pending, dict) and pending.get("type") == "create_strategy":
        return Skill(name="策略创建", tool_name="create_strategy", hint="创建策略走专用缺参追问与抽取流程。")

    if looks_like_create_strategy(message):
        return Skill(name="策略创建", tool_name="create_strategy", hint="创建策略走专用缺参追问与抽取流程。")

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
