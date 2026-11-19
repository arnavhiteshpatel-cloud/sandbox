"""Power management: modes, automatic switching, model residency and background-work scheduling.

Principles:
- Idle = no token generation, no screenshots, no indexing, no TTS, models unloaded on a timer.
- Mode changes never interrupt a running user task; they apply when it finishes.
- Heavy optional work (indexing, embedding, model downloads) runs only while charging, at
  background QoS (`taskpolicy -b`: efficiency cores, throttled I/O), unless you force it.
- JARVIS never holds a sleep assertion unless "prevent_sleep_during_tasks" is enabled.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass

log = logging.getLogger("jarvis.power")

PROFILES: dict[str, dict] = {
    "battery_saver": {
        "label": "Battery Saver",
        "keep_alive": "3m",        # unload the LLM 3 min after the last use (an idle loaded model draws ~no power)
        "prewarm_on_wake": False,  # don't load the LLM until we know it's needed
        "stt_model": "small",
        "animations": "minimal",
        "index_allowed": False,
        "unload_voice_models_after_s": 300,
    },
    "balanced": {
        "label": "Balanced",
        "keep_alive": "30m",       # reloading costs seconds per request; holding it in memory costs ~nothing
        "prewarm_on_wake": True,   # start loading the LLM while you are still speaking
        "stt_model": "turbo",
        "animations": "normal",
        "index_allowed": "charging",
        "unload_voice_models_after_s": 1800,
    },
    "max_performance": {
        "label": "Maximum Performance",
        "keep_alive": "2h",
        "prewarm_on_wake": True,
        "stt_model": "turbo",
        "animations": "full",
        "index_allowed": "charging",
        "unload_voice_models_after_s": 7200,
    },
}


@dataclass
class PowerState:
    source: str = "unknown"     # ac | battery | unknown
    percent: int | None = None
    charging: bool = False
    asleep: bool = False
    updated: float = 0.0


def read_power_source() -> PowerState:
    if sys.platform != "darwin":
        return PowerState("ac", 100, True, updated=time.time())
    try:
        out = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return PowerState(updated=time.time())
    m = re.search(r"(\d+)%;\s*([\w ]+?);", out)
    src = "ac" if "AC Power" in out else "battery"
    return PowerState(src, int(m.group(1)) if m else None, "charging" in out and "discharging" not in out, updated=time.time())


class PowerManager:
    def __init__(self, settings, events, on_mode_change=None):
        self.settings = settings
        self.events = events
        self.on_mode_change = on_mode_change or (lambda mode: None)
        self.state = read_power_source()
        self.mode = settings.get("power.mode", "balanced")
        self.pending_mode: str | None = None
        self.task_running = False
        self._index_proc: subprocess.Popen | None = None
        self._index_forced = False
        self._caffeinate: subprocess.Popen | None = None
        self._last_index_check = 0.0

    @property
    def profile(self) -> dict:
        return PROFILES.get(self.mode, PROFILES["balanced"])

    def wake_word_allowed(self) -> bool:
        if not self.settings.get("voice.wake_word_enabled", True):
            return False
        policy = self.settings.get("voice.wake_word_policy", "ac_only")
        if policy == "never":
            return False
        if policy == "ac_only":
            return self.state.source != "battery"
        if policy == "except_battery_saver":
            return self.mode != "battery_saver"
        return True

    # --- mode selection ------------------------------------------------------------------
    def auto_mode(self) -> str:
        if self.state.source == "ac":
            return self.settings.get("power.auto_on_ac", "max_performance")
        low = int(self.settings.get("power.low_battery_percent", 30))
        if self.state.percent is not None and self.state.percent <= low:
            return self.settings.get("power.auto_on_battery_low", "battery_saver")
        return self.settings.get("power.auto_on_battery", "balanced")

    def set_mode(self, mode: str, manual: bool = True, immediate: bool = False) -> str:
        if mode not in PROFILES:
            raise ValueError(f"unknown mode {mode}")
        if manual:
            self.settings.set("power.mode", mode)
            # A manual choice wins until the power source changes again.
            self._manual_until_source = self.state.source
        if self.task_running and mode != self.mode and not immediate:
            self.pending_mode = mode
            self.events.emit("power", mode=self.mode, pending=mode, note="applies after the current task")
            return self.mode
        self._apply(mode)
        return mode

    def _apply(self, mode: str) -> None:
        if mode == self.mode and self.pending_mode is None:
            self.events.emit("power", **self.status())
            return
        old = self.mode
        self.mode = mode
        self.pending_mode = None
        log.info("power mode %s -> %s", old, mode)
        self.on_mode_change(mode)
        self.events.emit("power", **self.status())

    def task_started(self) -> None:
        self.task_running = True
        if self.settings.get("power.prevent_sleep_during_tasks", False) and sys.platform == "darwin" and self._caffeinate is None:
            # -i prevents idle sleep only (lid close still sleeps); -w ties it to our process.
            self._caffeinate = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])

    def task_finished(self) -> None:
        self.task_running = False
        if self._caffeinate:
            self._caffeinate.terminate()
            self._caffeinate = None
        if self.pending_mode:
            self._apply(self.pending_mode)

    def power_source_changed(self, state: PowerState | None = None) -> None:
        prev = self.state.source
        self.state = state or read_power_source()
        if self.settings.get("power.auto_switch", True):
            manual_src = getattr(self, "_manual_until_source", None)
            if manual_src is None or manual_src != self.state.source:
                self._manual_until_source = None
                target = self.auto_mode()
                if target != self.mode:
                    self.set_mode(target, manual=False)
        if prev != self.state.source:
            self.events.emit("power_source", source=self.state.source, percent=self.state.percent)
            if self.state.source == "battery":
                self.stop_indexing(reason="unplugged")
        self.events.emit("power", **self.status())

    def status(self) -> dict:
        return {"mode": self.mode, "label": self.profile["label"], "pending": self.pending_mode,
                "source": self.state.source, "percent": self.state.percent, "charging": self.state.charging,
                "wake_word_active": self.wake_word_allowed(), "indexing": self.indexing}

    # --- background indexing -------------------------------------------------------------
    @property
    def indexing(self) -> bool:
        return self._index_proc is not None and self._index_proc.poll() is None

    def index_allowed(self) -> bool:
        allowed = self.profile["index_allowed"]
        if not allowed:
            return False
        if allowed == "charging" and self.settings.get("search.only_when_charging", True):
            return self.state.source == "ac"
        return True

    def start_indexing(self, force: bool = False) -> bool:
        if self.indexing:
            return True
        if not force and not self.index_allowed():
            return False
        cmd = [sys.executable, "-m", "jarvis", "index", "--max-seconds", "1800"]
        if sys.platform == "darwin":
            cmd = ["taskpolicy", "-b"] + cmd   # background QoS: E-cores, throttled disk
        env = dict(os.environ)
        self._index_proc = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                            preexec_fn=(lambda: os.nice(10)) if sys.platform != "win32" else None)
        self._index_forced = force
        self.events.emit("index", status="started", forced=force)
        return True

    def stop_indexing(self, reason: str = "") -> None:
        if self.indexing and not (self._index_forced and reason == "unplugged"):
            self._index_proc.terminate()
            self.events.emit("index", status="stopped", reason=reason)

    async def maintenance_loop(self, last_activity, db) -> None:
        """Low-frequency housekeeping. Wakes every 5 minutes; does nothing most of the time."""
        while True:
            await asyncio.sleep(300)
            if self.state.asleep:
                continue
            st = await asyncio.to_thread(read_power_source)
            if st.source != self.state.source or (st.percent or 0) // 10 != (self.state.percent or 0) // 10:
                self.power_source_changed(st)
            idle_for = time.time() - last_activity()
            if self.index_allowed() and not self.indexing and not self.task_running and idle_for > 120:
                last = db.one("SELECT max(indexed_at) AS t FROM files")["t"] or 0
                if time.time() - last > 6 * 3600:
                    self.start_indexing()

    # --- sleep -------------------------------------------------------------------------------
    def will_sleep(self) -> None:
        self.state.asleep = True
        self.stop_indexing(reason="sleep")

    def did_wake(self) -> None:
        self.state.asleep = False
        self.power_source_changed()
