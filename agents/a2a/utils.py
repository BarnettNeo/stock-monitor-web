from __future__ import annotations

import re
from typing import Iterable, List


def normalize_ws(text: str) -> str:
    s = (text or "").replace("\u00a0", " ").strip()
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def chunk_text(text: str, max_chars: int = 1200, overlap: int = 120) -> List[str]:
    s = (text or "").strip()
    if not s:
        return []
    max_chars = max(200, int(max_chars))
    overlap = max(0, min(int(overlap), max_chars // 2))

    chunks: List[str] = []
    i = 0
    n = len(s)
    while i < n:
        j = min(n, i + max_chars)
        # Try to break on paragraph boundary
        k = s.rfind("\n\n", i, j)
        if k != -1 and k > i + 300:
            j = k
        part = s[i:j].strip()
        if part:
            chunks.append(part)
        if j >= n:
            break
        i = max(0, j - overlap)
        if i == j:
            i = j
    return chunks


def uniq(items: Iterable[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for x in items:
        s = (x or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out

