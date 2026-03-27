from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

import httpx

from core.config import _server_base_url
from core.models import AgentChatResponse
from infrastructure.memory import memory
from domain.strategy import looks_like_create_strategy
from llm.llm import call_openai_compatible, extract_json_object


SUBSCRIPTION_SKILL_NAME = "subscription_management"

UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)

LIST_KEYWORDS = ["订阅列表", "列出订阅", "查看订阅", "我的订阅", "所有订阅"]
GET_KEYWORDS = ["订阅详情", "查看详情", "查看订阅详情", "订阅信息", "订阅配置"]
CREATE_KEYWORDS = ["新增订阅", "创建订阅", "添加订阅", "新建订阅", "绑定推送", "新增推送"]
UPDATE_KEYWORDS = ["修改订阅", "更新订阅", "编辑订阅", "调整订阅", "启用订阅", "停用订阅", "禁用订阅", "归属", "转给", "转移给"]
DELETE_KEYWORDS = ["删除订阅", "移除订阅", "取消订阅", "删除推送", "移除推送"]
# Keep this conservative: "提醒/推送" often appears in strategy creation.
HINT_KEYWORDS = ["订阅", "webhook", "钉钉", "企微", "企业微信", "机器人", "应用"]


def _has_subscription_anchor(text: str) -> bool:
    """Return True only when the user message clearly talks about subscription config."""
    t = (text or "").strip()
    if not t:
        return False
    lowered = t.lower()
    if any(k in t for k in ["订阅", "webhook", "钉钉", "企微", "企业微信", "机器人", "应用"]):
        return True
    # URL + "绑定/推送" is likely subscription setup.
    if re.search(r"https?://[^\s]+", t) and any(k in t for k in ["绑定", "推送", "通知", "webhook"]):
        return True
    if any(k in lowered for k in ["dingtalk", "wecom", "wecom_robot", "wecom_app"]):
        return True
    return False


def _is_admin(current_user: Dict[str, Any]) -> bool:
    return str((current_user or {}).get("role") or "").strip().lower() == "admin"


def looks_like_subscription_management(message: str, state: Optional[Dict[str, Any]] = None) -> bool:
    pending = state.get("pending") if isinstance(state, dict) else None
    if isinstance(pending, dict) and pending.get("type") == SUBSCRIPTION_SKILL_NAME:
        return True

    text = (message or "").strip()
    if not text:
        return False

    # If it looks like creating a monitoring strategy, do not steal the intent.
    if looks_like_create_strategy(text):
        return False

    # Avoid triggering by generic "提醒/推送" when there's no subscription anchor.
    if not _has_subscription_anchor(text):
        return False

    keywords = LIST_KEYWORDS + GET_KEYWORDS + CREATE_KEYWORDS + UPDATE_KEYWORDS + DELETE_KEYWORDS + HINT_KEYWORDS
    return any(keyword in text for keyword in keywords)


def subscription_skill_hint() -> str:
    return (
        "这是订阅管理 skill，负责根据用户自然语言处理订阅的增删改查。"
        "skill 内部自动选择 /api/subscriptions 的 GET、POST、PUT、DELETE 接口，"
        "优先根据订阅 ID、名称、创建人定位目标，定位不唯一时再追问。"
    )


def _extract_subscription_id(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""
    m = UUID_RE.search(raw)
    return m.group(0) if m else ""


def _extract_quoted_name(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""
    patterns = [r'"([^"]{2,40})"', r"'([^']{2,40})'", r"“([^”]{2,40})”", r"(?:名为|叫做|名称是)\s*([^\s，。；;]{2,40})"]
    for pattern in patterns:
        m = re.search(pattern, raw)
        if m:
            return str(m.group(1) or "").strip()
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
        r"(?:归属用户|归属给)\s*(?:用户id|用户ID|用户)?\s*[:：=]?\s*([0-9a-fA-F\-]{36})",
    ]
    for pattern in patterns:
        m = re.search(pattern, raw, flags=re.IGNORECASE)
        if not m:
            continue
        uid = str(m.group(1) or "").strip()
        if UUID_RE.fullmatch(uid):
            return uid
    return ""


def _extract_type_hint(text: str) -> Optional[str]:
    t = (text or "").lower()
    if "钉钉" in t or "dingtalk" in t:
        return "dingtalk"
    if "企微应用" in t or "企业微信应用" in t or "wecom_app" in t:
        return "wecom_app"
    if "企微机器人" in t or "企业微信机器人" in t or "wecom_robot" in t:
        return "wecom_robot"
    if "企微" in t or "企业微信" in t:
        return "wecom_robot"
    return None


def _extract_webhook(text: str) -> Optional[str]:
    m = re.search(r"https?://[^\s]+", text or "", flags=re.IGNORECASE)
    if not m:
        return None
    return m.group(0).rstrip("，。；;！!？?")


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
    if any(keyword in text for keyword in CREATE_KEYWORDS):
        return "create"
    return None


async def _llm_extract_subscription_intent(
    message: str,
    current: Dict[str, Any],
    model_override: Optional[str],
) -> Dict[str, Any]:
    prompt = {
        "instruction": "从用户自然语言中提取订阅管理意图和参数，只输出 JSON。",
        "output": {
            "action": "list|get|create|update|delete|null",
            "subscriptionId": "string|null",
            "userId": "string|null",
            "name": "string|null",
            "type": "dingtalk|wecom_robot|wecom_app|null",
            "enabled": "boolean|null",
            "webhookUrl": "string|null",
            "keyword": "string|null",
            "wecomApp": {
                "corpId": "string|null",
                "corpSecret": "string|null",
                "agentId": "number|null",
                "toUser": "string|null",
                "toParty": "string|null",
                "toTag": "string|null",
            },
        },
        "notes": [
            "列出订阅时 action=list。",
            "查看某条订阅详情时 action=get。",
            "创建订阅时 action=create。",
            "启用、停用、编辑、修改订阅时 action=update。",
            "删除、移除、取消订阅时 action=delete。",
            "管理员修改归属时可输出 userId。",
            "未知字段填 null，不要编造。",
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
        raise RuntimeError("缺少 Authorization，无法调用后端订阅接口。")
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


async def _list_subscriptions(
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
    data = await _api_request("GET", "/api/subscriptions", auth_header=auth_header, params=params or None)
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
    subscription_id = str(item.get("id") or "")
    name = str(item.get("name") or "未命名订阅")
    sub_type = str(item.get("type") or "-")
    enabled = "启用" if item.get("enabled") else "停用"
    owner = str(item.get("createdByUsername") or item.get("userId") or "").strip()
    owner_text = f" - 创建人: {owner}" if owner else ""
    return f"{prefix}{name}（{enabled}）- 类型: {sub_type}{owner_text} - ID: {subscription_id}"


def _match_candidates(message: str, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    subscription_id = _extract_subscription_id(message)
    if subscription_id:
        return [item for item in items if str(item.get("id") or "") == subscription_id]

    named = _extract_quoted_name(message).lower()
    lowered = (message or "").lower()
    type_hint = _extract_type_hint(message)

    # If user provided an explicit name, prioritize name match and don't broaden with type/owner
    # (otherwise "钉钉" would match all dingtalk subscriptions).
    if named:
        by_name = [
            item
            for item in items
            if isinstance(item, dict) and named in str(item.get("name") or "").lower()
        ]
        if by_name:
            return by_name

    matches: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        owner = str(item.get("createdByUsername") or item.get("userId") or "").strip().lower()
        item_type = str(item.get("type") or "").strip().lower()

        matched = False
        if named and named in name.lower():
            matched = True
        if name and name.lower() in lowered:
            matched = True
        if owner and owner in lowered:
            matched = True
        if type_hint and type_hint == item_type:
            matched = True

        if matched:
            matches.append(item)
    return matches


async def _save_pending(user_id: str, pending: Dict[str, Any], reply: str) -> AgentChatResponse:
    if user_id:
        await memory.save_state(user_id, {"pending": pending})
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(
        reply=reply,
        toolCalls=[],
        meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "state": pending.get("stage")},
    )


async def _clear_pending(user_id: str) -> None:
    if user_id:
        await memory.clear_state(user_id)


def _merge_non_empty(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base or {})
    for k, v in (patch or {}).items():
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        out[k] = v
    return out


def _create_patch_from_rules(message: str) -> Dict[str, Any]:
    patch: Dict[str, Any] = {}
    lowered = (message or "").lower()

    name = _extract_quoted_name(message)
    if name:
        patch["name"] = name

    type_hint = _extract_type_hint(message)
    if type_hint:
        patch["type"] = type_hint

    webhook = _extract_webhook(message)
    if webhook:
        patch["webhookUrl"] = webhook

    user_id = _extract_user_id_hint(message)
    if user_id:
        patch["userId"] = user_id

    if any(keyword in message for keyword in ["停用", "禁用", "关闭"]):
        patch["enabled"] = False
    elif any(keyword in message for keyword in ["启用", "开启", "打开"]):
        patch["enabled"] = True

    m_keyword = re.search(r"(?:关键词|keyword)\s*[:：=]?\s*([^\n，。；;]+)", message or "", flags=re.IGNORECASE)
    if m_keyword:
        kw = str(m_keyword.group(1) or "").strip()
        if kw:
            patch["keyword"] = kw

    if "清空关键词" in lowered or "删除关键词" in lowered:
        patch["keyword"] = ""

    corp_id = re.search(r"(?:corp[_\s-]?id|企业id)\s*[:：=]?\s*([A-Za-z0-9_\-]+)", message or "", flags=re.IGNORECASE)
    corp_secret = re.search(r"(?:corp[_\s-]?secret|secret)\s*[:：=]?\s*([A-Za-z0-9_\-]+)", message or "", flags=re.IGNORECASE)
    agent_id = re.search(r"(?:agent[_\s-]?id)\s*[:：=]?\s*(\d+)", message or "", flags=re.IGNORECASE)
    to_user = re.search(r"(?:to[_\s-]?user)\s*[:：=]?\s*([^\s，。；;]+)", message or "", flags=re.IGNORECASE)
    to_party = re.search(r"(?:to[_\s-]?party)\s*[:：=]?\s*([^\s，。；;]+)", message or "", flags=re.IGNORECASE)
    to_tag = re.search(r"(?:to[_\s-]?tag)\s*[:：=]?\s*([^\s，。；;]+)", message or "", flags=re.IGNORECASE)
    wecom_patch: Dict[str, Any] = {}
    if corp_id:
        wecom_patch["corpId"] = str(corp_id.group(1))
    if corp_secret:
        wecom_patch["corpSecret"] = str(corp_secret.group(1))
    if agent_id:
        wecom_patch["agentId"] = int(agent_id.group(1))
    if to_user:
        wecom_patch["toUser"] = str(to_user.group(1))
    if to_party:
        wecom_patch["toParty"] = str(to_party.group(1))
    if to_tag:
        wecom_patch["toTag"] = str(to_tag.group(1))
    if wecom_patch:
        patch["wecomApp"] = wecom_patch

    return patch


def _validate_create_draft(draft: Dict[str, Any]) -> List[str]:
    missing: List[str] = []
    if not str(draft.get("name") or "").strip():
        missing.append("name")
    sub_type = str(draft.get("type") or "").strip()
    if sub_type not in {"dingtalk", "wecom_robot", "wecom_app"}:
        missing.append("type")
    if sub_type in {"dingtalk", "wecom_robot"} and not str(draft.get("webhookUrl") or "").strip():
        missing.append("webhookUrl")
    if sub_type == "wecom_app":
        app = draft.get("wecomApp") if isinstance(draft.get("wecomApp"), dict) else {}
        if not str(app.get("corpId") or "").strip():
            missing.append("wecomApp.corpId")
        if not str(app.get("corpSecret") or "").strip():
            missing.append("wecomApp.corpSecret")
        if not isinstance(app.get("agentId"), (int, float)):
            missing.append("wecomApp.agentId")
    return missing


def _build_create_questions(missing: List[str]) -> str:
    questions: List[str] = []
    if "name" in missing:
        questions.append("请告诉我订阅名称，例如：交易提醒-钉钉。")
    if "type" in missing:
        questions.append("订阅类型是钉钉(dingtalk)、企微机器人(wecom_robot) 还是企微应用(wecom_app)？")
    if "webhookUrl" in missing:
        questions.append("请提供 webhook 地址（https://...）。")
    if "wecomApp.corpId" in missing:
        questions.append("请提供 wecomApp.corpId。")
    if "wecomApp.corpSecret" in missing:
        questions.append("请提供 wecomApp.corpSecret。")
    if "wecomApp.agentId" in missing:
        questions.append("请提供 wecomApp.agentId（正整数）。")
    return "\n".join(questions[:2])


def _create_request_body(draft: Dict[str, Any]) -> Dict[str, Any]:
    # Server uses zod optional() for webhookUrl/keyword/wecomApp: do not send null.
    body: Dict[str, Any] = {
        "name": str(draft.get("name") or "").strip(),
        "type": str(draft.get("type") or "").strip(),
        "enabled": bool(draft.get("enabled", True)),
    }

    webhook = str(draft.get("webhookUrl") or "").strip()
    if webhook:
        body["webhookUrl"] = webhook

    # Only include keyword if user explicitly provided it (empty string is allowed for clearing).
    if "keyword" in draft:
        kw_raw = draft.get("keyword")
        kw = kw_raw if isinstance(kw_raw, str) else str(kw_raw or "")
        body["keyword"] = kw.strip()

    if body["type"] == "wecom_app":
        wecom_app = draft.get("wecomApp") if isinstance(draft.get("wecomApp"), dict) else None
        if wecom_app:
            body["wecomApp"] = wecom_app
    return body


def _update_patch_is_empty(patch: Dict[str, Any]) -> bool:
    allowed = {"userId", "name", "type", "enabled", "webhookUrl", "keyword", "wecomApp"}
    return not any(key in patch for key in allowed)


def _build_update_patch(message: str, llm_patch: Dict[str, Any]) -> Dict[str, Any]:
    patch = _create_patch_from_rules(message)
    if isinstance(llm_patch, dict):
        patch = _merge_non_empty(patch, llm_patch)
    patch.pop("action", None)
    patch.pop("subscriptionId", None)
    return patch


async def _fetch_subscription_detail(auth_header: str, subscription_id: str) -> Dict[str, Any]:
    data = await _api_request("GET", f"/api/subscriptions/{subscription_id}", auth_header=auth_header)
    item = data.get("item")
    return item if isinstance(item, dict) else {}


def _pick_candidate_from_reply(message: str, candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    subscription_id = _extract_subscription_id(message)
    if subscription_id:
        for item in candidates:
            if str(item.get("id") or "") == subscription_id:
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
    owner_hint: str = "",
    patch: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[AgentChatResponse]]:
    items = await _list_subscriptions(
        auth_header,
        current_user_id=current_user_id,
        include_all=include_all,
        q_username=owner_hint if include_all else "",
    )
    if not items:
        reply = "你当前还没有可操作的订阅。要不要我先帮你创建一个？"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return None, AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME})

    subscription_id = _extract_subscription_id(user_message)
    if subscription_id:
        for item in items:
            if str(item.get("id") or "") == subscription_id:
                return item, None
        reply = f"没有找到 ID 为 `{subscription_id}` 的订阅。你可以先说“列出订阅”。"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return None, AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME})

    candidates = _match_candidates(user_message, items)
    if len(candidates) == 1:
        return candidates[0], None

    preview_source = candidates[:10] if candidates else items[:10]
    preview = "\n".join(_brief(item, idx) for idx, item in enumerate(preview_source, start=1))
    if candidates:
        reply = f"我找到了多条可能的订阅，请回复序号或完整订阅 ID：\n{preview}"
    else:
        reply = f"我还没法唯一定位你要操作的订阅，请回复序号或完整订阅 ID：\n{preview}"

    pending = {
        "type": SUBSCRIPTION_SKILL_NAME,
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
    items = await _list_subscriptions(
        auth_header,
        current_user_id=current_user_id,
        include_all=include_all,
        q_name=name,
        q_username=owner_hint if include_all else "",
    )
    if not items:
        reply = "你当前没有订阅。"
    else:
        lines = [f"共 {len(items)} 条订阅："]
        for index, item in enumerate(items[:20], start=1):
            lines.append(_brief(item, index))
        reply = "\n".join(lines)

    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "action": "list"})


async def _do_get(user_id: str, subscription_id: str, auth_header: str) -> AgentChatResponse:
    item = await _fetch_subscription_detail(auth_header, subscription_id)
    owner = str(item.get("createdByUsername") or item.get("userId") or "")
    wecom_app = item.get("wecomApp") if isinstance(item.get("wecomApp"), dict) else None
    wecom_text = (
        f"\nwecomApp: corpId={wecom_app.get('corpId')}, agentId={wecom_app.get('agentId')}, toUser={wecom_app.get('toUser')}, toParty={wecom_app.get('toParty')}, toTag={wecom_app.get('toTag')}"
        if wecom_app
        else ""
    )
    reply = (
        "订阅详情：\n"
        f"ID: {item.get('id')}\n"
        f"名称: {item.get('name')}\n"
        f"创建人: {owner}\n"
        f"类型: {item.get('type')}\n"
        f"状态: {'启用' if item.get('enabled') else '停用'}\n"
        f"Webhook: {item.get('webhookUrl')}\n"
        f"关键词: {item.get('keyword')}"
        f"{wecom_text}"
    )
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "action": "get"})


async def _do_delete(user_id: str, subscription_id: str, auth_header: str) -> AgentChatResponse:
    item = await _fetch_subscription_detail(auth_header, subscription_id)
    await _api_request("DELETE", f"/api/subscriptions/{subscription_id}", auth_header=auth_header)
    reply = f"已删除订阅：{item.get('name') or subscription_id}"
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "action": "delete"})


async def _do_update(user_id: str, subscription_id: str, patch: Dict[str, Any], auth_header: str) -> AgentChatResponse:
    current = await _fetch_subscription_detail(auth_header, subscription_id)
    if not current:
        raise RuntimeError("订阅不存在。")

    current_wecom = current.get("wecomApp") if isinstance(current.get("wecomApp"), dict) else {}
    patch_wecom = patch.get("wecomApp") if isinstance(patch.get("wecomApp"), dict) else {}
    merged_wecom = _merge_non_empty(current_wecom, patch_wecom)

    # Server uses zod optional() for webhookUrl/keyword/wecomApp: do not send null.
    body: Dict[str, Any] = {
        "userId": patch.get("userId", current.get("userId")),
        "name": patch.get("name", current.get("name")),
        "type": patch.get("type", current.get("type")),
        "enabled": patch.get("enabled", current.get("enabled", True)),
    }

    webhook_val = patch.get("webhookUrl", current.get("webhookUrl"))
    if isinstance(webhook_val, str) and webhook_val.strip():
        body["webhookUrl"] = webhook_val.strip()

    # Include keyword if present in patch or current (empty string clears).
    if "keyword" in patch or "keyword" in current:
        kw_val = patch.get("keyword", current.get("keyword"))
        if kw_val is None:
            # omit
            pass
        else:
            kw = kw_val if isinstance(kw_val, str) else str(kw_val)
            body["keyword"] = kw.strip()

    if body["type"] == "wecom_app" and merged_wecom:
        body["wecomApp"] = merged_wecom

    await _api_request("PUT", f"/api/subscriptions/{subscription_id}", auth_header=auth_header, json_body=body)

    reply = (
        "已更新订阅：\n"
        f"ID: {subscription_id}\n"
        f"用户ID: {body['userId']}\n"
        f"名称: {body['name']}\n"
        f"类型: {body['type']}\n"
        f"状态: {'启用' if body['enabled'] else '停用'}"
    )
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "action": "update"})


async def _handle_pending(
    *,
    user_id: str,
    message: str,
    auth_header: str,
    req_model: Optional[str],
    cfg_ok: bool,
    is_admin: bool,
    pending: Dict[str, Any],
) -> AgentChatResponse:
    if any(keyword in message for keyword in ["取消", "算了", "退出", "不用了"]):
        await _clear_pending(user_id)
        reply = "好的，已取消这次订阅操作。"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "state": "cancelled"})

    stage = str(pending.get("stage") or "")

    if stage == "create_missing":
        draft = dict(pending.get("draft") or {})
        rule_patch = _create_patch_from_rules(message)
        draft = _merge_non_empty(draft, rule_patch)
        if cfg_ok:
            llm_patch = await _llm_extract_subscription_intent(message, draft, req_model)
            if isinstance(llm_patch, dict):
                draft = _merge_non_empty(draft, llm_patch)
        missing = _validate_create_draft(draft)
        if missing:
            reply = "创建订阅还差一些关键信息：\n" + _build_create_questions(missing)
            return await _save_pending(user_id, {"type": SUBSCRIPTION_SKILL_NAME, "stage": "create_missing", "draft": draft}, reply)

        body = _create_request_body(draft)
        data = await _api_request("POST", "/api/subscriptions", auth_header=auth_header, json_body=body)
        await _clear_pending(user_id)
        reply = f"已创建订阅：{body['name']}\nID: {data.get('id')}\n类型: {body['type']}"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "action": "create"})

    if stage == "update_patch":
        subscription_id = str(pending.get("subscriptionId") or "")
        base_patch = dict(pending.get("patch") or {})
        llm_patch = await _llm_extract_subscription_intent(message, base_patch, req_model) if cfg_ok else {}
        patch = _build_update_patch(message, llm_patch)
        requested_user_id = _extract_user_id_hint(message)
        if not is_admin and requested_user_id:
            reply = "只有管理员可以修改订阅归属用户。你可以继续修改其他字段，比如启用状态、名称、webhook。"
            if user_id:
                await memory.append(user_id, {"role": "assistant", "content": reply})
            return AgentChatResponse(
                reply=reply,
                toolCalls=[],
                meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "state": "forbidden"},
            )
        if not is_admin:
            patch.pop("userId", None)
        merged_patch = _merge_non_empty(base_patch, patch)
        if _update_patch_is_empty(merged_patch):
            reply = "你想修改这个订阅的哪些内容？例如：停用、改 webhook、改关键词。"
            return await _save_pending(
                user_id,
                {"type": SUBSCRIPTION_SKILL_NAME, "stage": "update_patch", "subscriptionId": subscription_id, "patch": merged_patch},
                reply,
            )
        await _clear_pending(user_id)
        return await _do_update(user_id=user_id, subscription_id=subscription_id, patch=merged_patch, auth_header=auth_header)

    if stage == "select_target":
        candidates = pending.get("candidates") if isinstance(pending.get("candidates"), list) else []
        selected = _pick_candidate_from_reply(message, [item for item in candidates if isinstance(item, dict)])
        if not selected:
            reply = "我还没识别出你选的是哪一条，请回复序号或完整订阅 ID。"
            return await _save_pending(user_id, pending, reply)

        await _clear_pending(user_id)
        action = str(pending.get("action") or "")
        patch = pending.get("patch") if isinstance(pending.get("patch"), dict) else {}
        subscription_id = str(selected.get("id") or "")

        if action == "get":
            return await _do_get(user_id=user_id, subscription_id=subscription_id, auth_header=auth_header)
        if action == "delete":
            return await _do_delete(user_id=user_id, subscription_id=subscription_id, auth_header=auth_header)
        if action == "update":
            if _update_patch_is_empty(patch):
                reply = "你想修改这个订阅的哪些内容？例如：停用、改 webhook、改关键词。"
                return await _save_pending(
                    user_id,
                    {"type": SUBSCRIPTION_SKILL_NAME, "stage": "update_patch", "subscriptionId": subscription_id, "patch": patch},
                    reply,
                )
            return await _do_update(user_id=user_id, subscription_id=subscription_id, patch=patch, auth_header=auth_header)

    await _clear_pending(user_id)
    reply = "上一次订阅操作状态已失效，请重新描述你的需求。"
    if user_id:
        await memory.append(user_id, {"role": "assistant", "content": reply})
    return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "state": "expired"})


async def handle_subscription_management_skill(
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
        reply = "当前缺少登录授权，无法直接调用订阅接口。请重新登录后再试。"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "state": "unauthorized"})

    state = await memory.load_state(user_id) if user_id else {}
    pending = state.get("pending") if isinstance(state, dict) else None
    if isinstance(pending, dict) and pending.get("type") == SUBSCRIPTION_SKILL_NAME:
        stage = str(pending.get("stage") or "")
        if parsed_action in {"list", "create"}:
            await _clear_pending(user_id)
            pending = None
        elif stage == "select_target":
            pending_action = str(pending.get("action") or "")
            if parsed_action and parsed_action != pending_action:
                await _clear_pending(user_id)
                pending = None

    if isinstance(pending, dict) and pending.get("type") == SUBSCRIPTION_SKILL_NAME:
        try:
            return await _handle_pending(
                user_id=user_id,
                message=message,
                auth_header=auth_header,
                req_model=req_model,
                cfg_ok=cfg_ok,
                is_admin=admin_mode,
                pending=pending,
            )
        except Exception as exc:
            await _clear_pending(user_id)
            reply = f"处理上一轮订阅操作时失败：{str(exc)}"
            if user_id:
                await memory.append(user_id, {"role": "assistant", "content": reply})
            return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "state": "error"})

    draft: Dict[str, Any] = {
        "action": parsed_action,
        "subscriptionId": _extract_subscription_id(message) or None,
    }
    named = _extract_quoted_name(message)
    if named:
        draft["name"] = named
    draft = _merge_non_empty(draft, _create_patch_from_rules(message))

    if cfg_ok:
        llm_patch = await _llm_extract_subscription_intent(message, draft, req_model)
        if isinstance(llm_patch, dict):
            draft = _merge_non_empty(draft, llm_patch)

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
                owner_hint=owner_hint,
            )
            if response:
                return response
            return await _do_delete(user_id, str((target or {}).get("id") or ""), auth_header)

        if action == "update":
            patch = _build_update_patch(message, draft)
            requested_user_id = _extract_user_id_hint(message)
            if not admin_mode and requested_user_id:
                reply = "只有管理员可以修改订阅归属用户。你可以继续修改其他字段，比如启用状态、名称、webhook。"
                if user_id:
                    await memory.append(user_id, {"role": "assistant", "content": reply})
                return AgentChatResponse(
                    reply=reply,
                    toolCalls=[],
                    meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "state": "forbidden"},
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
                owner_hint=owner_hint,
                patch=patch,
            )
            if response:
                return response

            subscription_id = str((target or {}).get("id") or "")
            if _update_patch_is_empty(patch):
                reply = "你想修改这个订阅的哪些内容？例如：停用、改 webhook、改关键词。"
                return await _save_pending(
                    user_id,
                    {"type": SUBSCRIPTION_SKILL_NAME, "stage": "update_patch", "subscriptionId": subscription_id, "patch": patch},
                    reply,
                )
            return await _do_update(user_id=user_id, subscription_id=subscription_id, patch=patch, auth_header=auth_header)

        if action == "create":
            create_draft = dict(draft)
            missing = _validate_create_draft(create_draft)
            if missing:
                reply = "创建订阅还差一些关键信息：\n" + _build_create_questions(missing)
                return await _save_pending(
                    user_id,
                    {"type": SUBSCRIPTION_SKILL_NAME, "stage": "create_missing", "draft": create_draft},
                    reply,
                )
            body = _create_request_body(create_draft)
            data = await _api_request("POST", "/api/subscriptions", auth_header=auth_header, json_body=body)
            reply = f"已创建订阅：{body['name']}\nID: {data.get('id')}\n类型: {body['type']}"
            if user_id:
                await memory.append(user_id, {"role": "assistant", "content": reply})
            return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "action": "create"})

        reply = "你是想列出订阅、查看详情、新建、修改，还是删除订阅？可以直接告诉我。"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "state": "clarify"})
    except Exception as exc:
        reply = f"订阅操作失败：{str(exc)}"
        if user_id:
            await memory.append(user_id, {"role": "assistant", "content": reply})
        return AgentChatResponse(reply=reply, toolCalls=[], meta={"mode": "skill", "skill": SUBSCRIPTION_SKILL_NAME, "state": "error"})
