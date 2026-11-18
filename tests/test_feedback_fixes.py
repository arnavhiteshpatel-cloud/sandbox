"""Regression tests for the problems reported after the first real use on the Mac (2026-11-18)."""
import json
import os
import time

import numpy as np
import pytest

from jarvis.agent.thinking import decide
from jarvis.platform.base import resolve_app_name
from jarvis.router import route

APPS = ["Arc", "Archive Utility", "Audio MIDI Setup", "Safari", "Spotify", "Visual Studio Code", "Logic Pro", "Notes", "Calculator"]


@pytest.mark.parametrize("spoken,expected", [
    ("arc", "Arc"), ("Arc", "Arc"), ("ark", "Arc"), ("the arc browser", "Arc"),
    ("it", None), ("that", None), ("the first one", None), ("up arc", None),
    ("spotfy", "Spotify"), ("visual studio", "Visual Studio Code"), ("archive", "Archive Utility"),
])
def test_app_resolution_is_strict(spoken, expected):
    assert resolve_app_name(spoken, APPS) == expected


async def test_open_arc_is_instant_and_correct(assistant, scripted):
    assistant.llm = scripted([])
    assistant.agent.llm = assistant.llm
    for phrase in ("Hey JARVIS, open Arc.", "open ark", "is open Arc"):    # STT variants
        r = await assistant.handle_text(phrase)
        assert r["route"] == "builtin" and r["message"] == "Opening Arc.", (phrase, r)
    assert "open_app:Archive Utility" not in assistant.computer.log
    assert assistant.llm.calls == []


async def test_find_document_then_open_it(assistant, settings, tmp_path):
    from jarvis.search.indexer import Indexer

    docs = tmp_path / "Docs"
    docs.mkdir()
    (docs / "Biology IA draft.txt").write_text("Enzyme activity and temperature. Biology internal assessment.")
    (docs / "History essay.txt").write_text("The causes of the First World War.")
    (docs / "Chem notes.txt").write_text("Mentions biology once.")
    settings.set("search.roots", [str(docs)])
    Indexer(assistant.db, settings).run()
    r = await assistant.handle_text("find my biology document")
    assert r["route"] == "builtin" and "Biology IA draft.txt" in r["message"], r
    r = await assistant.handle_text("open it")
    assert r["ok"] and any(e.endswith("Biology IA draft.txt") for e in assistant.computer.log if e.startswith("open_path:")), r
    assert not any("Audio MIDI" in e for e in assistant.computer.log)
    r = await assistant.handle_text("open the second one")
    assert r["ok"] and "Chem notes.txt" in r["message"]


async def test_open_it_without_results_never_opens_an_app(assistant, scripted):
    llm = scripted([("text", "Which file do you mean?")])
    assistant.llm = llm
    assistant.agent.llm = llm
    r = await assistant.handle_text("open it")
    assert not any(e.startswith("open_app:") for e in assistant.computer.log)


async def test_learns_phrasing_then_runs_without_ai(assistant, scripted):
    import asyncio

    llm = scripted([("tools", [("open_app", {"name": "Spotify"})]), ("tools", [("done", {"summary": "Opening Spotify."})])])
    assistant.llm = llm
    assistant.agent.llm = llm
    asked = []

    async def yes(q):
        asked.append(q)
        return True
    assistant.confirm = yes
    r1 = await assistant.handle_text("crank up my tunes")
    assert r1["route"] == "agent" and r1["ok"]
    await asyncio.sleep(0.6)                      # the "should I remember…?" question runs after the reply
    assert asked == ["Should I remember that “crank up my tunes” means open Spotify?"]
    assert any(p["phrase"] == "crank up my tunes" for p in assistant.learner.all())
    calls_before = len(llm.calls)
    assistant.computer.quit_app("Spotify")
    r2 = await assistant.handle_text("crank up my tunes")
    assert r2["route"] == "learned" and r2["message"] == "Opening Spotify." and len(llm.calls) == calls_before
    r3 = await assistant.handle_text("no, that's wrong")
    assert "won't" in r3["message"] and assistant.learner.all() == []


def test_never_learns_contextual_or_risky_actions(db):
    from jarvis.learning import PhraseLearner

    pl = PhraseLearner(db)
    click = [{"tool": "click", "args": "{}", "raw_args": {"element_id": "w3"}, "ok": True}]
    assert pl.candidate("hit the big button", click) is None
    opening = [{"tool": "open_app", "args": "{}", "raw_args": {"name": "Notes"}, "ok": True}]
    assert pl.candidate("open that one", opening) is None          # pronoun: depends on context
    trash = [{"tool": "trash_files", "args": "{}", "raw_args": {"paths": ["/x"]}, "ok": True}]
    assert pl.candidate("clean my desktop", trash) is None


@pytest.mark.parametrize("text,mode,think", [
    ("open arc", "max_performance", False),
    ("Open Canvas, find my next three assignments and summarize them", "balanced", True),
    ("compare my two resumes and tell me the differences", "balanced", True),
    ("organize my desktop", "balanced", True),
    ("organize my desktop", "battery_saver", False),
    ("think carefully about which laptop I should buy", "battery_saver", True),
    ("quickly organize my desktop", "max_performance", True),   # "organize" outweighs "quickly"? no: quickly forces fast
])
def test_thinking_decision(text, mode, think):
    d = decide(text, mode)
    if text.startswith("quickly"):
        assert d.think is False
    else:
        assert d.think is think, d


async def test_agent_escalates_to_thinking_when_struggling(settings, scripted):
    from jarvis.agent import Agent, ToolContext
    from jarvis.platform.fake import FakeComputer
    from jarvis.shortcuts import CancelToken

    class Recorder:
        def __init__(self):
            self.thinks = []
            self.script = [("click", {"element_id": "w99"})] * 3 + [("done", {"summary": "ok"})]

        async def chat(self, messages, model, tools=None, think=False, **kw):
            from jarvis.llm import ChatResult, ToolCall

            self.thinks.append(think)
            name, args = self.script.pop(0)
            return ChatResult("", [ToolCall(name, args)], 1, model)

    rec = Recorder()
    c = FakeComputer()
    c.browser_open_url("https://ib.example.edu/course")
    await Agent(rec, settings).run("click it", ToolContext(computer=c, settings=settings), mode="balanced", model="m",
                                   cancel=CancelToken(), think=False, may_escalate=True)
    assert rec.thinks[0] is False and rec.thinks[-1] is True


def test_web_parsers_on_real_pages():
    from jarvis import web

    here = os.path.join(os.path.dirname(__file__), "fixtures")
    for fn, parse in (("ddg.html", web.parse_ddg_html), ("ddg_lite.html", web.parse_ddg_lite), ("bing.html", web.parse_bing)):
        res = parse(open(os.path.join(here, fn), encoding="utf-8", errors="replace").read())
        assert len(res) >= 5, fn
        assert all(r["url"].startswith("http") and r["title"] for r in res), fn
        assert "bing.com/ck" not in res[0]["url"]
    title, text = web.html_to_text("<html><title>T</title><script>evil()</script><nav>menu</nav><main><p>" + "Hello world. " * 50 + "</p></main></html>")
    assert title == "T" and "Hello world" in text and "evil" not in text and "menu" not in text


async def test_web_lookup_answers_in_background(assistant, scripted, monkeypatch):
    from jarvis import web

    async def fake_search(q, n=6):
        return {"provider": "DuckDuckGo", "results": [{"title": "Ethanol", "url": "https://pubchem.ncbi.nlm.nih.gov/x",
                                                        "snippet": "Ethanol boils at 78.37 °C."}]}
    monkeypatch.setattr(web, "web_search", fake_search)
    llm = scripted([("text", "Ethanol boils at about 78 °C (source: pubchem).")])
    assistant.llm = llm
    assistant.agent.llm = llm
    r = await assistant.handle_text("look up the boiling point of ethanol")
    assert r["route"] == "web" and "78" in r["message"]
    assert not any(e.startswith("open_url:") for e in assistant.computer.log)   # nothing opened on screen


def test_settings_migration(home):
    from jarvis import paths
    from jarvis.config import Settings

    json.dump({"voice": {"tts_speed": 1.05, "end_silence_ms": 750}, "llm": {"think": True},
               "security": {"blocked_apps": ["Terminal", "Zoom"]}}, open(paths.settings_path(), "w"))
    s = Settings()
    assert s.get("voice.tts_speed") == 1.25 and s.get("voice.end_silence_ms") == 600
    assert s.get("llm.think_policy") == "auto" and s.get("security.blocked_apps") == ["Zoom"]


def test_barge_in_detects_user_not_echo():
    import types

    from jarvis.voice.pipeline import VoiceLoop

    v = VoiceLoop.__new__(VoiceLoop)
    v.player = types.SimpleNamespace(level=0.0)
    v.wake = types.SimpleNamespace(noise_floor=0.003)
    v._barge_reset()
    rng = np.random.default_rng(1)

    def frame(rms):
        return (rng.normal(0, rms, 1280) * 32768).clip(-32767, 32767).astype(np.int16)

    v._speak_t0 = time.monotonic()
    for _ in range(10):                      # calibration: own voice leaks in at 0.3x
        v.player.level = 0.1
        v._barge_check(frame(0.03))
    v._speak_t0 = time.monotonic() - 5
    assert not any(v._barge_check(frame(0.03)) for _ in range(30))           # echo alone never triggers
    assert any(v._barge_check(frame(0.15)) for _ in range(6))                # the user talking does


async def test_declined_phrasing_is_not_asked_again(assistant, scripted):
    import asyncio

    asked = []

    async def no(q):
        asked.append(q)
        return False
    assistant.confirm = no
    for _ in range(2):
        llm = scripted([("tools", [("open_app", {"name": "Notes"})]), ("tools", [("done", {"summary": "Opening Notes."})])])
        assistant.llm = llm
        assistant.agent.llm = llm
        await assistant.handle_text("bring up my scribbles")
        await asyncio.sleep(0.6)
    assert len(asked) == 1 and assistant.learner.all() == []


async def test_briefing(assistant):
    r = await assistant.handle_text("what's my day look like")
    assert r["ok"] and "2 events" in r["message"] and "Submit IA draft" in r["message"] and "Battery" in r["message"]


async def test_silent_confirmations(assistant):
    spoken = []

    async def say(text, followup=False):
        spoken.append(text)
    assistant.say = say
    r = await assistant.handle_text("open spotify")
    assert r["message"] == "Opening Spotify." and spoken == []          # shown on the HUD, not spoken
    await assistant.handle_text("what time is it")
    assert len(spoken) == 1 and spoken[0].startswith("It's")           # answers are still spoken


def test_shortcut_suggestion_from_routine(db):
    import time as _t

    from jarvis.suggest import Suggester

    s = Suggester(db)
    day = 86400
    base = _t.time() - 5 * day
    for d in range(3):                                   # the same evening routine on 3 different days
        t0 = base + d * day
        for i, (step, label) in enumerate([({"action": "open_app", "app": "Arc"}, "open Arc"),
                                           ({"action": "open_app", "app": "Spotify"}, "open Spotify"),
                                           ({"action": "system", "command": "dark_mode"}, "dark mode")]):
            db.execute("INSERT INTO action_log(ts, step, label) VALUES (?,?,?)", (t0 + i * 60, __import__("json").dumps(step, sort_keys=True), label))
    sug = s.find([])
    assert sug and sug["labels"] == ["open Arc", "open Spotify", "dark mode"] and sug["days"] == 3
    s.mark(sug["key"], "declined")
    assert s.find([], now=_t.time() + 10 * 3600) is None or s.find([], now=_t.time() + 10 * 3600)["key"] != sug["key"]


async def test_suggestion_creates_shortcut(assistant, monkeypatch):
    import asyncio

    sug = {"key": "k1", "steps": [{"action": "open_app", "app": "Arc"}, {"action": "open_app", "app": "Spotify"}],
           "labels": ["open Arc", "open Spotify"], "days": 3}
    monkeypatch.setattr(assistant.suggester, "find", lambda shortcuts, now=None: sug)

    async def yes(q):
        return True

    async def name(q, timeout=15):
        return "focus time"
    assistant.confirm, assistant.ask = yes, name
    await assistant._maybe_suggest_shortcut()
    sc = assistant.shortcuts.get("focus-time")
    assert sc and [s["app"] for s in sc["steps"]] == ["Arc", "Spotify"]
    r = await assistant.handle_text("focus time")
    assert r["route"] == "shortcut" and r["ok"]


def test_history_pruned_after_30_days(assistant):
    import time as _t

    old = _t.time() - 40 * 86400
    assistant.db.execute("INSERT INTO activity(ts, level, category, message) VALUES (?,?,?,?)", (old, "info", "x", "old"))
    assistant.db.execute("INSERT INTO tasks(objective, route, status, started_at) VALUES (?,?,?,?)", ("old", "builtin", "ok", old))
    assistant.memory.add("User prefers Arc")                            # memories are never pruned
    assistant.prune_history(force=True)
    assert assistant.db.one("SELECT count(*) AS n FROM activity WHERE ts < ?", (old + 1,))["n"] == 0
    assert assistant.db.one("SELECT count(*) AS n FROM tasks WHERE started_at < ?", (old + 1,))["n"] == 0
    assert assistant.memory.all()
