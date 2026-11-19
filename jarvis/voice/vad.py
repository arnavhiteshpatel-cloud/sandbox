"""Is that a human voice? Silero VAD (MIT, bundled with openWakeWord, ~1 ms per 80 ms frame on CPU).

Used to start/stop recording and to decide whether you're talking over JARVIS. Loudness alone can't
tell your voice from a keyboard click, a tap on the desk or a door; Silero scores those low.
A second, simpler test (`sustained_rms`) measures loudness ignoring short clicks: an 80 ms frame is
split into 10 ms pieces and the median piece counts, so a 5-20 ms key click barely moves it while
speech, which is continuous, does.
"""
from __future__ import annotations

import logging

import numpy as np

log = logging.getLogger("jarvis.vad")


def rms(frame: np.ndarray) -> float:
    x = frame.astype(np.float32) / 32768.0 if frame.dtype == np.int16 else frame.astype(np.float32)
    return float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0


def sustained_rms(frame: np.ndarray, pieces: int = 8) -> float:
    """Loudness that ignores clicks: median RMS of `pieces` equal slices of the frame."""
    x = frame.astype(np.float32) / 32768.0 if frame.dtype == np.int16 else frame.astype(np.float32)
    n = len(x) // pieces
    if n == 0:
        return rms(frame)
    parts = x[: n * pieces].reshape(pieces, n)
    return float(np.median(np.sqrt(np.mean(parts ** 2, axis=1))))


class SpeechDetector:
    def __init__(self) -> None:
        self._vad = None
        self._failed = False

    def load(self) -> bool:
        if self._vad is not None:
            return True
        if self._failed:
            return False
        try:
            from openwakeword.vad import VAD

            self._vad = VAD()
            return True
        except Exception as e:  # missing onnxruntime / model: fall back to loudness
            self._failed = True
            log.warning("voice activity model unavailable (%s); using loudness only", e)
            return False

    @property
    def available(self) -> bool:
        return self.load()

    def reset(self) -> None:
        if self._vad is not None:
            self._vad.reset_states()

    def prob(self, frame: np.ndarray) -> float:
        """Probability (0-1) that this int16 16 kHz frame contains speech."""
        if not self.load():
            return 0.8 if sustained_rms(frame) > 0.012 else 0.1
        x = frame if frame.dtype == np.int16 else (np.clip(frame, -1, 1) * 32767).astype(np.int16)
        size = 640 if len(x) % 640 == 0 else (480 if len(x) % 480 == 0 else len(x))
        try:
            return float(self._vad.predict(x, frame_size=size))
        except Exception as e:
            log.warning("VAD failed: %s", e)
            self._failed, self._vad = True, None
            return 0.8 if sustained_rms(frame) > 0.012 else 0.1
