"""Offline voice pipeline self-test with real models and synthetic speech (no microphone).

Kokoro speaks test phrases -> 16 kHz audio is streamed frame by frame through the real
wake-word detector (with the energy gate) -> the audio after the wake word is transcribed
by real Whisper -> the transcript is routed. Also checks false triggers and silence gating.

  python -m jarvis.voice.selftest            (prints a JSON report)

This proves the models and plumbing work on this machine. It does NOT replace testing with
your real voice and microphone (accent, room noise, distance), which only the Mac can do.
"""
from __future__ import annotations

import json
import os
import sys
import time

import numpy as np

from ..router import route
from .audio import FRAME, SR
from .stt import STT
from .tts import TTS
from .wakeword import WakeWord


def resample(x: np.ndarray, sr_in: int, sr_out: int = SR) -> np.ndarray:
    n = int(len(x) * sr_out / sr_in)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def to_int16(x: np.ndarray) -> np.ndarray:
    return (np.clip(x, -1, 1) * 32767).astype(np.int16)


def synth(tts: TTS, text: str, voice: str) -> tuple[np.ndarray, float]:
    tts.voice = voice
    t0 = time.monotonic()
    audio, sr = tts.synth(text)
    dt = time.monotonic() - t0
    return resample(audio, sr), dt


def stream_wake(ww: WakeWord, audio16: np.ndarray, noise: float = 0.002) -> dict:
    rng = np.random.default_rng(0)
    pad = np.zeros(int(1.5 * SR), dtype=np.float32)
    sig = np.concatenate([pad, audio16, pad])
    sig = sig + rng.normal(0, noise, len(sig)).astype(np.float32)   # quiet room noise
    pcm = to_int16(sig)
    ww.reset()
    det_frame, det_score, best, t_inf = None, 0.0, 0.0, 0.0
    for i in range(0, len(pcm) - FRAME + 1, FRAME):
        t0 = time.perf_counter()
        score = ww.process(pcm[i:i + FRAME])
        t_inf += time.perf_counter() - t0
        if score is not None and det_frame is None:
            det_frame, det_score = i, score
    best = det_score if det_frame is not None else getattr(ww, "max_score", 0.0)
    return {"detected": det_frame is not None, "detect_s": round(det_frame / SR, 2) if det_frame is not None else None,
            "best_score": round(float(best), 3), "frames": len(pcm) // FRAME, "cpu_ms_per_frame": round(1000 * t_inf / max(1, len(pcm) // FRAME), 3),
            "pad_s": 1.5, "sig": sig, "det_sample": det_frame}


def main() -> dict:
    report: dict = {"platform": sys.platform}
    tts = TTS("kokoro", "bm_george", 1.0)
    if not tts.kokoro_available():
        raise SystemExit("Kokoro models missing; run `jarvis setup-models --skip-llm` first.")
    t0 = time.monotonic()
    tts.load()
    report["tts_load_s"] = round(time.monotonic() - t0, 2)
    ww = WakeWord("hey_jarvis", threshold=0.5, energy_gate=True)
    ww.load()
    stt = STT("auto", "base" if sys.platform != "darwin" else "turbo")
    t0 = time.monotonic()
    stt.load()
    report["stt"] = f"{stt.backend}/{stt.size}"
    report["stt_load_s"] = round(time.monotonic() - t0, 2)

    cases = [
        ("Hey Jarvis. Open Spotify.", "bm_george", True, "open"),
        ("Hey Jarvis. Scroll down.", "am_michael", True, "browser_scroll"),
        ("Hey Jarvis. Switch to battery saver mode.", "bf_emma", True, "power_mode"),
        ("Hey Jarvis. Open my IB.", "am_adam", True, "open"),
        ("I think the weather will be nice today.", "bm_lewis", False, None),
        ("Hey Travis, can you pass the salt?", "am_michael", False, None),
    ]
    rows = []
    for text, voice, should_wake, intent in cases:
        audio, synth_s = synth(tts, text, voice)
        r = stream_wake(ww, audio)
        row = {"phrase": text, "voice": voice, "expect_wake": should_wake, "wake": r["detected"], "best_score": r["best_score"],
               "detect_at_s": r["detect_s"], "wake_cpu_ms_per_80ms_frame": r["cpu_ms_per_frame"],
               "tts_s": round(synth_s, 2), "tts_rtf": round(synth_s / (len(audio) / SR), 3)}
        if r["detected"]:
            # The command is whatever follows the detection point (as the live pipeline does).
            cmd_audio = r["sig"][r["det_sample"] + FRAME:]
            res = stt.transcribe(cmd_audio)
            it = route(res["text"])
            row.update({"transcript": res["text"], "stt_ms": res["ms"], "intent": it.name if it else None,
                        "intent_ok": (it.name if it else None) == intent})
            # Full-utterance STT too (what push-to-talk would hear)
        full = stt.transcribe(np.concatenate([np.zeros(SR // 2, np.float32), audio]))
        row["full_transcript"] = full["text"]
        row["pass"] = (r["detected"] == should_wake) and (not should_wake or row.get("intent_ok", False))
        rows.append(row)
    report["cases"] = rows
    # Silence: the energy gate should skip (nearly) all inference.
    ww2 = WakeWord("hey_jarvis", 0.5, energy_gate=True)
    ww2.load()
    quiet = to_int16(np.random.default_rng(1).normal(0, 0.001, SR * 30).astype(np.float32))
    t0 = time.perf_counter()
    for i in range(0, len(quiet) - FRAME + 1, FRAME):
        ww2.process(quiet[i:i + FRAME])
    report["silence_30s"] = {**ww2.stats(), "cpu_ms_total": round(1000 * (time.perf_counter() - t0), 1)}
    ww3 = WakeWord("hey_jarvis", 0.5, energy_gate=False)
    ww3.load()
    t0 = time.perf_counter()
    for i in range(0, len(quiet) - FRAME + 1, FRAME):
        ww3.process(quiet[i:i + FRAME])
    report["silence_30s_no_gate_cpu_ms_total"] = round(1000 * (time.perf_counter() - t0), 1)
    report["passed"] = sum(r["pass"] for r in rows)
    report["total"] = len(rows)
    return report


if __name__ == "__main__":
    print(json.dumps(main(), indent=2, default=str))
