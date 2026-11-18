"""Every-app control: system/media commands, built-in app integrations, non-browser follow-ups, safety."""
import datetime as dt

import pytest

from jarvis.router import parse_reminder, route


@pytest.mark.parametrize("text,name,args", [
    ("pause", "media", {"key": "play"}),
    ("next song", "media", {"key": "next"}),
    ("previous track", "media", {"key": "previous"}),
    ("make the screen brighter", "media", {"key": "brightness_up"}),
    ("turn on dark mode", "appearance", {"dark": True}),
    ("switch to light mode", "appearance", {"dark": False}),
    ("turn off wifi", "wifi", {"on": False}),
    ("open bluetooth settings", "settings", {"pane": "bluetooth"}),
    ("take a screenshot", "screenshot", {}),
    ("minimize this window", "window", {"action": "minimize"}),
    ("make it full screen", "window", {"action": "fullscreen"}),
    ("hide spotify", "window", {"action": "hide", "app": "spotify"}),
    ("make a note saying Buy eggs", "note", {"body": "Buy eggs"}),
    ("what's on my calendar tomorrow", "calendar", {"when": "tomorrow"}),
    ("play lofi beats on spotify", "spotify_search", {"query": "lofi beats"}),
])
def test_routes(text, name, args):
    it = route(text)
    assert it and it.name == name, it
    for k, v in args.items():
        assert it.args[k] == v


def test_reminder_parsing_keeps_case_and_time():
    it = route("Remind me to submit the IA tomorrow at 9am")
    assert it.args["text"] == "submit the IA" and it.args["due_in_s"] > 0
    now = dt.datetime(2026, 11, 18, 14, 0)
    assert parse_reminder("call mom at 5pm", now) == ("call mom", 3 * 3600)
    assert parse_reminder("call mom at 5", now) == ("call mom", 3 * 3600)        # "at 5" = 5 pm
    assert parse_reminder("stretch in 20 minutes", now) == ("stretch", 1200)
    assert parse_reminder("buy milk", now) == ("buy milk", None)


async def test_system_commands_run_without_ai(assistant, scripted):
    assistant.llm = scripted([])
    assistant.agent.llm = assistant.llm
    c = assistant.computer
    for cmd, entry in [("pause", "media:play"), ("next song", "media:next"), ("turn on dark mode", "appearance:dark"),
                       ("open sound settings", "settings:sound"), ("take a screenshot", "screenshot"),
                       ("minimize this window", "window:minimize"), ("make a note saying call the dentist", "note:call the dentist")]:
        r = await assistant.handle_text(cmd)
        assert r["ok"] and r["route"] == "builtin", (cmd, r)
        assert entry in c.log, (cmd, c.log[-3:])
    assert assistant.llm.calls == []


async def test_reminder_and_calendar(assistant):
    r = await assistant.handle_text("remind me to stretch in 20 minutes")
    assert r["ok"] and "reminder:stretch:1200" in assistant.computer.log
    r = await assistant.handle_text("what's on my calendar today")
    assert r["ok"] and "Biology HL at 9:00 AM" in r["message"] and "2 events" in r["message"]


async def test_followups_work_in_non_browser_apps(assistant):
    c = assistant.computer
    c.open_app("Notes")                     # front app is not a browser
    r = await assistant.handle_text("new tab")
    assert r["ok"] and "window:new_tab" in c.log
    r = await assistant.handle_text("go back")
    assert r["ok"] and "window:back" in c.log


async def test_wifi_off_asks_first(assistant):
    async def no(q):
        return False
    assistant.confirm = no
    r = await assistant.handle_text("turn off wifi")
    assert "wifi:False" not in assistant.computer.log and "Leaving" in r["message"]


async def test_typing_into_terminal_asks_first(assistant):
    asked = []

    async def no(q):
        asked.append(q)
        return False
    assistant.confirm = no
    assistant.computer.apps.append("Terminal")
    assistant.computer.open_app("Terminal")
    await assistant.handle_text("type rm -rf ~/Documents")
    assert asked and not any(e.startswith("text:") for e in assistant.computer.log)


async def test_agent_scripting_and_messages_are_gated(settings, scripted):
    from jarvis.agent import Agent, ToolContext
    from jarvis.platform.fake import FakeComputer
    from jarvis.shortcuts import CancelToken

    c = FakeComputer()
    ctx = ToolContext(computer=c, settings=settings)
    llm = scripted([
        ("tools", [("script_app", {"script": 'tell application "Music" to play playlist "Focus"'})]),
        ("tools", [("script_app", {"script": 'tell application "Finder" to delete every file of desktop'})]),
        ("tools", [("send_message", {"to": "Mom", "text": "running late"})]),
        ("tools", [("done", {"summary": "ok"})]),
    ])
    asked = []

    async def deny(q):
        asked.append(q)
        return False
    res = await Agent(llm, settings, confirm=deny).run("play focus, clean desktop, text mom", ctx, mode="balanced", model="m", cancel=CancelToken())
    assert c.scripts == ['tell application "Music" to play playlist "Focus"']   # safe script ran, risky one didn't
    assert len(asked) == 2 and not any(e.startswith("message:") for e in c.log)
