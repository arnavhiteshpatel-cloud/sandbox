"""Microphone capture and audio playback (PortAudio via sounddevice)."""
from __future__ import annotations

import collections
import queue
import threading
import time

import numpy as np

SR = 16000
FRAME = 1280  # 80 ms, the frame size openWakeWord expects


class Mic:
    """Opens the microphone only while `start()`ed. Frames are int16 numpy arrays of 1280 samples."""

    def __init__(self, device=None):
        self.device = device
        self.q: queue.Queue = queue.Queue(maxsize=200)
        self._stream = None
        self._lock = threading.Lock()
        self.level = 0.0  # last RMS 0..1 for the UI visualizer
        self.opened_at = 0.0
        self.last_t = 0.0

    @property
    def active(self) -> bool:
        return self._stream is not None

    def _cb(self, indata, frames, t, status):
        frame = indata[:, 0].copy()
        self.level = float(np.sqrt(np.mean((frame.astype(np.float32) / 32768.0) ** 2)))
        item = (time.monotonic(), frame)   # arrival time: used to line JARVIS's echo up with what it played
        try:
            self.q.put_nowait(item)
        except queue.Full:
            try:
                self.q.get_nowait()
                self.q.put_nowait(item)
            except queue.Empty:
                pass

    def start(self) -> None:
        import sounddevice as sd

        with self._lock:
            if self._stream is not None:
                return
            self._stream = sd.InputStream(samplerate=SR, channels=1, dtype="int16", blocksize=FRAME,
                                          device=self.device, callback=self._cb, latency="high")
            self._stream.start()
            self.opened_at = time.monotonic()

    def stop(self) -> None:
        with self._lock:
            if self._stream is None:
                return
            try:
                self._stream.stop()
                self._stream.close()
            finally:
                self._stream = None
        self.drain()
        self.level = 0.0

    def drain(self) -> None:
        while True:
            try:
                self.q.get_nowait()
            except queue.Empty:
                return

    def read(self, timeout: float = 0.5) -> np.ndarray | None:
        """Next 80 ms frame (int16), or None. `last_t` is when it arrived."""
        try:
            item = self.q.get(timeout=timeout)
        except queue.Empty:
            return None
        if isinstance(item, tuple):
            self.last_t, item = item
        else:
            self.last_t = time.monotonic()
        return item


class Player:
    """Interruptible playback of float32 audio.

    Callback design: the sound card pulls samples from a small queue, so
    - `stop()` empties the queue: silence within one hardware buffer (a few ms), and nothing can hang;
    - ducking (`duck()`) applies to audio that is already queued, i.e. instantly;
    - one stream stays open for a whole reply: no gap or click between sentences;
    - `history` records how loud the output really was and when, so the barge-in detector knows how much
      of JARVIS's own voice to expect in the microphone.
    """

    BLOCK_S = 0.04

    def __init__(self, device=None):
        self.device = device
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._stream = None
        self._sr = 0
        self._chunks: collections.deque = collections.deque()
        self._cur: np.ndarray | None = None
        self._pos = 0
        self.playing = False
        self.level = 0.0
        self.gain = 1.0           # ducking: lowered while it checks whether you're talking over it
        self._gain_now = 1.0
        self.history: collections.deque = collections.deque(maxlen=80)  # (time, level) per callback block

    # --- control -------------------------------------------------------------------------------------
    def begin(self) -> None:
        """Start a new reply (clears a previous stop)."""
        self._stop.clear()
        self.gain = self._gain_now = 1.0

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def duck(self, gain: float = 0.15) -> None:
        self.gain = gain

    def unduck(self) -> None:
        self.gain = 1.0

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            self._chunks.clear()
            self._cur = None
        self.level = 0.0

    def recent_level(self, window: float = 0.4) -> float:
        """Loudest output level (after ducking) within the last `window` seconds."""
        now = time.monotonic()
        lv = [l for t, l in list(self.history) if now - t <= window]
        return max(lv) if lv else 0.0

    # --- the sound card's callback ---------------------------------------------------------------------
    def _callback(self, outdata, frames, time_info, status) -> None:
        out = outdata[:, 0]
        out.fill(0)
        n = 0
        with self._lock:
            while n < frames and not self._stop.is_set():
                if self._cur is None or self._pos >= len(self._cur):
                    if not self._chunks:
                        break
                    self._cur, self._pos = self._chunks.popleft(), 0
                take = min(frames - n, len(self._cur) - self._pos)
                out[n:n + take] = self._cur[self._pos:self._pos + take]
                self._pos += take
                n += take
        g0, g1 = self._gain_now, self.gain
        if g0 != g1:
            out *= np.linspace(g0, g1, frames, dtype=np.float32)   # ramp: no click
            self._gain_now = g1
        elif g1 != 1.0:
            out *= g1
        lvl = float(np.sqrt(np.mean(out ** 2))) if frames else 0.0
        self.level = lvl
        self.history.append((time.monotonic(), lvl))

    def _pending(self) -> int:
        with self._lock:
            rest = 0 if self._cur is None else len(self._cur) - self._pos
            return rest + sum(len(c) for c in self._chunks)

    def _ensure_stream(self, sr: int) -> None:
        import sounddevice as sd

        if self._stream is not None and self._sr == sr:
            return
        self._close()
        self._stream = sd.OutputStream(samplerate=sr, channels=1, dtype="float32", device=self.device,
                                       blocksize=int(sr * self.BLOCK_S), latency="low", callback=self._callback)
        self._sr = sr
        self._stream.start()

    def _close(self) -> None:
        s, self._stream = self._stream, None
        if s is not None:
            try:
                s.abort()
                s.close()
            except Exception:
                pass

    # --- playing -----------------------------------------------------------------------------------------
    def play(self, audio: np.ndarray, sr: int) -> bool:
        """Queue one sentence and wait until it has (nearly) played; returns False if interrupted.
        Returns ~0.15 s before the end so the next sentence is already queued: no gap."""
        if self._stop.is_set():
            return False
        self.playing = True
        try:
            self._ensure_stream(sr)
            with self._lock:
                self._chunks.append(np.ascontiguousarray(audio, dtype=np.float32))
            ahead = int(sr * 0.15)
            while self._pending() > ahead:
                if self._stop.is_set():
                    return False
                time.sleep(0.01)
            return not self._stop.is_set()
        finally:
            self.playing = False

    def finish(self) -> None:
        """End of a reply: let the queued audio play out (unless stopped), then close the stream."""
        while not self._stop.is_set() and self._stream is not None and self._pending() > 0:
            time.sleep(0.01)
        if not self._stop.is_set() and self._stream is not None:
            time.sleep(0.08)            # the last hardware buffer
        self._close()
        with self._lock:
            self._chunks.clear()
            self._cur = None
        self.level = 0.0


def chime(kind: str = "listen", sr: int = 24000) -> np.ndarray:
    """Short, soft earcons generated in code (no audio files)."""
    if kind == "listen":
        notes, dur = [880.0, 1318.5], 0.07
    elif kind == "done":
        notes, dur = [1318.5, 880.0], 0.06
    else:  # error
        notes, dur = [440.0, 349.2], 0.09
    out = []
    for f in notes:
        t = np.arange(int(sr * dur)) / sr
        env = np.minimum(1, t / 0.008) * np.exp(-t * 28)
        out.append(0.18 * np.sin(2 * np.pi * f * t) * env)
    return np.concatenate(out).astype(np.float32)


class RingBuffer:
    def __init__(self, seconds: float):
        self.frames: collections.deque = collections.deque(maxlen=max(1, int(seconds * SR / FRAME)))

    def add(self, frame: np.ndarray) -> None:
        self.frames.append(frame)

    def get(self) -> list[np.ndarray]:
        return list(self.frames)

    def clear(self) -> None:
        self.frames.clear()
