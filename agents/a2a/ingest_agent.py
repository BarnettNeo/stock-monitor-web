from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
import json
import re

from core.config import _env
from llm.embeddings import embed_texts
from infrastructure.milvus_news import NewsChunk, milvus_news
from .utils import chunk_text, normalize_ws, uniq


@dataclass
class FeedItem:
    title: str
    url: str
    source: str
    published_at: str
    published_ts: int
    canonical_url: str = ""
    content_simhash64: str = ""
    summary: str = ""


class NewsIngestAgent:
    """
    Crawl -> clean -> chunk -> embed -> upsert to Milvus.

    Sources:
      - RSS/Atom feeds via `feedparser`
      - Optional per-request feed overrides

    Env:
      - NEWS_RSS_FEEDS: comma-separated URLs
      - NEWS_HTTP_TIMEOUT: seconds (default 15)
      - NEWS_CHUNK_CHARS / NEWS_CHUNK_OVERLAP
    """

    def __init__(self, model: str = "") -> None:
        # reserved: allow later LLM-based extraction / cleaning
        self.model = model

    def _feeds(self, override: Optional[List[str]] = None) -> List[str]:
        if override:
            return [x.strip() for x in override if str(x).strip()]
        raw = _env("NEWS_RSS_FEEDS", "")
        return [x.strip() for x in raw.split(",") if x.strip()]

    async def _fetch_html(self, url: str) -> Tuple[bool, str]:
        timeout_s = float(_env("NEWS_HTTP_TIMEOUT", "15") or "15")
        headers = {
            "User-Agent": _env(
                "NEWS_UA",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            )
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_s, connect=10.0), follow_redirects=True) as c:
                r = await c.get(url, headers=headers)
                r.raise_for_status()
                return True, r.text
        except Exception as e:
            return False, str(e)

    def _canonicalize_url(self, url: str) -> str:
        """
        Canonicalize URL for de-dup:
          - lower-case scheme/host
          - drop fragment
          - remove common tracking query params (utm_*, spm, etc.)
          - sort remaining query params
        """
        u = (url or "").strip()
        if not u:
            return ""
        try:
            sp = urlsplit(u)
            scheme = (sp.scheme or "https").lower()
            netloc = (sp.netloc or "").lower()
            path = sp.path or ""
            q = parse_qsl(sp.query, keep_blank_values=False)
            drop_prefix = ("utm_",)
            drop_keys = {
                "spm",
                "spm_id_from",
                "from",
                "source",
                "src",
                "ref",
                "referer",
                "share",
                "share_source",
                "share_medium",
                "share_plat",
                "share_session_id",
                "session_id",
                "mkt_tok",
                "gclid",
                "fbclid",
                "igshid",
            }
            q2 = []
            for k, v in q:
                key = (k or "").strip()
                if not key:
                    continue
                lk = key.lower()
                if lk in drop_keys:
                    continue
                if any(lk.startswith(p) for p in drop_prefix):
                    continue
                q2.append((key, v))
            q2.sort(key=lambda kv: (kv[0], kv[1] or ""))
            query = urlencode(q2, doseq=True)
            return urlunsplit((scheme, netloc, path, query, ""))  # drop fragment
        except Exception:
            return u.split("#")[0].strip()

    @staticmethod
    def _tokenize_for_simhash(text: str) -> List[str]:
        import re

        s = (text or "").lower()
        s = re.sub(r"\s+", " ", s).strip()
        # keep simple alnum tokens, plus CJK blocks
        tokens = re.findall(r"[a-z0-9]{2,}|[\u4e00-\u9fff]", s)
        return tokens[:8000]

    def _simhash64(self, text: str) -> str:
        """
        64-bit simhash (hex string) for near-duplicate detection.
        """
        import hashlib

        tokens = self._tokenize_for_simhash(text)
        if not tokens:
            return "0" * 16
        v = [0] * 64
        for t in tokens:
            h = hashlib.md5(t.encode("utf-8", errors="ignore")).digest()
            # take 64 bits
            x = int.from_bytes(h[:8], "big", signed=False)
            for i in range(64):
                bit = (x >> i) & 1
                v[i] += 1 if bit else -1
        out = 0
        for i, w in enumerate(v):
            if w > 0:
                out |= 1 << i
        return f"{out:016x}"

    def _extract_text(self, html: str) -> str:
        try:
            from bs4 import BeautifulSoup  # type: ignore

            soup = BeautifulSoup(html or "", "lxml")
            for t in soup(["script", "style", "noscript"]):
                try:
                    t.extract()
                except Exception:
                    pass
            # Site-specific extraction (Sina Finance often has cleaner article body containers)
            try:
                url = ""
                if soup.head:
                    base = soup.head.find("base")
                    if base and base.get("href"):
                        url = str(base.get("href") or "")
                # If base tag absent, fall back to whole doc.
                _ = url
            except Exception:
                pass

            body_text = ""
            # Common Sina containers: #artibody, .article, .article-content, #article, .main-content
            for sel in ["#artibody", ".article", ".article-content", "#article", ".main-content", ".content"]:
                try:
                    node = soup.select_one(sel)
                    if not node:
                        continue
                    cand = normalize_ws(node.get_text(separator="\n"))
                    if len(cand) > len(body_text):
                        body_text = cand
                except Exception:
                    continue

            text = body_text or soup.get_text(separator="\n")
            return normalize_ws(text)
        except Exception:
            return normalize_ws(html or "")

    def _parse_feeds(self, feeds: List[str], since_ts: int, max_items: int) -> Tuple[List[FeedItem], List[str]]:
        errors: List[str] = []
        items: List[FeedItem] = []

        # 中文注释
        # 解析 RSS/Atom 订阅源
        # 从 RSS/Atom 订阅源中提取新闻标题、URL、摘要、发布时间等信息
        for feed_url in feeds:
            # Detect Sina-style JSON API (e.g. feed.mix.sina.com.cn/api/roll/get)
            if "feed.mix.sina.com.cn/api/roll/get" in feed_url:
                try:
                    import urllib.request

                    resp = urllib.request.urlopen(feed_url, timeout=int(_env("NEWS_HTTP_TIMEOUT", "15")))
                    data = json.loads(resp.read().decode("utf-8"))
                    result = data.get("result", {})
                    feed_items = result.get("data", []) or []
                    src = "新浪财经"

                    for ent in feed_items[: max(1, max_items)]:
                        title = str(ent.get("title", "") or "").strip()
                        url = str(ent.get("url", "") or "").strip()
                        intro = str(ent.get("intro", "") or "").strip()
                        if not title:
                            continue

                        published_ts = 0
                        try:
                            published_ts = int(ent.get("ctime", 0) or 0)
                        except Exception:
                            published_ts = 0

                        if published_ts and published_ts < since_ts:
                            continue

                        from datetime import datetime

                        published_at = datetime.fromtimestamp(published_ts).isoformat() if published_ts else ""
                        media_name = str(ent.get("media_name", "") or "").strip() or src

                        items.append(
                            FeedItem(
                                title=title[:1024],
                                url=url,
                                source=media_name[:80],
                                published_at=published_at[:64],
                                published_ts=published_ts or int(time.time()),
                                summary=intro[:4000],
                            )
                        )
                except Exception as e:
                    errors.append(f"sina json feed parse failed: {feed_url}: {str(e)}")
                continue

            # Default: RSS/Atom via feedparser
            try:
                import feedparser  # type: ignore
            except Exception as e:
                errors.append(f"feedparser not installed: {str(e)}")
                continue

            try:
                d = feedparser.parse(feed_url)
                src = str(getattr(d, "feed", {}).get("title", "") or "")[:80] or feed_url
                for ent in list(getattr(d, "entries", []) or [])[: max(1, max_items)]:
                    link = str(getattr(ent, "link", "") or "").strip()
                    title = str(getattr(ent, "title", "") or "").strip()
                    if not link and not title:
                        continue

                    published_ts = 0
                    try:
                        st = getattr(ent, "published_parsed", None) or getattr(ent, "updated_parsed", None)
                        if st:
                            published_ts = int(time.mktime(st))
                    except Exception:
                        published_ts = 0

                    if published_ts and published_ts < since_ts:
                        continue

                    published_at = str(getattr(ent, "published", "") or getattr(ent, "updated", "") or "").strip()
                    summary = str(getattr(ent, "summary", "") or getattr(ent, "description", "") or "").strip()
                    if summary and "<" in summary and ">" in summary:
                        try:
                            from bs4 import BeautifulSoup  # type: ignore

                            summary = BeautifulSoup(summary, "lxml").get_text(" ")
                        except Exception:
                            pass
                    summary = normalize_ws(summary)[:4000]
                    items.append(
                        FeedItem(
                            title=title[:1024],
                            url=link,
                            source=src,
                            published_at=published_at[:64],
                            published_ts=published_ts or int(time.time()),
                            summary=summary,
                        )
                    )
            except Exception as e:
                errors.append(f"feed parse failed: {feed_url}: {str(e)}")

        # De-dup by url
        dedup: Dict[str, FeedItem] = {}
        for it in items:
            k = it.url or (it.title + "|" + str(it.published_ts))
            if k not in dedup:
                dedup[k] = it
        return list(dedup.values())[: max(1, max_items)], errors

    # 从文本中提取 A-share 股票代码
    # 先尝试显式指定的代码，否则尝试从文本中提取
    def _resolve_symbols(self, text: str, explicit: List[str]) -> List[str]:
        # Prefer explicit targets; otherwise best-effort extract symbols from text.
        targets = [self._normalize_a_symbol(x) for x in (explicit or [])]
        targets = [x for x in targets if x]
        if targets:
            return targets
        try:
            from domain.strategy import extract_symbols_from_text  # type: ignore

            syms = uniq(extract_symbols_from_text(text or ""))
            out: List[str] = []
            for s in syms:
                n = self._normalize_a_symbol(s)
                if n:
                    out.append(n)
            return uniq(out)
        except Exception:
            return []

    # 规范 A-share 股票代码为 `sh600519` / `sz000001` 格式
    # 返回空字符串表示非 A-share 股票代码
    @staticmethod
    def _normalize_a_symbol(sym: str) -> str:
        """
        Normalize A-share symbol to `sh600519` / `sz000001`.
        Return empty string for non A-share codes.
        """
        s = (sym or "").strip().lower().replace(".", "").replace(" ", "")
        if not s:
            return ""
        m = re.fullmatch(r"(sh|sz)(\d{6})", s)
        if m:
            return f"{m.group(1)}{m.group(2)}"
        m2 = re.fullmatch(r"(\d{6})", s)
        if m2:
            code = m2.group(1)
            if code.startswith("6"):
                return f"sh{code}"
            if code.startswith(("0", "3")):
                return f"sz{code}"
        return ""

    # 主函数
    async def run(
        self,
        symbols: List[str],
        feeds: Optional[List[str]] = None,
        since_minutes: int = 180,
        max_items: int = 30,
        dry_run: bool = False,
        trace_id: str = "",
    ) -> Dict[str, Any]:
        feeds2 = self._feeds(feeds)
        if not feeds2:
            return {"ok": False, "error": "no feeds configured (NEWS_RSS_FEEDS)", "inserted": 0, "processed": 0, "fetched": 0}

        since_ts = int(time.time()) - max(1, int(since_minutes)) * 60
        max_items = max(1, min(int(max_items), 200))

        # Only ingest A-share symbols.
        symbols_norm = [self._normalize_a_symbol(x) for x in (symbols or [])]
        symbols_norm = [x for x in symbols_norm if x]
        symbol_allow = set(symbols_norm)

        feed_items, feed_errors = self._parse_feeds(feeds2, since_ts=since_ts, max_items=max_items)

        inserted = 0
        processed = 0
        fetched = 0
        errors: List[str] = list(feed_errors)
        trace_id = (trace_id or "").strip() or _env("TRACE_ID", "").strip() or ""
        if not trace_id:
            try:
                import uuid

                trace_id = str(uuid.uuid4())
            except Exception:
                trace_id = str(int(time.time()))
        try:
            print(
                json.dumps(
                    {
                        "type": "news_ingest_start",
                        "traceId": trace_id,
                        "sinceMinutes": int(since_minutes),
                        "maxItems": int(max_items),
                        "symbols": symbols,
                        "feedsCount": len(feeds2),
                        "dryRun": bool(dry_run),
                    },
                    ensure_ascii=False,
                )
            )
        except Exception:
            pass

        chunk_chars = int(_env("NEWS_CHUNK_CHARS", "1200") or "1200")
        chunk_overlap = int(_env("NEWS_CHUNK_OVERLAP", "120") or "120")

        for it in feed_items:
            if not it.url:
                continue
            fetched += 1
            canonical_url = self._canonicalize_url(it.url)
            ok, html_or_err = await self._fetch_html(it.url)
            html = html_or_err if ok else ""

            text = self._extract_text(html) if html else ""
            # If fetch failed or body too short, fall back to RSS summary (better than dropping)
            if (not ok) or len(text) < 200:
                if it.summary and len(it.summary) >= 120:
                    text = (it.title + "\n" + it.summary).strip()
                else:
                    if not ok:
                        errors.append(f"fetch failed: {it.url}: {html_or_err}")
                    continue
            # Heuristic to avoid navigation-only pages
            if len(text) < 200:
                continue
            content_simhash64 = self._simhash64(text)

            syms = self._resolve_symbols(it.title + "\n" + text, symbols)
            if symbol_allow:
                # hard filter: only ingest requested (A-share) symbols
                syms = [s for s in syms if s in symbol_allow]
            if not syms:
                continue

            parts = chunk_text(text, max_chars=chunk_chars, overlap=chunk_overlap)
            if not parts:
                continue

            # Embed once per chunk, then write once per symbol (same vectors)
            emb = await embed_texts(parts[:50])
            if not emb.get("ok"):
                errors.append(f"embedding failed: {it.url}: {emb.get('error','')}")
                continue
            vectors = emb.get("vectors") or []
            if not vectors or len(vectors) != len(parts[:50]):
                errors.append(f"embedding invalid: {it.url}")
                continue

            base_chunks = [
                NewsChunk(
                    text=p,
                    title=it.title,
                    # store canonical URL for stable de-dup across runs
                    url=canonical_url or it.url,
                    source=it.source,
                    published_at=it.published_at,
                )
                for p in parts[:50]
            ]

            processed += 1
            if dry_run:
                continue

            for sym in syms:
                r = milvus_news.upsert_chunks(
                    sym,
                    base_chunks,
                    vectors,
                    ts_unix_seconds=it.published_ts,
                    dedup_hint=f"{canonical_url}|{content_simhash64}",
                )
                if r.get("ok"):
                    inserted += int(r.get("inserted") or 0)
                else:
                    errors.append(f"milvus upsert failed: {sym}: {it.url}: {r.get('error','')}")

        try:
            print(
                json.dumps(
                    {
                        "type": "news_ingest_end",
                        "traceId": trace_id,
                        "fetched": fetched,
                        "processed": processed,
                        "inserted": inserted,
                        "errors": len(errors),
                        "error_details": errors[:5],
                    },
                    ensure_ascii=False,
                )
            )
        except Exception:
            pass

        return {
            "ok": True,
            "fetched": fetched,
            "processed": processed,
            "inserted": inserted,
            "errors": errors[:50],
            "meta": {
                "traceId": trace_id,
                "feeds": feeds2,
                "sinceTs": since_ts,
                "dryRun": dry_run,
                "milvus": milvus_news.info(),
            },
        }
