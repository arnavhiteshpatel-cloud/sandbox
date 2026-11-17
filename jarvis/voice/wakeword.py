"""'Hey JARVIS' detection with openWakeWord (Apache-2.0 code; the pre-trained hey_jarvis model is
CC BY-NC-SA 4.0, fine for personal use), behind an energy gate.

The energy gate skips neural inference while the room is quiet (most of the day), which is
where most of the standby power goes. When sound rises above the adaptive noise floor, the
last ~1.5 s of audio is replayed into the model so the start of "hey" is not lost.
"""
from __future__ import annotations

import logging
import time

import numpy as np

from .audio import FRAME, RingBuffer

log = logging.getLogger("jarvis.wake")


class WakeWord:
    def __init__(self, model_name: str = "hey_jarvis", threshold: float = 0.5, energy_gate: bool = True):
        self.model_name = model_name
        self.threshold = threshold
        self.energy_gate = energy_gate
        self.model = None
        self.noise_floor = 0.003
        self.preroll = RingBuffer(1.5)
        self.gate_open_until = 0.0
        self.frames_total = 0
        self.frames_inferred = 0
        self._cooldown_until = 0.0

    def load(self) -> None:
        if self.model is not None:
            return
        import openwakeword
        from openwakeword.model import Model

        try:
            self.model = Model(wakeword_models=[self.model_name], inference_framework="onnx")
        except Exception:
            # Models are downloaded on first use (stored in the package's resources folder).
            openwakeword.utils.download_models([self.model_name])
            self.model = Model(wakeword_models=[self.model_name], inference_framework="onnx")
        log.info("wake word model loaded: %s", self.model_name)

    def unload(self) -> None:
        self.model = None

    def reset(self) -> None:
        if self.model is not None:
            self.model.reset()
        self.preroll.clear()

    def _score(self, frame: np.ndarray) -> float:
        pred = self.model.predict(frame)
        return float(max(pred.values())) if pred else 0.0

    def process(self, frame: np.ndarray) -> float | None:
        """Feed one 80 ms int16 frame; returns the score when the wake word fires, else None."""
        self.frames_total += 1
        now = time.monotonic()
        if now < self._cooldown_until:
            return None
        rms = float(np.sqrt(np.mean((frame.astype(np.float32) / 32768.0) ** 2)))
        if self.energy_gate:
            # Slowly track the quiet-room level; open the gate on anything clearly louder.
            if rms < self.noise_floor * 1.5:
                self.noise_floor = 0.995 * self.noise_floor + 0.005 * max(rms, 1e-4)
            loud = rms > max(self.noise_floor * 2.5, 0.004)
            if not loud and now > self.gate_open_until:
                self.preroll.add(frame)
                return None
            if now > self.gate_open_until:  # gate opening: replay pre-roll for context
                self.model.reset()
                for f in self.preroll.get():
                    self._score(f)
                    self.frames_inferred += 1
                self.preroll.clear()
            if loud:
                self.gate_open_until = now + 2.0
        self.frames_inferred += 1
        score = self._score(frame)
        if score >= self.threshold:
            self._cooldown_until = now + 1.5
            self.model.reset()
            return score
        return None

    def stats(self) -> dict:
        return {"frames": self.frames_total, "inferred": self.frames_inferred,
                "gate_skip_ratio": round(1 - self.frames_inferred / max(1, self.frames_total), 3),
                "noise_floor": round(self.noise_floor, 5)}


def frames_from_audio(audio_int16: np.ndarray):
    for i in range(0, len(audio_int16) - FRAME + 1, FRAME):
        yield audio_int16[i:i + FRAME]
