"""The real voice loop + real assistant, end to end, in real time (~13 s per scenario).

A simulated microphone mixes room noise, your recorded voice, key clicks and JARVIS's own voice coming back from the
speaker 120 ms later at 40 % (like a MacBook). Wake word and speech recognition are scripted; capture, the follow-up
window, talk-over detection, echo removal, the speech queue, status events and reply streaming are the real code.
"""
import importlib.util
import os
import sys
import types

import pytest

pytest.importorskip("openwakeword")
pytest.importorskip("scipy")
_spec = importlib.util.spec_from_file_location("_voice_sim", os.path.join(os.path.dirname(__file__), "_voice_sim.py"))
sim = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sim)


@pytest.fixture(autouse=True)
def fake_sound_card(monkeypatch, home):
    monkeypatch.setitem(sys.modules, "sounddevice", types.SimpleNamespace(OutputStream=sim.FakeCard))


async def test_follow_up_without_the_wake_word():
    def check(tl, v):
        p = []
        if [h[2] for h in v.stt.heard][:2] != ["how are you", "what are you up to"]:
            p.append(f"follow-up not heard: {v.stt.heard}")
        if any(r[1] == "status" and r[2] == "idle" for r in tl if 3.5 < r[0] < 6.0):
            p.append("went idle during the follow-up window")
        if sum(1 for r in tl if r[1] == "transcript") != 2:
            p.append("each thing you said should appear once")
        return p
    assert not await sim.scenario("follow-up", [
        (0.5, "reply", "Very well, thank you."), (0.5, "wake", None), (0.9, "say", (sim.USER[:32000], "how are you")),
        (0.9, "reply", "Keeping an eye on things."), (6.0, "say", (sim.USER[:32000], "what are you up to"))], check)


LONG = ("Photosynthesis is how plants turn light into chemical energy. It happens in the chloroplasts. "
        "Light reactions make ATP and NADPH. The Calvin cycle then fixes carbon dioxide into sugar. "
        "That sugar feeds the plant and, eventually, most life on Earth.")


async def test_typing_never_interrupts_but_your_voice_does():
    def check(tl, v):
        p = []
        b = [r for r in tl if r[1] == "barge_in"]
        if any(r[0] < 6.0 for r in b):
            p.append("typing interrupted JARVIS")
        if len(b) != 1:
            p.append(f"expected exactly one interruption, got {len(b)}")
        elif b[0][0] - 6.0 > 1.0:
            p.append(f"interruption took {b[0][0] - 6.0:.2f} s")
        if "stop explaining and open spotify" not in [h[2] for h in v.stt.heard]:
            p.append(f"what you said over it was lost: {v.stt.heard}")
        return p
    assert not await sim.scenario("talk over", [
        (0.5, "reply", LONG), (0.5, "wake", None), (0.9, "say", (sim.USER[:32000], "explain photosynthesis")),
        (4.5, "type", None), (6.0, "say", (sim.USER, "stop explaining and open spotify"))], check)
