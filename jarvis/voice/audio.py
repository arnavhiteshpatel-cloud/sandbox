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

    @property
    def active(self) -> bool:
        return self._stream is not None

    def _cb(self, indata, frames, t, status):
        frame = indata[:, 0].copy()
        self.level = float(np.sqrt(np.mean((frame.astype(np.float32) / 32768.0) ** 2)))
        try:
            self.q.put_nowait(frame)
        except queue.Full:
            try:
                self.q.get_nowait()
                self.q.put_nowait(frame)
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
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None


class Player:
    """Interruptible playback of float32 audio."""

    def __init__(self, device=None):
        self.device = device
        self._stop = threading.Event()
        self.playing = False
        self.level = 0.0

    def stop(self) -> None:
        self._stop.set()
        try:
            import sounddevice as sd

            sd.stop()
        except Exception:
            pass

    def play(self, audio: np.ndarray, sr: int) -> bool:
        """Blocks until done; returns False if interrupted."""
        import sounddevice as sd

        self._stop.clear()
        self.playing = True
        try:
            block = int(sr * 0.05)
            with sd.OutputStream(samplerate=sr, channels=1, dtype="float32", device=self.device) as out:
                for i in range(0, len(audio), block):
                    if self._stop.is_set():
                        return False
                    chunk = audio[i:i + block].astype(np.float32)
                    self.level = float(np.sqrt(np.mean(chunk ** 2))) if len(chunk) else 0.0
                    out.write(chunk.reshape(-1, 1))
            return True
        finally:
            self.playing = False
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
