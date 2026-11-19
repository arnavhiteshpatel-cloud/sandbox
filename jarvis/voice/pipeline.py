"""The voice loop: wake word / push-to-talk -> capture -> transcribe -> assistant -> speak.

Runs on its own thread. The microphone is open only when it has to be:
- on AC power (your choice): continuously, for "Hey JARVIS";
- on battery: only while you hold the push-to-talk key, during the follow-up window after JARVIS
  replies, while JARVIS asks you a question, or while it speaks (so you can talk over it).
When the mic is closed this thread sleeps on an Event (zero wakeups).

Conversation rules (from real use):
- One utterance at a time. Replies are queued and each one finishes before the next starts.
- Talking over JARVIS stops it within ~0.25 s, but only for a human voice clearly louder than JARVIS's
  own voice in the mic. Keyboard clicks and taps don't count (voice-activity model + click-proof loudness).
- What the mic heard of JARVIS's own voice is removed from the transcript, so an interruption never
  turns into a request to repeat what it was saying. If nothing of yours is left, it carries on talking.
- After a reply it keeps listening for a follow-up (default 8 s) without the wake word. Noise that
  isn't speech doesn't use up that window.
"""
from __future__ import annotations

import asyncio
import difflib
import logging
import queue
import re
import threading
import time
from concurrent.futures import Future

import numpy as np

from .audio import FRAME, SR, Mic, Player, RingBuffer, chime
from .stt import STT
from .tts import TTS, speakable, split_sentences
from .vad import SpeechDetector, rms, sustained_rms
from .wakeword import WakeWord

log = logging.getLogger("jarvis.voice")

FRAME_MS = FRAME * 1000 // SR   # 80


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def strip_echo(transcript: str, spoken: str) -> str:
    """Remove the part of a transcript that is JARVIS's own voice picked up by the microphone.

    `spoken` is what JARVIS was saying around the moment it was interrupted. Any run of two or more
    words that matches it in order is echo; a lone leftover word that JARVIS also said is echo too.
    """
    if not transcript or not spoken:
        return transcript.strip()
    tokens = re.findall(r"\S+", transcript)
    norm = [(_words(t) or [""])[0] for t in tokens]
    sw = _words(spoken)
    sm = difflib.SequenceMatcher(None, norm, sw, autojunk=False)
    drop = set()
    for b in sm.get_matching_blocks():
        if b.size >= 2:
            drop.update(range(b.a, b.a + b.size))
    keep = [i for i in range(len(tokens)) if i not in drop and norm[i]]
    spoken_set = set(sw)
    if len(keep) == 1 and norm[keep[0]] in spoken_set and len(drop) > 0:
        keep = []
    out = " ".join(tokens[i] for i in keep).strip(" ,.;:-")
    return out


class VoiceLoop:
    def __init__(self, settings, events, loop: asyncio.AbstractEventLoop, on_utterance, on_wake=None):
        self.settings = settings
        self.events = events
        self.loop = loop
        self.on_utterance = on_utterance          # async fn(text, meta)
        self.on_wake = on_wake or (lambda: None)  # e.g. pre-warm the LLM
        self.busy_fn = lambda: False              # set by the assistant: is a task still running?
        self.mic = Mic(settings.get("voice.input_device"))
        self.player = Player(settings.get("voice.output_device"))
        self._chime_player = Player(settings.get("voice.output_device"))
        self.wake = WakeWord(settings.get("voice.wake_word_model", "hey_jarvis"), float(settings.get("voice.wake_threshold", 0.5)),
                             bool(settings.get("voice.energy_gate", True)))
        self.vad = SpeechDetector()
        self.stt = STT(settings.get("voice.stt_backend", "auto"), "turbo", settings.get("voice.language", "en"))
        self.tts = TTS(settings.get("voice.tts_backend", "auto"), settings.get("voice.tts_voice", "bm_george"),
                       float(settings.get("voice.tts_speed", 1.4)), settings.get("voice.say_voice", "Daniel"))
        self.wake_enabled = False
        self.muted = bool(settings.get("voice.muted", False))
        self._req_lock = threading.Lock()
        self._capture_req: dict | None = None
        self._ptt_held = False
        self._wakeup = threading.Event()
        self._running = False
        self._speak_stop = threading.Event()
        self._speak_lock = threading.Lock()   # one utterance at a time, in order
        self._speak_gen = 0                   # bumped by stop: queued utterances are dropped
        self.speaking = False
        self.capturing = False
        self.current_speech: list[str] = []   # sentences of the utterance being spoken
        self._sentence_idx = 0
        self._interrupted: dict | None = None
        self._echo_ratio: float | None = None  # mic level / output level for JARVIS's own voice (learned)
        self._echo_lag: float | None = None    # seconds from writing audio to hearing it in the mic (learned)
        self._suspect_k = 1.3                  # how much louder than the expected echo counts as "maybe you" 
        self._thread: threading.Thread | None = None
        self.last_error: str | None = None
        self._level_t = 0.0
        self._last_wait = 0.0
        self._barge_reset()

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

    def prewarm(self) -> None:
        """Load speech recognition and the voice in the background (they take a few seconds the first time)."""
        def work():
            try:
                self.vad.load()
                if self.stt._model is None:
                    self.stt.load()
                if self.tts.backend == "kokoro" and self.tts._kokoro is None:
                    self.tts.warm()
            except Exception as e:
                log.warning("prewarm failed: %s", e)

        threading.Thread(target=work, name="jarvis-prewarm", daemon=True).start()

    def ptt_down(self) -> None:
        self.stop_speaking()
        self._ptt_held = True
        self.events.emit("wake", source="ptt")
        self.prewarm()
        self._request("ptt")

    def ptt_up(self) -> None:
        self._ptt_held = False
        self._wakeup.set()

    def request_followup(self) -> None:
        if self.settings.get("voice.hands_free", True) and not self.muted:
            self._request("followup", timeout=float(self.settings.get("voice.followup_seconds", 8.0)))

    def listen_once(self, timeout: float = 8.0) -> Future:
        fut: Future = Future()
        self._request("ask", timeout=timeout, future=fut)
        return fut

    @property
    def capture_pending(self) -> bool:
        return self._capture_req is not None

    def _request(self, kind: str, timeout: float = 5.0, future: Future | None = None) -> None:
        with self._req_lock:
            old = self._capture_req
            if old and old.get("future") and not old["future"].done() and kind != "ask":
                old["future"].set_result(None)
            self._capture_req = {"kind": kind, "timeout": timeout, "future": future, "t": time.monotonic()}
        self._wakeup.set()

    def stop_speaking(self) -> None:
        self._speak_gen += 1            # anything queued behind the current utterance is dropped too
        self._speak_stop.set()
        self.player.stop()

    def stop_all(self) -> None:
        self.stop_speaking()
        self._interrupted = None
        with self._req_lock:
            req, self._capture_req = self._capture_req, None
        if req and req.get("future") and not req["future"].done():
            req["future"].set_result(None)

    def _emit_idle(self) -> None:
        """Say "idle" only when nothing is happening: not speaking, not listening, no task running."""
        if self.speaking or self.capturing or self._capture_req is not None:
            return
        self.events.emit("status", status="thinking" if self.busy_fn() else "idle")

    # --- speaking -------------------------------------------------------------------------
    async def speak(self, text: str) -> bool:
        text = speakable(text)
        if not text:
            return True
        self.events.emit("say", text=text)
        if self.muted and self.settings.get("voice.mute_speech_when_muted", False):
            return True
        gen = self._speak_gen
        return await asyncio.to_thread(self._speak_blocking, text, gen)

    def _speak_blocking(self, text: str, gen: int, followup: bool = False) -> bool:
        with self._speak_lock:                     # wait for the previous utterance to finish
            if gen != self._speak_gen:             # a stop/interruption happened while waiting
                return False
            self._speak_stop.clear()
            self.player.begin()
            sentences = split_sentences(text, first_short=True)
            self.current_speech, self._sentence_idx = sentences, 0
            self._interrupted = None
            self._barge_reset()
            self.speaking = True
            self.events.emit("status", status="speaking")
            self._wakeup.set()                     # open the mic so you can talk over it
            completed = False
            try:
                completed = self._play_sentences(sentences, text)
                return completed
            finally:
                self.player.finish()
                est = self._echo_estimate()
                if est is not None:
                    self._echo_ratio = est              # remembered for the next reply (with the delay)
                self.speaking = False
                self._speak_end_t = time.monotonic()
                if not completed and self._speak_stop.is_set():
                    self._interrupted = {"sentences": sentences[self._sentence_idx:], "t": time.monotonic(), "followup": followup}
                self._emit_idle()
                if completed and followup:
                    self.request_followup()

    def _play_sentences(self, sentences: list[str], text: str) -> bool:
        if self.tts.backend == "say":
            return self.tts.say_blocking(text, self._speak_stop)
        if self.tts.backend != "kokoro":
            return True  # no audio output available (e.g. headless test)
        q: queue.Queue = queue.Queue(maxsize=2)

        def produce():
            try:
                for s in sentences:
                    if self._speak_stop.is_set():
                        break
                    q.put(self.tts.synth(s))
            except Exception as e:  # fall back to `say` for this utterance
                q.put(e)
            q.put(None)

        threading.Thread(target=produce, daemon=True).start()
        idx = 0
        while True:
            try:
                item = q.get(timeout=0.05)   # poll so "stop" never waits for the next sentence to synthesize
            except queue.Empty:
                if self._speak_stop.is_set():
                    return False
                continue
            if item is None:
                return not self._speak_stop.is_set()
            if isinstance(item, Exception):
                log.warning("Kokoro failed (%s); using macOS say", item)
                return self.tts.say_blocking(" ".join(sentences[idx:]), self._speak_stop)
            self._sentence_idx = idx
            if self._speak_stop.is_set() or not self.player.play(*item):
                return False
            idx += 1

    def _resume_after_false_alarm(self) -> None:
        """The 'interruption' was only noise or JARVIS's own echo: carry on from the interrupted sentence."""
        intr, self._interrupted = self._interrupted, None
        if not intr or time.monotonic() - intr["t"] > 10 or not intr["sentences"]:
            return
        log.info("false interruption; resuming")
        text = " ".join(intr["sentences"])
        gen = self._speak_gen
        threading.Thread(target=self._speak_blocking, args=(text, gen, True), daemon=True).start()

    def play_chime(self, kind: str) -> None:
        if self.settings.get("voice.chime", False):
            threading.Thread(target=lambda: (self._chime_player.begin(), self._chime_player.play(chime(kind), 24000),
                                             self._chime_player.finish()), daemon=True).start()

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
                frame = None
                if self.speaking and self._barge_in_enabled():
                    # While JARVIS talks, the only question is whether you are talking over it.
                    frame = self.mic.read(timeout=0.2)
                    if frame is not None and self._barge_check(frame):
                        self._on_barge_in()
                    continue
                with self._req_lock:
                    req = self._capture_req
                if req is not None:
                    self._handle_capture(req)
                    continue
                frame = self.mic.read(timeout=0.5)
                if frame is None or not self.wake_enabled:
                    continue
                score = self.wake.process(frame)
                if score is not None:
                    log.info("wake word (%.2f)", score)
                    self.stop_speaking()
                    self.events.emit("wake", score=round(score, 3), source="wake_word")
                    self.prewarm()
                    self.on_wake()
                    self._request("wake", timeout=6.0)
            except Exception as e:  # keep the assistant alive; report and back off
                self.last_error = f"{type(e).__name__}: {e}"
                log.exception("voice loop error")
                self.events.emit("error", where="voice", message=self.last_error)
                self.mic.stop()
                self.capturing = False
                time.sleep(2.0)

    def _on_barge_in(self) -> None:
        log.info("barge-in: you started talking over JARVIS")
        i = self._sentence_idx
        self._barge_context = " ".join(self.current_speech[max(0, i - 1): i + 2])
        pre = self._barge_pre.get()
        self.stop_speaking()                 # aborts the audio stream: silent within milliseconds
        self.events.emit("barge_in")
        self._barge_frames = pre
        self._request("barge", timeout=4.0)
        if self.wake_enabled:
            self.wake.reset()

    def _handle_capture(self, req: dict) -> None:
        kind = req["kind"]
        if kind in ("wake", "ptt", "ask"):
            self.play_chime("listen")
        self.capturing = True
        self.events.emit("status", status="listening", reason=kind)
        try:
            audio = self._capture(kind, req["timeout"])
        finally:
            with self._req_lock:
                if self._capture_req is req:
                    self._capture_req = None
            self.capturing = False
        self.wake.reset()  # the command audio must never feed a later wake-word decision
        fut = req.get("future")
        if audio is None:
            if kind == "barge":
                self._resume_after_false_alarm()
            if fut and not fut.done():
                fut.set_result(None)
            self._emit_idle()
            return
        self.events.emit("status", status="transcribing")
        result = self.stt.transcribe(audio)
        text = result["text"]
        if kind == "barge" and text:
            heard = text
            text = strip_echo(text, getattr(self, "_barge_context", ""))
            if heard != text:
                log.info("removed JARVIS's own words from the transcript: %r -> %r", heard, text)
        if not text:
            if kind == "barge":
                self._resume_after_false_alarm()
            elif kind in ("followup", "wake") and req["timeout"] - self._last_wait > 1.5:
                # A cough, a click, a word to someone else: keep listening for the rest of the window.
                self._request(kind, timeout=req["timeout"] - self._last_wait)
                return
            if fut and not fut.done():
                fut.set_result(None)
            self._emit_idle()
            return
        self._interrupted = None
        self.events.emit("transcript", text=text, stt_ms=result["ms"], audio_s=result["duration"], source=kind)
        self.events.emit("timing", stage="stt", ms=result["ms"], audio_s=result["duration"])
        if fut is not None:
            if not fut.done():
                fut.set_result(text)
            self.events.emit("status", status="thinking")
            return
        self.events.emit("status", status="thinking")
        asyncio.run_coroutine_threadsafe(self.on_utterance(text, {"source": kind, "stt_ms": result["ms"],
                                                                  "heard_at": time.time()}), self.loop)

    # --- barge-in: notice YOU talking over JARVIS's own voice ------------------------------------------
    def _barge_reset(self) -> None:
        self._echo_samples: list[float] = []      # mic / output, lined up by the measured delay
        self._win_samples: list[float] = []       # mic / loudest recent output (before the delay is known)
        self._mic_env: list[tuple[float, float]] = []
        self._barge_hits = 0
        self._barge_pre = RingBuffer(0.8)
        self._speak_t0 = None
        self._lag_checked = 0.0
        self._duck_t = None
        self._confirm = self._confirm_seen = 0
        self.vad.reset()

    # The echo model: JARVIS's voice reaches the mic `lag` seconds after it is written to the speaker, at a
    # fairly constant fraction (`ratio`) of its level. Both are measured from its own speech (and remembered),
    # so the expected echo for every 80 ms frame is known and anything well above it is you.
    def _out_at(self, ts: np.ndarray, hist: np.ndarray) -> np.ndarray:
        """Output level around each time in `ts` (max of the 40 ms blocks written within -60..+20 ms)."""
        if len(hist) == 0:
            return np.zeros(len(ts))
        d = hist[None, :, 0] - ts[:, None]
        m = (d >= -0.06) & (d <= 0.02)
        return np.where(m, hist[None, :, 1], 0.0).max(axis=1)

    def _estimate_lag(self, hist: np.ndarray) -> None:
        env = np.array(self._mic_env[-60:])
        if len(env) < 16:
            return
        best, best_c = None, 0.0
        for lag in np.arange(0.0, 0.42, 0.02):
            o = self._out_at(env[:, 0] - lag, hist)
            ok = o > 0.005
            if ok.sum() < 10:
                continue
            x, y = np.log(o[ok] + 1e-4), np.log(env[ok, 1] + 1e-4)
            if x.std() < 1e-6 or y.std() < 1e-6:
                continue
            c = float(np.corrcoef(x, y)[0, 1])
            if c > best_c:
                best, best_c = float(lag), c
        if best is not None and best_c >= 0.5:
            if self._echo_lag is not None and abs(self._echo_lag - best) <= 0.04:
                best = 0.5 * (self._echo_lag + best)
            if self._echo_lag is None or abs(self._echo_lag - best) > 0.001:
                log.info("echo delay %.0f ms (r=%.2f)", best * 1000, best_c)
            self._echo_lag = best

    def _expected_echo(self, t: float, hist: np.ndarray) -> tuple[float, float | None]:
        """(raw output level that should be echoing in this frame, learned ratio or None)."""
        if self._echo_lag is not None:
            o = self._out_at(np.array([t - 0.04 - self._echo_lag, t - self._echo_lag]), hist)
            ratio = (float(np.percentile(self._echo_samples[-60:], 85)) if len(self._echo_samples) >= 8
                     else self._echo_ratio)
            return float(o.mean()), ratio
        o = float(hist[hist[:, 0] >= t - 0.35, 1].max()) if len(hist) and (hist[:, 0] >= t - 0.35).any() else 0.0
        ratio = float(np.percentile(self._win_samples[-60:], 90)) if len(self._win_samples) >= 6 else None
        return o, ratio

    def _barge_check(self, frame: np.ndarray) -> bool:
        """Are YOU talking over JARVIS? Two stages:
        1. Suspect: a human voice (voice-activity model; key clicks score low) louder than the expected echo
           of JARVIS's own voice for 160 ms -> JARVIS ducks to 15 % volume at once.
        2. Confirm: with JARVIS that quiet, your voice clearly dominates the mic if you're really talking.
           Confirmed -> stop (returns True). Not confirmed within ~0.4 s -> volume back up, nothing lost."""
        now = time.monotonic()
        t = getattr(self.mic, "last_t", 0.0) or now
        if self._speak_t0 is None:
            self._speak_t0 = now
        self._barge_pre.add(frame)
        p = self.vad.prob(frame)
        mic = sustained_rms(frame)
        half = len(frame) // 2
        noise = max(min(self.wake.noise_floor, 0.01), 0.002)
        voice = p >= 0.55
        hist = np.array(list(self.player.history), dtype=float).reshape(-1, 2)
        if self._duck_t is None:
            self._mic_env += [(t - 0.04, sustained_rms(frame[:half], 4)), (t, sustained_rms(frame[half:], 4))]
            self._mic_env = self._mic_env[-80:]
            if now - self._lag_checked > 1.0 and now - self._speak_t0 > 1.0:
                self._lag_checked = now
                self._estimate_lag(hist)
        o, ratio = self._expected_echo(t, hist)
        if self._duck_t is None:
            if o > 0.02 and now - self._speak_t0 > 0.15:            # learn (never while ducked)
                (self._echo_samples if self._echo_lag is not None else self._win_samples).append(mic / o)
            if ratio is None:
                if now - self._speak_t0 < 0.6:
                    return False                                     # very first reply: learn before judging
                ratio = 0.5
            louder = mic > max(ratio * o * self._suspect_k, noise * 4, 0.006)
            self._barge_hits = self._barge_hits + 1 if (voice and louder) else 0
            if self._barge_hits >= 2:
                self.player.duck(0.15)
                self._duck_t = now
                self._confirm = self._confirm_seen = 0
                self.events.emit("barge_suspect")
            return False
        since = now - self._duck_t
        if since < min(0.3, (self._echo_lag or 0.2) + 0.02):
            return False                                            # the ducked audio hasn't reached the mic yet
        self._confirm_seen += 1
        if voice and mic > max((ratio or 0.5) * o * 1.5, noise * 4, 0.006):
            self._confirm += 1
        if self._confirm >= 2:
            self._suspect_k = max(1.25, self._suspect_k * 0.97)    # real interruption: a bit more sensitive
            return True
        if self._confirm_seen >= 5:                                 # not you after all: back to normal volume
            self._suspect_k = min(2.0, self._suspect_k * 1.1)      # false alarm: a bit stricter in this room
            log.info("false alarm while speaking; sensitivity now %.2f", self._suspect_k)
            self.player.unduck()
            self._duck_t = None
            self._barge_hits = 0
        return False

    def _echo_estimate(self) -> float | None:
        if self._echo_lag is not None and len(self._echo_samples) >= 8:
            return float(np.percentile(self._echo_samples[-60:], 85))
        return self._echo_ratio

    # --- recording ------------------------------------------------------------------------------
    def _capture(self, kind: str, timeout: float) -> np.ndarray | None:
        """Record until you stop talking (voice-activity model) or release push-to-talk.
        Returns float32 audio, or None if nobody spoke within `timeout` seconds of listening."""
        frames: list[np.ndarray] = []
        started = False
        self.vad.reset()
        if kind == "barge":   # you're already talking: keep what you said over JARVIS
            frames.extend(getattr(self, "_barge_frames", []))
            self._barge_frames = []
            started = True
        noise = max(min(self.wake.noise_floor, 0.01), 0.002)
        end_ms = int(self.settings.get("voice.end_silence_ms", 500))
        max_s = float(self.settings.get("voice.max_utterance_s", 15))
        waited = 0.0
        silence_ms = 0
        voiced = 0
        pre = RingBuffer(0.4)
        t_start = time.monotonic()
        last = time.monotonic()
        self._last_wait = 0.0
        while self._running:
            with self._req_lock:
                if self._capture_req is None or self._capture_req["kind"] != kind:
                    return None  # cancelled or superseded
            frame = self.mic.read(timeout=0.3)
            now = time.monotonic()
            dt, last = now - last, now
            if not started and not self.speaking:
                waited += dt
                self._last_wait = waited
            if frame is None:
                if started and now - t_start > max_s:
                    break
                if not started and kind != "ptt" and waited > timeout:
                    return None
                continue
            level = rms(frame)
            if now - self._level_t > 0.08:
                self._level_t = now
                self.events.emit("level", value=round(min(1.0, level * 12), 3))
            if kind == "ptt":
                frames.append(frame)
                if not self._ptt_held:
                    for _ in range(2):   # small tail so the last word isn't clipped
                        f = self.mic.read(timeout=0.1)
                        if f is not None:
                            frames.append(f)
                    break
                if now - t_start > max_s:
                    break
                continue
            if self.speaking and kind != "barge":
                # A queued reply is playing: don't record JARVIS's own voice; the window resumes after it.
                pre.clear()
                voiced = 0
                continue
            p = self.vad.prob(frame)
            is_voice = p >= 0.5 and sustained_rms(frame) > max(noise * 1.5, 0.003)
            if not started:
                pre.add(frame)
                voiced = voiced + 1 if is_voice else 0
                if voiced >= 2:
                    started = True
                    t_start = now
                    frames.extend(pre.get())
                elif waited > timeout:
                    return None  # nobody spoke
                continue
            frames.append(frame)
            silence_ms = 0 if p >= 0.35 else silence_ms + FRAME_MS
            if silence_ms >= end_ms or now - t_start > max_s:
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
                "speaking": self.speaking, "listening": self.capturing, "stt": f"{self.stt.backend}/{self.stt.size}",
                "stt_loaded": self.stt._model is not None, "tts": self.tts.backend, "voice": self.tts.voice,
                "tts_loaded": self.tts._kokoro is not None, "echo_ratio": self._echo_ratio,
                "wake_stats": self.wake.stats(), "error": self.last_error}
