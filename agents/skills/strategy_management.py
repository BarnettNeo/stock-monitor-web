from __future__ import annotations
import json
import re
from typing import Any, Dict, List, Optional, Tuple

import httpx

from core.config import _server_base_url
from core.models import AgentChatResponse
from domain.strategy import (
    build_create_strategy_questions,
    extract_minutes_from_text,
    extract_percent_from_text,
    extract_stock_names_from_text,
    extract_symbols_from_text,
    extract_target_prices_from_text,
    llm_extract_create_strategy_args,
    looks_like_create_strategy,
    merge_args,
    normalize_symbol,
)
from infrastructure.memory import memory
from llm.llm import call_openai_compatible, extract_json_object


STRATEGY_SKILL_NAME = "strategy_management"

UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)


def _symbols_value_from_any(v: Any) -> str:
    if isinstance(v, list):
        return ",".join(str(x).strip() for x in v if str(x).strip())
    return str(v or "").strip()


async def _resolve_symbols_value(auth_header: str, symbols_value: str) -> Tuple[str, List[str]]:
    """Resolve mixed symbols (codes or Chinese names) into sh/sz codes via server resolver."""
    raw = str(symbols_value or "").strip()
    if not raw:
        return "", []

    parts = [p.strip() for p in raw.split(",") if p.strip()]
    resolved: List[str] = []
    unresolved: List[str] = []

    for part in parts:
        n = normalize_symbol(part)  # handles sh600519 / 600519
        if n:
            resolved.append(n)
            continue

        try:
            data = await _api_request(
                "GET",
                "/api/quotes/resolve",
                auth_header=auth_header,
                params={"q": part},
            )
            sym = str((data or {}).get("symbol") or "").strip()
        except Exception:
            sym = ""

        n2 = normalize_symbol(sym) if sym else None
        if n2:
            resolved.append(n2)
        else:
            unresolved.append(part)

    # De-dup while preserving order
    uniq: List[str] = []
    seen = set()
    for x in resolved:
        k = str(x).lower()
        if k in seen:
            continue
        uniq.append(x)
        seen.add(k)

    return ",".join(uniq), unresolved


async def _save_last_strategy_id(user_id: str, strategy_id: str) -> None:
    if not user_id or not strategy_id:
        return
    state = await memory.load_state(user_id)
    base = state if isinstance(state, dict) else {}
    merged = dict(base)
    merged["lastStrategyId"] = str(strategy_id)
    await memory.save_state(user_id, merged)

LIST_KEYWORDS = ["策略列表", "列出策略", "查看策略", "我的策略", "所有策略", "有哪些策略"]
GET_KEYWORDS = ["策略详情", "查看详情", "查看策略详情", "策略信息", "策略配置"]
UPDATE_KEYWORDS = ["修改策略", "更新策略", "编辑策略", "调整策略", "启用策略", "停用策略", "禁用策略", "开启策略", "关闭策略", "归属", "转给", "转移给"]
DELETE_KEYWORDS = ["删除策略", "移除策略", "删除监控", "移除监控", "取消监控"]
STRATEGY_HINT_KEYWORDS = ["策略", "监控策略", "策略管理", "监控"]


def _is_admin(current_user: Dict[str, Any]) -> bool:
    return str((current_user or {}).get("role") or "").strip().lower() == "admin"


def looks_like_strategy_management(message: str, state: Optional[Dict[str, Any]] = None) -> bool:
    pending = state.get("pending") if isinstance(state, dict) else None
    if isinstance(pending, dict) and pending.get("type") == STRATEGY_SKILL_NAME:
        return True

    text = (message or "").strip()
    if not text:
        return False

    if looks_like_create_strategy(text):
        return True

    keywords = LIST_KEYWORDS + GET_KEYWORDS + UPDATE_KEYWORDS + DELETE_KEYWORDS + STRATEGY_HINT_KEYWORDS
    return any(keyword in text for keyword in keywords)


def strategy_skill_hint() -> str:
    return (
        "这是策略管理 skill，负责根据用户自然语言处理策略的增删改查。"
        "skill 内部自动选择 /api/strategies 的 GET、POST、PUT、DELETE 接口，"
        "优先根据策略 ID、名称、股票代码或股票名称定位目标策略，定位不唯一时再追问。"
    )


def _extract_strategy_id(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""

    matches = list(UUID_RE.finditer(raw))
    if not matches:
        return ""

    explicit_markers = ["策略id", "策略编号", "strategy id", "strategy_id", "strategy-id"]
    lowered = raw.lower()
    for m in matches:
        start = max(0, m.start() - 24)
        end = min(len(raw), m.end() + 8)
        window = raw[start:end].lower()
        if any(marker in window for marker in explicit_markers):
            return m.group(0)

    # If the only UUID is clearly a user-id hint, do not treat it as strategy id.
    user_id_hint = _extract_user_id_hint(raw)
    if user_id_hint and len(matches) == 1:
        return ""

    # Backward-compatible fallback for messages that only provide one UUID.
    return matches[0].group(0)


def _extract_quoted_name(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""

    patterns = [
        r"(?:名为|叫做|策略名是|策略名称是)([\u4e00-\u9fffA-Za-z0-9_\-]{2,40})",
        r'"([^"]{2,40})"',
        r"'([^']{2,40})'",
        r"“([^”]{2,40})”",
    ]
    for pattern in patterns:
        match = re.search(pattern, raw)
        if match:
            return str(match.group(1) or "").strip()
    return ""


def _extract_owner_hint(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""

    patterns = [
        r"(?:创建人|创建者|用户名|用户|账号)\s*[:：=]?\s*([A-Za-z0-9_\-\u4e00-\u9fff]{2,40})",
        r"@([A-Za-z0-9_\-\u4e00-\u9fff]{2,40})",
    ]
    for pattern in patterns:
        m = re.search(pattern, raw, flags=re.IGNORECASE)
        if m:
            return str(m.group(1) or "").strip()
    return ""


def _extract_user_id_hint(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""

    patterns = [
        r"(?:user[_\s-]?id|用户id|用户ID)\s*[:：=]?\s*([0-9a-fA-F\-]{36})",
        r"(?:归属用户|归属给|归属到)\s*(?:用户id|用户ID|用户)?\s*[:：=]?\s*([0-9a-fA-F\-]{36})",
    ]
    for pattern in patterns:
        m = re.search(pattern, raw, flags=re.IGNORECASE)
        if not m:
            continue
        uid = str(m.group(1) or "").strip()
        if UUID_RE.fullmatch(uid):
            return uid
    return ""


def _extract_subscription_ids_hint(text: str, strategy_id: str = "") -> Optional[List[str]]:
    raw = str(text or "").strip()
    if not raw:
        return None

    lowered = raw.lower()
    if any(k in lowered for k in ["清空订阅", "移除订阅", "取消订阅绑定"]):
        return []

    block = ""
    m = re.search(r"(?:subscriptionIds?|订阅id|订阅ID|订阅)\s*[:：=]?\s*([^\n，。；;]+)", raw, flags=re.IGNORECASE)
    if m:
        block = str(m.group(1) or "")
    if not block:
        return None

    ids = [x.group(0) for x in UUID_RE.finditer(block)]
    if strategy_id:
        ids = [x for x in ids if x != strategy_id]
    if not ids:
        return None
    return list(dict.fromkeys(ids))


def _extract_action(message: str) -> Optional[str]:
    text = (message or "").strip()
    if not text:
        return None

    if any(keyword in text for keyword in DELETE_KEYWORDS):
        return "delete"
    if any(keyword in text for keyword in UPDATE_KEYWORDS):
        return "update"
    if any(keyword in text for keyword in GET_KEYWORDS):
        return "get"
    if any(keyword in text for keyword in LIST_KEYWORDS):
        return "list"
    if looks_like_create_strategy(text):
        return "create"
    return None


async def _llm_extract_strategy_intent(
    message: str,
    current: Dict[str, Any],
    model_override: Optional[str],
) -> Dict[str, Any]:
    prompt = {
        "instruction": "从用户自然语言中提取策略管理意图和参数，只输出 JSON。",
        "output": {
            "action": "list|get|create|update|delete|null",
            "strategyId": "string|null",
            "userId": "string|null",
            "name": "string|null",
            "symbols": "string[]|string|null",
            "enabled": "boolean|null",
            "marketTimeOnly": "boolean|null",
            "subscriptionIds": "string[]|null",
            "alertMode": "percent|target|null",
            "priceAlertPercent": "number|null",
            "targetPriceUp": "number|null",
            "targetPriceDown": "number|null",
            "intervalMinutes": "integer|null",
            "cooldownMinutes": "integer|null",
            "enableMacdGoldenCross": "boolean|null",
            "enableRsiOversold": "boolean|null",
            "enableRsiOverbought": "boolean|null",
            "enableMovingAverages": "boolean|null",
            "enablePatternSignal": "boolean|null",
        },
        "notes": [
            "列出策略时 action=list。",
            "查看某条策略详情时 action=get。",
            "创建策略时 action=create。",
            "启用、停用、编辑、修改策略时 action=update。",
            "删除、移除、取消监控时 action=delete。",
            "管理员修改策略归属时可输出 userId。",
            "不要编造用户未提及的字段，未知时填 null。",
        ],
        "current": current or {},
        "userMessage": message,
    }

    messages = [
        {"role": "system", "content": "你是一个信息抽取器，只输出 JSON。"},
        {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
    ]
    llm = await call_openai_compatible(messages, model_override=model_override, json_mode=True)
    if not llm.get("ok"):
        return {}

    obj = extract_json_object(str(llm.get("reply") or "")) or {}
    return obj if isinstance(obj, dict) else {}


async def _api_request(
    method: str,
    path: str,
    *,
    auth_header: str,
    params: Optional[Dict[str, Any]] = None,
    json_body: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if not auth_header.strip():
        raise RuntimeError("缺少 Authorization，无法调用后端策略接口。")

    url = f"{_server_base_url()}{path}"
    headers = {"Authorization": auth_header, "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=8.0)) as client:
        response = await client.request(
            method=method.upper(),
            url=url,
            headers=headers,
            params=params,
            json=json_body,
        )
        try:
            data = response.json()
        except Exception:
            data = {"message": response.text}

    if response.status_code >= 400:
        if isinstance(data, dict):
            raise RuntimeError(str(data.get("message") or data.get("error") or f"HTTP {response.status_code}"))
        raise RuntimeError(f"HTTP {response.status_code}")

    return data if isinstance(data, dict) else {"data": data}


async def _list_strategies(
    auth_header: str,
    *,
    current_user_id: str,
    include_all: bool,
    q_name: str = "",
    q_username: str = "",
) -> List[Dict[str, Any]]:
    params: Dict[str, Any] = {}
    if q_name.strip():
        params["name"] = q_name.strip()
    if q_username.strip():
        params["username"] = q_username.strip()
    data = await _api_request("GET", "/api/strategies", auth_header=auth_header, params=params or None)
    items = data.get("items")
    if not isinstance(items, list):
        return []

    result: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if not include_all and current_user_id and str(item.get("userId") or "") != current_user_id:
            continue
        result.append(item)
    return result


def _brief(item: Dict[str, Any], idx: Optional[int] = None) -> str:
    prefix = f"{idx}. " if isinstance(idx, int) else "- "
    strategy_id = str(item.get("id") or "")
    name = str(item.get("name") or "未命名策略")
    symbols = str(item.get("symbols") or "-")
    enabled = "启用" if item.get("enabled") else "停用"
    owner = str(item.get("createdByUsername") or item.get("userId") or "").strip()
    owner_text = f" - 创建人: {owner}" if owner else ""
    return f"{prefix}{name}（{enabled}）- {symbols}{owner_text} - ID: {strategy_id}"


def _match_candidates(message: str, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    strategy_id = _extract_strategy_id(message)
    if strategy_id:
        return [item for item in items if str(item.get("id") or "") == strategy_id]

    symbol_set = set(extract_symbols_from_text(message))
    named = _extract_quoted_name(message).lower()
    lowered = (message or "").lower()

    matches: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue

        name = str(item.get("name") or "")
        symbols = [part.strip().lower() for part in str(item.get("symbols") or "").split(",") if part.strip()]
        stock_names = [part.strip().lower() for part in str(item.get("stockNames") or "").split(",") if part.strip()]
        owner = str(item.get("createdByUsername") or item.get("userId") or "").strip().lower()

        matched = False
        if named and named in name.lower():
            matched = True
        if name and name.lower() in lowered:
            matched = True
        if symbol_set and symbol_set.intersection(set(symbols)):
            matched = True
        if stock_names and any(stock_name in lowered for stock_name in stock_names):
            matched = True
        if owner and owner in lowered:
            matched = True

        if matched:
            matches.append(item)

    return matches


async def _save_pending(user_id: str, pending: Dict[str, Any], reply: str) -> AgentChatResponse:
    if user_id:
        # Merge state to avoid clobbering other keys (e.g., lastStrategyId).
        state = await memory.load_state(user_id)
        base = state if isinstance(state, dict) else {}
        merged = dict(base)
        merged["pending"] = pending
        await memory.save_state(user_id, merged)
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(
        reply=reply,
        toolCalls=[],
        meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "state": pending.get("stage")},
    )


async def _clear_pending(user_id: str) -> None:
    if user_id:
        # Only clear the pending flow; keep other state (e.g., lastStrategyId).
        state = await memory.load_state(user_id)
        if isinstance(state, dict) and "pending" in state:
            merged = dict(state)
            merged.pop("pending", None)
            await memory.save_state(user_id, merged)
        else:
            await memory.clear_state(user_id)


def _create_patch_from_rules(message: str) -> Dict[str, Any]:
    patch: Dict[str, Any] = {}
    lowered = (message or "").lower()
    strategy_id = _extract_strategy_id(message)

    symbols = extract_symbols_from_text(message)
    if symbols:
        patch["symbols"] = symbols
    else:
        # Try Chinese stock names when creating/updating strategy, so later we can resolve to sh/sz codes.
        if looks_like_create_strategy(message) or any(k in message for k in ["股票", "监控"]):
            names = extract_stock_names_from_text(message)
            if names:
                patch["symbols"] = names

    target_patch = extract_target_prices_from_text(message)
    if target_patch:
        patch = merge_args(patch, target_patch)

    percent = extract_percent_from_text(message)
    if percent is not None:
        patch["alertMode"] = "percent"
        patch["priceAlertPercent"] = percent

    interval = extract_minutes_from_text(message, "interval")
    if interval is not None:
        patch["intervalMinutes"] = interval

    cooldown = extract_minutes_from_text(message, "cooldown")
    if cooldown is not None:
        patch["cooldownMinutes"] = cooldown

    if any(keyword in message for keyword in ["停用", "禁用", "关闭"]):
        patch["enabled"] = False
    elif any(keyword in message for keyword in ["启用", "开启", "打开"]):
        patch["enabled"] = True

    if any(keyword in message for keyword in ["仅交易时段", "交易时段内", "仅在交易时间", "市场时间内"]):
        patch["marketTimeOnly"] = True
    elif any(keyword in message for keyword in ["全天", "非交易时段也监控", "盘后也监控", "关闭交易时段限制"]):
        patch["marketTimeOnly"] = False

    toggle_rules = [
        ("enableMacdGoldenCross", ["macd金叉", "开启macd金叉", "启用macd金叉"], ["关闭macd金叉", "禁用macd金叉"]),
        ("enableRsiOversold", ["rsi超卖", "开启rsi超卖", "启用rsi超卖"], ["关闭rsi超卖", "禁用rsi超卖"]),
        ("enableRsiOverbought", ["rsi超买", "开启rsi超买", "启用rsi超买"], ["关闭rsi超买", "禁用rsi超买"]),
        ("enableMovingAverages", ["均线", "均线策略", "开启均线", "启用均线"], ["关闭均线", "禁用均线"]),
        ("enablePatternSignal", ["形态信号", "形态识别", "开启形态", "启用形态"], ["关闭形态", "禁用形态"]),
    ]
    for field, enable_terms, disable_terms in toggle_rules:
        if any(term in lowered for term in enable_terms):
            patch[field] = True
        elif any(term in lowered for term in disable_terms):
            patch[field] = False

    name = _extract_quoted_name(message)
    if name:
        patch["name"] = name

    user_id = _extract_user_id_hint(message)
    if user_id:
        patch["userId"] = user_id

    subscription_ids = _extract_subscription_ids_hint(message, strategy_id=strategy_id)
    if subscription_ids is not None:
        patch["subscriptionIds"] = subscription_ids

    return patch


async def _extract_create_draft(
    message: str,
    req_model: Optional[str],
    cfg_ok: bool,
    base: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    draft = dict(base or {})
    draft = merge_args(draft, _create_patch_from_rules(message))

    if cfg_ok:
        llm_patch = await llm_extract_create_strategy_args(message, draft, req_model)
        if isinstance(llm_patch, dict):
            draft = merge_args(draft, llm_patch)

    if not isinstance(draft.get("name"), str) or not str(draft.get("name") or "").strip():
        symbols = draft.get("symbols")
        if isinstance(symbols, list) and symbols:
            suffix = " 等" if len(symbols) > 3 else ""
            draft["name"] = f"监控 {','.join(str(x) for x in symbols[:3])}{suffix}"
        else:
            draft["name"] = "新策略"

    return draft


def _validate_create_draft(message: str, draft: Dict[str, Any]) -> List[str]:
    default_ok = any(keyword in message for keyword in ["默认", "都行", "随便", "按默认"])
    missing: List[str] = []

    symbols = draft.get("symbols")
    has_symbols = False
    if isinstance(symbols, list):
        has_symbols = len([item for item in symbols if isinstance(item, str) and item.strip()]) > 0
    elif isinstance(symbols, str):
        has_symbols = bool(symbols.strip())
    if not has_symbols:
        missing.append("symbols")

    has_percent = isinstance(draft.get("priceAlertPercent"), (int, float))
    has_target = isinstance(draft.get("targetPriceUp"), (int, float)) or isinstance(draft.get("targetPriceDown"), (int, float))
    has_alert_mode = str(draft.get("alertMode") or "").strip() in {"percent", "target"}
    condition_specified = has_percent or has_target or any(
        keyword in message for keyword in ["%", "目标价", "涨到", "跌到", "跌破", "突破"]
    )

    if not has_alert_mode:
        if condition_specified:
            draft["alertMode"] = "target" if has_target else "percent"
        elif default_ok:
            draft["alertMode"] = "percent"
            draft["priceAlertPercent"] = 2
        else:
            missing.append("conditionType")

    if str(draft.get("alertMode") or "percent") == "percent":
        if not isinstance(draft.get("priceAlertPercent"), (int, float)):
            if default_ok:
                draft["priceAlertPercent"] = 2
            else:
                missing.append("priceAlertPercent")
    else:
        has_up = isinstance(draft.get("targetPriceUp"), (int, float))
        has_down = isinstance(draft.get("targetPriceDown"), (int, float))
        if not has_up and not has_down:
            missing.append("targetPrice")

    return missing


def _create_request_body(draft: Dict[str, Any]) -> Dict[str, Any]:
    symbols = draft.get("symbols")
    symbols_value = (
        ",".join(str(item).strip() for item in symbols if str(item).strip())
        if isinstance(symbols, list)
        else str(symbols or "").strip()
    )

    interval_minutes = int(draft.get("intervalMinutes") or 1)
    body = {
        "name": str(draft.get("name") or "新策略"),
        "enabled": bool(draft.get("enabled", True)),
        "symbols": symbols_value,
        "marketTimeOnly": bool(draft.get("marketTimeOnly", True)),
        "subscriptionIds": draft.get("subscriptionIds") or [],
        "alertMode": str(draft.get("alertMode") or "percent"),
        "targetPriceUp": draft.get("targetPriceUp"),
        "targetPriceDown": draft.get("targetPriceDown"),
        "intervalMs": interval_minutes * 60_000,
        "cooldownMinutes": int(draft.get("cooldownMinutes") or 60),
        "priceAlertPercent": float(draft.get("priceAlertPercent") or 2),
        "enableMacdGoldenCross": bool(draft.get("enableMacdGoldenCross", True)),
        "enableRsiOversold": bool(draft.get("enableRsiOversold", True)),
        "enableRsiOverbought": bool(draft.get("enableRsiOverbought", True)),
        "enableMovingAverages": bool(draft.get("enableMovingAverages", False)),
        "enablePatternSignal": bool(draft.get("enablePatternSignal", False)),
    }

    if body["alertMode"] != "target":
        body.pop("targetPriceUp", None)
        body.pop("targetPriceDown", None)
    else:
        if not isinstance(body.get("targetPriceUp"), (int, float)):
            body.pop("targetPriceUp", None)
        if not isinstance(body.get("targetPriceDown"), (int, float)):
            body.pop("targetPriceDown", None)

    return body


def _update_patch_is_empty(patch: Dict[str, Any]) -> bool:
    allowed = {
        "userId",
        "name",
        "symbols",
        "enabled",
        "marketTimeOnly",
        "subscriptionIds",
        "alertMode",
        "priceAlertPercent",
        "targetPriceUp",
        "targetPriceDown",
        "intervalMinutes",
        "cooldownMinutes",
        "enableMacdGoldenCross",
        "enableRsiOversold",
        "enableRsiOverbought",
        "enableMovingAverages",
        "enablePatternSignal",
    }
    return not any(key in patch for key in allowed)


def _build_update_patch(message: str, llm_patch: Dict[str, Any]) -> Dict[str, Any]:
    patch = _create_patch_from_rules(message)
    if isinstance(llm_patch, dict):
        patch = merge_args(patch, llm_patch)
    patch.pop("action", None)
    patch.pop("strategyId", None)
    return patch


async def _fetch_strategy_detail(auth_header: str, strategy_id: str) -> Dict[str, Any]:
    data = await _api_request("GET", f"/api/strategies/{strategy_id}", auth_header=auth_header)
    item = data.get("item")
    return item if isinstance(item, dict) else {}


def _pick_candidate_from_reply(message: str, candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    strategy_id = _extract_strategy_id(message)
    if strategy_id:
        for item in candidates:
            if str(item.get("id") or "") == strategy_id:
                return item

    index_match = re.search(r"(?<!\d)(\d{1,2})(?!\d)", message or "")
    if index_match:
        index = int(index_match.group(1))
        if 1 <= index <= len(candidates):
            return candidates[index - 1]

    named = _extract_quoted_name(message).lower()
    lowered = (message or "").lower()
    for item in candidates:
        name = str(item.get("name") or "")
        if named and named in name.lower():
            return item
        if name and name.lower() in lowered:
            return item

    return None


async def _resolve_target_or_ask(
    *,
    user_id: str,
    user_message: str,
    action: str,
    auth_header: str,
    current_user_id: str,
    include_all: bool,
    last_strategy_id: str = "",
    owner_hint: str = "",
    patch: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[AgentChatResponse]]:
    items = await _list_strategies(
        auth_header,
        current_user_id=current_user_id,
        include_all=include_all,
        q_username=owner_hint if include_all else "",
    )
    if not items:
        reply = "你当前还没有可操作的策略。要不要我先帮你创建一个？"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return None, AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME})

    # If user refers to "this/last" strategy, try to use the last created/operated one.
    lowered_msg = (user_message or "").strip().lower()
    if last_strategy_id and any(k in lowered_msg for k in ["这个策略", "刚才", "刚刚", "上一个", "刚创建", "this strategy", "last strategy"]):
        for item in items:
            if str(item.get("id") or "") == str(last_strategy_id):
                return item, None

    strategy_id = _extract_strategy_id(user_message)
    if strategy_id:
        for item in items:
            if str(item.get("id") or "") == strategy_id:
                return item, None
        reply = f"没有找到 ID 为 `{strategy_id}` 的策略。你可以先说“列出策略”。"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return None, AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME})

    # If only one strategy is visible, treat "this strategy" as that one.
    if len(items) == 1:
        return items[0], None

    candidates = _match_candidates(user_message, items)
    if len(candidates) == 1:
        return candidates[0], None

    preview_source = candidates[:10] if candidates else items[:10]
    preview = "\n".join(_brief(item, idx) for idx, item in enumerate(preview_source, start=1))
    if candidates:
        reply = f"我找到了多条可能的策略，请回复序号或完整策略 ID：\n{preview}"
    else:
        reply = f"我还没法唯一定位你要操作的策略，请回复序号或完整策略 ID：\n{preview}"

    pending = {
        "type": STRATEGY_SKILL_NAME,
        "stage": "select_target",
        "action": action,
        "patch": patch or {},
        "candidates": preview_source,
    }
    return None, await _save_pending(user_id, pending, reply)


async def _do_list(
    user_id: str,
    auth_header: str,
    current_user_id: str,
    include_all: bool,
    name: str = "",
    owner_hint: str = "",
) -> AgentChatResponse:
    items = await _list_strategies(
        auth_header,
        current_user_id=current_user_id,
        include_all=include_all,
        q_name=name,
        q_username=owner_hint if include_all else "",
    )

    if not items:
        reply = "你当前没有策略。"
    else:
        lines = [f"共 {len(items)} 条策略："]
        for index, item in enumerate(items[:20], start=1):
            lines.append(_brief(item, index))
        reply = "\n".join(lines)

    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "action": "list"})


async def _do_get(user_id: str, strategy_id: str, auth_header: str) -> AgentChatResponse:
    item = await _fetch_strategy_detail(auth_header, strategy_id)
    owner = str(item.get("createdByUsername") or item.get("userId") or "")
    reply = (
        "策略详情：\n"
        f"ID: {item.get('id')}\n"
        f"名称: {item.get('name')}\n"
        f"创建人: {owner}\n"
        f"股票: {item.get('symbols')}\n"
        f"状态: {'启用' if item.get('enabled') else '停用'}\n"
        f"提醒模式: {item.get('alertMode')}\n"
        f"涨跌幅阈值: {item.get('priceAlertPercent')}%\n"
        f"上涨目标价: {item.get('targetPriceUp')}\n"
        f"下跌目标价: {item.get('targetPriceDown')}\n"
        f"扫描间隔: {int((item.get('intervalMs') or 60000) / 60000)} 分钟\n"
        f"冷却时间: {item.get('cooldownMinutes')} 分钟"
    )
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "action": "get"})


async def _do_delete(user_id: str, strategy_id: str, auth_header: str) -> AgentChatResponse:
    item = await _fetch_strategy_detail(auth_header, strategy_id)
    await _api_request("DELETE", f"/api/strategies/{strategy_id}", auth_header=auth_header)
    reply = f"已删除策略：{item.get('name') or strategy_id}"
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "action": "delete"})


async def _do_update(user_id: str, strategy_id: str, patch: Dict[str, Any], auth_header: str) -> AgentChatResponse:
    current = await _fetch_strategy_detail(auth_header, strategy_id)
    if not current:
        raise RuntimeError("策略不存在。")

    symbols = patch.get("symbols", current.get("symbols"))
    symbols_value = (
        ",".join(str(item).strip() for item in symbols if str(item).strip())
        if isinstance(symbols, list)
        else str(symbols or "").strip()
    )

    interval_ms = current.get("intervalMs")
    if patch.get("intervalMinutes") is not None:
        interval_ms = int(patch.get("intervalMinutes") or 1) * 60_000

    body = {
        "userId": patch.get("userId", current.get("userId")),
        "name": patch.get("name", current.get("name")),
        "enabled": patch.get("enabled", current.get("enabled", True)),
        "symbols": symbols_value,
        "marketTimeOnly": patch.get("marketTimeOnly", current.get("marketTimeOnly", True)),
        "subscriptionIds": patch.get("subscriptionIds", current.get("subscriptionIds") or []),
        "alertMode": patch.get("alertMode", current.get("alertMode") or "percent"),
        "targetPriceUp": patch.get("targetPriceUp", current.get("targetPriceUp")),
        "targetPriceDown": patch.get("targetPriceDown", current.get("targetPriceDown")),
        "intervalMs": interval_ms,
        "cooldownMinutes": patch.get("cooldownMinutes", current.get("cooldownMinutes") or 60),
        "priceAlertPercent": patch.get("priceAlertPercent", current.get("priceAlertPercent") or 2),
        "enableMacdGoldenCross": patch.get("enableMacdGoldenCross", current.get("enableMacdGoldenCross", True)),
        "enableRsiOversold": patch.get("enableRsiOversold", current.get("enableRsiOversold", True)),
        "enableRsiOverbought": patch.get("enableRsiOverbought", current.get("enableRsiOverbought", True)),
        "enableMovingAverages": patch.get("enableMovingAverages", current.get("enableMovingAverages", False)),
        "enablePatternSignal": patch.get("enablePatternSignal", current.get("enablePatternSignal", False)),
    }

    resolved_symbols, unresolved = await _resolve_symbols_value(auth_header, str(body.get("symbols") or ""))
    if unresolved:
        raise RuntimeError(
            f"无法解析股票代码/名称：{', '.join(unresolved)}。请提供如 sh600519 / 600519，或更准确的中文名称。"
        )
    if resolved_symbols:
        body["symbols"] = resolved_symbols

    if body["alertMode"] != "target":
        body.pop("targetPriceUp", None)
        body.pop("targetPriceDown", None)
    else:
        if not isinstance(body.get("targetPriceUp"), (int, float)):
            body.pop("targetPriceUp", None)
        if not isinstance(body.get("targetPriceDown"), (int, float)):
            body.pop("targetPriceDown", None)

    await _api_request("PUT", f"/api/strategies/{strategy_id}", auth_header=auth_header, json_body=body)

    reply = (
        "已更新策略：\n"
        f"ID: {strategy_id}\n"
        f"用户ID: {body['userId']}\n"
        f"名称: {body['name']}\n"
        f"股票: {body['symbols']}\n"
        f"状态: {'启用' if body['enabled'] else '停用'}"
    )
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "action": "update"})


async def _handle_pending(
    *,
    user_id: str,
    message: str,
    auth_header: str,
    current_user_id: str,
    req_model: Optional[str],
    cfg_ok: bool,
    is_admin: bool,
    pending: Dict[str, Any],
) -> AgentChatResponse:
    if any(keyword in message for keyword in ["取消", "算了", "退出", "不用了"]):
        await _clear_pending(user_id)
        reply = "好的，已取消这次策略操作。"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "state": "cancelled"})

    stage = str(pending.get("stage") or "")

    if stage == "create_missing":
        draft = dict(pending.get("draft") or {})
        draft = await _extract_create_draft(message, req_model, cfg_ok, draft)
        missing = _validate_create_draft(message, draft)
        if missing:
            question = build_create_strategy_questions(missing)
            reply = "创建策略还差一点关键信息：\n" + question
            return await _save_pending(user_id, {"type": STRATEGY_SKILL_NAME, "stage": "create_missing", "draft": draft}, reply)

        body = _create_request_body(draft)
        resolved_symbols, unresolved = await _resolve_symbols_value(auth_header, str(body.get("symbols") or ""))
        if unresolved:
            reply = f"无法解析股票代码/名称：{', '.join(unresolved)}。请提供如 sh600519 / 600519，或更准确的中文名称。"
            return await _save_pending(user_id, {"type": STRATEGY_SKILL_NAME, "stage": "create_missing", "draft": draft}, reply)
        if resolved_symbols:
            body["symbols"] = resolved_symbols
        data = await _api_request("POST", "/api/strategies", auth_header=auth_header, json_body=body)
        await _save_last_strategy_id(user_id, str(data.get("id") or ""))
        await _clear_pending(user_id)
        reply = f"已创建策略：{body['name']}\nID: {data.get('id')}\n股票: {body['symbols']}"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "action": "create"})

    if stage == "update_patch":
        strategy_id = str(pending.get("strategyId") or "")
        base_patch = dict(pending.get("patch") or {})
        llm_patch = await _llm_extract_strategy_intent(message, base_patch, req_model) if cfg_ok else {}
        patch = _build_update_patch(message, llm_patch)
        requested_user_id = _extract_user_id_hint(message)
        if not is_admin and requested_user_id:
            reply = "只有管理员可以修改策略归属用户。你可以继续修改其他字段，比如停用、阈值、监控股票等。"
            if user_id:
                await memory.append(user_id, {"role": "assistant", "content": reply})
            return AgentChatResponse(
                reply=reply,
                toolCalls=[],
                meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "state": "forbidden"},
            )
        if not is_admin:
            patch.pop("userId", None)
        merged_patch = merge_args(base_patch, patch)
        if _update_patch_is_empty(merged_patch):
            reply = "你想修改这条策略的哪些内容？例如：停用、阈值改成 3%、监控改成 sh600519。"
            return await _save_pending(
                user_id,
                {"type": STRATEGY_SKILL_NAME, "stage": "update_patch", "strategyId": strategy_id, "patch": merged_patch},
                reply,
            )
        await _clear_pending(user_id)
        return await _do_update(user_id=user_id, strategy_id=strategy_id, patch=merged_patch, auth_header=auth_header)

    if stage == "select_target":
        candidates = pending.get("candidates") if isinstance(pending.get("candidates"), list) else []
        selected = _pick_candidate_from_reply(message, [item for item in candidates if isinstance(item, dict)])
        if not selected:
            reply = "我还没识别出你选的是哪一条，请回复序号或完整策略 ID。"
            return await _save_pending(user_id, pending, reply)

        await _clear_pending(user_id)
        action = str(pending.get("action") or "")
        patch = pending.get("patch") if isinstance(pending.get("patch"), dict) else {}
        strategy_id = str(selected.get("id") or "")

        if action == "get":
            return await _do_get(user_id=user_id, strategy_id=strategy_id, auth_header=auth_header)
        if action == "delete":
            return await _do_delete(user_id=user_id, strategy_id=strategy_id, auth_header=auth_header)
        if action == "update":
            if _update_patch_is_empty(patch):
                reply = "你想修改这条策略的哪些内容？例如：停用、阈值改成 3%、监控改成 sh600519。"
                return await _save_pending(
                    user_id,
                    {"type": STRATEGY_SKILL_NAME, "stage": "update_patch", "strategyId": strategy_id, "patch": patch},
                    reply,
                )
            return await _do_update(user_id=user_id, strategy_id=strategy_id, patch=patch, auth_header=auth_header)

    await _clear_pending(user_id)
    reply = "上一次策略操作状态已失效，请重新描述你的需求。"
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "state": "expired"})


async def handle_strategy_management_skill(
    *,
    user_id: str,
    current_user: Dict[str, Any],
    auth: Optional[Dict[str, Any]],
    message: str,
    req_model: Optional[str],
    cfg_ok: bool,
) -> AgentChatResponse:
    auth_header = str((auth or {}).get("authorization") or "").strip()
    current_user_id = str((current_user or {}).get("userId") or "")
    admin_mode = _is_admin(current_user)
    parsed_action = _extract_action(message)

    if not auth_header:
        reply = "当前缺少登录授权，无法直接调用策略接口。请重新登录后再试。"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "state": "unauthorized"})

    state = await memory.load_state(user_id) if user_id else {}
    last_strategy_id = str(state.get("lastStrategyId") or "") if isinstance(state, dict) else ""
    pending = state.get("pending") if isinstance(state, dict) else None
    # Allow explicit fresh commands to interrupt stale pending flow.
    if isinstance(pending, dict) and pending.get("type") == STRATEGY_SKILL_NAME:
        stage = str(pending.get("stage") or "")
        if parsed_action in {"list", "create"}:
            await _clear_pending(user_id)
            pending = None
        elif stage == "select_target":
            pending_action = str(pending.get("action") or "")
            if parsed_action and parsed_action != pending_action:
                await _clear_pending(user_id)
                pending = None

    if isinstance(pending, dict) and pending.get("type") == STRATEGY_SKILL_NAME:
        try:
            return await _handle_pending(
                user_id=user_id,
                message=message,
                auth_header=auth_header,
                current_user_id=current_user_id,
                req_model=req_model,
                cfg_ok=cfg_ok,
                is_admin=admin_mode,
                pending=pending,
            )
        except Exception as exc:
            await _clear_pending(user_id)
            reply = f"处理上一轮策略操作时失败：{str(exc)}"
            if user_id:
                await memory.append(user_id, {"role": "assistant", "content": reply})
            return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "state": "error"})

    draft: Dict[str, Any] = {
        "action": parsed_action,
        "strategyId": _extract_strategy_id(message) or None,
    }
    named = _extract_quoted_name(message)
    if named:
        draft["name"] = named

    if cfg_ok:
        llm_patch = await _llm_extract_strategy_intent(message, draft, req_model)
        if isinstance(llm_patch, dict):
            draft = merge_args(draft, llm_patch)

    action = str(draft.get("action") or parsed_action or "").strip()
    owner_hint = _extract_owner_hint(message) if admin_mode else ""

    try:
        if action == "list":
            return await _do_list(
                user_id,
                auth_header,
                current_user_id,
                admin_mode,
                name=str(draft.get("name") or ""),
                owner_hint=owner_hint,
            )

        if action == "get":
            target, response = await _resolve_target_or_ask(
                user_id=user_id,
                user_message=message,
                action="get",
                auth_header=auth_header,
                current_user_id=current_user_id,
                include_all=admin_mode,
                last_strategy_id=last_strategy_id,
                owner_hint=owner_hint,
            )
            if response:
                return response
            return await _do_get(user_id, str((target or {}).get("id") or ""), auth_header)

        if action == "delete":
            target, response = await _resolve_target_or_ask(
                user_id=user_id,
                user_message=message,
                action="delete",
                auth_header=auth_header,
                current_user_id=current_user_id,
                include_all=admin_mode,
                last_strategy_id=last_strategy_id,
                owner_hint=owner_hint,
            )
            if response:
                return response
            return await _do_delete(user_id, str((target or {}).get("id") or ""), auth_header)

        if action == "update":
            patch = _build_update_patch(message, draft)
            requested_user_id = _extract_user_id_hint(message)
            if not admin_mode and requested_user_id:
                reply = "只有管理员可以修改策略归属用户。你可以继续修改其他字段，比如停用、阈值、监控股票等。"
                if user_id:
                    await memory.append(user_id, {"role": "assistant", "content": reply})
                return AgentChatResponse(
                    reply=reply,
                    toolCalls=[],
                    meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "state": "forbidden"},
                )
            if not admin_mode:
                patch.pop("userId", None)
            target, response = await _resolve_target_or_ask(
                user_id=user_id,
                user_message=message,
                action="update",
                auth_header=auth_header,
                current_user_id=current_user_id,
                include_all=admin_mode,
                last_strategy_id=last_strategy_id,
                owner_hint=owner_hint,
                patch=patch,
            )
            if response:
                return response

            strategy_id = str((target or {}).get("id") or "")
            if _update_patch_is_empty(patch):
                reply = "你想修改这条策略的哪些内容？例如：停用、阈值改成 3%、监控改成 sh600519。"
                return await _save_pending(
                    user_id,
                    {"type": STRATEGY_SKILL_NAME, "stage": "update_patch", "strategyId": strategy_id, "patch": patch},
                    reply,
                )
            return await _do_update(user_id=user_id, strategy_id=strategy_id, patch=patch, auth_header=auth_header)

        if action == "create":
            create_draft = await _extract_create_draft(message, req_model, cfg_ok, draft)
            missing = _validate_create_draft(message, create_draft)
            if missing:
                question = build_create_strategy_questions(missing)
                reply = "创建策略还差一点关键信息：\n" + question
                return await _save_pending(
                    user_id,
                    {"type": STRATEGY_SKILL_NAME, "stage": "create_missing", "draft": create_draft},
                    reply,
                )

            body = _create_request_body(create_draft)
            resolved_symbols, unresolved = await _resolve_symbols_value(auth_header, str(body.get("symbols") or ""))
            if unresolved:
                reply = f"无法解析股票代码/名称：{', '.join(unresolved)}。请提供如 sh600519 / 600519，或更准确的中文名称。"
                return await _save_pending(
                    user_id,
                    {"type": STRATEGY_SKILL_NAME, "stage": "create_missing", "draft": create_draft},
                    reply,
                )
            if resolved_symbols:
                body["symbols"] = resolved_symbols
            data = await _api_request("POST", "/api/strategies", auth_header=auth_header, json_body=body)
            await _save_last_strategy_id(user_id, str(data.get("id") or ""))
            reply = f"已创建策略：{body['name']}\nID: {data.get('id')}\n股票: {body['symbols']}"
            if user_id:
                await memory.append(user_id, {"role": "assistant", "content": reply})
            return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "action": "create"})

        reply = "你是想列出策略、查看详情、新建、修改，还是删除策略？可以直接告诉我。"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "state": "clarify"})
    except Exception as exc:
        reply = f"策略操作失败：{str(exc)}"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": STRATEGY_SKILL_NAME, "state": "error"})
