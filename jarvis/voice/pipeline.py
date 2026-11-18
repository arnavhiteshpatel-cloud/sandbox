"""The voice loop: wake word / push-to-talk -> capture -> transcribe -> assistant -> speak.

Runs on its own thread. The microphone is open only when it has to be:
- on AC power (your choice): continuously, for "Hey JARVIS";
- on battery: only while you hold the push-to-talk key, during a short follow-up window
  after JARVIS replies, or while JARVIS asks you a question.
When the mic is closed this thread sleeps on an Event (zero wakeups).
"""
from __future__ import annotations

import asyncio
import logging
import queue
import threading
import time
from concurrent.futures import Future

import numpy as np

from .audio import FRAME, SR, Mic, Player, RingBuffer, chime
from .stt import STT
from .tts import TTS, speakable, split_sentences
from .wakeword import WakeWord

log = logging.getLogger("jarvis.voice")


class VoiceLoop:
    def __init__(self, settings, events, loop: asyncio.AbstractEventLoop, on_utterance, on_wake=None):
        self.settings = settings
        self.events = events
        self.loop = loop
        self.on_utterance = on_utterance          # async fn(text, meta)
        self.on_wake = on_wake or (lambda: None)  # e.g. pre-warm the LLM
        self.mic = Mic(settings.get("voice.input_device"))
        self.player = Player(settings.get("voice.output_device"))
        self.wake = WakeWord(settings.get("voice.wake_word_model", "hey_jarvis"), float(settings.get("voice.wake_threshold", 0.5)),
                             bool(settings.get("voice.energy_gate", True)))
        self.stt = STT(settings.get("voice.stt_backend", "auto"), "turbo", settings.get("voice.language", "en"))
        self.tts = TTS(settings.get("voice.tts_backend", "auto"), settings.get("voice.tts_voice", "bm_george"),
                       float(settings.get("voice.tts_speed", 1.05)), settings.get("voice.say_voice", "Daniel"))
        self.wake_enabled = False
        self.muted = bool(settings.get("voice.muted", False))
        self._req_lock = threading.Lock()
        self._capture_req: dict | None = None
        self._ptt_held = False
        self._wakeup = threading.Event()
        self._running = False
        self._speak_stop = threading.Event()
        self.speaking = False
        self._thread: threading.Thread | None = None
        self.last_error: str | None = None
        self._level_t = 0.0

    # --- control (thread-safe) --------------------------------------------------------------
    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._run, name="jarvis-voice", daemon=True)
        self._thread.start()

    def shutdown(self) -> None:
        self._running = False
        self.stop_speaking()
        self._wakeup.set()
        self.mic.stop()

    def set_wake_enabled(self, enabled: bool) -> None:
        if enabled != self.wake_enabled:
            self.wake_enabled = enabled
            self.events.emit("voice", wake_word=enabled)
            self._wakeup.set()

    def set_muted(self, muted: bool) -> None:
        self.muted = muted
        self.settings.set("voice.muted", muted)
        if muted:
            self.mic.stop()
        self.events.emit("voice", muted=muted)
        self._wakeup.set()

    def ptt_down(self) -> None:
        self.stop_speaking()
        self._ptt_held = True
        self._request("ptt")

    def ptt_up(self) -> None:
        self._ptt_held = False
        self._wakeup.set()

    def request_followup(self) -> None:
        if self.settings.get("voice.hands_free", True) and not self.muted:
            self._request("followup", timeout=float(self.settings.get("voice.followup_seconds", 6.0)))

    def listen_once(self, timeout: float = 8.0) -> Future:
        fut: Future = Future()
        self._request("ask", timeout=timeout, future=fut)
        return fut

    def _request(self, kind: str, timeout: float = 5.0, future: Future | None = None) -> None:
        with self._req_lock:
            old = self._capture_req
            if old and old.get("future") and not old["future"].done() and kind != "ask":
                old["future"].set_result(None)
            self._capture_req = {"kind": kind, "timeout": timeout, "future": future, "t": time.monotonic()}
        self._wakeup.set()

    def stop_speaking(self) -> None:
        self._speak_stop.set()
        self.player.stop()

    def stop_all(self) -> None:
        self.stop_speaking()
        with self._req_lock:
            req, self._capture_req = self._capture_req, None
        if req and req.get("future") and not req["future"].done():
            req["future"].set_result(None)

    # --- speaking -------------------------------------------------------------------------
    async def speak(self, text: str) -> bool:
        text = speakable(text)
        if not text:
            return True
        self.events.emit("say", text=text)
        if self.muted and self.settings.get("voice.mute_speech_when_muted", False):
            return True
        return await asyncio.to_thread(self._speak_blocking, text)

    def _speak_blocking(self, text: str) -> bool:
        self._speak_stop.clear()
        self.speaking = True
        self.events.emit("status", status="speaking")
        try:
            if self.tts.backend == "say":
                return self.tts.say_blocking(text, self._speak_stop)
            if self.tts.backend != "kokoro":
                return True  # no audio output available (e.g. headless test)
            q: queue.Queue = queue.Queue(maxsize=2)

            def produce():
                try:
                    for s in split_sentences(text):
                        if self._speak_stop.is_set():
                            break
                        q.put(self.tts.synth(s))
                except Exception as e:  # fall back to `say` for this utterance
                    q.put(e)
                q.put(None)

            threading.Thread(target=produce, daemon=True).start()
            while True:
                try:
                    item = q.get(timeout=0.05)   # poll so "stop" never waits for the next sentence to synthesize
                except queue.Empty:
                    if self._speak_stop.is_set():
                        return False
                    continue
                if item is None:
                    return True
                if isinstance(item, Exception):
                    log.warning("Kokoro failed (%s); using macOS say", item)
                    return self.tts.say_blocking(text, self._speak_stop)
                if self._speak_stop.is_set() or not self.player.play(*item):
                    return False
        finally:
            self.speaking = False
            self.events.emit("status", status="idle")

    def play_chime(self, kind: str) -> None:
        if self.settings.get("voice.chime", True):
            threading.Thread(target=self.player.play, args=(chime(kind), 24000), daemon=True).start()

    # --- the loop ------------------------------------------------------------------------
    def _barge_in_enabled(self) -> bool:
        return bool(self.settings.get("voice.barge_in", True)) and self.tts.backend == "kokoro" and not self.muted

    def _want_mic(self) -> bool:
        if self.muted:
            return self._capture_req is not None and self._capture_req["kind"] in ("ptt", "ask")
        return self.wake_enabled or self._capture_req is not None or (self.speaking and self._barge_in_enabled())

    def _run(self) -> None:
        while self._running:
            try:
                if not self._want_mic():
                    self.mic.stop()
                    self._wakeup.wait()        # sleeps with zero CPU until something changes
                    self._wakeup.clear()
                    continue
                if not self.mic.active:
                    self.mic.start()
                    if self.wake_enabled:
                        self.wake.load()
                        self.wake.reset()
                    self.events.emit("voice", mic="open")
                with self._req_lock:
                    req = self._capture_req
                if req is not None:
                    self._handle_capture(req)
                    continue
                frame = self.mic.read(timeout=0.5)
                if frame is None:
                    continue
                if self.speaking and self._barge_in_enabled() and self._barge_check(frame):
                    log.info("barge-in: user started talking over JARVIS")
                    self.stop_speaking()
                    self.events.emit("barge_in")
                    self._request("barge", timeout=4.0)
                    continue
                if not self.speaking:
                    self._barge_reset()
                if not self.wake_enabled:
                    continue
                score = self.wake.process(frame)
                if score is not None:
                    log.info("wake word (%.2f)", score)
                    self.stop_speaking()           # barge-in
                    self.events.emit("wake", score=round(score, 3))
                    self.on_wake()
                    self._request("wake", timeout=5.0)
            except Exception as e:  # keep the assistant alive; report and back off
                self.last_error = f"{type(e).__name__}: {e}"
                log.exception("voice loop error")
                self.events.emit("error", where="voice", message=self.last_error)
                self.mic.stop()
                time.sleep(2.0)

    def _handle_capture(self, req: dict) -> None:
        kind = req["kind"]
        if kind in ("wake", "ptt", "ask"):
            self.play_chime("listen")
        self.events.emit("status", status="listening", reason=kind)
        audio = self._capture(kind, req["timeout"])
        with self._req_lock:
            if self._capture_req is req:
                self._capture_req = None
        self.wake.reset()  # the command audio must never feed a later wake-word decision
        fut = req.get("future")
        if audio is None:
            self.events.emit("status", status="idle")
            if fut and not fut.done():
                fut.set_result(None)
            return
        self.events.emit("status", status="transcribing")
        result = self.stt.transcribe(audio)
        text = result["text"]
        self.events.emit("transcript", text=text, stt_ms=result["ms"], audio_s=result["duration"], source=kind)
        if fut is not None:
            if not fut.done():
                fut.set_result(text or None)
            self.events.emit("status", status="thinking" if text else "idle")
            return
        if not text:
            self.events.emit("status", status="idle")
            return
        asyncio.run_coroutine_threadsafe(self.on_utterance(text, {"source": kind, "stt_ms": result["ms"]}), self.loop)

    # --- barge-in: notice the user talking over JARVIS's own voice ------------------------------------
    def _barge_reset(self) -> None:
        self._echo_samples: list[float] = []
        self._barge_hits = 0
        self._barge_pre = RingBuffer(0.6)
        self._speak_t0 = None

    def _barge_check(self, frame: np.ndarray) -> bool:
        """Compare mic level with what we're playing. Our own voice leaks into the mic at a roughly constant
        ratio, learned during the first ~0.8 s of each reply; sustained energy well above that is the user."""
        if not hasattr(self, "_barge_hits"):
            self._barge_reset()
        if self._speak_t0 is None:
            self._speak_t0 = time.monotonic()
        self._barge_pre.add(frame)
        mic = float(np.sqrt(np.mean((frame.astype(np.float32) / 32768.0) ** 2)))
        out = self.player.level
        noise = max(self.wake.noise_floor, 0.002)
        if time.monotonic() - self._speak_t0 < 0.8:      # learn the echo ratio
            if out > 0.02:
                self._echo_samples.append(mic / out)
            return False
        ratio = float(np.median(self._echo_samples)) if self._echo_samples else 0.5
        expected = ratio * out
        loud = mic > max(expected * 2.5, noise * 6, 0.02)
        self._barge_hits = self._barge_hits + 1 if loud else max(0, self._barge_hits - 1)
        return self._barge_hits >= 4                     # ~320 ms of sustained speech

    def _capture(self, kind: str, timeout: float) -> np.ndarray | None:
        """Record until end of speech (VAD) or PTT release. Returns float32 audio or None."""
        frames: list[np.ndarray] = []
        noise = max(self.wake.noise_floor, 0.002)
        started = False
        if kind == "barge":   # the user is already talking: keep what they said over JARVIS
            frames.extend(getattr(self, "_barge_pre", RingBuffer(0.1)).get())
            started = True
            self._barge_reset()
        silence_ms = 0
        end_ms = int(self.settings.get("voice.end_silence_ms", 750))
        max_s = float(self.settings.get("voice.max_utterance_s", 15))
        t0 = time.monotonic()
        speech_frames = 0
        pre = RingBuffer(0.3)
        while self._running:
            with self._req_lock:
                if self._capture_req is None or self._capture_req["kind"] != kind:
                    return None  # cancelled or superseded
            frame = self.mic.read(timeout=0.3)
            now = time.monotonic()
            if frame is None:
                if now - t0 > max_s:
                    break
                continue
            rms = float(np.sqrt(np.mean((frame.astype(np.float32) / 32768.0) ** 2)))
            if now - self._level_t > 0.08:
                self._level_t = now
                self.events.emit("level", value=round(min(1.0, rms * 12), 3))
            if kind == "ptt":
                frames.append(frame)
                if not self._ptt_held:
                    # small tail so the last word isn't clipped
                    for _ in range(2):
                        f = self.mic.read(timeout=0.1)
                        if f is not None:
                            frames.append(f)
                    break
                if now - t0 > max_s:
                    break
                continue
            loud = rms > max(noise * 3.0, 0.008)
            if not started:
                pre.add(frame)
                if loud:
                    speech_frames += 1
                    if speech_frames >= 2:
                        started = True
                        frames.extend(pre.get())
                else:
                    speech_frames = 0
                    noise = 0.98 * noise + 0.02 * rms
                if not started and now - t0 > timeout:
                    return None  # nobody spoke
                continue
            frames.append(frame)
            silence_ms = 0 if loud else silence_ms + FRAME * 1000 // SR
            if silence_ms >= end_ms or now - t0 > max_s:
                break
        if not frames:
            return None
        return np.concatenate(frames).astype(np.float32) / 32768.0

    # --- housekeeping ----------------------------------------------------------------------
    def release_idle_models(self, after_s: float) -> None:
        now = time.monotonic()
        if self.stt._model is not None and now - self.stt.last_used > after_s:
            self.stt.unload()
            log.info("STT unloaded after idle")
        if self.tts._kokoro is not None and now - self.tts.last_used > after_s:
            self.tts.unload()
            log.info("TTS unloaded after idle")
        if not self.wake_enabled and self.wake.model is not None:
            self.wake.unload()

    def status(self) -> dict:
        return {"wake_word": self.wake_enabled, "muted": self.muted, "mic_open": self.mic.active,
                "speaking": self.speaking, "stt": f"{self.stt.backend}/{self.stt.size}",
                "stt_loaded": self.stt._model is not None, "tts": self.tts.backend, "voice": self.tts.voice,
                "wake_stats": self.wake.stats(), "error": self.last_error}
