"""Long-term memory: things you explicitly told JARVIS, plus clearly-labelled inferences.

JARVIS only claims to remember what is in this table. Recall is full-text (FTS5) so it
works with the LLM unloaded.
"""
from __future__ import annotations

import json
import re
import time

from .db import Database, fts_query

KIND_HINTS = [
    ("preference", re.compile(r"\b(i (?:prefer|like|love|hate|want|always|never|usually)|my favou?rite|use .+ (?:for|instead))\b")),
    ("website", re.compile(r"\b(https?://|www\.|\.com\b|\.edu\b|\.org\b|website|url|portal)\b")),
    ("location", re.compile(r"\b(folder|directory|is (?:in|at|under)|located|path|~/)\b")),
    ("project", re.compile(r"\b(project|repo|repository|research|thesis|ia\b|extended essay)\b")),
    ("instruction", re.compile(r"\b(whenever|when i|always|never|don't|do not|make sure)\b")),
]


def guess_kind(content: str) -> str:
    low = content.lower()
    for kind, rx in KIND_HINTS:
        if rx.search(low):
            return kind
    return "fact"


class Memory:
    def __init__(self, db: Database):
        self.db = db

    def add(self, content: str, kind: str | None = None, subject: str | None = None,
            source: str = "explicit", confidence: float = 1.0) -> dict:
        content = content.strip()
        if not content:
            raise ValueError("empty memory")
        content = re.sub(r"^(?:my|i)\b", lambda m: m.group(0), content)
        # Rewrite first person into a stored statement about the user ("I prefer X" -> "User prefers X")
        stored = _third_person(content)
        dup = self.db.one("SELECT * FROM memories WHERE lower(content)=lower(?)", (stored,))
        now = time.time()
        if dup:
            self.db.execute("UPDATE memories SET updated_at=?, source=?, confidence=? WHERE id=?",
                            (now, source if source == "explicit" else dup["source"], max(confidence, dup["confidence"]), dup["id"]))
            return self.get(dup["id"])
        cur = self.db.execute(
            "INSERT INTO memories(kind, content, subject, source, confidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (kind or guess_kind(content), stored, subject, source, confidence, now, now),
        )
        self.db.log("memory", f"Saved ({source}): {stored}")
        return self.get(int(cur.lastrowid))

    def get(self, mid: int) -> dict | None:
        return self.db.one("SELECT * FROM memories WHERE id=?", (mid,))

    def update(self, mid: int, **fields) -> dict | None:
        allowed = {k: v for k, v in fields.items() if k in ("content", "kind", "subject", "source", "confidence")}
        if not allowed:
            return self.get(mid)
        sets = ", ".join(f"{k}=?" for k in allowed)
        self.db.execute(f"UPDATE memories SET {sets}, updated_at=? WHERE id=?", (*allowed.values(), time.time(), mid))
        return self.get(mid)

    def delete(self, mid: int) -> bool:
        return self.db.execute("DELETE FROM memories WHERE id=?", (mid,)).rowcount > 0

    def search(self, query: str, limit: int = 8) -> list[dict]:
        if not query.strip():
            return self.all(limit)
        q = fts_query(query)
        try:
            return self.db.query(
                "SELECT m.*, bm25(memories_fts) AS score FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid "
                "WHERE memories_fts MATCH ? ORDER BY score LIMIT ?", (q, limit))
        except Exception:
            return self.db.query("SELECT * FROM memories WHERE content LIKE ? LIMIT ?", (f"%{query}%", limit))

    def all(self, limit: int = 500) -> list[dict]:
        return self.db.query("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?", (limit,))

    def forget(self, query: str) -> list[dict]:
        hits = self.search(query, 3)
        for h in hits[:1]:
            self.delete(h["id"])
        return hits[:1]

    def export(self) -> str:
        return json.dumps({"format": "jarvis-memory", "version": 1, "memories": self.all(100000)}, indent=2)

    def context_for(self, text: str, limit: int = 6) -> list[str]:
        """Relevant memories to include in an LLM prompt (always labelled with their source)."""
        rows = self.search(text, limit)
        instr = self.db.query("SELECT * FROM memories WHERE kind='instruction' ORDER BY updated_at DESC LIMIT 5")
        seen, out = set(), []
        for r in instr + rows:
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            tag = "you told me" if r["source"] == "explicit" else f"inferred, confidence {r['confidence']:.1f}"
            out.append(f"- {r['content']} ({tag})")
        return out


_PRONOUNS = [
    (r"^i am\b", "User is"), (r"^i'm\b", "User is"), (r"^i have\b", "User has"), (r"^i've\b", "User has"),
    (r"^i (\w+)", None), (r"^my\b", "User's"),
]


def _third_person(s: str) -> str:
    s = s.strip().rstrip(".")
    low = s.lower()
    for pat, rep in _PRONOUNS:
        m = re.match(pat, low)
        if not m:
            continue
        if rep is None:
            verb = m.group(1)
            verb3 = verb + ("es" if verb.endswith(("s", "sh", "ch", "x", "o")) else "s") if not verb.endswith("s") else verb
            if verb in ("can", "will", "should", "must", "might", "would", "could", "don't", "do"):
                verb3 = {"don't": "doesn't", "do": "does"}.get(verb, verb)
            return "User " + verb3 + s[m.end():]
        return rep + s[m.end():]
    s = re.sub(r"\bmy\b", "the user's", s, flags=re.I)
    return s[0].upper() + s[1:] if s else s
