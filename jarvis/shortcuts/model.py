"""Shortcut definitions: schema, validation and templating.

A shortcut is JSON:

{
  "id": "open-my-ib",
  "name": "Open My IB",
  "triggers": ["open my ib", "open ib", "go to my ib course"],
  "params": [{"name": "query", "description": "what to search"}],     # optional, used as {query}
  "steps": [
    {"action": "open_url", "url": "https://...", "browser": "Arc", "new_tab": true},
    {"action": "wait_for", "condition": {"type": "page_ready"}, "timeout": 20},
    {"action": "verify", "condition": {"type": "url_contains", "value": "example.edu"}}
  ],
  "response": "Your IB course is open.",
  "on_error": "report"          # report | continue | agent
}

Every step may also carry: "retries": n, "continue_on_error": bool, "label": "...".
Templates: "{param}" substitutes; "{param|url}" URL-encodes; "{clipboard}" is not supported on purpose.
"""
from __future__ import annotations

import re
from urllib.parse import quote_plus

# action -> (required fields, risk) ; risk "high" requires confirmation when the shortcut
# was created by voice/AI rather than typed by the user in the editor.
ACTIONS: dict[str, tuple[tuple[str, ...], str]] = {
    "open_app": (("app",), "low"),
    "quit_app": (("app",), "low"),
    "focus_app": (("app",), "low"),
    "open_url": (("url",), "low"),
    "browser": (("command",), "low"),            # back | forward | reload | new_tab | close_tab
    "wait": (("seconds",), "low"),
    "wait_for": (("condition",), "low"),
    "verify": (("condition",), "low"),
    "click": (("target",), "medium"),            # text of a button/link on the page or app
    "type": (("text",), "medium"),
    "keys": (("combo",), "medium"),
    "scroll": ((), "low"),
    "menu": (("app", "path"), "medium"),
    "open_file": (("path",), "low"),
    "reveal_file": (("path",), "low"),
    "move_file": (("src", "dst"), "medium"),
    "macos_shortcut": (("name",), "medium"),     # run a Shortcuts.app shortcut (e.g. Focus / Do Not Disturb)
    "arrange_windows": (("layout", "apps"), "low"),
    "volume": ((), "low"),
    "say": (("text",), "low"),
    "notify": (("text",), "low"),
    "run_shortcut": (("shortcut",), "low"),      # reusable blocks: call another shortcut
    "if": (("condition", "then"), "low"),
    "agent": (("instruction",), "medium"),       # hand an unpredictable step to the local AI
    "applescript": (("script",), "high"),
    "shell": (("command",), "high"),
    "set": (("var", "value"), "low"),
    "media": (("key",), "low"),                  # play | next | previous | brightness_up | brightness_down
    "system": (("command",), "low"),             # dark_mode | light_mode | wifi_on | wifi_off | open_settings | screenshot | minimize | …
    "note": (("text",), "low"),                  # Apple Notes
    "reminder": (("text",), "low"),              # Apple Reminders, optional "when": "tomorrow at 9am"
    "open_location": (("url",), "low"),          # any URL scheme: spotify:, zoommtg:, music:, …
}

CONDITIONS = {"page_ready", "url_contains", "title_contains", "text_present", "element_present", "app_running",
              "app_frontmost", "file_exists", "var_equals", "not"}


class ShortcutError(ValueError):
    pass


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "shortcut"


def validate(sc: dict) -> dict:
    """Validate and normalize a shortcut dict in place; raises ShortcutError with a readable message."""
    if not isinstance(sc, dict):
        raise ShortcutError("Shortcut must be an object.")
    name = str(sc.get("name") or "").strip()
    if not name:
        raise ShortcutError("Shortcut needs a name.")
    sc["name"] = name
    sc["id"] = sc.get("id") or slugify(name)
    triggers = sc.get("triggers") or [name]
    if isinstance(triggers, str):
        triggers = [triggers]
    sc["triggers"] = [t.strip() for t in triggers if str(t).strip()]
    if not sc["triggers"]:
        raise ShortcutError("Shortcut needs at least one trigger phrase.")
    declared = {p["name"] for p in sc.get("params", []) if isinstance(p, dict) and p.get("name")}
    for t in sc["triggers"]:
        for slot in re.findall(r"{(\w+)}", t):
            if slot not in declared:
                sc.setdefault("params", []).append({"name": slot})
                declared.add(slot)
    steps = sc.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ShortcutError("Shortcut needs at least one step.")
    _validate_steps(steps, path="steps")
    sc.setdefault("on_error", "report")
    if sc["on_error"] not in ("report", "continue", "agent"):
        raise ShortcutError("on_error must be report, continue or agent.")
    sc.setdefault("response", "")
    return sc


def _validate_steps(steps: list, path: str) -> None:
    for i, st in enumerate(steps):
        where = f"{path}[{i}]"
        if not isinstance(st, dict) or "action" not in st:
            raise ShortcutError(f"{where}: each step needs an 'action'.")
        action = st["action"]
        if action not in ACTIONS:
            raise ShortcutError(f"{where}: unknown action '{action}'. Known: {', '.join(sorted(ACTIONS))}.")
        for req in ACTIONS[action][0]:
            if req not in st:
                raise ShortcutError(f"{where}: '{action}' needs '{req}'.")
        if "condition" in st:
            _validate_condition(st["condition"], where)
        if action == "if":
            _validate_steps(st["then"], f"{where}.then")
            if st.get("else"):
                _validate_steps(st["else"], f"{where}.else")
        if action == "open_url" and not str(st["url"]).strip():
            raise ShortcutError(f"{where}: the URL is empty.")


def _validate_condition(c: dict, where: str) -> None:
    if not isinstance(c, dict) or c.get("type") not in CONDITIONS:
        raise ShortcutError(f"{where}: condition type must be one of {', '.join(sorted(CONDITIONS))}.")
    if c["type"] == "not":
        _validate_condition(c.get("condition"), where)


def risk_of(sc: dict) -> str:
    levels = {"low": 0, "medium": 1, "high": 2}
    worst = 0

    def walk(steps):
        nonlocal worst
        for st in steps:
            worst = max(worst, levels[ACTIONS[st["action"]][1]])
            if st["action"] == "if":
                walk(st.get("then", []))
                walk(st.get("else", []) or [])

    walk(sc.get("steps", []))
    return {0: "low", 1: "medium", 2: "high"}[worst]


_TPL = re.compile(r"{(\w+)(?:\|(\w+))?}")


def render(value, variables: dict):
    """Substitute {var} / {var|url} in strings, recursively in lists/dicts."""
    if isinstance(value, str):
        def sub(m):
            v = variables.get(m.group(1))
            if v is None:
                return m.group(0)
            v = str(v)
            if m.group(2) == "url":
                return quote_plus(v)
            if m.group(2) == "lower":
                return v.lower()
            return v

        return _TPL.sub(sub, value)
    if isinstance(value, list):
        return [render(v, variables) for v in value]
    if isinstance(value, dict):
        return {k: (render(v, variables) if k not in ("then", "else") else v) for k, v in value.items()}
    return value
