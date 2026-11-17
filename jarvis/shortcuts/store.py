"""Shortcut persistence (SQLite), import/export and run history."""
from __future__ import annotations

import json
import time

from ..db import Database
from . import model as M


class ShortcutStore:
    def __init__(self, db: Database):
        self.db = db

    def list(self) -> list[dict]:
        rows = self.db.query("SELECT * FROM shortcuts ORDER BY name COLLATE NOCASE")
        out = []
        for r in rows:
            sc = json.loads(r["data"])
            sc["enabled"] = bool(r["enabled"])
            sc["updated_at"] = r["updated_at"]
            out.append(sc)
        return out

    def get(self, sid: str) -> dict | None:
        r = self.db.one("SELECT * FROM shortcuts WHERE id=?", (sid,))
        if not r:
            return None
        sc = json.loads(r["data"])
        sc["enabled"] = bool(r["enabled"])
        return sc

    def find_by_name(self, name: str) -> dict | None:
        from rapidfuzz import fuzz

        best, score = None, 0.0
        for sc in self.list():
            s = max(fuzz.ratio(name.lower(), sc["name"].lower()), *(fuzz.ratio(name.lower(), t.lower()) for t in sc["triggers"]))
            if s > score:
                best, score = sc, s
        return best if score >= 80 else None

    def save(self, sc: dict, created_by: str | None = None) -> dict:
        sc = M.validate(dict(sc))
        if created_by:
            sc["created_by"] = created_by
        sc.setdefault("created_by", "editor")
        enabled = 1 if sc.pop("enabled", True) else 0
        sc.pop("updated_at", None)
        now = time.time()
        existing = self.db.one("SELECT created_at FROM shortcuts WHERE id=?", (sc["id"],))
        self.db.execute(
            "INSERT INTO shortcuts(id, name, data, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, data=excluded.data, enabled=excluded.enabled, updated_at=excluded.updated_at",
            (sc["id"], sc["name"], json.dumps(sc), enabled, existing["created_at"] if existing else now, now),
        )
        self.db.log("shortcuts", f"Saved shortcut '{sc['name']}'", data={"id": sc["id"]})
        return {**sc, "enabled": bool(enabled)}

    def delete(self, sid: str) -> bool:
        cur = self.db.execute("DELETE FROM shortcuts WHERE id=?", (sid,))
        if cur.rowcount:
            self.db.log("shortcuts", f"Deleted shortcut {sid}")
        return cur.rowcount > 0

    def export(self) -> dict:
        return {"format": "jarvis-shortcuts", "version": 1, "exported_at": time.time(),
                "shortcuts": [{k: v for k, v in sc.items() if k != "updated_at"} for sc in self.list()]}

    def import_(self, payload: dict, overwrite: bool = False) -> dict:
        items = payload.get("shortcuts", payload if isinstance(payload, list) else [])
        added, skipped, errors = [], [], []
        for sc in items:
            try:
                sc = M.validate(dict(sc))
                if self.get(sc["id"]) and not overwrite:
                    skipped.append(sc["id"])
                    continue
                # Imported shortcuts with scripts/commands must be confirmed on first run.
                if M.risk_of(sc) == "high":
                    sc["trusted"] = False
                self.save(sc, created_by=sc.get("created_by", "import"))
                added.append(sc["id"])
            except M.ShortcutError as e:
                errors.append(str(e))
        return {"added": added, "skipped": skipped, "errors": errors}

    def run_started(self, sid: str) -> int:
        cur = self.db.execute("INSERT INTO shortcut_runs(shortcut_id, started_at, status) VALUES (?,?,?)",
                              (sid, time.time(), "running"))
        return int(cur.lastrowid)

    def run_finished(self, run_id: int, status: str, log: list) -> None:
        self.db.execute("UPDATE shortcut_runs SET finished_at=?, status=?, log=? WHERE id=?",
                        (time.time(), status, json.dumps(log, default=str), run_id))

    def runs(self, sid: str | None = None, limit: int = 50) -> list[dict]:
        if sid:
            rows = self.db.query("SELECT * FROM shortcut_runs WHERE shortcut_id=? ORDER BY id DESC LIMIT ?", (sid, limit))
        else:
            rows = self.db.query("SELECT * FROM shortcut_runs ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["log"] = json.loads(r["log"]) if r.get("log") else []
        return rows
