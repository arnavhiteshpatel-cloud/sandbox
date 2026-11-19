"""Scenario sweep (2026-11-19): hundreds of things people say, run through the real assistant on the simulated Mac.
Each case pins which path handles it (instant command / quick conversation / web lookup / AI agent) and what happens,
so the bugs found by simulating real use stay fixed."""
from __future__ import annotations

import pytest

from jarvis.llm import ChatResult, ToolCall


class TraceLLM:
    def __init__(self):
        self.calls = []

    async def chat(self, messages, model, tools=None, **kw):
        self.calls.append("agent" if tools else "chat")
        if tools:
            return ChatResult("", [ToolCall("done", {"summary": "[agent]"})], 5, model)
        return ChatResult("[chat]", [], 5, model)

    async def available(self):
        return True

    async def warm(self, *a, **k):
        pass


@pytest.fixture()
def a(assistant, monkeypatch):
    from jarvis import web

    async def fake_search(q, n=6):
        return {"provider": "sim", "results": [{"title": "R", "url": "https://example.com", "snippet": f"About {q}."}]}
    monkeypatch.setattr(web, "web_search", fake_search)
    assistant.llm = assistant.agent.llm = TraceLLM()
    assistant.llm_ok = True

    async def no(q):
        return False
    assistant.confirm = no
    return assistant


INSTANT = [  # (said, expected log entry): no AI at all
    ("open up arc", "open_app:Arc"), ("open ark", "open_app:Arc"), ("open arch", "open_app:Arc"), ("OPEN ARC", "open_app:Arc"),
    ("open arc open arc", "open_app:Arc"), ("um open arc", "open_app:Arc"), ("could you please open spotify", "open_app:Spotify"),
    ("fire up logic", "open_app:Logic Pro"), ("open the calculator", "open_app:Calculator"),
    ("close the arc browser", "quit_app:Arc"), ("open youtube", "open_url:https://www.youtube.com"),
    ("open gmail", "open_url:https://mail.google.com"), ("copy this", "keys:cmd+c"), ("paste", "keys:cmd+v"),
    ("undo", "keys:cmd+z"), ("select all", "keys:cmd+a"), ("show me my desktop", "window:show_desktop"),
    ("close archive utility and open arc", "open_app:Arc"), ("open safari and spotify", "open_app:Spotify"),
]


@pytest.mark.parametrize("said,expect", INSTANT)
async def test_instant_commands(a, said, expect):
    if said.startswith("close archive"):
        a.computer.running.append("Archive Utility")
    r = await a.handle_text(said)
    assert expect in a.computer.log, (said, r, a.computer.log)
    assert not a.llm.calls, (said, a.llm.calls)


CHAT = ["how are you", "lovely how about you", "why is the sky blue", "do you like music", "i'm bored", "my day was rough",
        "what's my name", "tell me a joke", "explain photosynthesis", "help me think of a name for my dog"]


@pytest.mark.parametrize("said", CHAT)
async def test_conversation_takes_the_fast_path(a, said):
    r = await a.handle_text(said)
    assert r["route"] == "chat" and a.llm.calls == ["chat"], (said, r, a.llm.calls)


AGENT = ["what's on my screen", "what does this say", "summarize this page", "read my emails", "hide the dock",
         "empty the trash", "log out", "right click the desktop", "how many tabs do i have open", "crank up my tunes"]


@pytest.mark.parametrize("said", AGENT)
async def test_computer_work_goes_to_the_agent(a, said):
    r = await a.handle_text(said)
    assert r["route"] == "agent" and "agent" in a.llm.calls, (said, r, a.llm.calls)


@pytest.mark.parametrize("said", ["what's the weather tomorrow", "who won the game last night", "what's the price of bitcoin"])
async def test_current_facts_are_looked_up(a, said):
    r = await a.handle_text(said)
    assert r["route"] == "web", (said, r)


@pytest.mark.parametrize("said,mode", [("battery saver", "battery_saver"), ("max performance mode", "max_performance"),
                                       ("switch to balanced mode", "balanced")])
async def test_power_modes_said_plainly(a, said, mode):
    await a.handle_text(said)
    assert a.power.mode == mode or a.power.pending == mode


@pytest.mark.parametrize("said", ["open", "close", "open the"])
async def test_cut_off_commands_ask(a, said):
    r = await a.handle_text(said)
    assert r["message"].endswith("what?") and not a.llm.calls


async def test_unknown_app_answers_instantly(a):
    r = await a.handle_text("open photoshop")
    assert not r["ok"] and "can't find an app called Photoshop" in r["message"] and not a.llm.calls
    r = await a.handle_text("open audio")                        # not Audio MIDI Setup
    assert "Audio MIDI Setup" not in a.computer.running


@pytest.mark.parametrize("said", ["never mind stop", "ok stop", "jarvis stop", "forget it"])
async def test_stop_variants(a, said):
    r = await a.handle_text(said)
    assert r.get("intent") == "stop" or r["message"] == "Stopped." or r["route"] == "builtin"
    assert not a.llm.calls


async def test_shortcut_by_voice_with_description(a):
    async def yes(q):
        return True
    a.confirm = yes
    r = await a.handle_text("create a shortcut called morning that opens arc and spotify")
    assert r["ok"] and "morning" in r["message"].lower()
    r = await a.handle_text("morning")
    assert r["route"] == "shortcut" and {"Arc", "Spotify"} <= set(a.computer.running)
    r = await a.handle_text("delete the morning shortcut")
    assert r["message"] == "Deleted."


async def test_taught_bare_name_opens_the_app(a):
    await a.handle_text("remember that when i say tunes i mean spotify")
    r = await a.handle_text("tunes")
    assert "open_app:Spotify" in a.computer.log and not a.llm.calls


async def test_next_one_after_a_search_is_the_next_result(a):
    a.session.last_results = [{"path": "/tmp/a.pdf", "name": "a.pdf"}, {"path": "/tmp/b.pdf", "name": "b.pdf"}]
    r = await a.handle_text("next one")
    assert "b.pdf" in r["message"] and not any(e.startswith("media:") for e in a.computer.log)


async def test_volume_by_amount(a):
    a.computer.volume = 50
    await a.handle_text("volume minus 5")
    assert a.computer.volume == 45


def test_shortcut_descriptions_parse_without_ai():
    from jarvis.platform.fake import FakeComputer
    from jarvis.shortcuts import builder

    c = FakeComputer()
    steps, _ = builder.parse_description("that opens arc and spotify and turns on dark mode", c.resolve_app, None, None, "Arc")
    assert steps == [{"action": "open_app", "app": "Arc"}, {"action": "open_app", "app": "Spotify"},
                     {"action": "system", "command": "dark_mode"}]
    assert builder.describe({"steps": steps}) == "open Arc, open Spotify and turn on dark mode"


def test_app_names_with_vendor_or_version():
    from jarvis.platform.base import resolve_app_name as r

    apps = ["Adobe Photoshop 2025", "Microsoft Word", "Audio MIDI Setup", "Archive Utility", "Logic Pro"]
    assert r("photoshop", apps) == "Adobe Photoshop 2025" and r("word", apps) == "Microsoft Word"
    assert r("audio", apps) is None and r("logic", apps) == "Logic Pro" and r("archive", apps) == "Archive Utility"
