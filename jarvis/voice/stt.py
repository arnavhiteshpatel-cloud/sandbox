"""Local speech recognition with Whisper.

- macOS / Apple Silicon: mlx-whisper (Metal GPU). Default model large-v3-turbo; Battery Saver uses small.
- Elsewhere (and as a fallback): faster-whisper on CPU (int8).
Models load lazily and are released after an idle period chosen by the power mode.
"""
from __future__ import annotations

import logging
import re
import sys
import threading
import time

import numpy as np

log = logging.getLogger("jarvis.stt")

MLX_REPOS = {"turbo": "mlx-community/whisper-large-v3-turbo", "small": "mlx-community/whisper-small.en-mlx",
             "base": "mlx-community/whisper-base.en-mlx", "tiny": "mlx-community/whisper-tiny.en-mlx"}
FW_NAMES = {"turbo": "large-v3-turbo", "small": "small.en", "base": "base.en", "tiny": "tiny.en"}

# Whisper's well-known outputs on silence/noise.
HALLUCINATIONS = {"you", "thank you", "thanks for watching", "thank you for watching", "bye", ".", "",
                  "thanks", "okay", "so", "um", "uh", "hmm", "please subscribe", "subtitles by the amara.org community"}


class STT:
    def __init__(self, backend: str = "auto", size: str = "turbo", language: str = "en"):
        if backend == "auto":
            backend = "mlx" if (sys.platform == "darwin" and _has("mlx_whisper")) else "faster_whisper"
        self.backend = backend
        self.size = size
        self.language = language
        self._model = None
        self._lock = threading.Lock()
        self.last_used = 0.0
        self.vocabulary = "JARVIS, Arc, Spotify, IB, Canvas, Safari, Finder"

    def set_size(self, size: str) -> None:
        if size != self.size:
            self.size = size
            self.unload()

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            t0 = time.monotonic()
            if self.backend == "mlx":
                import mlx_whisper  # noqa: F401  (weights are loaded on first transcribe and cached)

                self._model = MLX_REPOS.get(self.size, self.size)
                # Warm up so the first real command isn't slow.
                mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=self._model, language=self.language)
            else:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(FW_NAMES.get(self.size, self.size), device="cpu", compute_type="int8")
            log.info("STT %s/%s loaded in %.1fs", self.backend, self.size, time.monotonic() - t0)

    def unload(self) -> None:
        with self._lock:
            self._model = None
            if self.backend == "mlx":
                try:
                    from mlx_whisper.load_models import load_model  # noqa: F401
                    import mlx.core as mx

                    mx.clear_cache()
                    import mlx_whisper.transcribe as T

                    T.ModelHolder.model = None
                    T.ModelHolder.model_path = None
                except Exception:
                    pass

    def transcribe(self, audio: np.ndarray) -> dict:
        """audio: float32 mono 16 kHz in [-1, 1]."""
        self.load()
        self.last_used = time.monotonic()
        t0 = time.monotonic()
        dur = len(audio) / 16000
        rms = float(np.sqrt(np.mean(audio ** 2))) if len(audio) else 0.0
        if dur < 0.3 or rms < 0.002:
            return {"text": "", "ms": 0, "duration": dur, "reason": "no speech"}
        prompt = f"{self.vocabulary}."
        if self.backend == "mlx":
            import mlx_whisper

            r = mlx_whisper.transcribe(audio, path_or_hf_repo=self._model, language=self.language, temperature=0.0,
                                       initial_prompt=prompt, condition_on_previous_text=False, fp16=True)
            text = r.get("text", "")
        else:
            segs, _ = self._model.transcribe(audio, language=self.language, beam_size=1, initial_prompt=prompt,
                                             condition_on_previous_text=False, vad_filter=False, temperature=0.0)
            text = " ".join(s.text for s in segs)
        text = text.strip()
        if re.sub(r"[^\w ]", "", text.lower()).strip() in HALLUCINATIONS:
            text = ""
        return {"text": text, "ms": int((time.monotonic() - t0) * 1000), "duration": round(dur, 2)}


def _has(mod: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(mod) is not None
