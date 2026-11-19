"""Learn the way you talk.

1. Phrasings: when you say something in your own words ("pull up my browser") and the local AI works out
   that it meant one simple, safe action (open Arc), the phrasing is remembered. Next time it runs instantly
   without the AI. Saying "no" / "wrong" right afterwards forgets it. Everything is visible and deletable in
   Command Center → Memory.
2. Vocabulary: the names you use (apps, shortcuts, sites, saved memories) are fed to speech recognition so
   it hears your words correctly.
"""
from __future__ import annotations

import json
import re
import time

from rapidfuzz import fuzz

from .db import Database
from .router import match_key

# Only context-free, reversible, low-risk actions are learned. Clicks, typing and file changes depend on what is
# on screen, so they are never replayed blindly.
SAFE_TOOLS = {"open_app", "open_url", "run_shortcut", "media", "open_location"}
# Steps that may be part of a learned multi-step recipe: deterministic (no screen element ids), and checked by the
# safety policy again when replayed.
RECIPE_TOOLS = SAFE_TOOLS | {"system", "press_keys", "menu", "quit_app", "browser_nav", "scroll"}
MAX_RECIPE_STEPS = 8
SAFE_SYSTEM = {"dark_mode", "light_mode", "toggle_appearance", "open_settings", "screenshot", "minimize", "fullscreen",
               "hide", "new_window", "show_desktop", "mission_control"}
PASSIVE = {"observe", "wait", "done", "recall", "look_at_screen", "read_page", "web_search", "read_webpage",
           "app_dictionary", "list_folder", "calendar"}
CONTEXTUAL = re.compile(r"\b(it|this|that|these|those|them|one|first|second|third|last|next|previous|here|there)\b")
NEGATION = re.compile(r"^(?:(?:no|nope|wrong|not that|that's wrong|that is wrong|that's not what i (?:meant|asked|said)|"
                      r"undo that|don't do that|not what i (?:meant|wanted))\b[\s,.!]*)+", re.I)

SCHEMA = """
CREATE TABLE IF NOT EXISTS learning_declined (key TEXT PRIMARY KEY, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS learned_phrases (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    phrase TEXT NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    last_used REAL
);
"""


def describe_action(tool: str, args: dict) -> str:
    if tool == "open_app":
        return f"open {args.get('name')}"
    if tool == "open_url":
        from urllib.parse import urlparse

        return f"open {urlparse(str(args.get('url', ''))).netloc.removeprefix('www.') or args.get('url')}"
    if tool == "run_shortcut":
        return f"run your “{args.get('name')}” shortcut"
    if tool == "media":
        return {"play": "play or pause", "next": "skip to the next track", "previous": "go to the previous track"}.get(args.get("key"), str(args.get("key")))
    if tool == "system":
        return str(args.get("action", "")).replace("_", " ") + (f" {args.get('value')}" if args.get("value") else "")
    if tool == "sequence":
        parts = [describe_action(s["tool"], s["args"]) for s in args.get("steps", [])]
        return ", then ".join(parts) if parts else "nothing"
    if tool == "press_keys":
        return f"press {args.get('combo')}"
    if tool == "menu":
        return f"choose {' > '.join(args.get('path') or [])} in {args.get('app')}"
    if tool == "quit_app":
        return f"close {args.get('name')}"
    if tool == "browser_nav":
        return str(args.get("action", "")).replace("_", " ")
    return tool.replace("_", " ")


class PhraseLearner:
    def __init__(self, db: Database):
        self.db = db
        self.db.conn.executescript(SCHEMA)
        self.last_touched: tuple[int, float] | None = None   # (id, time) for "no, wrong" within a few seconds

    def candidate(self, text: str, steps: list[dict]) -> tuple[str, dict] | None:
        """The single safe action an AI run reduced the request to, if any."""
        key = match_key(text)
        if not key or len(key.split()) > 10 or CONTEXTUAL.search(key):
            return None
        actions = [s for s in steps if s["tool"] not in PASSIVE and s["tool"] not in ("app_shortcuts", "learn_app_shortcut",
                                                                                     "ask_user", "remember", "calculate")]
        done = [s for s in actions if s["ok"]]          # failed attempts the AI recovered from are not part of the recipe
        if not done or len(done) > MAX_RECIPE_STEPS:
            return None
        seq = []
        for s in done:
            args = s.get("raw_args")
            if not isinstance(args, dict):
                try:
                    args = json.loads(s["args"]) if isinstance(s["args"], str) else dict(s["args"])
                except (json.JSONDecodeError, TypeError):
                    return None
            tool = s["tool"]
            if tool == "system" and args.get("action") not in SAFE_SYSTEM:
                return None
            if tool not in RECIPE_TOOLS:
                return None                              # clicks/typing depend on the screen: never replayed blindly
            if seq and seq[-1] == {"tool": tool, "args": args}:
                continue
            seq.append({"tool": tool, "args": args})
        if len(seq) == 1:
            if seq[0]["tool"] not in SAFE_TOOLS and seq[0]["tool"] != "system":
                return ("sequence", {"steps": seq})
            return seq[0]["tool"], seq[0]["args"]
        return "sequence", {"steps": seq}

    def declined(self, text: str) -> bool:
        return self.db.one("SELECT key FROM learning_declined WHERE key=?", (match_key(text),)) is not None

    def decline(self, text: str) -> None:
        self.db.execute("INSERT OR REPLACE INTO learning_declined(key, ts) VALUES (?,?)", (match_key(text), time.time()))

    def known(self, text: str) -> bool:
        return self.db.one("SELECT id FROM learned_phrases WHERE key=?", (match_key(text),)) is not None

    def learn(self, text: str, tool: str, args: dict) -> int:
        key = match_key(text)
        now = time.time()
        self.db.execute(
            "INSERT INTO learned_phrases(key, phrase, tool, args, uses, created_at) VALUES (?,?,?,?,0,?) "
            "ON CONFLICT(key) DO UPDATE SET tool=excluded.tool, args=excluded.args, phrase=excluded.phrase",
            (key, text.strip(), tool, json.dumps(args), now))
        row = self.db.one("SELECT id FROM learned_phrases WHERE key=?", (key,))
        self.last_touched = (row["id"], now)
        self.db.log("learning", f"Learned: “{text.strip()}” → {tool} {json.dumps(args)}")
        return row["id"]

    def lookup(self, text: str) -> dict | None:
        key = match_key(text)
        if not key:
            return None
        row = self.db.one("SELECT * FROM learned_phrases WHERE key=?", (key,))
        if row is None and len(key) >= 10:
            best, score = None, 0.0
            for r in self.db.query("SELECT * FROM learned_phrases"):
                sc = fuzz.ratio(key, r["key"])
                if sc > score:
                    best, score = r, sc
            row = best if score >= 92 else None
        if row:
            self.db.execute("UPDATE learned_phrases SET uses=uses+1, last_used=? WHERE id=?", (time.time(), row["id"]))
            self.last_touched = (row["id"], time.time())
            row["args"] = json.loads(row["args"])
        return row

    def undo_recent(self, within_s: float = 25) -> dict | None:
        """Forget the phrasing that was just learned or used (after "no" / "wrong")."""
        if not self.last_touched or time.time() - self.last_touched[1] > within_s:
            return None
        row = self.db.one("SELECT * FROM learned_phrases WHERE id=?", (self.last_touched[0],))
        if row:
            self.db.execute("DELETE FROM learned_phrases WHERE id=?", (row["id"],))
            self.db.log("learning", f"Forgot: “{row['phrase']}”")
        self.last_touched = None
        return row

    def all(self) -> list[dict]:
        rows = self.db.query("SELECT * FROM learned_phrases ORDER BY COALESCE(last_used, created_at) DESC")
        for r in rows:
            r["args"] = json.loads(r["args"])
        return rows

    def delete(self, pid: int) -> bool:
        return self.db.execute("DELETE FROM learned_phrases WHERE id=?", (pid,)).rowcount > 0

    def vocabulary(self, shortcuts: list[dict], extra: list[str] | None = None, limit_chars: int = 700) -> str:
        """Words to prime speech recognition with: your apps, shortcuts, sites and saved names."""
        terms: list[str] = ["JARVIS"] + list(extra or [])
        for sc in shortcuts:
            terms.append(sc["name"])
        for r in self.all()[:40]:
            a = r["args"]
            if a.get("name"):
                terms.append(str(a["name"]))
            elif str(a.get("url", "")).startswith("http"):
                from urllib.parse import urlparse

                terms.append(urlparse(a["url"]).netloc.removeprefix("www."))
        for r in self.db.query("SELECT subject FROM memories WHERE subject IS NOT NULL ORDER BY updated_at DESC LIMIT 20"):
            terms.append(r["subject"])
        for r in self.db.query("SELECT result FROM tasks WHERE result LIKE 'Opening %' ORDER BY id DESC LIMIT 60"):
            terms.append(r["result"][8:].rstrip("."))
        seen, out = set(), []
        for t in terms:
            t = (t or "").strip()
            if t and t.lower() not in seen and len(t) < 40:
                seen.add(t.lower())
                out.append(t)
        return ", ".join(out)[:limit_chars]
