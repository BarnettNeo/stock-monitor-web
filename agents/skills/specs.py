from __future__ import annotations

from typing import Any, Dict, List, Sequence

from core.config import TOOLS_SPEC


def compact_tools_spec(tool_names: Sequence[str]) -> List[Dict[str, Any]]:
    """Return a compact subset of TOOLS_SPEC for the given tool names.

    Token-saving strategy:
    - only include tools needed for the current intent
    - reduce `args` from {name: description} to a simple list of arg names

    Note: The decision prompt only needs argument *names*; Node gateway validates at runtime.
    """

    wanted = {str(n).strip() for n in tool_names if str(n).strip()}
    if not wanted:
        return []

    out: List[Dict[str, Any]] = []
    for t in TOOLS_SPEC:
        name = str(t.get("name") or "").strip()
        if name not in wanted:
            continue

        args = t.get("args")
        arg_names: List[str] = []
        if isinstance(args, dict):
            arg_names = [str(k) for k in args.keys() if str(k)]

        out.append(
            {
                "name": name,
                "description": str(t.get("description") or ""),
                "args": arg_names,
            }
        )

    # Keep output ordering stable as tool_names
    ordered: List[Dict[str, Any]] = []
    idx = {t["name"]: t for t in out if isinstance(t, dict) and t.get("name")}
    for n in tool_names:
        k = str(n).strip()
        if k in idx:
            ordered.append(idx[k])
    return ordered
