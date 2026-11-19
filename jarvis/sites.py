"""Find the website you mean ("my canvas homepage", "the IB website", "my school email") without guessing.

Order, fastest first:
1. Sites JARVIS already learned (instant).
2. Your browser history (Arc, Chrome, Brave, Edge, Vivaldi): the site you actually visit for that name, e.g. your school's
   *.instructure.com for "canvas". Read-only, never leaves the Mac.
3. For public names (no "my"): a background web search for the official site.
Whatever is found is remembered, so the next time is instant: JARVIS gets faster the more you use it.
"""
from __future__ import annotations

import glob
import logging
import os
import re
import sqlite3
from urllib.parse import urlparse

log = logging.getLogger("jarvis.sites")

FILLER = {"my", "the", "a", "an", "our", "school", "s", "homepage", "home", "page", "website", "site", "web", "portal",
          "dashboard", "login", "log", "in", "main", "account", "app", "online", "official", "open", "go", "to"}
HOME_WORDS = re.compile(r"\b(?:home ?page|home|dashboard|main page|website|site|portal|login)\b")
# Names whose site has a different domain than the name ("canvas" lives on instructure.com).
SYNONYMS = {
    "canvas": ["instructure", "canvas"], "managebac": ["managebac"], "ib": ["ibo.org", "managebac"],
    "schoology": ["schoology"], "blackboard": ["blackboard"], "moodle": ["moodle"], "google classroom": ["classroom.google"],
    "classroom": ["classroom.google"], "email": ["mail.google", "outlook"], "school email": ["mail.google", "outlook"],
    "gmail": ["mail.google"], "drive": ["drive.google"], "docs": ["docs.google"], "calendar": ["calendar.google"],
    "powerschool": ["powerschool"], "turnitin": ["turnitin"], "kognity": ["kognity"], "khan": ["khanacademy"],
    "quizlet": ["quizlet"], "notion": ["notion.so"], "teams": ["teams.microsoft"], "outlook": ["outlook"],
}
SKIP_HOSTS = re.compile(r"(?:^|\.)(?:google\.[a-z.]+/search|bing\.com|duckduckgo\.com|search\.|accounts\.google)")

HISTORY_GLOBS = [
    "~/Library/Application Support/Arc/User Data/*/History",
    "~/Library/Application Support/Google/Chrome/*/History",
    "~/Library/Application Support/BraveSoftware/Brave-Browser/*/History",
    "~/Library/Application Support/Microsoft Edge/*/History",
    "~/Library/Application Support/Vivaldi/*/History",
]


def terms_for(target: str) -> tuple[list[str], bool]:
    """Search terms for a spoken target, and whether you asked for the site's home page."""
    t = re.sub(r"[^\w\s.'-]", " ", target.lower())
    want_home = bool(HOME_WORDS.search(t))
    words = [w for w in re.findall(r"[\w.'-]+", t) if w not in FILLER]
    name = " ".join(words).strip()
    if not name:
        return [], want_home
    terms = list(SYNONYMS.get(name, [])) or [name.replace(" ", "")] + ([w for w in words if len(w) >= 4] if len(words) > 1 else [])
    for w in words:                          # "my canvas course" -> canvas's synonyms too
        terms += [s for s in SYNONYMS.get(w, []) if s not in terms]
    return terms, want_home


def history_files() -> list[str]:
    out = []
    for g in HISTORY_GLOBS:
        out += [p for p in glob.glob(os.path.expanduser(g)) if os.path.isfile(p)]
    return out


def search_history(target: str, files: list[str] | None = None, strict: bool = False) -> str | None:
    """The URL you most likely mean, from your browsers' history, or None."""
    terms, want_home = terms_for(target)
    if not terms:
        return None
    hosts: dict[str, dict] = {}
    for f in files if files is not None else history_files():
        try:
            # immutable=1: read even while the browser has the database open; never writes.
            con = sqlite3.connect(f"file:{f}?immutable=1", uri=True, timeout=1)
            like = " OR ".join(["url LIKE ? OR title LIKE ?"] * len(terms))
            args = [x for t in terms for x in (f"%{t}%", f"%{t}%")]
            rows = con.execute(f"SELECT url, title, visit_count FROM urls WHERE {like} ORDER BY visit_count DESC LIMIT 400",
                               args).fetchall()
            con.close()
        except sqlite3.Error as e:
            log.debug("history %s: %s", f, e)
            continue
        for url, title, visits in rows:
            p = urlparse(url)
            if p.scheme not in ("http", "https") or SKIP_HOSTS.search(p.netloc + p.path):
                continue
            host = p.netloc.lower()
            in_host = any(t.replace(" ", "") in host for t in terms)
            in_title = any(t in (title or "").lower() for t in terms)
            if not (in_host or (in_title and not strict)):
                continue
            h = hosts.setdefault(host, {"score": 0.0, "best": (0, url), "scheme": p.scheme})
            h["score"] += (visits or 1) * (3.0 if in_host else 1.0)
            if (visits or 0) > h["best"][0]:
                h["best"] = (visits or 0, url)
    if not hosts:
        return None
    host, h = max(hosts.items(), key=lambda kv: kv[1]["score"])
    # "canvas" / "my canvas homepage" -> the site's home page; something more specific -> the page you visit most.
    specific = len([w for w in re.findall(r"[\w.'-]+", target.lower()) if w not in FILLER]) > 1
    return h["best"][1] if specific and not want_home else f"{h['scheme']}://{host}/"


def is_personal(target: str) -> bool:
    return bool(re.search(r"\b(?:my|our)\b", target.lower()))


def frequent_sites(limit: int = 15, files: list[str] | None = None) -> list[tuple[str, str]]:
    """The sites you visit most (host, a page title), from browser history: context so the AI knows "your" sites."""
    hosts: dict[str, list] = {}
    for f in files if files is not None else history_files():
        try:
            con = sqlite3.connect(f"file:{f}?immutable=1", uri=True, timeout=1)
            rows = con.execute("SELECT url, title, visit_count FROM urls ORDER BY visit_count DESC LIMIT 600").fetchall()
            con.close()
        except sqlite3.Error:
            continue
        for url, title, visits in rows:
            p = urlparse(url)
            if p.scheme not in ("http", "https") or SKIP_HOSTS.search(p.netloc + p.path) or "google.com/search" in url:
                continue
            h = hosts.setdefault(p.netloc.lower(), [0, title or ""])
            h[0] += visits or 1
    top = sorted(hosts.items(), key=lambda kv: -kv[1][0])[:limit]
    return [(host, (v[1] or "")[:60]) for host, v in top]
