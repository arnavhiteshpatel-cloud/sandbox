"""Real macOS implementation of the Computer interface."""
from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

from ..base import ActionResult, AutomationError, Computer
from . import applescript as AS
from .ax import AXController
from .browser import BrowserController

APP_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
            str(Path.home() / "Applications"), "/System/Library/CoreServices/Applications"]
BROWSERS = {"Arc", "Google Chrome", "Safari", "Brave Browser", "Microsoft Edge", "Vivaldi", "Chromium", "Firefox"}


def _sh(args: list[str], timeout: float = 10) -> str:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout


class MacComputer(Computer):
    name = "macos"

    def __init__(self, default_browser: str = "Arc"):
        self.browser = BrowserController(default_browser)
        self.ax = AXController()
        self._apps_cache: tuple[float, list[str]] = (0.0, [])

    def set_default_browser(self, name: str) -> None:
        self.browser.default = name

    # --- applications -------------------------------------------------------------------
    def list_apps(self) -> list[str]:
        ts, apps = self._apps_cache
        if apps and time.time() - ts < 600:
            return apps
        names: set[str] = set()
        for d in APP_DIRS + ["/Applications/Setapp", str(Path.home() / "Applications" / "Chrome Apps.localized")]:
            try:
                for entry in os.scandir(d):
                    if entry.name.endswith(".app"):
                        names.add(entry.name[:-4])
            except OSError:
                continue
        # Spotlight knows apps installed anywhere (subfolders, other volumes, Setapp, etc.).
        try:
            out = subprocess.run(["mdfind", "kMDItemContentType == 'com.apple.application-bundle'"],
                                 capture_output=True, text=True, timeout=8).stdout
            for line in out.splitlines():
                if line.endswith(".app") and "/Library/" not in line and ".app/" not in line[:-4]:
                    names.add(os.path.basename(line)[:-4])
        except Exception:
            pass
        self._apps_cache = (time.time(), sorted(names))
        return self._apps_cache[1]

    def running_apps(self) -> list[str]:
        # `lsappinfo list` includes hidden (⌘H) apps; it is always fresh and needs no permission.
        out = _sh(["lsappinfo", "list"])
        names = re.findall(r'^\s*\d+\)\s+"([^"]+)"', out, re.M)
        return names or re.findall(r'"([^"]+)"', _sh(["lsappinfo", "visibleProcessList"]))

    def _is_running(self, name: str) -> bool:
        """Display names can differ from bundle names ("Visual Studio Code" shows as "Code")."""
        if name in self.running_apps():
            return True
        return subprocess.run(["pgrep", "-f", f"/{name}.app/Contents/MacOS/"], capture_output=True).returncode == 0

    def _pid(self, name: str) -> int | None:
        out = _sh(["lsappinfo", "info", "-only", "pid", name])
        m = re.search(r"=\s*(\d+)", out)
        if m:
            return int(m.group(1))
        out = _sh(["pgrep", "-x", name])
        return int(out.split()[0]) if out.strip() else None

    def frontmost_app(self) -> str | None:
        asn = _sh(["lsappinfo", "front"]).strip()
        if not asn:
            return None
        out = _sh(["lsappinfo", "info", "-only", "name", asn])
        m = re.search(r'="([^"]*)"', out)
        return m.group(1) if m else None

    def open_app(self, name: str) -> ActionResult:
        proc = subprocess.run(["open", "-a", name], capture_output=True, text=True, timeout=15)
        if proc.returncode != 0:
            return ActionResult.fail(f"Couldn't open {name}: {proc.stderr.strip() or 'not found'}")
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self._is_running(name):
                return ActionResult(True, f"{name} is open.", {"app": name}, verified=True)
            time.sleep(0.2)
        return ActionResult(True, f"Asked macOS to open {name}, but couldn't confirm it started.", {"app": name})

    def quit_app(self, name: str) -> ActionResult:
        try:
            AS.run(f"tell application {AS.quote(name)} to quit", timeout=10)
        except AutomationError as e:
            return ActionResult.fail(str(e))
        for _ in range(25):
            if not self._is_running(name):
                return ActionResult(True, f"Quit {name}.", verified=True)
            time.sleep(0.2)
        return ActionResult(True, f"Asked {name} to quit; it may be showing a save dialog.")

    def focus_app(self, name: str) -> ActionResult:
        return self.open_app(name)  # `open -a` activates a running app without relaunching it

    # --- browser ----------------------------------------------------------------------
    def browser_open_url(self, url, browser=None, new_tab=True):
        return self.browser.open_url(url, browser, new_tab)

    def browser_state(self, browser=None):
        return self.browser.current(browser)

    def browser_wait_ready(self, browser=None, timeout=20, url_contains=None, expected_url=None):
        return self.browser.wait_ready(browser, timeout, url_contains, expected_url)

    def browser_snapshot(self, browser=None, max_elements=120):
        try:
            return self.browser.snapshot(browser, max_elements)
        except AutomationError as e:
            # Fall back to the accessibility tree of the browser window.
            b = browser or self.browser.default
            snap = self.ui_snapshot(b, max_elements)
            snap["note"] = f"DOM access unavailable ({e}); showing the accessibility tree instead."
            snap.update(self.browser.current(b))
            return snap

    def browser_click(self, element_id=None, text=None, browser=None):
        if element_id and element_id.startswith("a"):
            return self.ui_press(element_id)
        if not element_id and text:
            snap = self.browser.snapshot(browser)
            from ...router import best_element_match

            match = best_element_match(text, snap.get("elements", []))
            if not match:
                return ActionResult.fail(f"I couldn't find “{text}” on the page.")
            element_id = match["id"]
        return self.browser.click(element_id, browser)

    def browser_type(self, element_id, text, submit=False, browser=None):
        if element_id and element_id.startswith("a"):
            res = self.ui_set_value(element_id, text)
        else:
            res = self.browser.type(element_id, text, browser)
        if res.ok and submit:
            self.focus_app(browser or self.browser.default)
            self.press_keys("return")
            time.sleep(0.6)
            res.message += " Submitted."
        return res

    def browser_scroll(self, direction="down", amount=0.8, browser=None):
        res = self.browser.scroll(direction, amount, browser)
        if not res.ok:  # JS blocked: use real scroll-wheel events
            self.focus_app(browser or self.browser.default)
            return self.scroll(direction, 8)
        return res

    def browser_nav(self, action, browser=None):
        res = self.browser.nav(action, browser)
        if not res.ok and action in ("back", "forward", "reload"):
            self.focus_app(browser or self.browser.default)
            return self.press_keys({"back": "cmd+[", "forward": "cmd+]", "reload": "cmd+r"}[action])
        return res

    def browser_read(self, browser=None, max_chars=12000):
        try:
            return self.browser.read(browser, max_chars)
        except AutomationError as e:
            snap = self.ui_snapshot(browser or self.browser.default)
            return {"text": snap.get("text", ""), "note": f"Read via accessibility tree ({e})."}

    # --- accessibility ------------------------------------------------------------------
    def ui_snapshot(self, app=None, max_elements=150):
        app = app or self.frontmost_app()
        if not app:
            return {"error": "No frontmost app."}
        pid = self._pid(app)
        if pid is None:
            return {"error": f"{app} isn't running."}
        # Chromium and Electron apps (Arc, Slack, Discord, VS Code, Notion, Spotify…) only expose their
        # full UI to accessibility when asked; native apps ignore this attribute.
        try:
            from ApplicationServices import AXUIElementSetAttributeValue  # type: ignore

            AXUIElementSetAttributeValue(self.ax.app_element(pid), "AXManualAccessibility", True)
        except Exception:
            pass
        return self.ax.snapshot(pid, app, max_elements)

    def ui_press(self, element_id):
        return self.ax.press(element_id)

    def ui_set_value(self, element_id, text):
        return self.ax.set_value(element_id, text)

    def menu_select(self, app, path):
        pid = self._pid(app)
        if pid is None:
            return ActionResult.fail(f"{app} isn't running.")
        self.focus_app(app)
        return self.ax.menu_select(pid, path)

    # --- input ----------------------------------------------------------------------------
    def press_keys(self, combo):
        from . import inputs

        return inputs.press_keys(combo)

    def type_text(self, text):
        from . import inputs

        return inputs.type_text(text)

    def click_at(self, x, y, button="left", count=1):
        from . import inputs

        return inputs.click_at(x, y, button, count)

    def scroll(self, direction="down", amount=5):
        from . import inputs

        return inputs.scroll(direction, amount)

    # --- screen -----------------------------------------------------------------------------
    def screenshot(self, max_dim=1280):
        from . import screen

        return screen.screenshot(max_dim)

    def ocr(self):
        from . import screen

        return screen.ocr_screen()

    # --- system -------------------------------------------------------------------------------
    def get_volume(self):
        try:
            return int(AS.run("output volume of (get volume settings)", timeout=5))
        except (AutomationError, ValueError):
            return None

    def set_volume(self, level=None, delta=None, mute=None):
        try:
            if mute is not None:
                AS.run(f"set volume output muted {'true' if mute else 'false'}")
                return ActionResult(True, "Muted." if mute else "Unmuted.", verified=True)
            if delta is not None:
                level = max(0, min(100, (self.get_volume() or 50) + delta))
            level = max(0, min(100, int(level if level is not None else 50)))
            AS.run(f"set volume output muted false\nset volume output volume {level}")
        except AutomationError as e:
            return ActionResult.fail(str(e))
        got = self.get_volume()
        return ActionResult(True, f"Volume {level} percent.", {"level": got}, verified=(got is not None and abs(got - level) <= 2))

    def lock_screen(self):
        try:  # Ctrl+Cmd+Q is the system "Lock Screen" shortcut
            return self.press_keys("ctrl+cmd+q")
        except Exception as e:
            return ActionResult.fail(f"Couldn't lock the screen: {e}")

    def display_sleep(self):
        subprocess.run(["pmset", "displaysleepnow"], timeout=5)
        return ActionResult(True, "Display sleeping.")

    def battery(self):
        out = _sh(["pmset", "-g", "batt"])
        m = re.search(r"(\d+)%;\s*([\w ]+?);", out)
        source = "ac" if "AC Power" in out else "battery"
        return {"percent": int(m.group(1)) if m else None, "state": m.group(2).strip() if m else None,
                "source": source, "charging": source == "ac"}

    def notify(self, title, text):
        try:
            AS.run(f"display notification {AS.quote(text)} with title {AS.quote(title)}", timeout=5)
            return ActionResult(True, "Notified.")
        except AutomationError as e:
            return ActionResult.fail(str(e))

    def run_macos_shortcut(self, name, input_text=None):
        args = ["shortcuts", "run", name]
        proc = subprocess.run(args, input=input_text, capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            return ActionResult.fail(f"The Shortcuts app couldn't run “{name}”: {proc.stderr.strip()[:200]}")
        return ActionResult(True, f"Ran the “{name}” shortcut.", {"output": proc.stdout[:2000]}, verified=True)

    def open_path(self, path, app=None):
        p = os.path.expanduser(path)
        if not os.path.exists(p):
            return ActionResult.fail(f"{path} doesn't exist.")
        args = ["open", "-a", app, p] if app else ["open", p]
        proc = subprocess.run(args, capture_output=True, text=True, timeout=15)
        if proc.returncode != 0:
            return ActionResult.fail(proc.stderr.strip())
        return ActionResult(True, f"Opened {os.path.basename(p)}.")

    def reveal_in_finder(self, path):
        subprocess.run(["open", "-R", os.path.expanduser(path)], timeout=10)
        return ActionResult(True, "Shown in Finder.")

    def arrange_windows(self, layout, apps):
        from AppKit import NSScreen  # type: ignore

        main = NSScreen.screens()[0].frame()
        vf = NSScreen.mainScreen().visibleFrame()
        top = main.size.height - (vf.origin.y + vf.size.height)  # AX uses a top-left origin
        x0, W, H = vf.origin.x, vf.size.width, vf.size.height
        n = max(1, len(apps))
        frames = {
            "halves": [(x0 + i * W / 2, top, W / 2, H) for i in range(2)],
            "thirds": [(x0 + i * W / 3, top, W / 3, H) for i in range(3)],
            "columns": [(x0 + i * W / n, top, W / n, H) for i in range(n)],
            "maximize": [(x0, top, W, H)] * n,
            "left": [(x0, top, W / 2, H)], "right": [(x0 + W / 2, top, W / 2, H)],
        }.get(layout)
        if not frames:
            return ActionResult.fail(f"Unknown layout {layout}.")
        done = []
        for app, fr in zip(apps, frames):
            pid = self._pid(app)
            if pid and self.ax.set_window_frame(pid, *fr):
                done.append(app)
        ok = len(done) == len(apps[:len(frames)])
        return ActionResult(ok, f"Arranged {', '.join(done) or 'nothing'}.", verified=ok)

    # --- system & app integrations -------------------------------------------------------------
    def media_key(self, key):
        from . import integrations as I
        return I.media_key(key)

    def set_appearance(self, dark):
        from . import integrations as I
        return I.set_appearance(dark)

    def set_wifi(self, on):
        from . import integrations as I
        return I.set_wifi(on)

    def open_settings(self, pane):
        from . import integrations as I
        return I.open_settings(pane)

    def take_screenshot(self, path=None):
        from . import integrations as I
        return I.take_screenshot(path)

    def window_action(self, action, app=None):
        from . import integrations as I

        if action == "show_desktop":
            return self.press_keys("f11")
        if action == "mission_control":
            subprocess.run(["open", "-a", "Mission Control"], timeout=5)
            return ActionResult(True, "Mission Control.")
        combo = I.WINDOW_KEYS.get(action)
        if not combo:
            return ActionResult.fail(f"Unknown window action {action}.")
        if app:
            self.focus_app(app)
            time.sleep(0.2)
        return self.press_keys(combo)

    def app_script(self, script, language="AppleScript"):
        from . import integrations as I
        return I.app_script(script, language)

    def app_dictionary(self, app, max_chars=6000):
        from . import integrations as I

        name = self.resolve_app(app) or app
        for d in APP_DIRS:
            p = os.path.join(d, name + ".app")
            if os.path.isdir(p):
                return I.app_dictionary(p, max_chars)
        return f"{app} isn't installed."

    def create_note(self, body, title=None):
        from . import integrations as I
        return I.create_note(body, title)

    def create_reminder(self, text, due_in_s=None):
        from . import integrations as I
        return I.create_reminder(text, due_in_s)

    def calendar_events(self, day_offset=0, days=1):
        from . import integrations as I
        return I.calendar_events(day_offset, days)

    def compose_email(self, to, subject, body):
        from . import integrations as I
        return I.compose_email(to, subject, body)

    def open_location(self, url):
        p = subprocess.run(["open", url], capture_output=True, text=True, timeout=15)
        return ActionResult(p.returncode == 0, "Opened." if p.returncode == 0 else p.stderr.strip()[:200])

    def send_message(self, to, text):
        from . import integrations as I
        return I.send_message(to, text)

    def permissions(self):
        perms = {"accessibility": self.ax.trusted()}
        try:
            import Quartz  # type: ignore

            perms["screen_recording"] = bool(Quartz.CGPreflightScreenCaptureAccess())
        except Exception:
            perms["screen_recording"] = None
        try:
            import AVFoundation  # type: ignore

            st = AVFoundation.AVCaptureDevice.authorizationStatusForMediaType_(AVFoundation.AVMediaTypeAudio)
            perms["microphone"] = {0: "not_determined", 1: "restricted", 2: "denied", 3: "granted"}.get(int(st), str(st))
        except Exception:
            perms["microphone"] = None
        perms["automation"] = "asked per app on first use"
        return perms

    BUNDLE_ID = "local.jarvis.assistant"

    def reset_permissions(self) -> None:
        """Forget stale grants (e.g. ones made for a previous build) so macOS asks again for this build."""
        for service in ("Accessibility", "ScreenCapture", "Microphone", "AppleEvents"):
            subprocess.run(["tccutil", "reset", service, self.BUNDLE_ID], capture_output=True, timeout=10)

    def request_permissions(self) -> None:
        try:
            from ApplicationServices import AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt  # type: ignore

            AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: True})
        except Exception:
            pass
        try:
            import Quartz  # type: ignore

            Quartz.CGRequestScreenCaptureAccess()
        except Exception:
            pass
