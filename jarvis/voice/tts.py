"""Local text-to-speech.

Primary: Kokoro-82M (Apache-2.0) via kokoro-onnx, voice `bm_george` (British male, composed),
synthesized sentence by sentence so speech starts quickly and can be interrupted between
sentences. Fallback: macOS `say -v Daniel` (built in, zero setup).
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
import threading
import time

import numpy as np

from .. import paths

log = logging.getLogger("jarvis.tts")

KOKORO_FILES = ("kokoro-v1.0.int8.onnx", "voices-v1.0.bin")
KOKORO_VOICES = {
    "bm_george": "British male, composed (default)", "bm_lewis": "British male, deeper", "bm_fable": "British male, lighter",
    "bm_daniel": "British male", "bf_emma": "British female", "bf_isabella": "British female",
    "am_michael": "American male", "am_adam": "American male", "af_heart": "American female", "af_bella": "American female",
}


def split_sentences(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    parts = re.split(r"(?<=[.!?;:])\s+(?=[A-Z0-9\"'“(])", text)
    out: list[str] = []
    for p in parts:
        while len(p) > 280:  # very long sentences: split at a comma
            cut = p.rfind(",", 0, 280)
            cut = cut if cut > 80 else 280
            out.append(p[:cut + 1].strip())
            p = p[cut + 1:].strip()
        if p:
            out.append(p)
    return out


def speakable(text: str) -> str:
    """Strip markdown and things that sound bad when read aloud."""
    t = re.sub(r"```.*?```", " ", text, flags=re.S)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"https?://\S+", "the link", t)
    t = re.sub(r"[*_#>|]+", " ", t)
    t = re.sub(r"^\s*[-•]\s+", "", t, flags=re.M)
    return re.sub(r"\s+", " ", t).strip()


class TTS:
    def __init__(self, backend: str = "auto", voice: str = "bm_george", speed: float = 1.05, say_voice: str = "Daniel"):
        self.backend = backend
        self.voice = voice
        self.speed = speed
        self.say_voice = say_voice
        self._kokoro = None
        self._lock = threading.Lock()
        self._say_proc: subprocess.Popen | None = None
        self.last_used = 0.0
        if backend == "auto":
            self.backend = "kokoro" if self.kokoro_available() else ("say" if sys.platform == "darwin" else "none")

    @staticmethod
    def kokoro_available() -> bool:
        d = paths.models_dir() / "kokoro"
        try:
            import kokoro_onnx  # noqa: F401
        except Exception:
            return False
        return all((d / f).exists() for f in KOKORO_FILES)

    def load(self) -> None:
        if self.backend != "kokoro":
            return
        with self._lock:
            if self._kokoro is None:
                from kokoro_onnx import Kokoro

                d = paths.models_dir() / "kokoro"
                t0 = time.monotonic()
                self._kokoro = Kokoro(str(d / KOKORO_FILES[0]), str(d / KOKORO_FILES[1]))
                log.info("Kokoro loaded in %.1fs", time.monotonic() - t0)

    def unload(self) -> None:
        with self._lock:
            self._kokoro = None

    def synth(self, sentence: str) -> tuple[np.ndarray, int]:
        self.load()
        self.last_used = time.monotonic()
        lang = "en-gb" if self.voice.startswith("b") else "en-us"
        samples, sr = self._kokoro.create(sentence, voice=self.voice, speed=self.speed, lang=lang)
        return np.asarray(samples, dtype=np.float32), sr

    def say_blocking(self, text: str, stop_event: threading.Event) -> bool:
        """macOS `say` fallback; interruptible."""
        rate = int(185 * self.speed)
        self._say_proc = subprocess.Popen(["say", "-v", self.say_voice, "-r", str(rate), text])
        while self._say_proc.poll() is None:
            if stop_event.is_set():
                self._say_proc.terminate()
                return False
            time.sleep(0.05)
        return True
