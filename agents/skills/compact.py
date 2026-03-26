from __future__ import annotations

from typing import Any, Dict, List

from core.models import ToolResult


def _take_list(v: Any, n: int) -> Any:
    if isinstance(v, list):
        return v[:n]
    return v


def compact_tool_results_for_prompt(tool_results: List[ToolResult]) -> List[Dict[str, Any]]:
    """Compact toolResults before injecting into LLM prompt.

    Goal: reduce tokens while keeping enough signal for a good final reply.
    """

    out: List[Dict[str, Any]] = []

    for tr in tool_results:
        item: Dict[str, Any] = {
            "id": tr.id,
            "name": tr.name,
            "ok": bool(tr.ok),
        }
        if not tr.ok:
            item["error"] = tr.error or "unknown error"
            out.append(item)
            continue

        r = tr.result

        # Keep per-tool small, stable summaries
        if tr.name == "query_triggers" and isinstance(r, dict):

            triggers = r.get("triggers")
            item["result"] = {
                "count": r.get("count") if "count" in r else (len(triggers) if isinstance(triggers, list) else None),
                "triggers": _take_list(triggers, 10),
            }

        elif tr.name == "get_stock_info" and isinstance(r, dict):
            item["result"] = {
                "stocks": _take_list(r.get("stocks"), 10),
                "unresolved": _take_list(r.get("unresolved"), 10),
            }

        elif tr.name == "get_diagnostic" and isinstance(r, dict):
            diagnosis = r.get("diagnosis")
            # diagnosis may contain nested data; keep it but limit size by dropping huge arrays
            if isinstance(diagnosis, dict):
                slim_diag: Dict[str, Any] = {}
                for k, v in diagnosis.items():
                    # Keep only top 10 entries for list values
                    slim_diag[str(k)] = _take_list(v, 10)
                item["result"] = {"symbol": r.get("symbol"), "diagnosis": slim_diag}
            else:
                item["result"] = {"symbol": r.get("symbol"), "diagnosis": diagnosis}

        elif tr.name == "generate_report" and isinstance(r, dict):
            item["result"] = {"reportType": r.get("reportType"), "summary": r.get("summary")}

        elif tr.name == "update_subscription" and isinstance(r, dict):

            item["result"] = r

        else:
            # generic fallback: keep shallow dict or first 10 list items
            if isinstance(r, dict):
                # keep at most 20 keys
                keys = list(r.keys())[:20]
                item["result"] = {k: _take_list(r.get(k), 10) for k in keys}
            elif isinstance(r, list):
                item["result"] = r[:10]
            else:
                item["result"] = r

        out.append(item)

    return out
