"""'Hey JARVIS' detection with openWakeWord (Apache-2.0 code; the pre-trained hey_jarvis model is
CC BY-NC-SA 4.0, fine for personal use), behind an energy gate.

The energy gate skips neural inference while the room is quiet (most of the day), which is
where most of the standby power goes. When sound rises above the adaptive noise floor, the
last ~1.5 s of audio is replayed into the model so the start of "hey" is not lost.
"""
from __future__ import annotations

import logging
import os
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

    def model_path(self) -> str:
        """Prefer a copy in JARVIS's model folder; fall back to the model bundled with openWakeWord."""
        from .. import paths

        local = paths.models_dir() / "wakeword" / f"{self.model_name}_v0.1.onnx"
        if local.exists():
            return str(local)
        import openwakeword

        for p in openwakeword.get_pretrained_model_paths():
            if os.path.basename(p).startswith(self.model_name) and p.endswith(".onnx"):
                return p
        raise FileNotFoundError(f"Wake word model '{self.model_name}' not found. Run: jarvis setup-models")

    def load(self) -> None:
        if self.model is not None:
            return
        from openwakeword.model import Model

        path = self.model_path()
        try:  # openWakeWord >= 0.5
            self.model = Model(wakeword_models=[path], inference_framework="onnx")
        except TypeError:  # 0.4.x
            self.model = Model(wakeword_model_paths=[path])
        pp = getattr(self.model, "preprocessor", None)
        # Snapshot the blank feature state so reset() can restore it cheaply.
        self._blank = None
        if pp is not None and hasattr(pp, "feature_buffer"):
            self._blank = (pp.feature_buffer.copy(), pp.melspectrogram_buffer.copy())
        log.info("wake word model loaded: %s", path)

    def unload(self) -> None:
        self.model = None

    def reset(self) -> None:
        """Forget all previous audio. openWakeWord's own reset() only clears predictions and keeps
        ~10 s of audio features, which could re-detect an earlier "Hey JARVIS" (false trigger)."""
        if self.model is not None:
            self.model.reset()
            pp = getattr(self.model, "preprocessor", None)
            if pp is not None and getattr(self, "_blank", None) is not None:
                pp.feature_buffer = self._blank[0].copy()
                pp.melspectrogram_buffer = self._blank[1].copy()
                pp.raw_data_buffer.clear()
                pp.accumulated_samples = 0
        self.preroll.clear()
        self.max_score = 0.0

    def _score(self, frame: np.ndarray) -> float:
        pred = self.model.predict(frame)
        self.last_score = float(max(pred.values())) if pred else 0.0
        self.max_score = max(getattr(self, "max_score", 0.0), self.last_score)
        return self.last_score

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
            if now > self.gate_open_until:  # gate opening: start clean, replay pre-roll for context
                pre = self.preroll.get()
                self.reset()
                for f in pre:
                    self._score(f)
                    self.frames_inferred += 1
                self.preroll.clear()
            if loud:
                self.gate_open_until = now + 2.0
        self.frames_inferred += 1
        score = self._score(frame)
        if score >= self.threshold:
            self._cooldown_until = now + 1.5
            self.reset()
            return score
        return None

    def stats(self) -> dict:
        return {"frames": self.frames_total, "inferred": self.frames_inferred,
                "gate_skip_ratio": round(1 - self.frames_inferred / max(1, self.frames_total), 3),
                "noise_floor": round(self.noise_floor, 5)}


def frames_from_audio(audio_int16: np.ndarray):
    for i in range(0, len(audio_int16) - FRAME + 1, FRAME):
        yield audio_int16[i:i + FRAME]
