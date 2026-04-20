from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from core.config import _env, _llm_config


def _normalize_openai_base_url(raw: str) -> str:
    s = (raw or "").strip().rstrip("/")
    if not s:
        return s
    # If caller passed a chat/completions URL, strip it to base.
    if "/chat/completions" in s:
        s = s.split("/chat/completions")[0].rstrip("/")
    return s


async def embed_texts(texts: List[str]) -> Dict[str, Any]:
    """
    Call OpenAI-compatible embeddings endpoint.

    Env:
      - EMBEDDING_BASE_URL (optional, defaults to LLM_BASE_URL)
      - EMBEDDING_API_KEY (optional, defaults to LLM_API_KEY)
      - EMBEDDING_MODEL (optional, default: text-embedding-3-small)
    """
    cfg = _llm_config()
    base_url = _normalize_openai_base_url(_env("EMBEDDING_BASE_URL", cfg.get("base_url", "")))
    api_key = _env("EMBEDDING_API_KEY", cfg.get("api_key", ""))
    model = _env("EMBEDDING_MODEL", "text-embedding-3-small")

    if not base_url or not api_key:
        return {"ok": False, "error": "embedding not configured", "vectors": []}

    # OpenAI-compatible: base/v1/embeddings (if base already endswith /v1, use base/embeddings)
    if base_url.endswith("/v1"):
        url = f"{base_url}/embeddings"
    else:
        url = f"{base_url}/v1/embeddings"

    payload: Dict[str, Any] = {"model": model, "input": texts}
    headers = {"Authorization": f"Bearer {api_key}"}

    timeout = httpx.Timeout(30.0, connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        return {"ok": False, "error": f"embedding request failed: {str(e)}", "vectors": []}

    try:
        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return {"ok": False, "error": "invalid embedding response", "vectors": []}
        vectors: List[List[float]] = []
        for it in items:
            emb = it.get("embedding") if isinstance(it, dict) else None
            if isinstance(emb, list) and emb:
                vectors.append([float(x) for x in emb])
        if len(vectors) != len(texts):
            return {"ok": False, "error": "embedding count mismatch", "vectors": []}
        return {"ok": True, "vectors": vectors, "raw": data}
    except Exception:
        return {"ok": False, "error": "invalid embedding response", "vectors": []}


async def embed_text(text: str) -> Dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "empty text", "vector": None}
    r = await embed_texts([text])
    if not r.get("ok"):
        return {"ok": False, "error": r.get("error", "embedding failed"), "vector": None}
    vecs = r.get("vectors") or []
    return {"ok": True, "vector": vecs[0]}

