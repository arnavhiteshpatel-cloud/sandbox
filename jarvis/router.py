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


STOP_RE = re.compile(r"^(?:(?:never ?mind|ok(?:ay)?|no|wait|hey|actually|please|just|jarvis|stop)[, ]+)*"
                     r"(stop|stop it|stop that|cancel|cancel that|abort|halt|never ?mind|shut up|be quiet|quiet|enough|"
                     r"that's enough|stop talking|emergency stop|forget it)(?: please| now| jarvis)?$")

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


COMMAND_VERBS = {"open", "launch", "start", "quit", "close", "play", "pause", "scroll", "go", "click", "turn", "set", "find",
                 "search", "remind", "make", "take", "what", "whats", "minimize", "hide", "show", "switch", "type", "press",
                 "lock", "mute", "unmute", "remember", "forget", "create", "delete", "next", "skip", "stop", "volume", "look"}
FILE_WORDS = re.compile(r"\b(documents?|docs?|files?|pdfs?|papers?|notes|slides?|presentations?|decks?|spreadsheets?|sheets?|"
                        r"essays?|reports?|worksheets?|homework|assignments?|resumes?|cvs?|screenshots?|photos?|pictures?|images?|"
                        r"lab reports?|ia|syllabus|study guide|word doc|keynote|powerpoint|excel|downloads?|folder)\b")
ORDINAL_WORDS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "top": 1, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5}


def route(text: str, ctx: dict | None = None) -> Intent | None:
    """Recognize built-in commands. `ctx` carries conversation state (browser_active, etc.)."""
    it = _route(text, ctx)
    if it is None:
        # Speech recognition sometimes keeps a stray word from the wake phrase ("is open Arc", "vis scroll down").
        # Retry without it, but only when what follows clearly starts with a command.
        words = normalize(text).split()
        if len(words) >= 2 and words[0] not in COMMAND_VERBS and len(words[0]) <= 6 and words[1] in COMMAND_VERBS:
            it = _route(" ".join(words[1:]), ctx)
    return it


def _route(text: str, ctx: dict | None = None) -> Intent | None:
    ctx = ctx or {}
    s = normalize(text)
    if not s:
        return Intent("empty", text=text)
    if STOP_RE.match(s):
        return Intent("stop", text=s)
    # Speech recognition sometimes repeats you: "open arc open arc" -> "open arc".
    w = s.split()
    if len(w) >= 4 and len(w) % 2 == 0 and w[: len(w) // 2] == w[len(w) // 2:]:
        return _route(" ".join(w[: len(w) // 2]), ctx)
    # A command word with nothing after it (cut off, or you paused): ask instead of guessing.
    m = re.fullmatch(r"(open|launch|start|close|quit|play|find|search for|go to|switch to|type|click)(?: (?:the|a|an|my|up))?", s)
    if m:
        return Intent("clarify", {"question": f"{m.group(1).capitalize()} what?"}, s)

    def I(intent_name, **args):
        return Intent(intent_name, args, s)

    # --- JARVIS's own window (the menu-bar icon can be hidden behind the notch) ---------------
    m = re.fullmatch(r"(?:open|show|go to|bring up|pull up)?\s*(?:the |your |jarvis(?:'s|s)? |my )?(?:jarvis )?"
                     r"(command center|dashboard|settings|preferences|shortcuts|memory|activity)(?: page| window)?"
                     r"(?: for jarvis| for you)?", s)
    if m and (re.search(r"\b(?:jarvis|your|command center|dashboard)\b", s) or s in ("settings", "open settings")) \
            and "system" not in s:
        page = {"settings": "settings", "preferences": "settings", "shortcuts": "shortcuts", "memory": "memory",
                "activity": "activity"}.get(m.group(1), "live")
        return I("open_center", page=page)

    # --- assistant control ---------------------------------------------------------
    if re.fullmatch(r"(stop listening|mute yourself|go to sleep|mute the microphone|stop listening to me)", s):
        return I("mute_mic")
    m = re.fullmatch(r"(?:(?:switch to|enable|activate|use|go to|go into|turn on|set|put (?:it|you|me) (?:in|on|into))\s+)?(?:the\s+)?(.+?)(?:\s+mode)?(?: please| now)?", s)
    if m and m.group(1) in POWER_MODES:
        return I("power_mode", mode=POWER_MODES[m.group(1)])
    if re.fullmatch(r"(?:what(?:'s| is) (?:the |my )?)?(?:battery|power)(?: level| status| percentage)?|how much battery(?: do i have)?(?: left)?", s):
        return I("battery")
    if re.fullmatch(r"what time is it|what's the time|what is the time|time", s):
        return I("time")
    if re.fullmatch(r"what(?:'s| is) (?:the |today's )?date(?: today)?|what day is (?:it|today)|what's today", s):
        return I("date")

    # --- teaching a phrasing: "remember that when I say open arc I mean the Arc browser" -----------
    m = re.fullmatch(r"(?:remember(?: that)? |from now on |just so you know |note that )?(?:when(?:ever)?|every ?time|any ?time|each time|if) i say "
                     r"[\"']?(.+?)[\"']?,? i (?:mean|want(?: you to)?|am talking about|'m talking about) (.+)", s) \
        or re.fullmatch(r"(?:remember(?: that)? )[\"']?(.+?)[\"']? (?:means|should mean|is short for) (.+)", s)
    if m:
        return I("teach", phrase=m.group(1).strip(" ,.\"'"), meaning=m.group(2).strip(" ,.\"'"))

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
    m = re.fullmatch(r"(?:create|make|add|new|set up|record)\s+(?:a\s+)?(?:new\s+)?(?:voice\s+)?shortcut(?:\s+(?:called|named|for))?\s*(.*?)"
                     r"(?:,?\s+(?:that|which|to|where it|so it)\s+(.+))?", s)
    if m:
        return I("shortcut_create", name=m.group(1).strip(" '\"") or None, description=m.group(2))
    raw = WAKE_RE.sub("", text.strip()).strip()
    m = re.fullmatch(r"(?:please\s+)?whenever i say\s+[\"'“‘]?(.+?)[\"'”’]?\s*(?:,|:|\byou should\b|\bplease\b|\bi want you to\b)\s*(.+?)[.!]?", raw, re.I)
    if m:
        return I("shortcut_create", name=m.group(1).strip(" '\"").lower(), description=m.group(2))
    m = re.fullmatch(r"whenever i say (.+?) (open|launch|start|go to|turn|activate|arrange|play|set) (.+)", s)
    if m:
        return I("shortcut_create", name=m.group(1).strip(" '"), description=m.group(2) + " " + m.group(3))
    m = re.fullmatch(r"(?:delete|remove)\s+(?:the\s+)?(?:voice\s+)?shortcut(?:\s+(?:called|named))?\s+(.+)", s) \
        or re.fullmatch(r"(?:delete|remove)\s+(?:the\s+|my\s+)?(.+?)\s+shortcut", s)
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
    m = re.fullmatch(r"(?:turn (?:the )?)?volume (up|down|minus|plus) (?:by )?(.+?)(?: percent)?", s)
    if m and parse_number(m.group(2)) is not None:
        return I("volume", delta=parse_number(m.group(2)) * (-1 if m.group(1) in ("down", "minus") else 1))
    m = re.fullmatch(r"(?:set |change |turn )?(?:the )?volume (?:to |at )?(.+)", s)
    if m and parse_number(m.group(1)) is not None:
        return I("volume", level=parse_number(m.group(1)))
    if re.fullmatch(r"mute(?: the)?(?: volume| sound| audio| computer)?", s):
        return I("volume", mute=True)
    if re.fullmatch(r"unmute(?: the)?(?: volume| sound| audio| computer)?", s):
        return I("volume", mute=False)

    # --- everyday editing keys, in any app -----------------------------------------------------
    for pat, combo in ((r"copy(?: (?:this|that|it|the selection|that text|this text))?", "cmd+c"),
                       (r"paste(?: (?:it|that|this|here))?", "cmd+v"), (r"cut(?: (?:this|that|it))?", "cmd+x"),
                       (r"undo(?: that| it)?", "cmd+z"), (r"redo(?: that| it)?", "cmd+shift+z"),
                       (r"select (?:all|everything)", "cmd+a"), (r"save(?: (?:this|it|that|the (?:file|document)))?", "cmd+s"),
                       (r"print(?: (?:this|it|that|the (?:page|document)))?", "cmd+p"),
                       (r"(?:zoom in|make (?:it|this|the text) bigger)", "cmd+="), (r"(?:zoom out|make (?:it|this|the text) smaller)", "cmd+-"),
                       (r"(?:switch|go back) to the (?:last|previous) app", "cmd+tab")):
        if re.fullmatch(pat, s):
            return I("keys", combo=combo)

    # --- media, system and window control (any app) ------------------------------------
    if re.fullmatch(r"(?:play|pause|resume|stop the music|pause the music|play the music|pause (?:the )?(?:song|video|music)|resume (?:the )?(?:song|video|music)|play pause)", s):
        return I("media", key="play")
    if re.fullmatch(r"next one|the next one", s) and ctx.get("has_results"):
        return I("next_result")
    if re.fullmatch(r"(?:next|skip)(?: (?:song|track|this song|this track))?|play the next (?:song|track)", s):
        return I("media", key="next")
    if re.fullmatch(r"(?:previous|last|go back a) (?:song|track)|play the previous (?:song|track)", s):
        return I("media", key="previous")
    m = re.fullmatch(r"play (.+?) on spotify", s)
    if m:
        return I("spotify_search", query=m.group(1))
    if re.fullmatch(r"(?:turn (?:the )?)?brightness up|(?:make (?:the )?screen |screen )?brighter|increase (?:the )?brightness", s):
        return I("media", key="brightness_up")
    if re.fullmatch(r"(?:turn (?:the )?)?brightness down|(?:make (?:the )?screen |screen )?(?:dimmer|darker)|(?:decrease|lower|dim) (?:the )?(?:brightness|screen)", s):
        return I("media", key="brightness_down")
    m = re.fullmatch(r"(?:turn |switch )?(on|off|enable|disable)? ?(?:the )?dark mode ?(on|off)?|(?:switch to|use|enable) (dark|light) mode|toggle dark mode", s)
    if m:
        word = m.group(1) or m.group(2) or m.group(3)
        dark = None if word is None and "toggle" in s else (word in ("on", "enable", "dark") if word else True)
        return I("appearance", dark=dark)
    m = re.fullmatch(r"(?:turn |switch )?(on|off) (?:the )?wi-?fi|(?:turn |switch )?(?:the )?wi-?fi (on|off)|(enable|disable) (?:the )?wi-?fi", s)
    if m:
        return I("wifi", on=(m.group(1) or m.group(2) or m.group(3)) in ("on", "enable"))
    m = re.fullmatch(r"(?:open|show|go to)(?: the| my)? (.+?) settings|(?:open )?settings for (.+)", s)
    if m:
        return I("settings", pane=(m.group(1) or m.group(2)).strip())
    if re.fullmatch(r"(?:take|grab|capture) (?:a )?screen ?shot(?: of (?:the|my) screen)?|screenshot", s):
        return I("screenshot")
    for pat, action in ((r"minimi[sz]e(?: (?:this|the) window| this| it)?", "minimize"),
                        (r"(?:make (?:this|it|the window) )?full ?screen|(?:enter|exit|toggle) full ?screen", "fullscreen"),
                        (r"(?:open )?(?:a )?new window", "new_window"),
                        (r"close (?:this|the) window", "close_window"),
                        (r"show (?:me )?(?:the |my )?desktop|go to (?:the |my )?desktop", "show_desktop"),
                        (r"(?:open |show )?mission control|show (?:me )?all (?:my )?windows", "mission_control")):
        if re.fullmatch(pat, s):
            return I("window", action=action)
    m = re.fullmatch(r"(?:hide|auto ?hide|turn on auto ?hide for) (?:the )?dock|(show|unhide|bring back) (?:the )?dock|toggle (?:the )?dock", s)
    if m:
        return I("dock", hide=None if s.startswith("toggle") else not bool(m.group(1)))
    if re.fullmatch(r"empty (?:the |my )?(?:trash|bin|recycle bin)(?: can)?|clear (?:the |my )?trash", s):
        return I("empty_trash")
    m = re.fullmatch(r"hide (?:the )?(.+?)(?: app)?", s)
    if m:
        return I("window", action="hide", app=None if m.group(1) in ("this", "it", "this app", "this window") else m.group(1))

    if re.fullmatch(r"brief me|(?:give me |read me )?(?:my |a |the )?(?:morning |daily )?briefing|what(?:'s| does| is) my day(?: look like)?(?: today)?|"
                    r"what do i have going on(?: today)?|catch me up|what's on for today", s):
        return I("briefing")

    # --- built-in apps ----------------------------------------------------------------------
    m = re.fullmatch(r"(?:make|create|take|write|add) (?:a )?(?:new )?note(?: (?:that says|saying|that|about|:))? (.+)|note (?:down|that) (.+)", s)
    if m:
        return I("note", body=raw_after(text, r"(?:note(?:\s+(?:that says|saying|that|about|:))?|note\s+(?:down|that))\s+") or (m.group(1) or m.group(2)))
    m = re.fullmatch(r"remind me (?:to |about )?(.+)", s)
    if m:
        body, due = parse_reminder(raw_after(text, r"remind\s+me\s+(?:to\s+|about\s+)?") or m.group(1))
        return I("reminder", text=body, due_in_s=due)
    m = re.fullmatch(r"what(?:'s| is| do i have) (?:on )?(?:my )?(?:calendar|schedule|agenda)?(?: on)? ?(today|tomorrow|this week)?|(?:what do i have|what's on) (today|tomorrow|this week)|(?:read|show) (?:me )?my (?:calendar|schedule)(?: for)? ?(today|tomorrow|this week)?", s)
    if m and re.search(r"calendar|schedule|agenda|have (today|tomorrow|this week)|on (today|tomorrow|this week)", s):
        when = m.group(1) or m.group(2) or m.group(3) or "today"
        return I("calendar", when=when)

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

    # --- typing: dictation and writing for you -------------------------------------------------
    if re.fullmatch(r"(?:start |begin )?(?:take dictation|dictation(?: mode)?|dictate|type (?:what|everything) i say|start typing what i say)", s):
        return I("dictation", on=True)
    if re.fullmatch(r"(?:stop|end|exit|finish|quit) (?:dictation|dictating|typing)(?: mode)?|dictation off", s):
        return I("dictation", on=False)
    m = re.fullmatch(r"(?:write|draft|compose|type up|type out)(?: me| out)? (?:a |an |the |some |my )?(.+?)(?: (?:here|for me|in this (?:doc|document|box|field)))?", s)
    if m and not re.search(r"\b(email|e-mail|text|message|imessage|reminder|note to|shortcut)\b", m.group(1)) and len(m.group(1).split()) >= 2:
        return I("compose", what=raw_after(text, r"(?:write|draft|compose|type up|type out)\s+(?:me\s+|out\s+)?") or m.group(1))

    # --- "do it": complete the task on screen autonomously ------------------------------------
    TASK_NOUNS = (r"assignment|worksheet|quiz|form|homework|practice|questions?|task|test|exercises?|problems?|sheet|"
                  r"application|survey|activity|lab|module|lesson")
    if re.fullmatch(r"(?:can you |please )?(?:do|complete|finish|solve|answer|work through|fill (?:in|out))"
                    r"(?: (?:it|this|that|these|them|all of (?:it|this|them|these))"
                    r"| (?:all (?:of )?)?(?:the |this |these |those |my )?(?:\w+ ){0,2}(?:" + TASK_NOUNS + r"))?"
                    r"(?: (?:for me|out|in|now|please))*|fill (?:it|this|that|the form|this form) (?:out|in)(?: for me)?", s) \
            and s not in ("do", "complete", "finish", "answer", "solve"):
        return I("complete_task", request=s)

    # --- internet lookups (background; answered from search results) ---------------------------
    m = re.fullmatch(r"(?:look up|lookup|google|search (?:the web|the internet|online|google) for|search online for|search the web|"
                     r"look online for|find out|check online)(?: for| about)? (.+)", s)
    if m:
        return I("web_lookup", query=m.group(1))

    # --- files: instant search and acting on the results (no AI) -----------------------------
    m = re.fullmatch(r"(?:find|search for|search|look for|locate|where(?:'s| is| are)|get|pull up|show me) (?:me )?(?:my |the |a |an |all (?:of )?(?:my |the )?)?(.+)", s)
    if m and FILE_WORDS.search(m.group(1)) and len(m.group(1).split()) <= 9 and not re.search(r"\b(and then|then|and (?:open|tell|summari[sz]e|compare|move|organi[sz]e|read))\b", m.group(1)):
        return I("find_files", query=m.group(1))
    m = re.fullmatch(r"(?:open|show|read|play|pull up)(?: up)? (?:it|that|this|that one|this one|that file|this file|the file|the document|the result|"
                     r"(?:the )?(first|second|third|fourth|fifth|last|next|top|1st|2nd|3rd|4th|5th)(?: one| result| file| document| match)?|number (\d+))", s)
    if m:
        word, num = m.group(1), m.group(2)
        index = int(num) if num else ORDINAL_WORDS.get(word) if word in ORDINAL_WORDS else word  # None = current, "next", "last"
        return I("open_result", index=index)
    if re.fullmatch(r"(?:the )?next (?:one|result|file|match)|(?:what about )?the (?:other|next) one|another one", s):
        return I("next_result")

    # --- apps & websites ---------------------------------------------------------------
    m = re.fullmatch(r"(?:quit|close|exit|kill)\s+(?:the\s+)?(.+?)(?:\s+app)?", s)
    if m:
        return I("quit_app", name=m.group(1))
    m = re.fullmatch(r"(?:open(?: up)?|launch|start(?: up)?|run|fire up|pull up|bring up|boot up)\s+(?:the\s+)?(?:app\s+)?(.+?)(?:\s+app)?", s)
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


_NUM = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "ten": 10, "fifteen": 15, "twenty": 20,
        "thirty": 30, "forty five": 45, "half an": 0.5}


def parse_reminder(text: str, now=None) -> tuple[str, float | None]:
    """Split "call mom at 5pm" / "do homework tomorrow at 7" / "stretch in 20 minutes" into (text, seconds from now)."""
    import datetime as _dt

    now = now or _dt.datetime.now()
    t = text.strip().rstrip(".")
    m = re.search(r"\s+in (\d+|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|forty five|half an) (minutes?|mins?|hours?)$", t)
    if m:
        n = float(m.group(1)) if m.group(1).isdigit() else _NUM[m.group(1)]
        return t[:m.start()].strip(), n * (3600 if m.group(2).startswith("h") else 60)
    m = re.search(r"\s+(?:(today|tonight|tomorrow)\s*)?(?:at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?)?\s*(today|tonight|tomorrow)?$", t)
    if m and (m.group(1) or m.group(2) or m.group(5)):
        day = m.group(1) or m.group(5) or ""
        hour = int(m.group(2)) if m.group(2) else (20 if day == "tonight" else 9)
        minute = int(m.group(3) or 0)
        ampm = (m.group(4) or "").replace(".", "")
        if ampm == "pm" and hour < 12:
            hour += 12
        elif ampm == "am" and hour == 12:
            hour = 0
        elif not ampm and m.group(2) and hour < 8:
            hour += 12        # "at 5" means 5 pm
        if day == "tonight" and hour < 12:
            hour += 12
        target = now.replace(hour=hour % 24, minute=minute, second=0, microsecond=0)
        if day == "tomorrow":
            target += _dt.timedelta(days=1)
        elif target <= now:
            target += _dt.timedelta(days=1)
        return t[:m.start()].strip(), (target - now).total_seconds()
    return t, None


# --- conversation vs. computer work --------------------------------------------------------------
# A question that doesn't involve your screen, files or apps doesn't need the full agent (36 tool
# descriptions, ~3,300 tokens to process before the first word). It gets one short model call instead.
COMPUTER_OBJECT = (r"(?:screen|page|tab|tabs|window|windows|file|files|folder|folders|document|documents|doc|docs|pdf|"
                   r"email|emails|mail|inbox|message|messages|texts|desktop|downloads|calendar|reminders?|notes?|"
                   r"mac|computer|laptop|apps?|browser|clipboard|playlist|photos|homework|assignments?|form|quiz|"
                   r"worksheet|essay|slides?|presentation|spreadsheet|site|website|link|selection|paragraph|question|"
                   r"meetings?|appointments?|events?|schedule|agenda|battery|volume|wifi|wi-fi|bluetooth|music|song)")
COMPUTER_WORK = re.compile(
    r"\b(?:click|type|scroll|press|select|highlight|copy|paste|drag|download|upload|install|uninstall|bookmark|"
    r"submit|fill|log ?in|sign ?in|on (?:my|the) screen|what(?:'s| is) (?:this|that|on)|"
    r"(?:read|summari[sz]e|explain|translate|check|fix|edit|finish|answer|look at|go through) (?:this|that|it|these|the)\b|"
    r"(?:my|this|that|these|the|current|open) " + COMPUTER_OBJECT + r"\b|"
    r"\b(?:arc|safari|chrome|spotify|finder|notion|canvas|word|excel|powerpoint|keynote|pages|terminal|vs code|xcode)\b|"
    r"\b(?:does|is|in|on|of|about|says?|mean|means) (?:this|that)\b(?! (?:is|was|would|could|will))|\bthis (?:say|says|mean|means)\b|"
    r"\b(?:tabs|windows|desktop|downloads|clipboard|inbox|calendar|reminders)\b)")
DO_VERB = re.compile(r"^(?:open|go|show|start|launch|close|quit|find|search|play|turn|set|make|create|delete|move|send|"
                     r"hide|empty|log (?:out|off|in)|lock|restart|reboot|shut|sleep|minimi[sz]e|maximi[sz]e|resize|"
                     r"copy|paste|undo|redo|save|print|enable|disable|toggle|increase|decrease|lower|raise|right[- ]click|"
                     r"double[- ]click|drag|select|connect|disconnect|pair|eject|install|uninstall|update|change|rename|"
                     r"duplicate|zip|unzip|compress|convert|scroll|zoom|maximize|press|hit|tap|enter|fill|"
                     r"bring|pull|fire|boot|get|grab|fetch|take|summari[sz]e|list|sort|compare|check|look up|"
                     r"type|click|put|add|remind|schedule|switch|mute|unmute|save|rename|organi[sz]e|clean|"
                     r"download|install|book|order|buy|email|text|message|call|do (?:it|this|that|these|my|the)|complete|run)\b")
POLITE = re.compile(r"^(?:(?:can|could|would|will) you(?: please)?|please|jarvis|hey jarvis|i (?:want|need) you to|"
                    r"go ahead and|i'd like you to)\s+")
LIVE_INFO = re.compile(
    r"\b(?:weather|forecast|temperature outside|news|headlines|price|prices|stock|stocks|score|scores|won|winning|"
    r"election|today|tonight|tomorrow|yesterday|this week|this weekend|latest|current|currently|right now|recent|"
    r"recently|20[2-3]\d|open now|release date|exchange rate)\b")
CONVERSATIONAL_OPENER = re.compile(
    r"^(?:what|what's|whats|who|who's|when|where|why|how|how's|which|is|are|was|were|will|would|should|could|can|"
    r"do|does|did|tell me|explain|define|describe|guess|i|i'm|im|i've|i'd|my|me|we|we're|you|you're|it|it's|its|that|"
    r"that's|this is|there|there's|hi|hello|hey|yo|good|thanks|thank|cheers|nice|cool|great|ok|okay|yes|yeah|no|nope|"
    r"well|so|honestly|actually|lol|haha|wow|oh|hmm|any|let's|lets|imagine|pretend|"
    r"help me (?:think|come up|decide|figure out|brainstorm|understand|pick|choose))\b")
PERSONAL_LIVE = re.compile(r"\b(?:my|i|i'm|me)\b")


def classify_question(text: str, last_route: str | None = None) -> str | None:
    """'chat' (answer directly, fast), 'web' (needs current facts: look it up) or None (computer work: agent).
    Conversation is the default; only clear computer tasks go to the slower agent."""
    n = normalize(text)
    words = n.split()
    if not words or len(words) > 60:
        return None
    core = POLITE.sub("", n)
    if DO_VERB.match(core) or COMPUTER_WORK.search(n):
        return None
    # An instruction about something of yours ("crank up my tunes"), as opposed to conversation that merely
    # mentions it ("my day was rough", "I think my dog is hungry", "what's my name").
    if re.search(r"\bmy\b", core) and not CONVERSATIONAL_OPENER.match(core):
        return None
    if LIVE_INFO.search(n) and not PERSONAL_LIVE.search(n):
        return "web"
    return "chat"


# --- several commands at once: "close archive utility and open arc" -----------------------------------
SIMPLE_INTENTS = {"open", "open_url", "quit_app", "goto", "media", "spotify_search", "volume", "appearance", "window",
                  "browser_nav", "browser_scroll", "settings", "screenshot", "lock", "mute", "unmute", "dictation", "keys",
                  "lock_screen", "power_mode", "wifi", "note", "reminder"}


def split_compound(text: str, ctx: dict | None = None) -> list[tuple[str, "Intent"]] | None:
    """Split "X and Y" / "X then Y" into separate simple commands, but only when every part is one."""
    parts = [p.strip(" ,.") for p in re.split(r",?\s+(?:and then|and also|and|then|after that)\s+|,\s+", text.strip(), flags=re.I)]
    parts = [p for p in parts if p]
    if len(parts) < 2 or len(parts) > 5:
        return None
    out = []
    for p in parts:
        it = route(p, ctx)
        if it is None and out and out[-1][1].name in ("open", "quit_app", "goto") and looks_like_app_name(p) \
                and not DO_VERB.match(normalize(p)) and not CONVERSATIONAL_OPENER.match(normalize(p)):
            # "open safari and spotify": the second part borrows the verb
            verb = {"open": "open", "quit_app": "close", "goto": "switch to"}[out[-1][1].name]
            p = f"{verb} {p}"
            it = route(p, ctx)
        if it is None or it.name not in SIMPLE_INTENTS:
            return None
        out.append((p, it))
    return out


# --- websites people open by name ----------------------------------------------------------------
KNOWN_SITES = {
    "youtube": "https://www.youtube.com", "gmail": "https://mail.google.com", "google": "https://www.google.com",
    "google docs": "https://docs.google.com", "docs": "https://docs.google.com", "google drive": "https://drive.google.com",
    "drive": "https://drive.google.com", "google classroom": "https://classroom.google.com", "classroom": "https://classroom.google.com",
    "google calendar": "https://calendar.google.com", "google sheets": "https://sheets.google.com", "google slides": "https://slides.google.com",
    "netflix": "https://www.netflix.com", "reddit": "https://www.reddit.com", "twitter": "https://x.com", "instagram": "https://www.instagram.com",
    "facebook": "https://www.facebook.com", "github": "https://github.com", "chatgpt": "https://chatgpt.com", "wikipedia": "https://www.wikipedia.org",
    "amazon": "https://www.amazon.com", "linkedin": "https://www.linkedin.com", "twitch": "https://www.twitch.tv", "tiktok": "https://www.tiktok.com",
    "pinterest": "https://www.pinterest.com", "quizlet": "https://quizlet.com", "khan academy": "https://www.khanacademy.org",
    "desmos": "https://www.desmos.com/calculator", "duolingo": "https://www.duolingo.com", "canva": "https://www.canva.com",
    "figma": "https://www.figma.com", "whatsapp": "https://web.whatsapp.com", "outlook": "https://outlook.live.com", "maps": "https://maps.google.com",
    "google maps": "https://maps.google.com", "translate": "https://translate.google.com", "google translate": "https://translate.google.com",
    "spotify web": "https://open.spotify.com", "youtube music": "https://music.youtube.com", "hulu": "https://www.hulu.com",
    "disney plus": "https://www.disneyplus.com", "prime video": "https://www.primevideo.com", "wolfram alpha": "https://www.wolframalpha.com",
}


def known_site(target: str) -> str | None:
    t = re.sub(r"^(?:the|my)\s+", "", normalize(target))
    t = re.sub(r"\s+(?:website|site|web ?site|page|homepage|dot com)$", "", t)
    return KNOWN_SITES.get(t)


def looks_like_app_name(target: str) -> bool:
    """A short name ("photoshop", "final cut") rather than a reference ("it", "the first one", "my biology notes")."""
    t = normalize(target)
    t = re.sub(r"^(?:the|a|an|up)\s+", "", t)
    words = [x for x in t.split() if x not in ("the", "a", "an", "up", "app")]
    if not words or len(words[0]) < 2:
        return False
    if not words or len(words) > 3:
        return False
    if re.search(r"\b(?:it|this|that|these|those|one|my|your|our|the first|the last|next|previous|file|files|folder|doc|"
                 r"document|notes|pdf|page|link|tab|email|message|result|results)\b", t):
        return False
    return True


def split_first_step(text: str, ctx: dict | None = None) -> tuple[str, "Intent", str] | None:
    """'open canvas, find my ib 150 class, … and find week 13 homework' -> ('open canvas', <open canvas>, 'find my …').
    The first step is done instantly; the rest goes to the AI, which continues from where that step left off."""
    m = re.match(r"\s*(.+?)(?:\s*,\s*(?:and\s+)?(?:then\s+)?|\s+(?:and\s+)?then\s+|\s+and\s+(?=(?:find|go|navigate|open|click|"
                 r"search|look|read|show|get|check|scroll)\b))(.+)$", text, re.I | re.S)
    if not m:
        return None
    first, rest = m.group(1).strip(), m.group(2).strip(" ,.")
    if len(rest.split()) < 2 or len(first.split()) > 6:
        return None
    it = route(first, ctx)
    if it is None or it.name not in ("open", "goto", "open_url"):
        return None
    return first, it, rest
