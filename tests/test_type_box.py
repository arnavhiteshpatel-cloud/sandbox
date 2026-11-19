"""⌥⇧C opens a box to type to JARVIS (2026-11-19: "when I do shift option c I want to be able to type to it, because
I have a lot of stuff in the menu bar and it doesn't show"). Voice is "Hey JARVIS", or Return on an empty box."""
from __future__ import annotations

import types

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.server import make_app

TOKEN = "t" * 20


class FakeVoice:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        if name in ("speaking", "capturing", "capture_pending"):
            return False

        def rec(*a, **k):
            self.calls.append(name)
            return True
        return rec

    async def speak(self, text):
        self.calls.append(f"speak:{text}")
        return True


@pytest.fixture()
async def client(assistant):
    assistant.voice = FakeVoice()
    assistant.voice.events = assistant.events
    app = make_app(assistant, TOKEN, 47999)
    c = TestClient(TestServer(app, port=47999))
    await c.start_server()
    yield c, assistant
    await c.close()


H = {"X-Jarvis-Token": TOKEN}


async def test_talk_key_opens_the_type_box_by_default(client):
    c, a = client
    r = await c.post("/api/hotkey", json={"phase": "down"}, headers=H)
    assert (await r.json())["action"] == "type"
    assert "ptt_down" not in a.voice.calls                       # it does NOT start listening


async def test_hold_to_talk_is_still_a_setting(client):
    c, a = client
    a.settings.set("hotkeys.talk_key_action", "talk")
    r = await c.post("/api/hotkey", json={"phase": "down"}, headers=H)
    assert (await r.json())["action"] == "talk" and "ptt_down" in a.voice.calls
    await c.post("/api/hotkey", json={"phase": "up"}, headers=H)
    assert "ptt_up" in a.voice.calls


async def test_return_on_an_empty_box_listens(client):
    c, a = client
    r = await c.post("/api/listen", json={}, headers=H)
    assert r.status == 200 and "_request" in a.voice.calls


async def test_typed_requests_get_written_answers_without_the_microphone(assistant):
    v = FakeVoice()
    assistant.voice = v
    seen = []
    orig = assistant.events.emit
    assistant.events.emit = lambda t, **k: (seen.append((t, k.get("text"))), orig(t, **k))[1]
    r = await assistant.handle_text("what time is it", source="typed")
    assert r["ok"] and any(t == "response" for t, _ in seen)
    assert not any(c.startswith("speak:") for c in v.calls)      # not spoken
    assert "request_followup" not in v.calls                      # mic stays closed
    r = await assistant.handle_text("what time is it", source="voice")
    assert any(c.startswith("speak:") for c in v.calls)          # by voice it still answers aloud
    assistant.voice = None


@pytest.mark.parametrize("said,page", [("settings", "settings"), ("jarvis settings", "settings"),
                                       ("open command center", "live"), ("open jarvis shortcuts", "shortcuts")])
async def test_reaching_the_command_center_without_the_menu_bar_icon(assistant, said, page):
    seen = []
    orig = assistant.events.emit
    assistant.events.emit = lambda t, **k: (seen.append((t, k)), orig(t, **k))[1]
    await assistant.handle_text(said, source="typed")
    assert ("open_center", {"hash": page}) in seen


async def test_mac_settings_still_open_system_settings(assistant):
    from jarvis import router

    assert router.route("open system settings").name == "settings"
    assert router.route("open wifi settings").name == "settings"


def test_hey_jarvis_on_battery_switch(assistant):
    """Small panel switch: off by default; on = "always" (listens on battery too)."""
    p = assistant.power
    p.state.source = "battery"
    assert assistant.settings.get("voice.wake_word_policy") == "ac_only" and not p.wake_word_allowed()
    assistant.settings.set("voice.wake_word_policy", "always")
    assert p.wake_word_allowed()
    p.state.source = "ac"
    assistant.settings.set("voice.wake_word_policy", "ac_only")
    assert p.wake_word_allowed()
