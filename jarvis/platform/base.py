"""The Computer interface: everything JARVIS can do to the machine.

The shortcut engine, the deterministic router and the agent only talk to this
interface. `platform/macos` is the real implementation; `platform/fake.py` is an
in-memory simulator used by unit tests (never counted as acceptance evidence).

All methods are synchronous (they block on AppleScript / AX calls); async callers use
`asyncio.to_thread`. Every mutating method returns an ActionResult that states whether
the effect was *verified*, not merely attempted.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ActionResult:
    ok: bool
    message: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    verified: bool = False   # True when we observed the post-condition, not just sent the action

    def to_dict(self) -> dict:
        return {"ok": self.ok, "message": self.message, "verified": self.verified, **({"data": self.data} if self.data else {})}

    @staticmethod
    def fail(msg: str, **data) -> "ActionResult":
        return ActionResult(False, msg, data)


class AutomationError(Exception):
    """Raised when macOS refuses an automation request (permissions, unsupported app...)."""


APP_ALIASES = {
    "vs code": "Visual Studio Code", "vscode": "Visual Studio Code", "code": "Visual Studio Code", "chrome": "Google Chrome",
    "google": "Google Chrome", "settings": "System Settings", "system preferences": "System Settings", "preferences": "System Settings",
    "word": "Microsoft Word", "excel": "Microsoft Excel", "powerpoint": "Microsoft PowerPoint", "teams": "Microsoft Teams",
    "outlook": "Microsoft Outlook", "edge": "Microsoft Edge", "brave": "Brave Browser", "app store": "App Store",
    "facetime": "FaceTime", "face time": "FaceTime", "itunes": "Music", "apple music": "Music", "files": "Finder",
    "ark": "Arc", "arch": "Arc", "arc browser": "Arc", "the arc browser": "Arc", "ark browser": "Arc",
    "imessage": "Messages", "i message": "Messages", "texts": "Messages", "text messages": "Messages", "email": "Mail",
    "calculator app": "Calculator", "notion app": "Notion", "chat gpt": "ChatGPT", "chatgpt": "ChatGPT", "claude app": "Claude",
    "spotify app": "Spotify", "zoom": "zoom.us", "quicktime": "QuickTime Player", "quick time": "QuickTime Player",
    "activity monitor": "Activity Monitor", "terminal app": "Terminal", "photos app": "Photos", "the finder": "Finder",
}
NOT_APPS = {"it", "this", "that", "them", "these", "those", "one", "the one", "the first one", "the second one", "the last one",
            "the file", "the document", "the link", "the page", "the result", "the first", "the second", "the third", "the next one",
            "the most recent one", "the latest one", "the newest one", "up", "me", "my", "a", "the"}


def resolve_app_name(spoken: str, apps: list[str]) -> str | None:
    import re as _re

    from rapidfuzz import fuzz

    if not apps:
        return None
    s = _re.sub(r"[^\w\s.'+-]", "", spoken.strip().lower())
    s = _re.sub(r"\s+", " ", s).strip()
    s = _re.sub(r"^(?:the|my)\s+", "", s)
    if not s or s in NOT_APPS or _re.fullmatch(r"(?:the )?(?:first|second|third|fourth|fifth|last|next|previous|\d+(?:st|nd|rd|th)?)(?: one| result| file)?", s):
        return None
    lower = {a.lower(): a for a in apps}
    for cand in (s, _re.sub(r"\s+(?:app|application|browser|program)$", "", s)):
        if cand in lower:
            return lower[cand]
        if cand in APP_ALIASES and APP_ALIASES[cand].lower() in lower:
            return lower[APP_ALIASES[cand].lower()]
    s = _re.sub(r"\s+(?:app|application|program)$", "", s)
    if len(s) < 3:
        return None
    # Whole-word prefix match: "visual studio" -> "Visual Studio Code", "logic" -> "Logic Pro". Unique only.
    words = s.split()
    pref = [name for low, name in lower.items()
            if len(words) <= len(low.split()) and all(lw.startswith(w) and len(w) >= 3 for w, lw in zip(words, low.split()))]
    if len(pref) == 1:
        return pref[0]
    # Close spelling of the whole name only (handles transcription slips like "spotfy"), never substrings.
    if len(s) >= 4:
        scored = sorted(((fuzz.ratio(s, low), name) for low, name in lower.items()), reverse=True)
        if scored and scored[0][0] >= 85 and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 5):
            return scored[0][1]
    return None


class Computer:
    name = "abstract"

    # --- applications ---------------------------------------------------------------
    def list_apps(self) -> list[str]: raise NotImplementedError
    def running_apps(self) -> list[str]: raise NotImplementedError
    def frontmost_app(self) -> str | None: raise NotImplementedError
    def resolve_app(self, spoken: str) -> str | None:
        """Map a spoken app name ("spotify", "vs code", "ark") to an installed app, or None.

        Deliberately strict: a wrong app is worse than asking. Never matches a fragment inside a word
        ("arc" must not open "Archive Utility") and never resolves pronouns ("open it").
        """
        return resolve_app_name(spoken, self.list_apps())

    def open_app(self, name: str) -> ActionResult: raise NotImplementedError
    def quit_app(self, name: str) -> ActionResult: raise NotImplementedError
    def focus_app(self, name: str) -> ActionResult: raise NotImplementedError

    # --- browser (DOM-level control of the user's real browser) ------------------------
    def browser_open_url(self, url: str, browser: str | None = None, new_tab: bool = True) -> ActionResult: raise NotImplementedError
    def browser_state(self, browser: str | None = None) -> dict: raise NotImplementedError
    def browser_wait_ready(self, browser: str | None = None, timeout: float = 20, url_contains: str | None = None) -> ActionResult: raise NotImplementedError
    def browser_snapshot(self, browser: str | None = None, max_elements: int = 120) -> dict: raise NotImplementedError
    def browser_click(self, element_id: str | None = None, text: str | None = None, browser: str | None = None) -> ActionResult: raise NotImplementedError
    def browser_type(self, element_id: str | None, text: str, submit: bool = False, browser: str | None = None) -> ActionResult: raise NotImplementedError
    def browser_scroll(self, direction: str = "down", amount: float = 0.8, browser: str | None = None) -> ActionResult: raise NotImplementedError
    def browser_nav(self, action: str, browser: str | None = None) -> ActionResult: raise NotImplementedError  # back|forward|reload|new_tab|close_tab
    def browser_read(self, browser: str | None = None, max_chars: int = 12000) -> dict: raise NotImplementedError

    # --- generic UI through the accessibility tree -------------------------------------
    def ui_snapshot(self, app: str | None = None, max_elements: int = 150) -> dict: raise NotImplementedError
    def ui_press(self, element_id: str) -> ActionResult: raise NotImplementedError
    def ui_set_value(self, element_id: str, text: str) -> ActionResult: raise NotImplementedError
    def menu_select(self, app: str, path: list[str]) -> ActionResult: raise NotImplementedError

    # --- raw input ------------------------------------------------------------------
    def press_keys(self, combo: str) -> ActionResult: raise NotImplementedError
    def type_text(self, text: str) -> ActionResult: raise NotImplementedError
    def click_at(self, x: float, y: float, button: str = "left", count: int = 1) -> ActionResult: raise NotImplementedError
    def scroll(self, direction: str = "down", amount: int = 5) -> ActionResult: raise NotImplementedError

    # --- screen -----------------------------------------------------------------------
    def screenshot(self, max_dim: int = 1280) -> bytes: raise NotImplementedError
    def ocr(self) -> list[dict]: raise NotImplementedError

    # --- system -----------------------------------------------------------------------
    def set_volume(self, level: int | None = None, delta: int | None = None, mute: bool | None = None) -> ActionResult: raise NotImplementedError
    def get_volume(self) -> int | None: raise NotImplementedError
    def lock_screen(self) -> ActionResult: raise NotImplementedError
    def display_sleep(self) -> ActionResult: raise NotImplementedError
    def battery(self) -> dict: raise NotImplementedError
    def notify(self, title: str, text: str) -> ActionResult: raise NotImplementedError
    def run_macos_shortcut(self, name: str, input_text: str | None = None) -> ActionResult: raise NotImplementedError
    def open_path(self, path: str, app: str | None = None) -> ActionResult: raise NotImplementedError
    def reveal_in_finder(self, path: str) -> ActionResult: raise NotImplementedError
    def arrange_windows(self, layout: str, apps: list[str]) -> ActionResult: raise NotImplementedError
    def permissions(self) -> dict: return {}

    # --- system & app integrations (work with every app) -----------------------------------
    def media_key(self, key: str) -> ActionResult: raise NotImplementedError
    """play | next | previous | brightness_up | brightness_down | keyboard_light_up | keyboard_light_down"""
    def set_appearance(self, dark: bool | None) -> ActionResult: raise NotImplementedError   # None = toggle
    def set_wifi(self, on: bool) -> ActionResult: raise NotImplementedError
    def open_settings(self, pane: str) -> ActionResult: raise NotImplementedError
    def take_screenshot(self, path: str | None = None) -> ActionResult: raise NotImplementedError
    def window_action(self, action: str, app: str | None = None) -> ActionResult: raise NotImplementedError
    """minimize | fullscreen | hide | new_window | close_window | show_desktop | mission_control"""
    def app_script(self, script: str, language: str = "AppleScript") -> ActionResult: raise NotImplementedError
    def app_dictionary(self, app: str, max_chars: int = 6000) -> str: raise NotImplementedError
    def create_note(self, body: str, title: str | None = None) -> ActionResult: raise NotImplementedError
    def create_reminder(self, text: str, due_in_s: float | None = None) -> ActionResult: raise NotImplementedError
    def calendar_events(self, day_offset: int = 0, days: int = 1) -> ActionResult: raise NotImplementedError
    def compose_email(self, to: list[str], subject: str, body: str) -> ActionResult: raise NotImplementedError
    def send_message(self, to: str, text: str) -> ActionResult: raise NotImplementedError
    def open_location(self, url: str) -> ActionResult: raise NotImplementedError   # any URL scheme (spotify:, music:, zoommtg:, …)
