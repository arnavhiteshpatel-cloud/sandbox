"""Notice routines and offer to turn them into shortcuts ("You often open Arc, open Spotify and turn on dark
mode together. Want a shortcut for that?"). This is the shortcut side of learning how you work.

Only simple, repeatable actions are recorded (opening apps/sites, shortcuts, media, appearance, Settings panes).
A pattern is offered when it happened on at least 3 different days; each pattern is offered at most once, and
declined patterns are never offered again.
"""
from __future__ import annotations

import json
import time
from collections import defaultdict

from .db import Database

SCHEMA = """
CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    step TEXT NOT NULL,
    label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS action_log_ts ON action_log(ts);
CREATE TABLE IF NOT EXISTS suggestion_log (
    key TEXT PRIMARY KEY,
    status TEXT NOT NULL,        -- offered | accepted | declined
    ts REAL NOT NULL
);
"""

SESSION_GAP_S = 15 * 60
MIN_DAYS = 3
MIN_GAP_BETWEEN_OFFERS_S = 4 * 3600


class Suggester:
    def __init__(self, db: Database):
        self.db = db
        self.db.conn.executescript(SCHEMA)

    def record(self, step: dict, label: str) -> None:
        self.db.execute("INSERT INTO action_log(ts, step, label) VALUES (?,?,?)", (time.time(), json.dumps(step, sort_keys=True), label))

    def _sessions(self, days: int = 21) -> list[list[dict]]:
        rows = self.db.query("SELECT * FROM action_log WHERE ts > ? ORDER BY ts", (time.time() - days * 86400,))
        sessions: list[list[dict]] = []
        last = 0.0
        for r in rows:
            if not sessions or r["ts"] - last > SESSION_GAP_S:
                sessions.append([])
            # collapse immediate repeats ("open arc", "open arc")
            if not sessions[-1] or sessions[-1][-1]["step"] != r["step"]:
                sessions[-1].append(r)
            last = r["ts"]
        return sessions

    def find(self, existing_shortcuts: list[dict], now: float | None = None) -> dict | None:
        now = now or time.time()
        last_offer = self.db.one("SELECT max(ts) AS t FROM suggestion_log")["t"] or 0
        if now - last_offer < MIN_GAP_BETWEEN_OFFERS_S:
            return None
        handled = {r["key"] for r in self.db.query("SELECT key FROM suggestion_log")}
        existing = {json.dumps([json.dumps(s, sort_keys=True) for s in sc.get("steps", [])]) for sc in existing_shortcuts}
        days_seen: dict[tuple, set] = defaultdict(set)
        labels: dict[tuple, list[str]] = {}
        for sess in self._sessions():
            day = time.strftime("%Y-%m-%d", time.localtime(sess[0]["ts"]))
            for n in (4, 3, 2):
                for i in range(len(sess) - n + 1):
                    gram = tuple(r["step"] for r in sess[i:i + n])
                    if len(set(gram)) < n:
                        continue
                    days_seen[gram].add(day)
                    labels[gram] = [r["label"] for r in sess[i:i + n]]
        best = None
        for gram, days in days_seen.items():
            key = json.dumps(list(gram))
            if len(days) < MIN_DAYS or key in handled or json.dumps(list(gram)) in existing:
                continue
            score = (len(gram), len(days))
            if best is None or score > best[0]:
                best = (score, gram, key)
        if best is None:
            return None
        _, gram, key = best
        return {"key": key, "steps": [json.loads(s) for s in gram], "labels": labels[gram], "days": len(days_seen[gram])}

    def mark(self, key: str, status: str) -> None:
        self.db.execute("INSERT INTO suggestion_log(key, status, ts) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status, ts=excluded.ts",
                        (key, status, time.time()))


def describe_steps(labels: list[str]) -> str:
    if len(labels) == 1:
        return labels[0]
    return ", ".join(labels[:-1]) + " and " + labels[-1]
