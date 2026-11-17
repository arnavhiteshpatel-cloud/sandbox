"""Incremental file indexer.

- Walks authorized roots, skipping excluded patterns (hidden folders, ~/Library, vaults...).
- Re-extracts only files whose size or mtime changed; removes rows for deleted files.
- SHA-256 per file for duplicate detection.
- Embeddings are computed in batches via the local embedding model, only when allowed.
- Designed to run in a separate low-priority process (`taskpolicy -b`, i.e. efficiency cores
  only) while charging; see power.py / scheduler.
"""
from __future__ import annotations

import fnmatch
import hashlib
import os
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from ..db import Database
from .extract import INDEXABLE, chunk, extract_text, kind_of


@dataclass
class IndexStats:
    scanned: int = 0
    indexed: int = 0
    unchanged: int = 0
    removed: int = 0
    errors: int = 0
    skipped_large: int = 0
    embedded_chunks: int = 0
    seconds: float = 0.0
    stopped_early: bool = False
    roots: list[str] = field(default_factory=list)


def _excluded(path: str, patterns: list[str], home: str) -> bool:
    rel = path
    for p in patterns:
        if fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel + "/", p):
            return True
    return False


def hidden_or_excluded_dir(full: str, name: str, patterns: list[str], home: str) -> bool:
    if name.startswith("."):
        return True
    if full == os.path.join(home, "Library"):
        return True
    return _excluded(full + "/x", patterns, home)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


class Indexer:
    def __init__(self, db: Database, settings, embed: Callable[[list[str]], list[list[float]]] | None = None,
                 should_stop: Callable[[], bool] | None = None, progress: Callable[[dict], None] | None = None):
        self.db = db
        self.settings = settings
        self.embed = embed
        self.should_stop = should_stop or (lambda: False)
        self.progress = progress or (lambda d: None)

    def roots(self) -> list[str]:
        out = []
        for r in self.settings.get("search.roots", []):
            p = os.path.realpath(os.path.expanduser(r))
            if os.path.isdir(p):
                out.append(p)
        return out

    def run(self, max_seconds: float | None = None, max_files: int | None = None) -> IndexStats:
        st = IndexStats(roots=self.roots())
        t0 = time.monotonic()
        home = os.path.expanduser("~")
        patterns = [p.replace("~", home) for p in self.settings.get("search.exclude", [])]
        max_bytes = int(self.settings.get("search.max_file_mb", 50)) * 1024 * 1024
        ocr = bool(self.settings.get("search.ocr_images", True))
        known = {r["path"]: r for r in self.db.query("SELECT id, path, size, mtime FROM files")}
        seen: set[str] = set()
        for root in st.roots:
            for d, dirs, files in os.walk(root):
                dirs[:] = [x for x in dirs if not hidden_or_excluded_dir(os.path.join(d, x), x, patterns, home)
                           and not x.endswith((".app", ".photoslibrary", ".bundle", ".framework"))]
                for f in files:
                    if f.startswith("."):
                        continue
                    path = os.path.join(d, f)
                    ext = os.path.splitext(f)[1].lower()
                    if ext not in INDEXABLE or _excluded(path, patterns, home):
                        continue
                    st.scanned += 1
                    seen.add(path)
                    try:
                        s = os.stat(path)
                    except OSError:
                        continue
                    k = known.get(path)
                    if k and k["size"] == s.st_size and abs((k["mtime"] or 0) - s.st_mtime) < 1e-3:
                        st.unchanged += 1
                        continue
                    if s.st_size > max_bytes:
                        st.skipped_large += 1
                        self._upsert_meta(path, s, None, "too large")
                        continue
                    self._index_file(path, s, ocr, st)
                    if st.indexed % 25 == 0:
                        self.progress({"type": "index_progress", "indexed": st.indexed, "scanned": st.scanned})
                    if self.should_stop() or (max_seconds and time.monotonic() - t0 > max_seconds) or \
                            (max_files and st.indexed >= max_files):
                        st.stopped_early = True
                        st.seconds = time.monotonic() - t0
                        return st
        # Remove files that disappeared (only under roots we actually walked)
        for path, row in known.items():
            if path not in seen and any(path.startswith(r + os.sep) for r in st.roots) and not os.path.exists(path):
                self.db.execute("DELETE FROM chunks WHERE file_id=?", (row["id"],))
                self.db.execute("DELETE FROM files WHERE id=?", (row["id"],))
                st.removed += 1
        if self.embed and self.settings.get("search.semantic", True):
            st.embedded_chunks = self.embed_pending()
        st.seconds = time.monotonic() - t0
        self.db.log("index", f"Indexed {st.indexed} files ({st.unchanged} unchanged, {st.removed} removed) in {st.seconds:.1f}s")
        return st

    def _upsert_meta(self, path, s, sha, error=None) -> int:
        self.db.execute(
            "INSERT INTO files(path, name, ext, kind, size, mtime, sha256, indexed_at, error) VALUES (?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, sha256=excluded.sha256, "
            "indexed_at=excluded.indexed_at, error=excluded.error, kind=excluded.kind",
            (path, os.path.basename(path), os.path.splitext(path)[1].lower(), kind_of(path), s.st_size, s.st_mtime,
             sha, time.time(), error))
        return int(self.db.one("SELECT id FROM files WHERE path=?", (path,))["id"])

    def _index_file(self, path: str, s, ocr: bool, st: IndexStats) -> None:
        try:
            sha = sha256_file(path)
            text = extract_text(path, ocr_images=ocr)
            fid = self._upsert_meta(path, s, sha)
            with self.db.transaction() as conn:
                conn.execute("DELETE FROM chunks WHERE file_id=?", (fid,))
                header = f"{os.path.basename(path)} — {os.path.dirname(path)}"
                pieces = chunk(text) or [""]
                for i, c in enumerate(pieces[:400]):
                    conn.execute("INSERT INTO chunks(file_id, ord, text) VALUES (?,?,?)", (fid, i, (header + "\n" + c) if i == 0 else c))
            st.indexed += 1
        except Exception as e:
            st.errors += 1
            try:
                self._upsert_meta(path, s, None, f"{type(e).__name__}: {e}")
            except Exception:
                pass

    def embed_pending(self, batch: int = 32, limit: int = 5000) -> int:
        n = 0
        while n < limit and not self.should_stop():
            rows = self.db.query("SELECT id, text FROM chunks WHERE embedding IS NULL LIMIT ?", (batch,))
            if not rows:
                break
            try:
                vecs = self.embed([r["text"][:2000] for r in rows])
            except Exception as e:
                self.db.log("index", f"Embedding unavailable: {e}", level="warn")
                break
            for r, v in zip(rows, vecs):
                arr = np.asarray(v, dtype=np.float32)
                arr /= (np.linalg.norm(arr) + 1e-9)
                self.db.execute("UPDATE chunks SET embedding=? WHERE id=?", (arr.tobytes(), r["id"]))
            n += len(rows)
        return n
