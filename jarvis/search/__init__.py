"""Hybrid personal search: Spotlight (free, always up to date) + own FTS5 index + semantic vectors.

Results from the three sources are merged with reciprocal-rank fusion and returned with
file paths (citations) and snippets.
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import time

import numpy as np

from ..db import Database, fts_query
from .extract import KINDS, kind_of

SPOTLIGHT_TYPES = {
    "pdf": "kMDItemContentType == 'com.adobe.pdf'",
    "image": "kMDItemContentTypeTree == 'public.image'",
    "presentation": "kMDItemContentTypeTree == 'public.presentation'",
    "spreadsheet": "kMDItemContentTypeTree == 'public.spreadsheet'",
    "code": "kMDItemContentTypeTree == 'public.source-code'",
    "document": "(kMDItemContentTypeTree == 'public.composite-content' || kMDItemContentTypeTree == 'public.text')",
    "text": "kMDItemContentTypeTree == 'public.text'",
}
STOP = {"the", "a", "an", "of", "my", "that", "i", "find", "show", "me", "locate", "file", "files", "document",
        "documents", "about", "related", "to", "for", "with", "all", "every", "where", "is", "took", "downloaded",
        "last", "month", "week", "year", "recent", "latest", "most", "version", "on", "in", "from", "this", "any"}


def _days_from_text(q: str) -> int | None:
    ql = q.lower()
    for pat, d in ((r"\btoday\b", 1), (r"\byesterday\b", 2), (r"\blast week\b|\bthis week\b", 10),
                   (r"\blast month\b|\bthis month\b", 45), (r"\blast year\b|\bthis year\b", 400)):
        if re.search(pat, ql):
            return d
    return None


def _kind_from_text(q: str) -> str | None:
    ql = q.lower()
    for word, k in (("pdf", "pdf"), ("paper", "pdf"), ("screenshot", "image"), ("photo", "image"), ("image", "image"),
                    ("slides", "presentation"), ("slide", "presentation"), ("presentation", "presentation"),
                    ("spreadsheet", "spreadsheet"), ("excel", "spreadsheet"), ("code", "code"), ("script", "code")):
        if re.search(rf"\b{word}s?\b", ql):
            return k
    return None


def keywords(q: str) -> list[str]:
    return [w for w in re.findall(r"[\w'-]+", q.lower()) if w not in STOP and len(w) > 1]


class Search:
    def __init__(self, db: Database, settings, embed=None):
        self.db = db
        self.settings = settings
        self.embed = embed  # async fn(list[str]) -> list[vec]
        self._vec_cache: tuple[float, np.ndarray | None, list[int]] = (0, None, [])

    async def search(self, query: str, kind: str | None = None, days: int | None = None, limit: int = 10) -> list[dict]:
        kind = kind or _kind_from_text(query)
        days = days or _days_from_text(query)
        since = time.time() - days * 86400 if days else None
        kws = keywords(query)
        lists: list[list[dict]] = []
        if self.settings.get("search.use_spotlight", True) and sys.platform == "darwin":
            lists.append(await asyncio.to_thread(self.spotlight, kws, kind, days, 30))
        lists.append(await asyncio.to_thread(self.fulltext, kws, kind, since, 30))
        lists.append(await asyncio.to_thread(self.filename, kws, kind, since, 30))
        if self.embed and self.settings.get("search.semantic", True):
            try:
                lists.append(await self.semantic(query, kind, since, 30))
            except Exception:
                pass
        merged: dict[str, dict] = {}
        for lst in lists:
            for rank, r in enumerate(lst):
                m = merged.setdefault(r["path"], {**r, "score": 0.0, "sources": []})
                m["score"] += 1.0 / (60 + rank)
                m["sources"].append(r["source"])
                if r.get("snippet") and not m.get("snippet"):
                    m["snippet"] = r["snippet"]
        out = [m for m in merged.values() if os.path.exists(m["path"])]
        recency = "recent" in query.lower() or "latest" in query.lower() or "newest" in query.lower()
        for m in out:
            try:
                m["mtime"] = m.get("mtime") or os.path.getmtime(m["path"])
            except OSError:
                m["mtime"] = 0
            if recency:
                m["score"] += 0.01 * max(0, 1 - (time.time() - m["mtime"]) / (365 * 86400))
        out.sort(key=lambda m: -m["score"])
        return out[:limit]

    def spotlight(self, kws: list[str], kind: str | None, days: int | None, limit: int) -> list[dict]:
        if not kws:
            return []
        terms = " && ".join(f"(kMDItemDisplayName == '*{k}*'cd || kMDItemTextContent == '{k}*'cdw)" for k in kws[:5])
        q = terms
        if kind in SPOTLIGHT_TYPES:
            q = f"({q}) && {SPOTLIGHT_TYPES[kind]}"
        if days:
            q = f"({q}) && kMDItemFSContentChangeDate >= $time.today(-{int(days)})"
        roots = [os.path.expanduser(r) for r in self.settings.get("search.roots", [])] or [os.path.expanduser("~")]
        out = []
        for root in roots:
            try:
                p = subprocess.run(["mdfind", "-onlyin", root, q], capture_output=True, text=True, timeout=8)
            except subprocess.TimeoutExpired:
                continue
            for line in p.stdout.splitlines():
                if "/Library/" in line or "/." in line:
                    continue
                out.append({"path": line, "name": os.path.basename(line), "kind": kind_of(line), "source": "spotlight"})
                if len(out) >= limit:
                    return out
        return out

    def fulltext(self, kws, kind, since, limit) -> list[dict]:
        if not kws:
            return []
        sql = ("SELECT f.path, f.name, f.kind, f.mtime, snippet(chunks_fts, 0, '[', ']', '…', 18) AS snippet, "
               "bm25(chunks_fts) AS s FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN files f ON f.id = c.file_id "
               "WHERE chunks_fts MATCH ?")
        params: list = [fts_query(" ".join(kws))]
        if kind:
            sql += " AND f.kind = ?"
            params.append(kind)
        if since:
            sql += " AND f.mtime >= ?"
            params.append(since)
        sql += " ORDER BY s LIMIT ?"
        params.append(limit * 3)
        seen, out = set(), []
        for r in self.db.query(sql, params):
            if r["path"] in seen:
                continue
            seen.add(r["path"])
            out.append({**r, "source": "content"})
        return out[:limit]

    def filename(self, kws, kind, since, limit) -> list[dict]:
        if not kws:
            return []
        where = " AND ".join("lower(name) LIKE ?" for _ in kws[:4])
        sql = f"SELECT path, name, kind, mtime FROM files WHERE ({where})"
        params: list = [f"%{k}%" for k in kws[:4]]
        if kind:
            sql += " AND kind=?"
            params.append(kind)
        if since:
            sql += " AND mtime >= ?"
            params.append(since)
        sql += " ORDER BY mtime DESC LIMIT ?"
        params.append(limit)
        return [{**r, "source": "filename"} for r in self.db.query(sql, params)]

    def _vectors(self):
        count = self.db.one("SELECT count(*) AS n FROM chunks WHERE embedding IS NOT NULL")["n"]
        ts, mat, ids = self._vec_cache
        if mat is not None and len(ids) == count and time.time() - ts < 300:
            return mat, ids
        rows = self.db.query("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL")
        if not rows:
            return None, []
        mat = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
        ids = [r["id"] for r in rows]
        self._vec_cache = (time.time(), mat, ids)
        return mat, ids

    async def semantic(self, query, kind, since, limit) -> list[dict]:
        mat, ids = await asyncio.to_thread(self._vectors)
        if mat is None:
            return []
        q = np.asarray((await self.embed([query]))[0], dtype=np.float32)
        q /= (np.linalg.norm(q) + 1e-9)
        if q.shape[0] != mat.shape[1]:
            return []
        sims = mat @ q
        order = np.argsort(-sims)[: limit * 4]
        out, seen = [], set()
        for i in order:
            if sims[i] < 0.25:
                break
            r = self.db.one("SELECT f.path, f.name, f.kind, f.mtime, c.text FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.id=?", (ids[int(i)],))
            if not r or r["path"] in seen or (kind and r["kind"] != kind) or (since and (r["mtime"] or 0) < since):
                continue
            seen.add(r["path"])
            out.append({"path": r["path"], "name": r["name"], "kind": r["kind"], "mtime": r["mtime"],
                        "snippet": r["text"][:200], "similarity": float(sims[i]), "source": "semantic"})
            if len(out) >= limit:
                break
        return out

    def duplicates(self, limit: int = 200) -> list[list[str]]:
        rows = self.db.query("SELECT sha256, group_concat(path, '\n') AS paths, count(*) AS n FROM files "
                             "WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING n > 1 LIMIT ?", (limit,))
        return [r["paths"].split("\n") for r in rows]

    def stats(self) -> dict:
        return {
            "files": self.db.one("SELECT count(*) AS n FROM files")["n"],
            "chunks": self.db.one("SELECT count(*) AS n FROM chunks")["n"],
            "embedded": self.db.one("SELECT count(*) AS n FROM chunks WHERE embedding IS NOT NULL")["n"],
            "last_indexed": self.db.one("SELECT max(indexed_at) AS t FROM files")["t"],
        }


__all__ = ["Search", "KINDS"]
