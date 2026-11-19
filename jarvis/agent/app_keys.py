"""Keyboard shortcuts built into apps, plus the ones JARVIS has learned.

Pressing an app's own shortcut is faster and more reliable than clicking through its UI. JARVIS uses these directly
("toggle the sidebar" in Arc presses ⌘S, no AI involved) and gives them to the AI as context. When it needs one it
doesn't know, the AI looks it up and saves it (`learn_app_shortcut`), so next time it already knows.
Only well-established shortcuts are listed here; anything else is looked up and learned.
"""
from __future__ import annotations

import json
import re

from rapidfuzz import fuzz

BROWSER_COMMON = {
    "new tab": "cmd+t", "close tab": "cmd+w", "reopen closed tab": "cmd+shift+t", "reload page": "cmd+r",
    "back": "cmd+[", "forward": "cmd+]", "find on page": "cmd+f", "zoom in": "cmd+=", "zoom out": "cmd+-",
    "actual size": "cmd+0", "new window": "cmd+n", "private window": "cmd+shift+n", "bookmark page": "cmd+d",
    "history": "cmd+y", "address bar": "cmd+l", "first tab": "cmd+1", "last tab": "cmd+9",
    "next tab": "ctrl+tab", "previous tab": "ctrl+shift+tab", "print page": "cmd+p", "save page": "cmd+s",
}
SHORTCUTS: dict[str, dict[str, str]] = {
    "*": {  # standard macOS shortcuts (work in nearly every app)
        "copy": "cmd+c", "paste": "cmd+v", "cut": "cmd+x", "undo": "cmd+z", "redo": "cmd+shift+z", "select all": "cmd+a",
        "find": "cmd+f", "save": "cmd+s", "save as": "cmd+shift+s", "print": "cmd+p", "new": "cmd+n", "open": "cmd+o",
        "close window": "cmd+w", "quit app": "cmd+q", "hide app": "cmd+h", "minimize window": "cmd+m",
        "app settings": "cmd+,", "switch apps": "cmd+tab", "full screen": "ctrl+cmd+f", "bold": "cmd+b",
        "italic": "cmd+i", "underline": "cmd+u", "paste without formatting": "cmd+opt+shift+v",
    },
    "Arc": {**BROWSER_COMMON,
            "command bar": "cmd+t", "toggle sidebar": "cmd+s", "copy url": "cmd+shift+c", "edit url": "cmd+l",
            "little arc window": "cmd+opt+n", "pin tab": "cmd+d", "new incognito window": "cmd+shift+n"},
    "Google Chrome": {**BROWSER_COMMON, "next tab": "cmd+opt+right", "previous tab": "cmd+opt+left",
                      "developer tools": "cmd+opt+i", "show bookmarks bar": "cmd+shift+b", "downloads": "cmd+shift+j",
                      "clear browsing data": "cmd+shift+delete"},
    "Safari": {**BROWSER_COMMON, "next tab": "cmd+shift+]", "previous tab": "cmd+shift+[", "reader mode": "cmd+shift+r",
               "show sidebar": "cmd+shift+l", "downloads": "cmd+opt+l"},
    "Finder": {"new folder": "cmd+shift+n", "new finder window": "cmd+n", "go to folder": "cmd+shift+g", "get info": "cmd+i",
               "duplicate": "cmd+d", "show hidden files": "cmd+shift+.", "downloads folder": "cmd+opt+l",
               "desktop folder": "cmd+shift+d", "documents folder": "cmd+shift+o", "applications folder": "cmd+shift+a",
               "home folder": "cmd+shift+h", "icloud drive": "cmd+shift+i", "recents": "cmd+shift+f",
               "quick look": "space", "show path bar": "cmd+opt+p", "new tab": "cmd+t", "eject": "cmd+e"},
    "Spotify": {"play pause": "space", "next track": "cmd+right", "previous track": "cmd+left",
                "volume up": "cmd+up", "volume down": "cmd+down", "search": "cmd+l", "shuffle": "cmd+s", "repeat": "cmd+r"},
    "Notes": {"new note": "cmd+n", "new folder": "cmd+shift+n", "checklist": "cmd+shift+l", "search notes": "cmd+opt+f",
              "title style": "cmd+shift+t", "heading": "cmd+shift+h", "body text": "cmd+shift+b"},
    "Mail": {"new message": "cmd+n", "reply": "cmd+r", "reply all": "cmd+shift+r", "forward": "cmd+shift+f",
             "get new mail": "cmd+shift+n", "search mail": "cmd+opt+f"},
    "Messages": {"new message": "cmd+n", "search messages": "cmd+f"},
    "Visual Studio Code": {"command palette": "cmd+shift+p", "quick open file": "cmd+p", "toggle terminal": "ctrl+`",
                           "toggle sidebar": "cmd+b", "search in files": "cmd+shift+f", "comment line": "cmd+/",
                           "format document": "shift+opt+f", "go to line": "ctrl+g", "new terminal": "ctrl+shift+`"},
    "Slack": {"quick switcher": "cmd+k", "search": "cmd+g", "new message": "cmd+n", "all unreads": "cmd+shift+a",
              "threads": "cmd+shift+t", "previous channel": "cmd+["},
    "Preview": {"zoom in": "cmd+=", "zoom out": "cmd+-", "next page": "down", "rotate left": "cmd+l", "rotate right": "cmd+r",
                "show markup toolbar": "cmd+shift+a", "export as pdf": "cmd+shift+e"},
    "Microsoft Word": {"bold": "cmd+b", "italic": "cmd+i", "underline": "cmd+u", "center text": "cmd+e",
                       "word count": "cmd+shift+g", "insert page break": "cmd+return"},
    "Pages": {"word count": "cmd+shift+w", "insert page break": "fn+return"},
    "Terminal": {"new tab": "cmd+t", "new window": "cmd+n", "clear": "cmd+k"},
}
ALIASES = {"chrome": "Google Chrome", "brave browser": "Google Chrome", "microsoft edge": "Google Chrome", "vs code": "Visual Studio Code",
           "code": "Visual Studio Code"}
for _b in ("Brave Browser", "Microsoft Edge", "Vivaldi", "Chromium"):
    SHORTCUTS[_b] = SHORTCUTS["Google Chrome"]


def _learned(settings) -> dict:
    return dict(settings.get("learned_keys", {}) or {}) if settings is not None else {}


def shortcuts_for(app: str | None, settings=None) -> dict[str, str]:
    """All known shortcuts for an app: built in, then learned (learned win), then the standard macOS ones."""
    name = ALIASES.get((app or "").lower(), app or "")
    out = dict(SHORTCUTS["*"])
    out.update(SHORTCUTS.get(name, {}))
    out.update(_learned(settings).get(name, {}))
    return out


def learn(settings, app: str, action: str, combo: str) -> None:
    d = _learned(settings)
    d.setdefault(app, {})[action.strip().lower()] = combo.strip().lower()
    settings.set("learned_keys", d)


KEY = r"(?:[a-z0-9`\[\]\-=;',./\\]|return|enter|tab|space|delete|backspace|escape|esc|left|right|up|down|home|end|pageup|pagedown|f\d{1,2})"
COMBO = re.compile(r"^(?:(?:cmd|command|ctrl|control|opt|option|alt|shift|fn)\+)*" + KEY + "$")


def valid_combo(combo: str) -> bool:
    return bool(COMBO.match(combo.strip().lower()))


def match_action(text: str, app: str | None, settings=None) -> tuple[str, str] | None:
    """'toggle the sidebar' said in Arc -> ('toggle sidebar', 'cmd+s'). Strict: whole-phrase match only."""
    t = re.sub(r"^(?:please |can you |could you |jarvis,? )+", "", text.lower().strip(" .!?"))
    t = re.sub(r"\b(?:the|a|this|my)\b", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    if not t or len(t.split()) > 6:
        return None
    best = None
    for action, combo in shortcuts_for(app, settings).items():
        for form in (action, f"open {action}", f"show {action}", f"go to {action}", f"do {action}"):
            sc = fuzz.ratio(t, form)
            if sc >= 92 and (best is None or sc > best[0]):
                best = (sc, action, combo)
    return (best[1], best[2]) if best else None


def describe(app: str | None, settings=None, limit: int = 40) -> str:
    keys = shortcuts_for(app, settings)
    own = {k: v for k, v in keys.items() if k not in SHORTCUTS["*"]}
    items = list(own.items())[:limit] or list(keys.items())[:limit]
    return json.dumps(dict(items))
