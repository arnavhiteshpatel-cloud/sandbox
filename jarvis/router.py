"""Level 1: deterministic command recognition (no LLM).

Turns a transcript into an Intent when the command can be recognized reliably. Anything
not recognized with confidence is returned as None and goes to the local AI agent.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from rapidfuzz import fuzz

WAKE_RE = re.compile(r"^\s*(?:(?:hey|hi|ok|okay|yo)[\s,]+)?(?:jarvis|jervis|jarvas|travis|jarvi|javis)\b[\s,.!?:]*", re.I)
FILLER_START = re.compile(
    r"^(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need)\s+you\s+to\s+|i'?d\s+like\s+you\s+to\s+|go\s+ahead\s+and\s+|now\s+|and\s+|okay\s+|ok\s+|so\s+)+",
    re.I,
)
FILLER_END = re.compile(r"(?:[\s,]+(?:please|for me|thanks|thank you|now|jarvis))+[\s.!?]*$", re.I)

NUM_WORDS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
             "ten": 10, "fifteen": 15, "twenty": 20, "twenty five": 25, "thirty": 30, "forty": 40, "fifty": 50,
             "sixty": 60, "seventy": 70, "seventy five": 75, "eighty": 80, "ninety": 90, "hundred": 100, "a hundred": 100,
             "one hundred": 100, "half": 50, "max": 100, "maximum": 100}
ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
            "ninth": 9, "tenth": 10, "last": -1, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5}


def normalize(text: str) -> str:
    """Clean a transcript for matching while keeping domain names intact."""
    s = text.strip().replace("’", "'").replace("“", '"').replace("”", '"')
    s = WAKE_RE.sub("", s)
    # Collapse dotted acronyms: "I.B." -> "ib", "U.S." -> "us"
    s = re.sub(r"\b((?:[A-Za-z]\.){2,})", lambda m: m.group(1).replace(".", ""), s)
    s = s.lower()
    s = re.sub(r"[!?;\"]+", " ", s)
    s = re.sub(r",", " ", s)
    s = re.sub(r"\.(?=\s|$)", " ", s)  # sentence periods, but not "youtube.com"
    s = re.sub(r"\s+", " ", s).strip()
    s = FILLER_START.sub("", s)
    s = FILLER_END.sub("", s)
    # Join spelled-out letters: "open my i b" -> "open my ib" (only runs of 2+ single letters)
    s = re.sub(r"\b(?:[a-z] ){1,}[a-z]\b", lambda m: m.group(0).replace(" ", "") if len(m.group(0)) <= 11 else m.group(0), s)
    return s.strip()


def match_key(text: str) -> str:
    """Aggressive form used for shortcut-trigger comparison."""
    s = normalize(text)
    s = re.sub(r"[^\w\s{}']", " ", s)
    s = re.sub(r"\b(the|a|an)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def parse_number(s: str) -> int | None:
    s = s.strip().lower().replace("%", "").replace(" percent", "")
    if s.isdigit():
        return int(s)
    return NUM_WORDS.get(s)


def looks_like_domain(s: str) -> bool:
    return bool(re.fullmatch(r"(https?://)?[\w-]+(\.[\w-]+)+(/\S*)?", s.strip()))


def spoken_to_url(s: str) -> str | None:
    t = s.strip().lower().replace(" dot ", ".").replace(" slash ", "/")
    t = re.sub(r"\s+", "", t) if " dot " in s.lower() or re.search(r"\.\w{2,}$", t) else t
    return t if looks_like_domain(t) else None


ELEMENT_NOISE = re.compile(r"\b(the|a|an|on|button|link|tab|page|section|option|menu|item|icon)\b")


def best_element_match(query: str, elements: list[dict], min_score: float = 80) -> dict | None:
    """Pick the page/UI element the user named, only when the match is unambiguous."""
    q = ELEMENT_NOISE.sub(" ", query.lower())
    q = re.sub(r"\s+", " ", q).strip()
    if not q:
        return None
    scored = []
    for e in elements:
        name = (e.get("name") or "").lower().strip()
        if not name or e.get("disabled"):
            continue
        if name == q:
            score = 100.0
        else:
            score = max(fuzz.ratio(q, name), fuzz.token_set_ratio(q, name) - 4 if len(name) < 60 else 0,
                        fuzz.partial_ratio(q, name) - 8 if len(q) >= 4 else 0)
            if name.startswith(q) and len(q) >= 4:
                score = max(score, 92)
        if e.get("in_view") is False:
            score -= 3
        scored.append((score, e))
    if not scored:
        return None
    scored.sort(key=lambda t: -t[0])
    best_score, best = scored[0]
    if best_score < min_score:
        return None
    if len(scored) > 1:
        second_score, second = scored[1]
        same_name = (second.get("name") or "").lower() == (best.get("name") or "").lower()
        if best_score < 100 and best_score - second_score < 6 and not same_name:
            return None  # ambiguous: let the agent decide or ask
    return best


@dataclass
class Intent:
    name: str
    args: dict[str, Any] = field(default_factory=dict)
    text: str = ""

    def __repr__(self):
        return f"Intent({self.name}, {self.args})"


STOP_RE = re.compile(r"^(stop|stop it|stop that|cancel|cancel that|abort|halt|never ?mind|shut up|be quiet|quiet|enough|that's enough|stop talking|emergency stop)$")

POWER_MODES = {"battery saver": "battery_saver", "battery saving": "battery_saver", "low power": "battery_saver",
               "power saving": "battery_saver", "balanced": "balanced", "normal": "balanced",
               "max performance": "max_performance", "maximum performance": "max_performance",
               "performance": "max_performance", "high performance": "max_performance", "full power": "max_performance"}

SPOKEN_KEYS = {"command": "cmd", "control": "ctrl", "option": "opt", "shift": "shift", "enter": "return",
               "return": "return", "escape": "escape", "tab": "tab", "space": "space", "delete": "delete",
               "backspace": "delete", "up": "up", "down": "down", "left": "left", "right": "right"}


def spoken_combo(s: str) -> str | None:
    parts = [p for p in re.split(r"[\s+-]+", s.lower()) if p and p not in ("and", "plus", "key", "the")]
    out = []
    for p in parts:
        if p in SPOKEN_KEYS:
            out.append(SPOKEN_KEYS[p])
        elif len(p) == 1 or re.fullmatch(r"f\d{1,2}", p):
            out.append(p)
        else:
            return None
    return "+".join(out) if out else None


def route(text: str, ctx: dict | None = None) -> Intent | None:
    """Recognize built-in commands. `ctx` carries conversation state (browser_active, etc.)."""
    ctx = ctx or {}
    s = normalize(text)
    if not s:
        return Intent("empty", text=text)
    if STOP_RE.match(s):
        return Intent("stop", text=s)

    def I(intent_name, **args):
        return Intent(intent_name, args, s)

    # --- assistant control ---------------------------------------------------------
    if re.fullmatch(r"(stop listening|mute yourself|go to sleep|mute the microphone|stop listening to me)", s):
        return I("mute_mic")
    m = re.fullmatch(r"(?:switch to|enable|activate|use|go to|turn on|set)\s+(?:the\s+)?(.+?)(?:\s+mode)?", s)
    if m and m.group(1) in POWER_MODES:
        return I("power_mode", mode=POWER_MODES[m.group(1)])
    if re.fullmatch(r"(?:what(?:'s| is) (?:the |my )?)?(?:battery|power)(?: level| status| percentage)?|how much battery(?: do i have)?(?: left)?", s):
        return I("battery")
    if re.fullmatch(r"what time is it|what's the time|what is the time|time", s):
        return I("time")
    if re.fullmatch(r"what(?:'s| is) (?:the |today's )?date(?: today)?|what day is (?:it|today)|what's today", s):
        return I("date")

    # --- memory ----------------------------------------------------------------------
    m = re.fullmatch(r"remember (?:that )?(.+)", s)
    if m:
        return I("remember", content=raw_after(text, r"remember\s+(?:that\s+)?") or m.group(1))
    m = re.fullmatch(r"forget (?:that |about |what i said about )?(.+)", s)
    if m:
        return I("forget", query=m.group(1))
    m = re.fullmatch(r"what do you (?:remember|know) about (.+)|what did i (?:tell|say to) you about (.+)", s)
    if m:
        return I("recall", query=m.group(1) or m.group(2))

    # --- shortcuts -------------------------------------------------------------------
    m = re.fullmatch(r"(?:create|make|add|new|set up|record)\s+(?:a\s+)?(?:new\s+)?(?:voice\s+)?shortcut(?:\s+(?:called|named|for))?\s*(.*)", s)
    if m:
        return I("shortcut_create", name=m.group(1).strip() or None)
    raw = WAKE_RE.sub("", text.strip()).strip()
    m = re.fullmatch(r"(?:please\s+)?whenever i say\s+[\"'“‘]?(.+?)[\"'”’]?\s*(?:,|:|\byou should\b|\bplease\b|\bi want you to\b)\s*(.+?)[.!]?", raw, re.I)
    if m:
        return I("shortcut_create", name=m.group(1).strip(" '\"").lower(), description=m.group(2))
    m = re.fullmatch(r"whenever i say (.+?) (open|launch|start|go to|turn|activate|arrange|play|set) (.+)", s)
    if m:
        return I("shortcut_create", name=m.group(1).strip(" '"), description=m.group(2) + " " + m.group(3))
    m = re.fullmatch(r"(?:delete|remove)\s+(?:the\s+)?(?:voice\s+)?shortcut(?:\s+(?:called|named))?\s+(.+)", s)
    if m:
        return I("shortcut_delete", name=m.group(1))
    if re.fullmatch(r"(?:list|show|what are)(?: me)? (?:all )?(?:of )?my shortcuts", s):
        return I("shortcut_list")

    # --- system ----------------------------------------------------------------------
    if re.fullmatch(r"lock (?:the |my )?(?:screen|computer|mac|laptop)", s):
        return I("lock_screen")
    if re.fullmatch(r"(?:turn (?:off|down) the display|sleep (?:the )?display|display off)", s):
        return I("display_sleep")
    if re.fullmatch(r"(?:turn (?:it|the volume|volume) up|volume up|louder|increase (?:the )?volume|raise (?:the )?volume)", s):
        return I("volume", delta=10)
    if re.fullmatch(r"(?:turn (?:it|the volume|volume) down|volume down|quieter|softer|decrease (?:the )?volume|lower (?:the )?volume)", s):
        return I("volume", delta=-10)
    m = re.fullmatch(r"(?:set |change |turn )?(?:the )?volume (?:to |at )?(.+)", s)
    if m and parse_number(m.group(1)) is not None:
        return I("volume", level=parse_number(m.group(1)))
    if re.fullmatch(r"mute(?: the)?(?: volume| sound| audio| computer)?", s):
        return I("volume", mute=True)
    if re.fullmatch(r"unmute(?: the)?(?: volume| sound| audio| computer)?", s):
        return I("volume", mute=False)

    # --- browser follow-ups (cheap, deterministic) -----------------------------------
    browser_ctx = ctx.get("browser_active", False)
    m = re.fullmatch(r"scroll(?: the page)?\s*(down|up)?(?:\s+(?:a bit|a little|more|some))?|page (down|up)", s)
    if m:
        return I("browser_scroll", direction=m.group(1) or m.group(2) or "down")
    m = re.fullmatch(r"(?:scroll|go|jump) to the (top|bottom)(?: of the page)?", s)
    if m:
        return I("browser_scroll", direction=m.group(1))
    if re.fullmatch(r"(?:go )?back|go back(?: a page| one page)?|previous page", s):
        return I("browser_nav", action="back")
    if re.fullmatch(r"go forward|forward|next page", s) and browser_ctx:
        return I("browser_nav", action="forward")
    if re.fullmatch(r"(?:reload|refresh)(?: the| this)?(?: page| tab)?", s):
        return I("browser_nav", action="reload")
    if re.fullmatch(r"(?:open )?(?:a )?new tab", s):
        return I("browser_nav", action="new_tab")
    if re.fullmatch(r"close (?:this |the |current )?tab", s):
        return I("browser_nav", action="close_tab")
    m = re.fullmatch(r"(?:click|press|tap|select|hit)(?: on)? (.+)", s)
    if m and not spoken_combo(m.group(1)):
        return I("click", target=m.group(1))
    m = re.fullmatch(r"(?:press|hit)(?: the)? (.+?)(?: key| keys)?", s)
    if m and spoken_combo(m.group(1)):
        return I("keys", combo=spoken_combo(m.group(1)))
    m = re.fullmatch(r"type (.+)", s)
    if m:
        return I("type", text=raw_after(text, r"type\s+") or m.group(1))

    # --- apps & websites ---------------------------------------------------------------
    m = re.fullmatch(r"(?:quit|close|exit|kill)\s+(?:the\s+)?(.+?)(?:\s+app)?", s)
    if m:
        return I("quit_app", name=m.group(1))
    m = re.fullmatch(r"(?:open|launch|start|run|fire up|pull up|bring up)\s+(?:the\s+)?(?:app\s+)?(.+?)(?:\s+app)?", s)
    if m:
        target = m.group(1)
        url = spoken_to_url(target)
        if url:
            return I("open_url", url=url)
        return I("open", target=target)
    m = re.fullmatch(r"(?:switch to|go to|show me|show|focus)\s+(?:the\s+)?(.+?)(?:\s+app)?", s)
    if m:
        target = m.group(1)
        url = spoken_to_url(target)
        if url:
            return I("open_url", url=url, new_tab=not browser_ctx)
        return I("goto", target=target)
    return None


def raw_after(original: str, verb_rx: str) -> str | None:
    """Text after a command verb, with the user's original casing and punctuation."""
    o = WAKE_RE.sub("", original.strip())
    o = FILLER_START.sub("", o)
    m = re.search(r"(?i)\b" + verb_rx + r"(.+)$", o)
    return m.group(1).strip().rstrip(".") if m else None


def text_after(original: str, normalized_tail: str) -> str:
    """Recover original casing/punctuation for free text (e.g. 'type Hello, World')."""
    o = WAKE_RE.sub("", original.strip())
    idx = o.lower().find(normalized_tail[:12].lower())
    return o[idx:].strip().rstrip(".") if idx >= 0 else normalized_tail


def ordinal_in(s: str) -> int | None:
    for w, n in ORDINALS.items():
        if re.search(rf"\b{w}\b", s):
            return n
    m = re.search(r"\bnumber (\d+)\b", s)
    return int(m.group(1)) if m else None
