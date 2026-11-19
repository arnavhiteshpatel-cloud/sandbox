"""Round 3: the real voice loop + real assistant, end to end, in real time.

A simulated microphone mixes: room noise, your recorded voice (when the script says you speak), key clicks, and
JARVIS's own voice coming back from the speaker 120 ms later at 40 % (like a MacBook). Wake word and speech
recognition are scripted; everything else (capture, follow-up window, barge-in, echo removal, speech queue, HUD
status events, chat streaming) is the real code.
"""
import asyncio
import collections
import os
import sys
import tempfile
import threading
import time
import types

import numpy as np


from scipy.signal import resample_poly  # noqa: E402

S = np.load(os.path.join(os.path.dirname(__file__), "fixtures", "voice_samples.npz"))
USER = S["user"].astype(np.float32) / 32768
JARVIS_VOICE = np.concatenate([S["jarvis"]] * 4).astype(np.float32) / 32768
KEYS = S["keyboard"].astype(np.float32) / 32768
T0 = time.monotonic()


def now():
    return time.monotonic() - T0


class Room:
    """What the microphone hears."""

    def __init__(self):
        self.lock = threading.Lock()
        self.played = collections.deque()      # (t_start, audio16k) of JARVIS's output
        self.sources = []                      # (t_start, audio16k, label)
        self.rng = np.random.default_rng(0)

    def add(self, audio, label, at=None):
        with self.lock:
            self.sources.append((now() if at is None else at, audio, label))

    def frame(self, t_end):
        n, sr = 1280, 16000
        t0 = t_end - n / sr
        out = self.rng.standard_normal(n).astype(np.float32) * 0.002
        with self.lock:
            for ts, a, _ in self.sources:
                i = int((t0 - ts) * sr)
                if i + n > 0 and i < len(a):
                    lo, hi = max(i, 0), min(i + n, len(a))
                    out[lo - i:hi - i] += a[lo:hi]
            for ts, a in self.played:           # echo: 120 ms later, 40 %
                i = int((t0 - 0.12 - ts) * sr)
                if i + n > 0 and i < len(a):
                    lo, hi = max(i, 0), min(i + n, len(a))
                    out[lo - i:hi - i] += 0.4 * a[lo:hi]
        return (np.clip(out, -1, 1) * 32767).astype(np.int16)


ROOM = Room()


class FakeMic:
    def __init__(self):
        self.active = False
        self.last_t = 0.0
        self._next = None

    def start(self):
        self.active = True
        self._next = now() + 0.08

    def stop(self):
        self.active = False

    def read(self, timeout=0.5):
        if not self.active:
            time.sleep(min(timeout, 0.05))
            return None
        wait = self._next - now()
        if wait > timeout:
            time.sleep(timeout)
            return None
        if wait > 0:
            time.sleep(wait)
        t = self._next
        self._next += 0.08
        self.last_t = time.monotonic()
        return ROOM.frame(t)


class FakeCard:
    """sounddevice.OutputStream stand-in: pulls through the callback in real time and feeds the room."""

    def __init__(self, samplerate, channels, dtype, device, blocksize, latency, callback):
        self.sr, self.block, self.cb, self.run = samplerate, blocksize, callback, False

    def start(self):
        self.run = True

        def loop():
            while self.run:
                buf = np.zeros((self.block, 1), np.float32)
                self.cb(buf, self.block, None, None)
                a16 = resample_poly(buf[:, 0], 2, 3).astype(np.float32)
                with ROOM.lock:
                    ROOM.played.append((now(), a16))
                time.sleep(self.block / self.sr)
        threading.Thread(target=loop, daemon=True).start()

    def abort(self):
        self.run = False

    def close(self):
        self.run = False




class FakeTTS:
    backend = "kokoro"
    voice = "bm_george"
    speed = 1.4
    _kokoro = object()
    last_used = 0

    def __init__(self):
        self.pos = 0

    def synth(self, s):
        n = int(len(s) * 0.055 * 24000 / 1.4)          # ~ speaking time for this sentence
        src = resample_poly(JARVIS_VOICE, 3, 2).astype(np.float32)
        a = src[self.pos:self.pos + n]
        self.pos = (self.pos + n) % (len(src) - n - 1)
        return a, 24000

    def warm(self):
        pass

    def unload(self):
        pass


class FakeWake:
    model = object()
    noise_floor = 0.003
    threshold = 0.5

    def __init__(self):
        self.fire = False

    def load(self):
        pass

    def reset(self):
        pass

    def unload(self):
        pass

    def stats(self):
        return {}

    def process(self, frame):
        if self.fire:
            self.fire = False
            return 0.9
        return None


class FakeSTT:
    backend, size, _model, last_used, vocabulary = "sim", "sim", object(), 0, ""

    def __init__(self):
        self.script = []
        self.heard = []

    def transcribe(self, audio):
        dur = len(audio) / 16000
        text = self.script.pop(0) if self.script else ""
        self.heard.append((round(now(), 2), round(dur, 2), text))
        return {"text": text, "ms": 120, "duration": dur}

    def load(self):
        pass

    def unload(self):
        pass

    def set_size(self, s):
        pass


class StreamLLM:
    def __init__(self):
        self.replies = collections.deque()

    async def chat_stream(self, messages, model, **kw):
        text = self.replies.popleft() if self.replies else "Certainly."
        for i in range(0, len(text), 8):
            await asyncio.sleep(0.03)
            yield text[i:i + 8]

    async def chat(self, *a, **k):
        from jarvis.llm import ChatResult
        return ChatResult("Done.", [], 5, "m")

    async def available(self):
        return True

    async def warm(self, *a, **k):
        pass


async def scenario(name, steps, expect):
    """steps: list of (at_seconds, action, arg). Prints the timeline; returns findings."""
    from jarvis.assistant import Assistant
    from jarvis.config import Settings
    from jarvis.db import Database
    from jarvis.platform.fake import FakeComputer
    from jarvis.voice.pipeline import VoiceLoop

    global T0
    T0 = time.monotonic()
    ROOM.sources.clear()
    ROOM.played.clear()
    s = Settings()
    s.set("voice.enabled", False)
    s.set("power.auto_switch", False)
    a = Assistant(settings=s, db=Database(), computer=FakeComputer())
    a.llm = a.agent.llm = StreamLLM()
    a.llm_ok = True
    timeline = []
    orig = a.events.emit

    def emit(t, **k):
        if t in ("status", "wake", "transcript", "barge_in", "barge_suspect", "response", "say"):
            detail = k.get("status") or k.get("text") or ""
            if t == "status" and k.get("reason"):
                detail += f" ({k['reason']})"
            timeline.append((round(now(), 2), t, str(detail)[:70]))
        return orig(t, **k)
    a.events.emit = emit
    loop = asyncio.get_running_loop()
    v = VoiceLoop(s, a.events, loop, a.handle_utterance)
    v.mic, v.wake, v.stt, v.tts = FakeMic(), FakeWake(), FakeSTT(), FakeTTS()
    v.busy_fn = lambda: bool(a.current and not a.current["task"].done())
    a.voice = v
    v.wake_enabled = True
    v.start()
    end = max(t for t, *_ in steps) + 9
    for at, action, arg in sorted(steps, key=lambda x: x[0]):
        while now() < at:
            await asyncio.sleep(0.02)
        if action == "wake":
            v.wake.fire = True
            timeline.append((round(now(), 2), "YOU", "Hey JARVIS"))
        elif action == "say":
            audio, text = arg
            v.stt.script.append(text)
            ROOM.add(audio, "you")
            timeline.append((round(now(), 2), "YOU", f"say: {text}"))
        elif action == "type":
            ROOM.add(KEYS * 1.5, "keys")
            timeline.append((round(now(), 2), "YOU", "typing on the keyboard"))
        elif action == "reply":
            a.llm.replies.append(arg)
    while now() < end:
        await asyncio.sleep(0.05)
    v.shutdown()
    problems = expect(timeline, v)
    if problems:
        print("\n".join(f"{r[0]:6.2f}s {r[1]:14s} {r[2]}" for r in timeline), "\nSTT:", v.stt.heard)
    return problems


