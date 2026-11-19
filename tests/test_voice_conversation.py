"""Conversation behaviour from real use (2026-11-19 feedback):
- keyboard typing / JARVIS's own voice must not interrupt it; your voice must, quickly;
- an interruption must not turn JARVIS's own words into a new request ("it restarts what it was saying");
- one utterance at a time (it "interrupts itself");
- noise must not use up the follow-up window; the HUD must not go idle while it's listening.

The audio is real speech (Kokoro voices for "you" and "JARVIS") and synthetic key clicks, mixed the way a
laptop hears them: JARVIS's voice comes back into the mic after a delay at some level ("echo gain").
"""
from __future__ import annotations

import asyncio
import collections
import threading
import time
import types
from pathlib import Path

import numpy as np
import pytest

import jarvis.voice.pipeline as P
from jarvis.voice.pipeline import VoiceLoop, strip_echo

pytest.importorskip("openwakeword")
SAMPLES = np.load(Path(__file__).parent / "fixtures" / "voice_samples.npz")
USER = SAMPLES["user"].astype(np.float32) / 32768
JARVIS = np.concatenate([SAMPLES["jarvis"], SAMPLES["jarvis"]]).astype(np.float32) / 32768
KEYBOARD = SAMPLES["keyboard"].astype(np.float32) / 32768


class _Clock:
    t = 0.0


class _Player:
    def __init__(self):
        self.gain = 1.0
        self.history = collections.deque(maxlen=80)

    def duck(self, g=0.15):
        self.gain = g

    def unduck(self):
        self.gain = 1.0


def _simulate(monkeypatch, echo_gain, extra=None, at=0.0, prior=None, delay=0.12, seed=0):
    """Feed JARVIS's reply (plus optional user speech / typing) through _barge_check frame by frame.
    Returns (time it stopped or None, learned echo model)."""
    clk = _Clock()
    monkeypatch.setattr(P.time, "monotonic", lambda: clk.t)
    rng = np.random.default_rng(seed)
    v = VoiceLoop.__new__(VoiceLoop)
    v.vad = P.SpeechDetector()
    v.wake = types.SimpleNamespace(noise_floor=0.003)
    v.events = types.SimpleNamespace(emit=lambda *a, **k: None)
    v.mic = types.SimpleNamespace(last_t=0.0)
    v._echo_ratio, v._echo_lag = prior or (None, None)
    v._suspect_k = 1.3
    v.player = pl = _Player()
    v._barge_reset()
    n = len(JARVIS)
    ext = np.zeros(n, np.float32)
    if extra is not None:
        i = int(at * 16000)
        m = min(len(extra), n - i)
        ext[i:i + m] = extra[:m]
    played = np.zeros(n, np.float32)
    d = int(delay * 16000)
    for k in range(0, n - 1279, 1280):
        for b in (k, k + 640):                       # the player writes 40 ms blocks (after ducking)
            seg = JARVIS[b:b + 640] * pl.gain
            played[b:b + 640] = seg
            pl.history.append((b / 16000 - 0.02, float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0))
        clk.t = v.mic.last_t = (k + 1280) / 16000 + 0.005
        idx = np.arange(k, k + 1280) - d
        echo = np.where(idx >= 0, played[np.clip(idx, 0, n - 1)], 0.0) * echo_gain
        mic = echo + ext[k:k + 1280] + rng.standard_normal(1280) * 0.002
        if v._barge_check((np.clip(mic, -1, 1) * 32767).astype(np.int16)):
            return clk.t, (v._echo_estimate(), v._echo_lag)
    return None, (v._echo_estimate(), v._echo_lag)


@pytest.mark.parametrize("gain", [0.15, 0.4, 0.8])
def test_own_voice_and_keyboard_never_interrupt(monkeypatch, gain):
    stopped, model = _simulate(monkeypatch, gain)                       # first reply: learns the echo
    assert stopped is None
    assert model[1] is not None and 0.1 <= model[1] <= 0.25           # it measured the echo delay
    assert _simulate(monkeypatch, gain, prior=model, seed=1)[0] is None
    assert _simulate(monkeypatch, gain, KEYBOARD, 1.0, prior=model)[0] is None          # typing
    assert _simulate(monkeypatch, gain, KEYBOARD * 3, 1.0, prior=model)[0] is None      # loud typing


@pytest.mark.parametrize("gain,user_level", [(0.15, 0.5), (0.15, 0.25), (0.4, 0.5), (0.4, 0.25), (0.8, 0.5)])
def test_your_voice_interrupts(monkeypatch, gain, user_level):
    _, model = _simulate(monkeypatch, gain)
    stopped, _ = _simulate(monkeypatch, gain, USER * user_level, 2.0, prior=model)
    assert stopped is not None and 2.0 < stopped < 3.6


def test_echo_is_removed_from_an_interruption():
    said = "I've opened the document and I'm reading through the first section now, it covers cell biology."
    assert strip_echo("reading through the first section. Actually, open Spotify instead.", said) == "Actually, open Spotify instead"
    assert strip_echo("the first section now", said) == ""             # only its own voice: a false alarm
    assert strip_echo("stop", said) == "stop"
    assert strip_echo("first section stop", said) == "stop"
    assert strip_echo("open Spotify", "") == "open Spotify"


class _FakeTTS:
    backend = "kokoro"

    def synth(self, s):
        return np.zeros(240, np.float32), 24000


class _RecPlayer:
    """Records when each sentence plays; play takes 50 ms."""

    def __init__(self):
        self.log = []
        self._stop = threading.Event()
        self.history = collections.deque()

    def begin(self):
        self._stop.clear()

    def play(self, audio, sr):
        start = time.monotonic()
        while time.monotonic() - start < 0.05:
            if self._stop.is_set():
                return False
            time.sleep(0.005)
        self.log.append((start, time.monotonic()))
        return True

    def stop(self):
        self._stop.set()

    def finish(self):
        pass

    def recent_level(self, w=0.4):
        return 0.0


def _voice(settings, events):
    loop = asyncio.get_running_loop()
    v = VoiceLoop(settings, events, loop, on_utterance=lambda *a: None)
    v.tts = _FakeTTS()
    v.player = _RecPlayer()
    return v


async def test_one_utterance_at_a_time(assistant):
    v = _voice(assistant.settings, assistant.events)
    await asyncio.gather(v.speak("First thing. Second part."), v.speak("Another thought."), v.speak("A third."))
    spans = sorted(v.player.log)
    assert len(spans) == 4
    assert all(a[1] <= b[0] + 1e-3 for a, b in zip(spans, spans[1:]))   # never two at once


async def test_stop_drops_queued_utterances(assistant):
    v = _voice(assistant.settings, assistant.events)
    first = asyncio.create_task(v.speak("One. Two. Three. Four."))
    queued = asyncio.create_task(v.speak("This should never be said."))
    await asyncio.sleep(0.07)
    v.stop_speaking()
    assert await first is False and await queued is False
    assert len(v.player.log) <= 2


class _FakeMic:
    def __init__(self, frames, pace=0.004):
        self.frames = list(frames)
        self.pace = pace
        self.active = True
        self.last_t = 0.0

    def read(self, timeout=0.5):
        time.sleep(self.pace)
        self.last_t = time.monotonic()
        return self.frames.pop(0) if self.frames else None

    def stop(self):
        pass

    def start(self):
        pass


def _frames(audio):
    a = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    return [a[i:i + 1280] for i in range(0, len(a) - 1279, 1280)]


async def test_typing_does_not_start_a_recording_but_speech_does(assistant):
    v = _voice(assistant.settings, assistant.events)
    v._running = True
    silence = np.zeros(16000 // 2, np.float32)
    v.mic = _FakeMic(_frames(np.concatenate([KEYBOARD[:32000], USER, silence])))
    v._capture_req = {"kind": "followup", "timeout": 30, "future": None, "t": time.monotonic()}
    audio = await asyncio.to_thread(v._capture, "followup", 30)
    assert audio is not None
    # recording starts at the speech (after 2 s of typing), not at the first key click
    assert len(audio) < len(USER) + 16000 // 2 + 16000 * 0.6

    v.mic = _FakeMic(_frames(KEYBOARD))       # only typing: the window passes with no recording
    v._capture_req = {"kind": "followup", "timeout": 0.15, "future": None, "t": time.monotonic()}
    assert await asyncio.to_thread(v._capture, "followup", 0.15) is None


async def test_status_stays_listening_during_followup(assistant):
    seen = []
    orig = assistant.events.emit
    assistant.events.emit = lambda t, **k: (seen.append((t, k.get("status"))), orig(t, **k))[1]
    async def speak(text):
        return True
    assistant.voice = types.SimpleNamespace(speaking=False, capturing=False, capture_pending=True, speak=speak,
                                            request_followup=lambda: None, stop_all=lambda: None)
    await assistant.handle_text("what time is it")
    assert ("status", "idle") not in seen[-3:]
    assistant.voice = None


# --- speed: questions that don't involve the computer skip the agent ------------------------------------
class _RecLLM:
    def __init__(self, replies):
        from jarvis.llm import ChatResult

        self.ChatResult, self.replies, self.calls = ChatResult, list(replies), []

    async def chat(self, messages, model, tools=None, **kw):
        self.calls.append({"messages": messages, "tools": tools, **kw})
        return self.ChatResult(self.replies.pop(0) if self.replies else "Done.", [], 5, model)

    async def available(self):
        return True

    async def warm(self, *a, **k):
        pass


async def test_general_question_is_one_short_call(assistant):
    llm = _RecLLM(["Canberra, sir."])
    assistant.llm = assistant.agent.llm = llm
    r = await assistant.handle_text("what's the capital of australia")
    assert r["route"] == "chat" and r["message"] == "Canberra, sir."
    assert len(llm.calls) == 1 and not llm.calls[0]["tools"]
    assert sum(len(m["content"]) for m in llm.calls[0]["messages"]) < 2500     # vs ~13,000 chars for the agent
    # a short follow-up continues the conversation with context
    llm.replies = ["About 26 million."]
    r = await assistant.handle_text("and its population")
    assert r["route"] == "chat" and any("Canberra" in m["content"] for m in llm.calls[1]["messages"])


async def test_question_needing_current_facts_is_looked_up(assistant, monkeypatch):
    from jarvis import web

    searched = []

    async def fake_search(q, n=6):
        searched.append(q)
        return {"provider": "DuckDuckGo", "results": [{"title": "Forecast", "url": "https://weather.example/x",
                                                        "snippet": "Tomorrow: light rain, 14 °C."}]}
    monkeypatch.setattr(web, "web_search", fake_search)
    llm = _RecLLM(["Light rain tomorrow, around 14 degrees."])
    assistant.llm = assistant.agent.llm = llm
    r = await assistant.handle_text("is it going to rain tomorrow")
    assert r["route"] == "web" and searched and "rain" in r["message"].lower()

    # the model can also decide it needs a lookup
    llm.replies = ["LOOKUP: tallest building completed this year", "The Jeddah Tower, reportedly."]
    r = await assistant.handle_text("what is the tallest building ever finished")
    assert r["route"] == "web" and searched[-1] == "tallest building completed this year"


async def test_computer_requests_still_use_the_agent(assistant):
    from jarvis.router import classify_question

    for t in ("what's on my screen", "summarize this document", "how many tabs do I have open", "find my biology notes"):
        assert classify_question(t) is None


# --- the audio player: stops instantly, ducks instantly, never hangs ---------------------------------------
class _FakeSoundCard:
    """Stands in for sounddevice.OutputStream: pulls blocks through the callback in real time."""
    played: list = []

    def __init__(self, samplerate, channels, dtype, device, blocksize, latency, callback):
        self.sr, self.block, self.cb = samplerate, blocksize, callback
        self._run = False

    def start(self):
        self._run = True

        def loop():
            while self._run:
                buf = np.zeros((self.block, 1), np.float32)
                self.cb(buf, self.block, None, None)
                _FakeSoundCard.played.append((time.monotonic(), float(np.abs(buf).max())))
                time.sleep(self.block / self.sr)
        threading.Thread(target=loop, daemon=True).start()

    def abort(self):
        self._run = False

    def close(self):
        self._run = False


@pytest.fixture()
def fake_sound(monkeypatch):
    import sys

    _FakeSoundCard.played = []
    monkeypatch.setitem(sys.modules, "sounddevice", types.SimpleNamespace(OutputStream=_FakeSoundCard))
    return _FakeSoundCard


def test_player_stops_instantly(fake_sound):
    from jarvis.voice.audio import Player

    p = Player()
    p.begin()
    tone = np.full(24000 * 3, 0.5, np.float32)          # 3 s of sound
    result = {}
    t = threading.Thread(target=lambda: result.setdefault("ok", p.play(tone, 24000)))
    t.start()
    time.sleep(0.5)
    t_stop = time.monotonic()
    p.stop()
    t.join(1.0)
    assert not t.is_alive() and result["ok"] is False                 # play() returned, nothing hung
    loud_after = [ts for ts, lvl in fake_sound.played if ts > t_stop + 0.05 and lvl > 0.01]
    assert not loud_after                                              # silent within one 40 ms block
    p.finish()


def test_player_ducks_queued_audio_and_plays_sentences_back_to_back(fake_sound):
    from jarvis.voice.audio import Player

    p = Player()
    p.begin()
    s1, s2 = np.full(4800, 0.5, np.float32), np.full(4800, 0.5, np.float32)   # two 0.2 s sentences
    assert p.play(s1, 24000) and p.play(s2, 24000)
    p.duck(0.1)
    time.sleep(0.12)
    assert p.recent_level(0.05) < 0.1                                 # ducking reached audio already queued
    p.unduck()
    p.finish()
    levels = [lvl for _, lvl in fake_sound.played]
    first, last = levels.index(next(l for l in levels if l > 0)), len(levels) - 1 - levels[::-1].index(next(l for l in levels[::-1] if l > 0))
    assert all(l > 0 for l in levels[first:last + 1])                  # no gap between the sentences


def test_unfinished_model_reasoning_is_never_spoken():
    from jarvis.llm import _strip_think

    assert _strip_think("<think>\nThinking Process:\n1. Analyze") == ("", "Thinking Process:\n1. Analyze")
    assert _strip_think("<think>x</think>\nCanberra.") == ("Canberra.", "x")
    assert _strip_think("Canberra.") == ("Canberra.", "")
