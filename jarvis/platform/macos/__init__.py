"""Real macOS implementation of the Computer interface."""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from ..base import ActionResult, AutomationError, Computer, resolve_app_name
from . import applescript as AS
from .ax import AXController
from .browser import BrowserController

log = logging.getLogger("jarvis.macos")

APP_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
            str(Path.home() / "Applications"), "/System/Library/CoreServices/Applications"]
# Spoken name -> bundle-id prefix of a running app that should answer to it when no app has that exact name.
FAMILY_ALIASES = {"arc": "company.thebrowser.", "the browser company": "company.thebrowser."}


def _seen_apps_file() -> Path:
    from ... import paths as _paths

    return _paths.data_dir() / "seen_apps.json"


def _load_seen_apps() -> dict:
    try:
        return json.loads(_seen_apps_file().read_text())
    except Exception:
        return {}


def _save_seen_apps(d: dict) -> None:
    try:
        _seen_apps_file().write_text(json.dumps(d, indent=1, sort_keys=True))
    except OSError:
        pass


def parse_lsappinfo(out: str) -> list[dict]:
    """`lsappinfo list` -> [{name, bundle_id, path}] for every running app (no permission needed)."""
    apps = []
    for block in re.split(r"(?m)^\s*\d+\)\s+", out)[1:]:
        m = re.match(r'"([^"]+)"', block)
        if not m:
            continue
        bid = re.search(r'bundleID="([^"]*)"', block)
        path = re.search(r'bundle path="([^"]*)"', block)
        apps.append({"name": m.group(1), "bundle_id": bid.group(1) if bid else "", "path": path.group(1) if path else ""})
    return apps


KNOWN_BUNDLE_IDS = {"Arc": "company.thebrowser.Browser", "Google Chrome": "com.google.Chrome", "Spotify": "com.spotify.client",
                    "Visual Studio Code": "com.microsoft.VSCode", "Brave Browser": "com.brave.Browser", "Notion": "notion.id",
                    "Microsoft Word": "com.microsoft.Word", "zoom.us": "us.zoom.xos", "Discord": "com.hnc.Discord"}
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
        """Every app JARVIS can open: installed ones (app folders and one level of subfolders, Spotlight,
        macOS's own app database by bundle id) plus everything that is running right now, wherever it lives."""
        ts, apps = self._apps_cache
        if not (apps and time.time() - ts < 600):
            names: set[str] = set()
            paths: dict[str, str] = {}

            def add(name: str, path: str) -> None:
                names.add(name)
                paths.setdefault(name, path)

            home = Path.home()
            for d in APP_DIRS + ["/Applications/Setapp", str(home / "Applications" / "Chrome Apps.localized"),
                                 str(home / "Downloads"), str(home / "Desktop")]:
                try:
                    for entry in os.scandir(d):
                        if entry.name.endswith(".app"):
                            add(entry.name[:-4], entry.path)
                        elif entry.is_dir() and d in ("/Applications", str(home / "Applications")):
                            try:     # one level down: /Applications/Browsers/Arc.app
                                for sub in os.scandir(entry.path):
                                    if sub.name.endswith(".app"):
                                        add(sub.name[:-4], sub.path)
                            except OSError:
                                pass
                except OSError:
                    continue
            try:     # Spotlight knows apps installed anywhere (other volumes, Setapp, etc.)
                out = subprocess.run(["mdfind", "kMDItemContentType == 'com.apple.application-bundle'"],
                                     capture_output=True, text=True, timeout=8).stdout
                for line in out.splitlines():
                    if line.endswith(".app") and "/Library/" not in line and ".app/" not in line[:-4]:
                        add(os.path.basename(line)[:-4], line)
            except Exception:
                pass
            for name, path in _load_seen_apps().items():  # apps seen running before, wherever they live
                if os.path.isdir(path):
                    add(name, path)
            for name, bid in KNOWN_BUNDLE_IDS.items():   # macOS's app database, works even with Spotlight off
                if name not in paths:
                    p = self._path_for_bundle_id(bid)
                    if p:
                        add(name, p)
            self._app_paths = paths
            self._apps_cache = (time.time(), sorted(names))
        # Running apps, always fresh: "I literally have it open" must always work.
        names = set(self._apps_cache[1])
        self._family_aliases = {}
        seen = None
        for app in parse_lsappinfo(_sh(["lsappinfo", "list"])):
            if app.get("path", "").endswith(".app"):
                names.add(app["name"])
                if self._app_paths.get(app["name"]) != app["path"] and "/Contents/" not in app["path"]:
                    seen = seen if seen is not None else _load_seen_apps()
                    if seen.get(app["name"]) != app["path"]:
                        seen[app["name"]] = app["path"]          # remember it, so it opens after you quit it too
                        _save_seen_apps(seen)
                self._app_paths.setdefault(app["name"], app["path"])
                for spoken, prefix in FAMILY_ALIASES.items():   # e.g. The Browser Company's browser for "arc"
                    if app.get("bundle_id", "").startswith(prefix):
                        self._family_aliases.setdefault(spoken, app["name"])
        return sorted(names)

    def resolve_app(self, spoken: str) -> str | None:
        apps = self.list_apps()
        aliases = {**getattr(self, "_family_aliases", {}), **(getattr(self, "user_aliases", None) or {})}
        return resolve_app_name(spoken, apps, aliases)

    @staticmethod
    def _path_for_bundle_id(bid: str) -> str | None:
        try:   # LaunchServices: knows every app macOS has seen, no Spotlight needed
            from AppKit import NSWorkspace  # type: ignore

            url = NSWorkspace.sharedWorkspace().URLForApplicationWithBundleIdentifier_(bid)
            if url is not None and os.path.isdir(url.path()):
                return str(url.path())
        except Exception:
            pass
        try:
            out = subprocess.run(["mdfind", f"kMDItemCFBundleIdentifier == '{bid}'"], capture_output=True, text=True,
                                 timeout=5).stdout
        except Exception:
            return None
        for line in out.splitlines():
            if line.endswith(".app") and os.path.isdir(line):
                return line
        return None

    def app_path(self, name: str) -> str | None:
        self.list_apps()
        p = getattr(self, "_app_paths", {}).get(name)
        if p and os.path.isdir(p):
            return p
        if name in KNOWN_BUNDLE_IDS:
            return self._path_for_bundle_id(KNOWN_BUNDLE_IDS[name])
        return None

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
        """Open exactly this app, by its path. Never `open -a <name>`: macOS guesses on a name it doesn't know
        exactly, which is how "Arc" opened Archive Utility."""
        path = self.app_path(name)
        if not path:
            return ActionResult.fail(f"I can't find an app called {name} on this Mac.")
        proc = subprocess.run(["open", path], capture_output=True, text=True, timeout=15)
        if proc.returncode != 0:
            return ActionResult.fail(f"Couldn't open {name}: {proc.stderr.strip() or 'macOS refused'}")
        deadline = time.monotonic() + 10
        exe_dir = path.rstrip("/") + "/Contents/MacOS/"
        while time.monotonic() < deadline:
            if name in self.running_apps() or subprocess.run(["pgrep", "-f", exe_dir], capture_output=True).returncode == 0:
                return ActionResult(True, f"{name} is open.", {"app": name, "path": path}, verified=True)
            time.sleep(0.2)
        return ActionResult.fail(f"I asked macOS to open {name}, but it didn't start.")

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

    def browser_tabs(self, browser=None):
        return self.browser.tabs(browser)

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

    def drag(self, x1, y1, x2, y2):
        from . import inputs

        return inputs.drag(x1, y1, x2, y2)

    def clipboard_get(self) -> str:
        return subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=5).stdout

    def clipboard_set(self, text: str) -> ActionResult:
        subprocess.run(["pbcopy"], input=text, text=True, timeout=5)
        return ActionResult(True, "Copied to the clipboard.", verified=self.clipboard_get() == text)

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
        args = ["open", p]
        if app:
            name = self.resolve_app(app) or app
            ap = self.app_path(name)
            if not ap:
                return ActionResult.fail(f"I can't find an app called {app} on this Mac.")
            args = ["open", "-a", ap, p]          # by path: macOS never has to guess
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

    def set_dock_autohide(self, hide):
        """Hide/show the Dock (automatic hiding), via System Events: no restart of the Dock needed."""
        val = "not (autohide of dock preferences)" if hide is None else ("true" if hide else "false")
        try:
            AS.run(f'tell application "System Events" to set autohide of dock preferences to {val}', timeout=8)
            now = AS.run('tell application "System Events" to get autohide of dock preferences', timeout=8).strip()
        except AutomationError as e:
            return ActionResult.fail(f"Couldn't change the Dock: {e}")
        hidden = now == "true"
        return ActionResult(True, "Dock hidden." if hidden else "Dock showing.", verified=(hide is None or hidden == hide))

    def empty_trash(self):
        try:
            AS.run('tell application "Finder" to empty trash', timeout=60)
            left = AS.run('tell application "Finder" to count items of trash', timeout=10).strip()
        except AutomationError as e:
            return ActionResult.fail(f"Couldn't empty the Trash: {e}")
        return ActionResult(True, "Trash emptied.", verified=(left == "0"))

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

    def paste_text(self, text):
        """Paste long text quickly, then restore whatever text was on the clipboard before."""
        old = subprocess.run(["pbpaste"], capture_output=True, timeout=5).stdout
        subprocess.run(["pbcopy"], input=text.encode("utf-8"), timeout=5)
        r = self.press_keys("cmd+v")
        time.sleep(0.35)
        subprocess.run(["pbcopy"], input=old, timeout=5)
        return ActionResult(r.ok, "Typed the text." if r.ok else r.message)

    def focused_editable(self):
        try:
            from ApplicationServices import AXUIElementCopyAttributeValue, AXUIElementCreateSystemWide  # type: ignore

            err, el = AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), "AXFocusedUIElement", None)
            if err != 0 or el is None:
                return None
            err, role = AXUIElementCopyAttributeValue(el, "AXRole", None)
            if role in ("AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"):
                return True
            err, rng = AXUIElementCopyAttributeValue(el, "AXSelectedTextRange", None)   # any editable text supports this
            return err == 0 and rng is not None
        except Exception:
            return None

    def screen_size(self):
        from AppKit import NSScreen  # type: ignore

        f = NSScreen.mainScreen().frame()
        return float(f.size.width), float(f.size.height)

    def reminders_due(self, days=1):
        from . import integrations as I
        return I.reminders_due(days)

    def open_location(self, url):
        p = subprocess.run(["open", url], capture_output=True, text=True, timeout=15)
        return ActionResult(p.returncode == 0, "Opened." if p.returncode == 0 else p.stderr.strip()[:200])

    def send_message(self, to, text):
        from . import integrations as I
        return I.send_message(to, text)

    _FRESH_CHECK = (
        "import json\n"
        "out = {}\n"
        "try:\n"
        "    from ApplicationServices import AXIsProcessTrusted\n"
        "    out['accessibility'] = bool(AXIsProcessTrusted())\n"
        "except Exception: pass\n"
        "try:\n"
        "    import Quartz\n"
        "    out['screen_recording'] = bool(Quartz.CGPreflightScreenCaptureAccess())\n"
        "except Exception: pass\n"
        "print(json.dumps(out))\n")

    def fresh_permissions(self) -> dict:
        """Ask macOS from a brand-new process. A running process can keep getting the answer from when it
        started, which is why granting access in System Settings seemed to do nothing."""
        now = time.monotonic()
        cached = getattr(self, "_fresh_cache", None)
        if cached and now - cached[0] < 2.0:
            return cached[1]
        try:
            r = subprocess.run([sys.executable, "-c", self._FRESH_CHECK], capture_output=True, text=True, timeout=15)
            res = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
        except Exception as e:
            log.warning("fresh permission check failed: %s", e)
            res = {}
        self._fresh_cache = (now, res)
        return res

    def permissions(self):
        here = {"accessibility": self.ax.trusted()}
        try:
            import Quartz  # type: ignore

            here["screen_recording"] = bool(Quartz.CGPreflightScreenCaptureAccess())
        except Exception:
            here["screen_recording"] = None
        fresh = self.fresh_permissions()
        perms = {k: fresh.get(k, v) for k, v in here.items()}
        # Granted now, but this process still has the old "no": the service must restart to use it.
        perms["needs_restart"] = any(fresh.get(k) and not here.get(k) for k in here)
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
