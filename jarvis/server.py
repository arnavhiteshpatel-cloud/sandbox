"""Local API for the menu-bar shell and the web UI.

Security: binds 127.0.0.1 only; every request needs the random token stored in the data
directory (0600) or passed by the shell; Host/Origin are checked so a web page in your
browser cannot drive JARVIS through localhost (CSRF / DNS-rebinding).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time

from aiohttp import WSMsgType, web

from . import paths
from .shortcuts.model import ShortcutError

log = logging.getLogger("jarvis.server")


def load_token() -> str:
    p = paths.token_path()
    env = os.environ.get("JARVIS_TOKEN")
    if env:
        # The app generates a fresh token per launch; mirror it to the 0600 file so the
        # `jarvis ask` CLI can talk to the running service.
        p.write_text(env)
        os.chmod(p, 0o600)
        return env
    if p.exists():
        return p.read_text().strip()
    tok = secrets.token_urlsafe(32)
    p.write_text(tok)
    os.chmod(p, 0o600)
    return tok


def make_app(assistant, token: str, port: int) -> web.Application:
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    allowed_origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}", "null", ""}

    @web.middleware
    async def guard(request: web.Request, handler):
        if request.host not in allowed_hosts:
            return web.json_response({"error": "bad host"}, status=403)
        origin = request.headers.get("Origin", "")
        if origin not in allowed_origins:
            return web.json_response({"error": "bad origin"}, status=403)
        if request.path.startswith("/api/"):
            supplied = request.headers.get("X-Jarvis-Token") or request.query.get("token", "")
            if not secrets.compare_digest(supplied, token):
                return web.json_response({"error": "unauthorized"}, status=401)
        try:
            return await handler(request)
        except ShortcutError as e:
            return web.json_response({"error": str(e)}, status=400)
        except web.HTTPException:
            raise
        except Exception as e:
            log.exception("API error")
            return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)

    a = assistant
    S = a.settings
    J = web.json_response

    async def body(request) -> dict:
        try:
            return await request.json()
        except Exception:
            return {}

    # --- core -----------------------------------------------------------------------------
    async def state(request):
        return J(a.status())

    async def command(request):
        b = await body(request)
        text = (b.get("text") or "").strip()
        if not text:
            return J({"error": "text required"}, status=400)
        if b.get("wait", False):
            return J(await a.handle_text(text, source=b.get("source", "text")))
        asyncio.create_task(a.handle_text(text, source=b.get("source", "text")))
        return J({"accepted": True})

    async def stop(request):
        return J({"stopped": a.stop("hotkey" if (await body(request)).get("source") == "hotkey" else "ui")})

    async def ptt(request):
        action = request.match_info["action"]
        if not a.voice:
            return J({"error": "voice unavailable"}, status=409)
        (a.voice.ptt_down if action == "down" else a.voice.ptt_up)()
        return J({"ok": True})

    async def hotkey(request):
        """The talk key (⌥⇧C). Typing mode: the app opens the type box. Talk mode: hold to talk."""
        b = await body(request)
        if a.settings.get("hotkeys.talk_key_action", "type") == "type":
            if a.voice:
                a.voice.prewarm()                 # you may press Return on an empty box to talk
            return J({"action": "type"})
        if not a.voice:
            return J({"action": "type", "note": "voice unavailable"})
        (a.voice.ptt_down if b.get("phase", "down") == "down" else a.voice.ptt_up)()
        return J({"action": "talk"})

    async def listen(request):
        """Start listening once (Return on an empty type box): works on battery, when the wake word is off."""
        if not a.voice:
            return J({"error": "voice unavailable"}, status=409)
        a.voice.stop_speaking()
        a.voice.prewarm()
        a.voice.events.emit("wake", source="type_box")
        a.voice._request("wake", timeout=6.0)
        return J({"ok": True})

    async def answer(request):
        return J({"ok": a.answer((await body(request)).get("text", ""))})

    async def system_event(request):
        b = await body(request)
        ev = b.get("event")
        if ev == "permissions":
            a.app_permissions = {"accessibility_app": b.get("app_accessibility"), "talk_key": b.get("talk_key")}
            a.events.emit("permissions", **a.app_permissions)
            asyncio.create_task(check_permissions())
        if ev == "will_sleep":
            a.power.will_sleep()
            if a.voice:
                a.voice.stop_all()
                a.voice.set_wake_enabled(False)
        elif ev == "did_wake":
            a.power.did_wake()
            a._apply_voice_profile()
        elif ev == "power_source":
            a.power.power_source_changed()
            a._apply_voice_profile()
        elif ev == "screen_locked" and a.voice:
            a.voice.set_wake_enabled(False)
        elif ev == "screen_unlocked":
            a._apply_voice_profile()
        return J({"ok": True, "power": a.power.status()})

    async def voice_preview(request):
        b = await body(request)
        if not a.voice:
            return J({"error": "Voice is unavailable on this system."}, status=409)
        a.voice.tts.voice = S.get("voice.tts_voice", a.voice.tts.voice)
        a.voice.tts.speed = float(S.get("voice.tts_speed", a.voice.tts.speed))
        asyncio.create_task(a.voice.speak(b.get("text") or "Hello."))
        return J({"ok": True, "backend": a.voice.tts.backend, "voice": a.voice.tts.voice})

    async def mute(request):
        b = await body(request)
        if a.voice:
            a.voice.set_muted(bool(b.get("muted", True)))
        return J({"muted": a.voice.muted if a.voice else None})

    # --- settings & power ------------------------------------------------------------------
    async def get_settings(request):
        return J(S.as_dict())

    async def put_settings(request):
        patch = await body(request)
        if "llm" in patch and patch["llm"].get("api_key") == "********":
            patch["llm"].pop("api_key")
        S.update(patch)
        a._apply_voice_profile()
        return J(S.as_dict())

    async def power_mode(request):
        b = await body(request)
        if "auto" in b:
            S.set("power.auto_switch", bool(b["auto"]))
        if b.get("mode"):
            a.power.set_mode(b["mode"], immediate=not (a.current and not a.current["task"].done()))
        a._apply_voice_profile()
        return J(a.power.status())

    async def models(request):
        try:
            avail = await a.llm.list_models()
            loaded = await a.llm.loaded_models()
        except Exception as e:
            return J({"error": str(e), "configured": S.get("llm.models")})
        return J({"available": avail, "loaded": loaded, "configured": S.get("llm.models"), "active": a.model})

    # --- shortcuts ----------------------------------------------------------------------------
    async def sc_list(request):
        return J(a.shortcuts.list())

    async def sc_save(request):
        return J(a.shortcuts.save(await body(request), created_by="editor"))

    async def sc_delete(request):
        return J({"deleted": a.shortcuts.delete(request.match_info["id"])})

    async def sc_test(request):
        sc = a.shortcuts.get(request.match_info["id"])
        if not sc:
            return J({"error": "not found"}, status=404)
        params = (await body(request)).get("params") or {}
        from .shortcuts import CancelToken

        tok = CancelToken()
        a.current = {"task": asyncio.current_task(), "cancel": tok, "id": -1, "text": f"test {sc['name']}"}
        try:
            res = await a.engine.run(sc, params, tok)
        finally:
            a.current = None
        return J({"ok": res.ok, "message": res.message, "log": res.log})

    async def sc_export(request):
        return J(a.shortcuts.export())

    async def sc_import(request):
        b = await body(request)
        return J(a.shortcuts.import_(b, overwrite=bool(request.query.get("overwrite"))))

    async def sc_runs(request):
        return J(a.shortcuts.runs(request.query.get("id")))

    # --- memory -------------------------------------------------------------------------------
    async def mem_list(request):
        q = request.query.get("q", "")
        return J(a.memory.search(q, 200) if q else a.memory.all())

    async def mem_add(request):
        b = await body(request)
        return J(a.memory.add(b["content"], kind=b.get("kind"), subject=b.get("subject"), source=b.get("source", "explicit")))

    async def mem_update(request):
        return J(a.memory.update(int(request.match_info["id"]), **(await body(request))))

    async def mem_delete(request):
        return J({"deleted": a.memory.delete(int(request.match_info["id"]))})

    async def mem_export(request):
        return web.Response(text=a.memory.export(), content_type="application/json",
                            headers={"Content-Disposition": "attachment; filename=jarvis-memory.json"})

    async def learned_list(request):
        return J(a.learner.all())

    async def learned_delete(request):
        return J({"deleted": a.learner.delete(int(request.match_info["id"]))})

    # --- history, activity, search ---------------------------------------------------------------
    async def tasks(request):
        return J(a.db.recent_tasks(int(request.query.get("limit", 50))))

    async def activity(request):
        return J(a.db.recent_activity(int(request.query.get("limit", 200))))

    async def search(request):
        q = request.query.get("q", "")
        res = await a.search.search(q, kind=request.query.get("kind") or None,
                                    days=int(request.query["days"]) if request.query.get("days") else None, limit=25)
        return J(res)

    async def search_stats(request):
        return J({**a.search.stats(), "indexing": a.power.indexing, "roots": S.get("search.roots"),
                  "only_when_charging": S.get("search.only_when_charging")})

    async def index_run(request):
        force = bool((await body(request)).get("force", True))
        return J({"started": a.power.start_indexing(force=force)})

    async def open_path(request):
        p = (await body(request)).get("path", "")
        r = await asyncio.to_thread(a.computer.reveal_in_finder if request.query.get("reveal") else a.computer.open_path, p)
        return J(r.to_dict())

    async def check_permissions() -> dict:
        perms = await asyncio.to_thread(a.computer.permissions)
        if perms.get("needs_restart"):
            restart_for_permissions()
        return perms

    def restart_for_permissions() -> None:
        """A permission was granted after this process started, and macOS keeps giving this process the old
        answer. Restart the service (the app does it; we exit as a fallback). At most once per 10 minutes."""
        marker = paths.data_dir() / ".permission_restart"
        try:
            if marker.exists() and time.time() - marker.stat().st_mtime < 600:
                return
            marker.write_text(str(time.time()))
        except OSError:
            return
        log.info("permission granted since start-up: restarting the service to pick it up")
        a.db.log("system", "New permission granted: restarting JARVIS's background service to use it")
        a.events.emit("service_restart", reason="permissions")
        asyncio.get_running_loop().call_later(5.0, os._exit, 75)   # the app restarts a service that exits

    async def permissions(request):
        b = await body(request)
        if b.get("reset") and hasattr(a.computer, "reset_permissions"):
            await asyncio.to_thread(a.computer.reset_permissions)
        if (b.get("request") or b.get("reset")) and hasattr(a.computer, "request_permissions"):
            await asyncio.to_thread(a.computer.request_permissions)
        return J({**(await check_permissions()), **getattr(a, "app_permissions", {})})

    # --- events ---------------------------------------------------------------------------------
    async def ws(request):
        sock = web.WebSocketResponse()  # no heartbeat: loopback only, avoids periodic wakeups
        await sock.prepare(request)
        q = a.events.queue()
        await sock.send_json({"type": "hello", "state": a.status()})

        async def pump():
            while True:
                ev = await q.get()
                await sock.send_str(json.dumps(ev, default=str))

        pump_task = asyncio.create_task(pump())
        try:
            async for msg in sock:
                if msg.type == WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue
                    if data.get("type") == "command":
                        asyncio.create_task(a.handle_text(data.get("text", ""), source="ui"))
                    elif data.get("type") == "stop":
                        a.stop("ui")
                    elif data.get("type") == "answer":
                        a.answer(data.get("text", ""))
                elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                    break
        finally:
            pump_task.cancel()
            a.events.unqueue(q)
        return sock

    async def index_html(request):
        return web.FileResponse(paths.ui_dir() / "index.html", headers={"Cache-Control": "no-store"})

    app = web.Application(middlewares=[guard], client_max_size=8 * 1024 * 1024)
    r = app.router
    r.add_get("/", index_html)
    r.add_get("/ui", index_html)
    r.add_static("/ui/", paths.ui_dir(), show_index=False)
    r.add_get("/health", lambda req: J({"ok": True, "ts": time.time()}))
    r.add_get("/api/state", state)
    r.add_post("/api/command", command)
    r.add_post("/api/stop", stop)
    r.add_post("/api/ptt/{action:down|up}", ptt)
    r.add_post("/api/answer", answer)
    r.add_post("/api/hotkey", hotkey)
    r.add_post("/api/listen", listen)
    r.add_post("/api/system/event", system_event)
    r.add_post("/api/mute", mute)
    r.add_post("/api/voice/preview", voice_preview)
    r.add_get("/api/settings", get_settings)
    r.add_put("/api/settings", put_settings)
    r.add_post("/api/power", power_mode)
    r.add_get("/api/models", models)
    r.add_get("/api/shortcuts", sc_list)
    r.add_post("/api/shortcuts", sc_save)
    r.add_delete("/api/shortcuts/{id}", sc_delete)
    r.add_post("/api/shortcuts/{id}/test", sc_test)
    r.add_get("/api/shortcuts-export", sc_export)
    r.add_post("/api/shortcuts-import", sc_import)
    r.add_get("/api/shortcut-runs", sc_runs)
    r.add_get("/api/memory", mem_list)
    r.add_post("/api/memory", mem_add)
    r.add_put("/api/memory/{id}", mem_update)
    r.add_delete("/api/memory/{id}", mem_delete)
    r.add_get("/api/memory-export", mem_export)
    r.add_get("/api/learned", learned_list)
    r.add_delete("/api/learned/{id}", learned_delete)
    r.add_get("/api/tasks", tasks)
    r.add_get("/api/activity", activity)
    r.add_get("/api/search", search)
    r.add_get("/api/search/stats", search_stats)
    r.add_post("/api/index", index_run)
    r.add_post("/api/open", open_path)
    r.add_post("/api/permissions", permissions)
    r.add_get("/api/events", ws)
    return app


async def serve(assistant, host: str = "127.0.0.1", port: int = 47823, voice: bool = True) -> None:
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Refusing to listen on a non-loopback address.")
    token = load_token()
    await assistant.start(voice=voice)
    app = make_app(assistant, token, port)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    log.info("JARVIS listening on http://%s:%d", host, port)
    print(f"JARVIS ready on http://{host}:{port}  (token in {paths.token_path()})", flush=True)
    stop_ev = asyncio.Event()
    try:
        import signal

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop_ev.set)
    except (NotImplementedError, RuntimeError):
        pass
    await stop_ev.wait()
    await assistant.shutdown()
    await runner.cleanup()
