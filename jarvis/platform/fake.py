"""In-memory simulated computer for unit tests and Linux development.

THIS IS NOT THE REAL THING. Results produced against FakeComputer are never counted as
acceptance-test evidence. It exists so the shortcut engine, router and agent loop can be
tested deterministically (including failure injection) without a Mac.
"""
from __future__ import annotations

from urllib.parse import urlparse

from .base import ActionResult, Computer

# A tiny "web": url -> page with elements; links navigate to other urls.
DEFAULT_SITES: dict[str, dict] = {
    "https://ib.example.edu/course": {
        "title": "IB Biology HL — Course Home",
        "elements": [
            {"role": "link", "name": "Home", "href": "https://ib.example.edu/course"},
            {"role": "link", "name": "Assignments", "href": "https://ib.example.edu/course/assignments"},
            {"role": "link", "name": "Grades", "href": "https://ib.example.edu/course/grades"},
            {"role": "input:text", "name": "Search course"},
        ],
        "text": "Welcome to IB Biology HL. Announcements: Lab report due Friday.",
    },
    "https://ib.example.edu/course/assignments": {
        "title": "Assignments",
        "elements": [
            {"role": "link", "name": "Internal Assessment Draft (due Nov 20)", "href": "https://ib.example.edu/a/3"},
            {"role": "link", "name": "Enzyme Lab Report (due Nov 14)", "href": "https://ib.example.edu/a/2"},
            {"role": "link", "name": "Cell Respiration Quiz (due Nov 2)", "href": "https://ib.example.edu/a/1"},
        ],
        "text": "Upcoming: Internal Assessment Draft due Nov 20. Past: Enzyme Lab Report, Cell Respiration Quiz.",
    },
    "https://ib.example.edu/a/3": {
        "title": "Internal Assessment Draft",
        "elements": [{"role": "button", "name": "Submit"}, {"role": "link", "name": "Back to assignments",
                                                           "href": "https://ib.example.edu/course/assignments"}],
        "text": "Instructions: Write a 2,000-word draft of your IA research question, methodology and preliminary data. "
                "Include a risk assessment. Submit as PDF by Nov 20, 23:59.",
    },
}


class FakeComputer(Computer):
    name = "simulated"

    def __init__(self, sites: dict | None = None):
        self.apps = ["Arc", "Safari", "Spotify", "Finder", "Notes", "Visual Studio Code", "System Settings", "Google Chrome"]
        self.running: list[str] = ["Finder"]
        self.front: str | None = "Finder"
        self.sites = sites or DEFAULT_SITES
        self.tabs: list[dict] = []
        self.history: list[str] = []
        self.volume = 50
        self.log: list[str] = []
        self.fail_next: dict[str, int] = {}   # method name -> number of times to fail (failure injection)
        self._ids: dict[str, dict] = {}
        self.scroll_y = 0

    def _maybe_fail(self, op: str) -> ActionResult | None:
        if self.fail_next.get(op, 0) > 0:
            self.fail_next[op] -= 1
            return ActionResult.fail(f"simulated failure in {op}")
        return None

    # apps
    def list_apps(self): return list(self.apps)
    def running_apps(self): return list(self.running)
    def frontmost_app(self): return self.front

    def open_app(self, name):
        if f := self._maybe_fail("open_app"):
            return f
        if name not in self.apps:
            return ActionResult.fail(f"{name} not installed")
        if name not in self.running:
            self.running.append(name)
        self.front = name
        self.log.append(f"open_app:{name}")
        return ActionResult(True, f"{name} is open.", {"app": name}, verified=True)

    def quit_app(self, name):
        if name in self.running:
            self.running.remove(name)
        self.log.append(f"quit_app:{name}")
        return ActionResult(True, f"Quit {name}.", verified=True)

    def focus_app(self, name):
        return self.open_app(name)

    # browser
    @property
    def tab(self) -> dict | None:
        return self.tabs[-1] if self.tabs else None

    def _page(self) -> dict:
        t = self.tab
        return self.sites.get(t["url"], {"title": urlparse(t["url"]).netloc, "elements": [], "text": ""}) if t else {}

    def browser_open_url(self, url, browser=None, new_tab=True):
        if f := self._maybe_fail("browser_open_url"):
            return f
        b = browser or "Arc"
        self.open_app(b)
        if "://" not in url:
            url = "https://" + url
        if new_tab or not self.tabs:
            self.tabs.append({"url": url, "back": [], "fwd": []})
        else:
            self.tab["back"].append(self.tab["url"])
            self.tab["url"] = url
        self.log.append(f"open_url:{url}")
        return ActionResult(True, f"Opened {url} in {b}", {"url": url})

    def browser_state(self, browser=None):
        t = self.tab
        return {"url": t["url"], "title": self._page().get("title")} if t else {"url": None, "title": None}

    def browser_wait_ready(self, browser=None, timeout=20, url_contains=None, expected_url=None):
        st = self.browser_state()
        if url_contains and url_contains not in (st["url"] or ""):
            return ActionResult(False, f"Page at {st['url']} doesn't match", st)
        return ActionResult(True, f"Loaded: {st['title']}", st, verified=True)

    def browser_snapshot(self, browser=None, max_elements=120):
        page = self._page()
        self._ids = {}
        els = []
        for i, e in enumerate(page.get("elements", [])[:max_elements], 1):
            eid = f"w{i}"
            self._ids[eid] = e
            els.append({"id": eid, **e, "in_view": True})
        st = self.browser_state()
        return {**st, "ready": "complete", "elements": els, "text": page.get("text", "")}

    def browser_click(self, element_id=None, text=None, browser=None):
        if f := self._maybe_fail("browser_click"):
            return f
        if not self._ids:
            self.browser_snapshot()
        if element_id is None and text:
            from ..router import best_element_match

            m = best_element_match(text, [{"id": k, **v} for k, v in self._ids.items()])
            if not m:
                return ActionResult.fail(f"I couldn't find “{text}” on the page.")
            element_id = m["id"]
        e = self._ids.get(element_id)
        if not e:
            return ActionResult.fail("element not found (page changed?)")
        self.log.append(f"click:{e['name']}")
        if e.get("href"):
            self.tab["back"].append(self.tab["url"])
            self.tab["url"] = e["href"]
            self._ids = {}
            return ActionResult(True, f"Clicked “{e['name']}” — page changed.", self.browser_state(), verified=True)
        return ActionResult(True, f"Clicked “{e['name']}”.")

    def browser_type(self, element_id, text, submit=False, browser=None):
        self.log.append(f"type:{text}")
        return ActionResult(True, "Typed the text.", verified=True)

    def browser_scroll(self, direction="down", amount=0.8, browser=None):
        self.scroll_y += 800 if direction == "down" else -800
        self.log.append(f"scroll:{direction}")
        return ActionResult(True, f"Scrolled {direction}.", verified=True)

    def browser_nav(self, action, browser=None):
        t = self.tab
        if action == "back" and t and t["back"]:
            t["fwd"].append(t["url"])
            t["url"] = t["back"].pop()
        elif action == "forward" and t and t["fwd"]:
            t["back"].append(t["url"])
            t["url"] = t["fwd"].pop()
        elif action == "new_tab":
            self.tabs.append({"url": "about:blank", "back": [], "fwd": []})
        elif action == "close_tab" and self.tabs:
            self.tabs.pop()
        self._ids = {}
        self.log.append(f"nav:{action}")
        return ActionResult(True, action, self.browser_state())

    def browser_read(self, browser=None, max_chars=12000):
        page = self._page()
        return {**self.browser_state(), "text": page.get("text", "")[:max_chars]}

    # generic UI
    def ui_snapshot(self, app=None, max_elements=150):
        return {"app": app or self.front, "window": "Window", "elements": [{"id": "a1", "role": "Button", "name": "OK"}]}

    def ui_press(self, element_id):
        self.log.append(f"press:{element_id}")
        return ActionResult(True, f"Pressed {element_id}.")

    def ui_set_value(self, element_id, text):
        return ActionResult(True, "Entered the text.", verified=True)

    def menu_select(self, app, path):
        self.log.append("menu:" + ">".join(path))
        return ActionResult(True, "Selected.")

    def press_keys(self, combo):
        self.log.append(f"keys:{combo}")
        return ActionResult(True, f"Pressed {combo}.")

    def type_text(self, text):
        self.log.append(f"text:{text}")
        return ActionResult(True, "Typed.")

    def click_at(self, x, y, button="left", count=1):
        return ActionResult(True, "Clicked.")

    def scroll(self, direction="down", amount=5):
        return ActionResult(True, "Scrolled.")

    def screenshot(self, max_dim=1280):
        return b""

    def ocr(self):
        return [{"text": "Simulated screen", "x": 0, "y": 0, "w": 100, "h": 20, "center": [50, 10]}]

    def set_volume(self, level=None, delta=None, mute=None):
        if delta is not None:
            self.volume = max(0, min(100, self.volume + delta))
        elif level is not None:
            self.volume = level
        return ActionResult(True, f"Volume {self.volume} percent.", verified=True)

    def get_volume(self): return self.volume
    def lock_screen(self): self.log.append("lock"); return ActionResult(True, "Locked.")
    def display_sleep(self): return ActionResult(True, "Display sleeping.")
    def battery(self): return {"percent": 80, "source": "ac", "charging": True, "state": "charging"}
    def notify(self, title, text): return ActionResult(True, "Notified.")

    def run_macos_shortcut(self, name, input_text=None):
        self.log.append(f"macos_shortcut:{name}")
        return ActionResult(True, f"Ran {name}.")

    def open_path(self, path, app=None):
        self.log.append(f"open_path:{path}")
        return ActionResult(True, "Opened.")

    def reveal_in_finder(self, path): return ActionResult(True, "Shown.")

    def arrange_windows(self, layout, apps):
        self.log.append(f"arrange:{layout}:{','.join(apps)}")
        return ActionResult(True, "Arranged.", verified=True)

    def permissions(self):
        return {"accessibility": None, "screen_recording": None, "microphone": None, "simulated": True}
