"""Turn a spoken description into shortcut steps.

Common phrasings are parsed deterministically. Anything else is converted by the local LLM
into the same JSON schema and validated before it can be saved. The draft is always read
back to you before saving.
"""
from __future__ import annotations

import json
import re

from ..router import normalize, spoken_to_url
from . import model as M

THIS_URL = re.compile(r"\b(this|the current|the same|current)\s+(url|page|site|website|link|address|tab)\b")
SPLIT = re.compile(r"\s*(?:,\s*and then|,\s*then|\band then\b|\bthen\b|\band\b|,)\s*")
DND = re.compile(r"\b(do not disturb|dnd|focus mode|focus)\b")
ARRANGE = re.compile(r"\b(arrange|tile|split|organi[sz]e)\b.*\bwindows?\b")


def parse_description(desc: str, resolve_app, current_url: str | None, clipboard_url: str | None,
                      default_browser: str = "Arc") -> tuple[list[dict] | None, list[str]]:
    """Return (steps or None, notes). None means: ask the LLM."""
    text = normalize(desc)
    # "that opens arc and spotify" -> "open arc and spotify"; third-person verbs from "a shortcut that opens…"
    text = re.sub(r"^(?:that|which|it|to|so it|where it|it should|you should|should)\s+", "", text)
    text = re.sub(r"\b(open|launch|start|play|turn|set|go|close|quit|switch|show|mute|unmute|navigate|visit|load|"
                  r"arrange|activate|say|tell)s\b", r"\1", text)
    text = re.sub(r"\bgoes\b", "go", text)
    steps: list[dict] = []
    notes: list[str] = []
    browser = default_browser
    opened_apps: list[str] = []
    last_verb = None
    for part in [p for p in SPLIT.split(text) if p]:
        part = part.strip()
        if last_verb and resolve_app(part) and not re.match(r"(?:open|launch|start|activate|close|quit|go|turn|set|play)\b", part):
            part = f"{last_verb} {part}"           # "open arc and spotify": spotify borrows "open"
        m = re.fullmatch(r"(?:close|quit)\s+(.+)", part)
        if m and resolve_app(m.group(1)):
            steps.append({"action": "quit_app", "app": resolve_app(m.group(1))})
            last_verb = "close"
            continue
        m = re.fullmatch(r"(?:turn (?:on|off) |switch to |enable |disable )?(?:the )?(dark|light) mode(?: (?:on|off))?|"
                         r"(?:turn )?dark mode (on|off)|(?:turn )?(on|off) dark mode", part)
        if m:
            on = (m.group(1) == "dark") if m.group(1) else (m.group(2) or m.group(3)) == "on"
            if m.group(1) == "dark" and re.search(r"\boff\b", part):
                on = False
            steps.append({"action": "system", "command": "dark_mode" if on else "light_mode"})
            continue
        m = re.fullmatch(r"(?:play|pause|resume)(?: (?:the )?music)?|(?:next|skip)(?: song| track)?", part)
        if m:
            steps.append({"action": "media", "key": "next" if re.match(r"next|skip", part) else "play"})
            continue
        m = re.fullmatch(r"(?:open|launch|start|activate)\s+(?:up\s+)?(.+)", part)
        if m:
            last_verb = "open"
        if m and not THIS_URL.search(part):
            target = m.group(1)
            url = spoken_to_url(target)
            if url:
                steps.append({"action": "open_url", "url": url, "browser": browser})
                continue
            app = resolve_app(target)
            if app:
                if app in ("Arc", "Google Chrome", "Safari", "Brave Browser", "Microsoft Edge"):
                    browser = app
                steps.append({"action": "open_app", "app": app})
                opened_apps.append(app)
                continue
            if DND.search(part):
                pass
            else:
                return None, notes
        if THIS_URL.search(part) or re.match(r"(?:go to|navigate to|open|visit|load)\b", part):
            url = None
            if THIS_URL.search(part):
                url = current_url or clipboard_url
                if url:
                    notes.append(f"Using the page currently open in {browser}: {url}" if url == current_url
                                 else f"Using the link on your clipboard: {url}")
                else:
                    notes.append("I couldn't see a URL to use. Paste it into the shortcut editor.")
                    url = "about:blank#paste-your-url-in-the-editor"
            else:
                tail = re.sub(r"^(?:go to|navigate to|open|visit|load)\s+", "", part)
                url = spoken_to_url(tail)
                if not url:
                    return None, notes
            # A preceding "open Arc" is redundant with open_url in Arc; keep it simple.
            if steps and steps[-1].get("action") == "open_app" and steps[-1]["app"] == browser:
                steps.pop()
            steps.append({"action": "open_url", "url": url, "browser": browser, "new_tab": True})
            continue
        if DND.search(part):
            steps.append({"action": "macos_shortcut", "name": "JARVIS Focus On", "continue_on_error": True})
            notes.append("Do Not Disturb runs your Shortcuts-app shortcut named “JARVIS Focus On”. "
                         "macOS has no public API for Focus, so create that shortcut once with a “Set Focus” action.")
            continue
        if ARRANGE.search(part):
            apps = opened_apps or [browser]
            steps.append({"action": "arrange_windows", "layout": "halves" if len(apps) <= 2 else "columns", "apps": apps})
            continue
        m = re.fullmatch(r"(?:set (?:the )?volume to|volume)\s+(\d+)(?:\s*percent)?", part)
        if m:
            steps.append({"action": "volume", "level": int(m.group(1))})
            continue
        m = re.fullmatch(r"(?:say|tell me)\s+(.+)", part)
        if m:
            steps.append({"action": "say", "text": m.group(1)})
            continue
        return None, notes  # unknown phrase: LLM
    return (steps or None), notes


LLM_PROMPT = """Convert the user's description of a voice shortcut into JSON steps.
Allowed actions and fields:
- open_app {app}; quit_app {app}; open_url {url, browser, new_tab}; browser {command: back|forward|reload|new_tab|close_tab}
- wait {seconds}; wait_for {condition, timeout}; click {target}; type {text, target?, submit?}; keys {combo e.g. "cmd+t"}
- scroll {direction}; open_file {path}; macos_shortcut {name}; arrange_windows {layout: halves|thirds|columns|maximize, apps}
- volume {level}; say {text}; agent {instruction}  (use agent for anything unpredictable)
Conditions: {"type": "url_contains"|"title_contains"|"text_present"|"app_running"|"page_ready", "value": ...}
Rules: never invent URLs; if a URL is needed but not given, use "ASK_USER". Default browser: {browser}.
Return only JSON: {"steps": [...], "response": "short confirmation sentence"}.
Description: {desc}"""


def llm_prompt(desc: str, browser: str) -> str:
    return LLM_PROMPT.replace("{browser}", browser).replace("{desc}", desc)


def parse_llm_json(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def describe(sc: dict) -> str:
    """Short spoken summary of what a shortcut does."""
    parts = []
    for st in sc.get("steps", []):
        a = st["action"]
        if a == "open_app":
            parts.append(f"open {st['app']}")
        elif a == "open_url":
            host = re.sub(r"^https?://(www\.)?", "", st["url"]).split("/")[0]
            parts.append(f"open {host} in {st.get('browser', 'your browser')}")
        elif a == "macos_shortcut":
            parts.append(f"run the “{st['name']}” shortcut")
        elif a == "arrange_windows":
            parts.append("arrange the windows")
        elif a == "say":
            parts.append(f"say “{st['text']}”")
        elif a == "agent":
            parts.append(f"have me {st['instruction']}")
        elif a == "quit_app":
            parts.append(f"close {st['app']}")
        elif a == "system":
            parts.append({"dark_mode": "turn on dark mode", "light_mode": "turn on light mode", "wifi_on": "turn Wi-Fi on",
                          "wifi_off": "turn Wi-Fi off", "screenshot": "take a screenshot"}.get(st.get("command"),
                                                                                            str(st.get("command", "")).replace("_", " ")))
        elif a == "media":
            parts.append({"play": "play or pause the music", "next": "skip to the next track", "previous": "go back a track"}.get(
                st.get("key"), str(st.get("key", "")).replace("_", " ")))
        elif a == "volume":
            parts.append(f"set the volume to {st.get('level')}%" if st.get("level") is not None else "change the volume")
        elif a == "keys":
            parts.append(f"press {st['combo']}")
        elif a == "type":
            parts.append(f"type “{st['text'][:40]}”")
        elif a == "open_location":
            parts.append(f"open {st['url'].split(':')[0].capitalize()}")
        else:
            parts.append(a.replace("_", " "))
    if not parts:
        return "do nothing"
    return ", ".join(parts[:-1]) + (" and " if len(parts) > 1 else "") + parts[-1]


def draft(name: str, triggers: list[str] | None, steps: list[dict], response: str | None = None) -> dict:
    sc = {"name": name.strip().title() if name.islower() else name.strip(), "triggers": triggers or [name.lower()],
          "steps": steps, "response": response or "", "on_error": "agent"}
    if sc["triggers"] and not sc["triggers"][0].startswith(("open", "start", "run", "go", "launch")) and len(sc["triggers"][0].split()) <= 3:
        pass
    return M.validate(sc)
