"""Deterministic shortcut executor.

Runs steps in order with waits, verification, branches, retries and reusable blocks.
Unpredictable steps can be delegated to the AI agent with an "agent" step, and if a
shortcut fails with on_error="agent", the agent is asked to finish the job.
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from ..platform.base import ActionResult, Computer
from ..router import best_element_match
from . import model as M


class Cancelled(Exception):
    pass


class CancelToken:
    def __init__(self):
        self._ev = asyncio.Event()
        self.reason = ""

    def cancel(self, reason: str = "stopped"):
        self.reason = reason
        self._ev.set()

    @property
    def cancelled(self) -> bool:
        return self._ev.is_set()

    def check(self):
        if self._ev.is_set():
            raise Cancelled(self.reason)

    async def sleep(self, seconds: float):
        try:
            await asyncio.wait_for(self._ev.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            return
        raise Cancelled(self.reason)


@dataclass
class RunResult:
    ok: bool
    message: str
    log: list[dict] = field(default_factory=list)
    browser: str | None = None
    final_state: dict = field(default_factory=dict)


Speak = Callable[[str], Awaitable[None]]
Confirm = Callable[[str], Awaitable[bool]]
AgentRunner = Callable[[str, CancelToken], Awaitable[RunResult]]


class ShortcutEngine:
    def __init__(self, computer: Computer, store, settings, speak: Speak | None = None,
                 confirm: Confirm | None = None, agent: AgentRunner | None = None, on_step=None):
        self.c = computer
        self.store = store
        self.settings = settings
        self.speak = speak
        self.confirm = confirm
        self.agent = agent
        self.on_step = on_step or (lambda *_: None)

    async def _call(self, fn, *args, **kw) -> ActionResult:
        return await asyncio.to_thread(fn, *args, **kw)

    async def run(self, sc: dict, params: dict | None = None, cancel: CancelToken | None = None, depth: int = 0) -> RunResult:
        if depth > 5:
            return RunResult(False, "Shortcuts are nested too deeply (possible loop).")
        cancel = cancel or CancelToken()
        vars_ = {**(params or {})}
        ctx = {"browser": self.settings.get("browser.default", "Arc"), "vars": vars_, "log": [], "sc": sc}
        run_id = self.store.run_started(sc["id"]) if depth == 0 else None
        try:
            ok, msg = await self._steps(sc["steps"], ctx, cancel, depth)
            if not ok and sc.get("on_error") == "agent" and self.agent:
                self.on_step("agent_takeover", {"reason": msg})
                res = await self.agent(f"The shortcut '{sc['name']}' failed at: {msg}. Finish its goal: "
                                       f"{json.dumps(sc['steps'])[:1500]}", cancel)
                ok, msg = res.ok, res.message
            if ok:
                msg = M.render(sc.get("response") or "", vars_) or msg or "Done."
            status = "ok" if ok else "failed"
        except Cancelled as e:
            ok, msg, status = False, f"Stopped ({e}).", "cancelled"
        if run_id is not None:
            self.store.run_finished(run_id, status, ctx["log"])
        return RunResult(ok, msg, ctx["log"], ctx["browser"])

    async def _steps(self, steps: list, ctx: dict, cancel: CancelToken, depth: int) -> tuple[bool, str]:
        for i, raw in enumerate(steps):
            cancel.check()
            st = M.render(raw, ctx["vars"])
            retries = int(st.get("retries", 1 if st["action"] in ("click", "open_url") else 0))
            attempt = 0
            while True:
                t0 = time.monotonic()
                try:
                    res = await self._step(st, ctx, cancel, depth)
                except Cancelled:
                    raise
                except Exception as e:  # a crashing step is a failed step, not a crashed assistant
                    res = ActionResult.fail(f"{type(e).__name__}: {e}")
                entry = {"i": i, "action": st["action"], "label": st.get("label"), "ok": res.ok,
                         "message": res.message, "verified": res.verified, "ms": int((time.monotonic() - t0) * 1000),
                         "attempt": attempt + 1}
                ctx["log"].append(entry)
                self.on_step("shortcut_step", entry)
                if res.ok or attempt >= retries:
                    break
                attempt += 1
                await cancel.sleep(0.6 * attempt)
            if not res.ok and not st.get("continue_on_error") and ctx["sc"].get("on_error") != "continue":
                return False, f"step {i + 1} ({st['action']}): {res.message}"
        return True, ""

    # --- conditions ------------------------------------------------------------------
    async def _cond(self, c: dict, ctx: dict) -> bool:
        t = c["type"]
        b = c.get("browser") or ctx["browser"]
        if t == "not":
            return not await self._cond(c["condition"], ctx)
        if t == "page_ready":
            return (await self._call(self.c.browser_wait_ready, b, 0.5)).ok
        if t in ("url_contains", "title_contains"):
            st = await self._call(self.c.browser_state, b)
            field_ = "url" if t == "url_contains" else "title"
            return str(c.get("value", "")).lower() in str(st.get(field_) or "").lower()
        if t == "text_present":
            page = await self._call(self.c.browser_read, b, 50000)
            return str(c.get("value", "")).lower() in str(page.get("text", "")).lower()
        if t == "element_present":
            snap = await self._call(self.c.browser_snapshot, b)
            return best_element_match(c.get("value", ""), snap.get("elements", [])) is not None
        if t == "app_running":
            return c.get("value") in await asyncio.to_thread(self.c.running_apps)
        if t == "app_frontmost":
            return c.get("value") == await asyncio.to_thread(self.c.frontmost_app)
        if t == "file_exists":
            return os.path.exists(os.path.expanduser(c.get("value", "")))
        if t == "var_equals":
            return str(ctx["vars"].get(c.get("var"))) == str(c.get("value"))
        return False

    # --- steps ----------------------------------------------------------------------
    async def _step(self, st: dict, ctx: dict, cancel: CancelToken, depth: int) -> ActionResult:
        a = st["action"]
        c = self.c
        b = st.get("browser") or ctx["browser"]
        if a == "open_app":
            name = c.resolve_app(st["app"]) or st["app"]
            return await self._call(c.open_app, name)
        if a == "quit_app":
            return await self._call(c.quit_app, st["app"])
        if a == "focus_app":
            return await self._call(c.focus_app, st["app"])
        if a == "open_url":
            ctx["browser"] = b
            res = await self._call(c.browser_open_url, st["url"], b, st.get("new_tab", True))
            if not res.ok or st.get("wait", True) is False:
                return res
            timeout = float(st.get("timeout", self.settings.get("browser.page_load_timeout_s", 20)))
            ready = await self._call(c.browser_wait_ready, b, timeout, st.get("expect_url_contains"), st["url"])
            ready.message = (ready.message if ready.ok else f"Opened, but {ready.message[0].lower()}{ready.message[1:]}")
            ctx["last_page"] = ready.data
            return ready
        if a == "browser":
            return await self._call(c.browser_nav, st["command"], b)
        if a == "wait":
            await cancel.sleep(float(st["seconds"]))
            return ActionResult(True, f"Waited {st['seconds']}s.")
        if a in ("wait_for", "verify"):
            cond = st["condition"]
            timeout = float(st.get("timeout", 15 if a == "wait_for" else 0))
            if cond["type"] == "page_ready":
                return await self._call(c.browser_wait_ready, cond.get("browser") or b, max(timeout, 1))
            deadline = time.monotonic() + timeout
            while True:
                if await self._cond(cond, ctx):
                    return ActionResult(True, f"Condition met: {cond['type']} {cond.get('value', '')}".strip(), verified=True)
                if time.monotonic() >= deadline:
                    return ActionResult.fail(f"Condition not met: {cond['type']} {cond.get('value', '')}".strip())
                await cancel.sleep(0.4)
        if a == "click":
            target = st["target"]
            if st.get("app") and st["app"] not in (b,):
                snap = await self._call(c.ui_snapshot, st["app"])
                m = best_element_match(target, snap.get("elements", []))
                if not m:
                    return ActionResult.fail(f"No “{target}” in {st['app']}.")
                return await self._call(c.ui_press, m["id"])
            return await self._call(c.browser_click, None, target, b)
        if a == "type":
            if st.get("target"):
                snap = await self._call(c.browser_snapshot, b)
                m = best_element_match(st["target"], snap.get("elements", []))
                if not m:
                    return ActionResult.fail(f"No field “{st['target']}”.")
                return await self._call(c.browser_type, m["id"], st["text"], bool(st.get("submit")), b)
            res = await self._call(c.type_text, st["text"])
            if st.get("submit"):
                await self._call(c.press_keys, "return")
            return res
        if a == "keys":
            return await self._call(c.press_keys, st["combo"])
        if a == "scroll":
            return await self._call(c.browser_scroll, st.get("direction", "down"), float(st.get("amount", 0.8)), b)
        if a == "menu":
            path = st["path"] if isinstance(st["path"], list) else [p.strip() for p in str(st["path"]).split(">")]
            return await self._call(c.menu_select, st["app"], path)
        if a == "open_file":
            return await self._call(c.open_path, st["path"], st.get("app"))
        if a == "reveal_file":
            return await self._call(c.reveal_in_finder, st["path"])
        if a == "move_file":
            return await asyncio.to_thread(self._move, st["src"], st["dst"])
        if a == "macos_shortcut":
            return await self._call(c.run_macos_shortcut, st["name"], st.get("input"))
        if a == "arrange_windows":
            apps = st["apps"] if isinstance(st["apps"], list) else [x.strip() for x in str(st["apps"]).split(",")]
            return await self._call(c.arrange_windows, st["layout"], apps)
        if a == "volume":
            return await self._call(c.set_volume, st.get("level"), st.get("delta"), st.get("mute"))
        if a == "say":
            if self.speak:
                await self.speak(st["text"])
            return ActionResult(True, st["text"])
        if a == "notify":
            return await self._call(c.notify, st.get("title", "JARVIS"), st["text"])
        if a == "media":
            return await self._call(c.media_key, st["key"])
        if a == "system":
            cmd, val = st["command"], st.get("value")
            if cmd in ("dark_mode", "light_mode", "toggle_appearance"):
                return await self._call(c.set_appearance, {"dark_mode": True, "light_mode": False}.get(cmd))
            if cmd in ("wifi_on", "wifi_off"):
                return await self._call(c.set_wifi, cmd == "wifi_on")
            if cmd == "open_settings":
                return await self._call(c.open_settings, val or "")
            if cmd == "screenshot":
                return await self._call(c.take_screenshot)
            return await self._call(c.window_action, cmd, val)
        if a == "note":
            return await self._call(c.create_note, st["text"], st.get("title"))
        if a == "reminder":
            from ..router import parse_reminder

            due = parse_reminder("x " + st["when"])[1] if st.get("when") else None
            return await self._call(c.create_reminder, st["text"], due)
        if a == "open_location":
            return await self._call(c.open_location, st["url"])
        if a == "set":
            ctx["vars"][st["var"]] = st["value"]
            return ActionResult(True, f"{st['var']} = {st['value']}")
        if a == "run_shortcut":
            sub = self.store.get(st["shortcut"]) or self.store.find_by_name(st["shortcut"])
            if not sub:
                return ActionResult.fail(f"No shortcut named {st['shortcut']}.")
            res = await self.run(sub, {**ctx["vars"], **(st.get("params") or {})}, cancel, depth + 1)
            return ActionResult(res.ok, res.message)
        if a == "if":
            branch = st["then"] if await self._cond(st["condition"], ctx) else (st.get("else") or [])
            ok, msg = await self._steps(branch, ctx, cancel, depth)
            return ActionResult(ok, msg or "Branch done.")
        if a == "agent":
            if not self.agent:
                return ActionResult.fail("The AI agent isn't available, so this step can't run.")
            res = await self.agent(st["instruction"], cancel)
            return ActionResult(res.ok, res.message)
        if a == "applescript":
            if not await self._authorize(ctx["sc"], f"run the AppleScript in “{ctx['sc']['name']}”"):
                return ActionResult.fail("Not authorized.")
            from ..platform.macos import applescript as AS

            out = await asyncio.to_thread(AS.run, st["script"], 30)
            return ActionResult(True, out[:500] or "AppleScript ran.")
        if a == "shell":
            return await self._shell(st, ctx)
        return ActionResult.fail(f"Unhandled action {a}")

    async def _authorize(self, sc: dict, what: str) -> bool:
        if sc.get("created_by", "editor") == "editor" and sc.get("trusted", True):
            return True  # you typed this into the editor yourself
        if self.confirm is None:
            return False
        return await self.confirm(f"This shortcut wants to {what}. Allow it?")

    async def _shell(self, st: dict, ctx: dict) -> ActionResult:
        cmd = st["command"]
        argv = shlex.split(cmd)
        allow = set(self.settings.get("security.shell_allowlist", []))
        if not argv:
            return ActionResult.fail("Empty command.")
        if argv[0] not in allow and not await self._authorize(ctx["sc"], f"run the command `{cmd}`"):
            return ActionResult.fail("Not authorized.")
        proc = await asyncio.to_thread(subprocess.run, argv, capture_output=True, text=True, timeout=60)
        out = (proc.stdout or proc.stderr)[-1500:]
        return ActionResult(proc.returncode == 0, out or f"exit {proc.returncode}")

    def _move(self, src: str, dst: str) -> ActionResult:
        s, d = os.path.expanduser(src), os.path.expanduser(dst)
        if not os.path.exists(s):
            return ActionResult.fail(f"{src} doesn't exist.")
        if os.path.isdir(d):
            d = os.path.join(d, os.path.basename(s))
        if os.path.exists(d):
            return ActionResult.fail(f"{d} already exists; not overwriting.")
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.move(s, d)
        return ActionResult(True, f"Moved to {d}.", verified=os.path.exists(d))
