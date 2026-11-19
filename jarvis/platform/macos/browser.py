"""Control the user's real browser (Arc by default) via AppleScript + injected JavaScript.

Why not Playwright? Playwright launches a separate browser profile without your logins,
so "open my IB" would land on a login page. Driving your actual Arc keeps your sessions.

Supported: Arc, Google Chrome, Brave Browser, Microsoft Edge, Vivaldi (Chromium dictionary)
and Safari. Chrome/Brave/Edge/Safari need "Allow JavaScript from Apple Events" enabled
(Chrome: View > Developer; Safari: Develop menu) for DOM-level control; URL navigation
works without it. If JavaScript is unavailable, the agent falls back to the accessibility
tree and screenshots.
"""
from __future__ import annotations

import json
import time
from urllib.parse import urlparse

from ..base import ActionResult, AutomationError
from . import applescript as AS
from . import browser_js as JS

CHROMIUM = {"Arc", "Google Chrome", "Brave Browser", "Microsoft Edge", "Vivaldi", "Chromium"}
SAFARI = {"Safari"}


def _is_safari(b: str) -> bool:
    return b in SAFARI


class BrowserController:
    def __init__(self, default_browser: str = "Arc"):
        self.default = default_browser
        self.js_available: dict[str, bool] = {}

    def _b(self, browser: str | None) -> str:
        return browser or self.default

    # --- primitives ---------------------------------------------------------------------
    def js(self, code: str, browser: str | None = None, timeout: float = 15) -> str:
        b = self._b(browser)
        if _is_safari(b):
            script = f'tell application "Safari" to do JavaScript {AS.quote(code)} in current tab of front window'
        else:
            script = f'tell application {AS.quote(b)} to tell active tab of front window to execute javascript {AS.quote(code)}'
        try:
            out = AS.run(script, timeout=timeout)
            self.js_available[b] = True
            return out
        except AutomationError as e:
            msg = str(e)
            if "JavaScript" in msg and ("Apple Events" in msg or "turned off" in msg or "allow" in msg.lower()):
                self.js_available[b] = False
                raise AutomationError(
                    f"{b} blocks JavaScript from Apple Events. Enable it in {b}'s Developer menu "
                    f"(Allow JavaScript from Apple Events) for full page control."
                ) from e
            raise

    def js_json(self, code: str, browser: str | None = None, timeout: float = 15) -> dict:
        raw = self.js(code, browser, timeout)
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {"raw": raw[:2000]}

    def window_count(self, browser: str | None = None) -> int:
        b = self._b(browser)
        try:
            return int(AS.run(f'tell application {AS.quote(b)} to count of windows', timeout=5) or 0)
        except (AutomationError, ValueError):
            return 0

    def current(self, browser: str | None = None) -> dict:
        b = self._b(browser)
        if _is_safari(b):
            script = 'tell application "Safari" to return (URL of current tab of front window) & linefeed & (name of current tab of front window)'
        else:
            script = f'tell application {AS.quote(b)} to return (URL of active tab of front window) & linefeed & (title of active tab of front window)'
        try:
            out = AS.run(script, timeout=5)
        except AutomationError as e:
            return {"url": None, "title": None, "error": str(e)}
        url, _, title = out.partition("\n")
        return {"url": url or None, "title": title or None}

    def tabs(self, browser: str | None = None, limit: int = 25) -> list[dict]:
        """Titles and URLs of the tabs in the front window (context for the AI: "switch to my email tab")."""
        b = self._b(browser)
        if _is_safari(b):
            script = ('tell application "Safari" to set out to ""\n'
                      'tell application "Safari" to repeat with t in tabs of front window\n'
                      'set out to out & (URL of t) & tab & (name of t) & linefeed\nend repeat\nreturn out')
        else:
            script = (f'set out to ""\ntell application {AS.quote(b)}\nrepeat with t in tabs of front window\n'
                      f'set out to out & (URL of t) & tab & (title of t) & linefeed\nend repeat\nend tell\nreturn out')
        try:
            raw = AS.run(script, timeout=5)
        except AutomationError:
            return []
        out = []
        for line in raw.splitlines()[:limit]:
            url, _, title = line.partition("\t")
            if url:
                out.append({"url": url, "title": title})
        return out

    # --- navigation ------------------------------------------------------------------
    def open_url(self, url: str, browser: str | None = None, new_tab: bool = True) -> ActionResult:
        b = self._b(browser)
        if "://" not in url:
            url = "https://" + url
        q = AS.quote(url)
        if _is_safari(b):
            if new_tab:
                script = f'''tell application "Safari"
  activate
  if (count of windows) = 0 then make new document
  tell front window to set current tab to (make new tab with properties {{URL:{q}}})
end tell'''
            else:
                script = f'tell application "Safari" to activate\ntell application "Safari" to set URL of current tab of front window to {q}'
        else:
            if new_tab:
                script = f'''tell application {AS.quote(b)}
  activate
  if (count of windows) = 0 then make new window
  tell front window to make new tab with properties {{URL:{q}}}
end tell'''
            else:
                script = f'''tell application {AS.quote(b)}
  activate
  if (count of windows) = 0 then make new window
  set URL of active tab of front window to {q}
end tell'''
        try:
            AS.run(script, timeout=15)
        except AutomationError as e:
            return ActionResult.fail(f"Couldn't open the page in {b}: {e}")
        return ActionResult(True, f"Opened {url} in {b}", {"url": url, "browser": b})

    def wait_ready(self, browser: str | None = None, timeout: float = 20, url_contains: str | None = None,
                   expected_url: str | None = None) -> ActionResult:
        """Poll until the tab finished loading; then verify where we actually are."""
        b = self._b(browser)
        deadline = time.monotonic() + timeout
        state: dict = {}
        delay = 0.15
        js_ok = self.js_available.get(b, True)
        while time.monotonic() < deadline:
            state = self.current(b)
            ready = None
            if js_ok:
                try:
                    st = self.js_json(JS.STATE, b, timeout=5)
                    ready = st.get("ready")
                    state.update({k: st.get(k) for k in ("url", "title") if st.get(k)})
                except AutomationError:
                    js_ok = False
            url = state.get("url") or ""
            url_ok = (url_contains is None or url_contains.lower() in url.lower())
            if url and url_ok and (ready == "complete" or (not js_ok and url not in ("", "about:blank"))):
                break
            time.sleep(delay)
            delay = min(delay * 1.5, 0.6)
        url = state.get("url") or ""
        if url_contains and url_contains.lower() not in url.lower():
            return ActionResult(False, f"Page loaded at {url or 'an unknown address'}, which doesn't match '{url_contains}'.", state)
        if expected_url:
            exp_host = urlparse(expected_url if "://" in expected_url else "https://" + expected_url).netloc.lower()
            got_host = urlparse(url).netloc.lower()
            if exp_host and got_host and exp_host.removeprefix("www.") != got_host.removeprefix("www."):
                return ActionResult(True, f"Opened, but the site redirected to {got_host} (perhaps a login page).",
                                    {**state, "redirected": True}, verified=True)
        if not url:
            return ActionResult(False, "Timed out waiting for the page.", state)
        return ActionResult(True, f"Loaded: {state.get('title') or url}", state, verified=True)

    def nav(self, action: str, browser: str | None = None) -> ActionResult:
        b = self._b(browser)
        try:
            if action == "back":
                self.js("history.back()", b)
            elif action == "forward":
                self.js("history.forward()", b)
            elif action == "reload":
                self.js("location.reload()", b)
            elif action == "new_tab":
                if _is_safari(b):
                    AS.run('tell application "Safari" to tell front window to set current tab to (make new tab)')
                else:
                    AS.run(f'tell application {AS.quote(b)} to tell front window to make new tab')
            elif action == "close_tab":
                if _is_safari(b):
                    AS.run('tell application "Safari" to close current tab of front window')
                else:
                    AS.run(f'tell application {AS.quote(b)} to close active tab of front window')
            else:
                return ActionResult.fail(f"Unknown browser action {action}")
        except AutomationError as e:
            return ActionResult.fail(str(e))
        time.sleep(0.4)
        return ActionResult(True, action.replace("_", " ").capitalize() + ".", self.current(b))

    # --- DOM interaction --------------------------------------------------------------
    def snapshot(self, browser: str | None = None, max_elements: int = 120, text_chars: int = 3000) -> dict:
        code = JS.SNAPSHOT.replace("__MAX__", str(int(max_elements))).replace("__TEXT__", str(int(text_chars)))
        return self.js_json(code, browser, timeout=20)

    def click(self, element_id: str, browser: str | None = None) -> ActionResult:
        b = self._b(browser)
        try:
            res = self.js_json(JS.CLICK.replace("__ID__", json.dumps(element_id)), b)
        except AutomationError as e:
            return ActionResult.fail(str(e))
        if not res.get("ok"):
            return ActionResult.fail(res.get("error", "click failed"))
        time.sleep(0.5)
        after = self.current(b)
        changed = after.get("url") != res.get("before")
        return ActionResult(True, f"Clicked “{res.get('name') or element_id}”" + (" — page changed." if changed else "."),
                            {"url": after.get("url"), "title": after.get("title"), "navigated": changed}, verified=changed)

    def type(self, element_id: str | None, text: str, browser: str | None = None) -> ActionResult:
        code = JS.TYPE.replace("__ID__", json.dumps(element_id) if element_id else "null").replace("__TEXT__", json.dumps(text))
        try:
            res = self.js_json(code, browser)
        except AutomationError as e:
            return ActionResult.fail(str(e))
        if not res.get("ok"):
            return ActionResult.fail(res.get("error", "typing failed"))
        ok = text[:20] in str(res.get("value", ""))
        return ActionResult(True, "Typed the text.", res, verified=ok)

    def scroll(self, direction: str = "down", amount: float = 0.8, browser: str | None = None) -> ActionResult:
        dy = {"down": amount, "up": -amount, "top": -1000, "bottom": 1000}.get(direction, amount)
        try:
            res = self.js_json(JS.SCROLL.replace("__DY__", str(float(dy))), browser)
        except AutomationError as e:
            return ActionResult.fail(str(e))
        moved = res.get("moved", 0)
        if moved == 0:
            return ActionResult(True, f"Already at the {'bottom' if dy > 0 else 'top'} of the page.", res, verified=True)
        return ActionResult(True, f"Scrolled {direction}.", res, verified=True)

    def read(self, browser: str | None = None, max_chars: int = 12000) -> dict:
        return self.js_json(JS.READ.replace("__MAX__", str(int(max_chars))), browser, timeout=20)
