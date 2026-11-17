"""Local SQLite storage: memory, shortcuts, history, activity log, file index.

One file, WAL mode, FTS5 for full-text search. All access goes through a lock so the
asyncio thread, the voice thread and the indexer can share it safely.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from . import paths

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'fact',          -- preference | fact | instruction | project | location | website
    content TEXT NOT NULL,
    subject TEXT,                               -- optional short key, e.g. "IB course URL"
    source TEXT NOT NULL DEFAULT 'explicit',    -- explicit (you said it) | inferred (JARVIS guessed)
    confidence REAL NOT NULL DEFAULT 1.0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, subject, content='memories', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, subject) VALUES (new.id, new.content, new.subject);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, subject) VALUES('delete', old.id, old.content, old.subject);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, subject) VALUES('delete', old.id, old.content, old.subject);
  INSERT INTO memories_fts(rowid, content, subject) VALUES (new.id, new.content, new.subject);
END;

CREATE TABLE IF NOT EXISTS shortcuts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,             -- JSON definition (see shortcuts/model.py)
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS shortcut_runs (
    id INTEGER PRIMARY KEY,
    shortcut_id TEXT NOT NULL,
    started_at REAL NOT NULL,
    finished_at REAL,
    status TEXT NOT NULL,           -- running | ok | failed | cancelled
    log TEXT                        -- JSON list of step results
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    objective TEXT NOT NULL,
    route TEXT NOT NULL,            -- builtin | shortcut | agent | chat
    status TEXT NOT NULL,           -- running | ok | failed | cancelled | needs_input
    started_at REAL NOT NULL,
    finished_at REAL,
    steps TEXT,                     -- JSON list
    result TEXT,
    model TEXT,
    latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS conversation (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts);

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    ext TEXT,
    kind TEXT,
    size INTEGER,
    mtime REAL,
    sha256 TEXT,
    indexed_at REAL,
    error TEXT
);
CREATE INDEX IF NOT EXISTS files_sha ON files(sha256);
CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB                   -- float32 vector, NULL until embedded
);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text, content='chunks', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
"""


class Database:
    def __init__(self, path: Path | str | None = None):
        self.path = str(path or paths.db_path())
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        with self._lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA foreign_keys=ON")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.executescript(SCHEMA)
            self.conn.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),)
            )

    # -- low level -----------------------------------------------------------------
    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self.conn.execute(sql, tuple(params))

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, tuple(params)).fetchall()]

    def one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def transaction(self):
        db = self

        class _Tx:
            def __enter__(self_inner):
                db._lock.acquire()
                db.conn.execute("BEGIN")
                return db.conn

            def __exit__(self_inner, exc_type, exc, tb):
                try:
                    db.conn.execute("ROLLBACK" if exc_type else "COMMIT")
                finally:
                    db._lock.release()
                return False

        return _Tx()

    # -- activity log --------------------------------------------------------------
    def log(self, category: str, message: str, level: str = "info", data: Any = None) -> None:
        self.execute(
            "INSERT INTO activity(ts, level, category, message, data) VALUES (?,?,?,?,?)",
            (time.time(), level, category, message, json.dumps(data, default=str) if data is not None else None),
        )

    def recent_activity(self, limit: int = 200) -> list[dict]:
        return self.query("SELECT * FROM activity ORDER BY id DESC LIMIT ?", (limit,))

    def prune_activity(self, keep_days: int = 30) -> None:
        self.execute("DELETE FROM activity WHERE ts < ?", (time.time() - keep_days * 86400,))

    # -- tasks ----------------------------------------------------------------------
    def task_start(self, objective: str, route: str, model: str | None = None) -> int:
        cur = self.execute(
            "INSERT INTO tasks(objective, route, status, started_at, model) VALUES (?,?,?,?,?)",
            (objective, route, "running", time.time(), model),
        )
        return int(cur.lastrowid)

    def task_finish(self, task_id: int, status: str, result: str, steps: list | None = None, latency_ms: int | None = None):
        self.execute(
            "UPDATE tasks SET status=?, result=?, steps=?, finished_at=?, latency_ms=? WHERE id=?",
            (status, result, json.dumps(steps or [], default=str), time.time(), latency_ms, task_id),
        )

    def recent_tasks(self, limit: int = 50) -> list[dict]:
        rows = self.query("SELECT * FROM tasks ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["steps"] = json.loads(r["steps"]) if r.get("steps") else []
        return rows

    def close(self):
        with self._lock:
            self.conn.close()


def fts_query(text: str) -> str:
    """Turn free text into a safe FTS5 query (OR of quoted terms, prefix match on last)."""
    import re

    terms = [t for t in re.findall(r"[\w']+", text.lower()) if len(t) > 1]
    stop = {"the", "a", "an", "of", "to", "my", "and", "or", "in", "on", "for", "about", "that", "i", "me", "is", "it", "what", "do", "you"}
    terms = [t.replace("'", "") for t in terms if t not in stop] or [t.replace("'", "") for t in terms]
    if not terms:
        return '""'
    return " OR ".join(f'"{t}"*' for t in terms)
