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


class Computer:
    name = "abstract"

    # --- applications ---------------------------------------------------------------
    def list_apps(self) -> list[str]: raise NotImplementedError
    def running_apps(self) -> list[str]: raise NotImplementedError
    def frontmost_app(self) -> str | None: raise NotImplementedError
    def resolve_app(self, spoken: str) -> str | None:
        """Map a spoken app name ("spotify", "vs code") to an installed app name."""
        from rapidfuzz import fuzz, process

        apps = self.list_apps()
        if not apps:
            return None
        s = spoken.strip().lower()
        aliases = {"vs code": "Visual Studio Code", "vscode": "Visual Studio Code", "chrome": "Google Chrome",
                   "settings": "System Settings", "system preferences": "System Settings", "word": "Microsoft Word",
                   "excel": "Microsoft Excel", "powerpoint": "Microsoft PowerPoint", "teams": "Microsoft Teams",
                   "outlook": "Microsoft Outlook", "edge": "Microsoft Edge", "brave": "Brave Browser",
                   "app store": "App Store", "facetime": "FaceTime", "itunes": "Music", "files": "Finder"}
        if s in aliases and aliases[s] in apps:
            return aliases[s]
        lower = {a.lower(): a for a in apps}
        if s in lower:
            return lower[s]
        best = process.extractOne(s, list(lower.keys()), scorer=fuzz.WRatio)
        if best and best[1] >= 88:
            return lower[best[0]]
        return None

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
