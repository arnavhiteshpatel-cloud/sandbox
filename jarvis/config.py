"""Persistent settings (JSON) with defaults and dotted-path access.

Settings are a plain nested dict so the web UI can edit them generically.
Unknown keys from older/newer versions are preserved.
"""
from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any

from . import paths

DEFAULTS: dict[str, Any] = {
    "settings_version": 4,
    "apps": {"aliases": {}},          # app names you taught ("arc" -> "Arc")
    "learning": {
        "ask_before_learning": True,   # user choice: ask before remembering a new phrasing
        "suggest_shortcuts": True,     # user choice: suggest shortcuts for things you repeat, whenever useful
    },
    "history_days": 30,                # user choice: commands, task steps and activity are deleted after 30 days
    "do_it": {
        "finish": "ask_then_submit",   # user choice: spoken summary, then "Submit?"; presses Submit on yes
    },
    "assistant": {
        "name": "JARVIS",
        "user_name": "",              # optional
        "honorific": "sir",            # used only in conversational / multistep replies, never on simple commands
        "session_idle_minutes": 10,   # conversation context expires after this
    },
    "power": {
        "mode": "balanced",           # battery_saver | balanced | max_performance
        "auto_switch": True,          # battery -> balanced/saver, AC -> max (see power.py)
        "auto_on_battery": "balanced",
        "auto_on_battery_low": "battery_saver",
        "low_battery_percent": 30,
        "auto_on_ac": "max_performance",
        "prevent_sleep_during_tasks": False,  # never hold a sleep assertion unless enabled
    },
    "llm": {
        "provider": "ollama",          # ollama | openai_compatible
        "base_url": "http://127.0.0.1:11434",
        "api_key": "",                 # only for optional OpenAI-compatible servers; prefer Keychain
        "models": {                    # per power mode; benchmark with `jarvis bench`
            "battery_saver": "qwen3.5:4b",
            "balanced": "qwen3.5:9b",
            "max_performance": "qwen3.5:9b",
        },
        "vision_model": "",            # empty = same model (Qwen3.5 is natively multimodal)
        "embed_model": "embeddinggemma:300m",
        "num_ctx": 16384,
        "temperature": 0.2,
        "think_policy": "auto",        # auto: fast by default, think for complex requests or when struggling | always | never
        "request_timeout_s": 180,
    },
    "voice": {
        "enabled": True,
        "wake_word_enabled": True,
        # When the always-on wake word runs. User choice (2026-11-17): only while on AC power;
        # on battery JARVIS uses hold-to-talk only (no open mic, no orange dot, lowest drain).
        "wake_word_policy": "ac_only",   # always | ac_only | except_battery_saver | never
        "wake_word_model": "hey_jarvis",
        "wake_threshold": 0.5,         # 0..1, lower = more sensitive
        "energy_gate": True,           # skip wake-word inference during silence (saves power)
        "input_device": None,          # None = system default
        "output_device": None,
        "stt_backend": "auto",         # auto | mlx | faster_whisper
        "stt_model": "auto",           # resolved per power mode
        "language": "en",
        "tts_backend": "auto",         # auto | kokoro | say
        "tts_voice": "bm_george",      # Kokoro British male voice; `say` fallback uses Daniel
        "say_voice": "Daniel",
        "tts_speed": 1.4,
        "followup_seconds": 8.0,       # listen for a follow-up without the wake word
        "hands_free": True,
        "barge_in": True,              # interrupt JARVIS by simply talking over it (turn off if it cuts itself off)
        "end_silence_ms": 500,
        "max_utterance_s": 15,
        "muted": False,
        "chime": False,                # user choice: no listening sound
        "speak_confirmations": False,  # user choice: simple confirmations are shown on the HUD, not spoken
    },
    "agent": {
        "max_steps": {"battery_saver": 8, "balanced": 20, "max_performance": 40},
        "allow_vision": {"battery_saver": False, "balanced": True, "max_performance": True},
        "step_timeout_s": 60,
        "confirm_high_risk": True,
    },
    "browser": {
        "default": "Arc",              # Arc | Google Chrome | Safari | Brave Browser | Microsoft Edge
        "page_load_timeout_s": 20,
    },
    "web": {
        "enabled": True,               # background internet lookups (DuckDuckGo → Bing → Wikipedia; no keys, no accounts)
    },
    "search": {
        # User authorized the whole home folder (2026-11-17). Private/system areas are excluded below.
        "roots": ["~"],
        "exclude": [
            "**/.git/**", "**/node_modules/**", "**/.venv/**", "**/Library/**",
            "**/.Trash/**", "**/*.photoslibrary/**", "**/.ssh/**", "**/.gnupg/**",
            "**/.*/**",                  # all hidden folders (configs, caches, credentials)
            "**/*.keychain*", "**/*.kdbx", "**/*.1pux", "**/*.agilekeychain/**", "**/*.opvault/**",
            "**/Applications/**", "**/*.app/**", "**/__pycache__/**", "**/build/**", "**/dist/**",
            "**/Pictures/Photos Library.photoslibrary/**", "**/Music/**", "**/Movies/**",
        ],
        "max_file_mb": 50,
        "only_when_charging": True,
        "semantic": True,
        "ocr_images": True,
        "use_spotlight": True,
    },
    "security": {
        "allowed_apps": [],            # empty = all apps allowed
        "blocked_apps": [],            # user choice (2026-11-18): every app is reachable
        # Apps where any click/type/keypress/script by JARVIS asks first (consistent with "confirm high-impact").
        "sensitive_apps": ["Terminal", "iTerm", "iTerm2", "Keychain Access", "Passwords", "System Settings",
                           "1Password", "Bitwarden", "Disk Utility", "Activity Monitor"],
        "shell_allowlist": ["ls", "du", "mdfind", "mdls", "file", "wc", "head", "stat", "sw_vers", "pmset", "system_profiler"],
        "file_write_roots": ["~/Downloads", "~/Documents", "~/Desktop"],
    },
    "ui": {
        "reduced_motion": False,
        "show_hud": True,
        "hud_style": "pill",           # minimal pill, visible only while active
        "hud_position": "top_left",    # user choice (2026-11-18)
    },
    "hotkeys": {                       # handled by the native shell (Carbon hot keys)
        "push_to_talk": "opt+shift+c", # hold to talk
        "emergency_stop": "ctrl+opt+cmd+.",
    },
    "server": {
        "host": "127.0.0.1",
        "port": 47823,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


SETTINGS_VERSION = 4


def _migrate(data: dict, stored_version: int) -> dict:
    """Upgrade saved settings when defaults change for a reason (feedback from real use)."""
    if stored_version < 2:
        v = data.setdefault("voice", {})
        if float(v.get("tts_speed", 1.25)) <= 1.1:
            v["tts_speed"] = 1.25          # "talks way too slow"
        if int(v.get("end_silence_ms", 600)) >= 750:
            v["end_silence_ms"] = 600      # respond sooner after you stop talking
        data.get("llm", {}).pop("think", None)   # replaced by think_policy (auto)
        data.get("security", {})["blocked_apps"] = [a for a in data.get("security", {}).get("blocked_apps", [])
                                                    if a not in ("Keychain Access", "Terminal", "iTerm")]
    if stored_version < 3:   # design choices made by the user on 2026-11-18
        v = data.setdefault("voice", {})
        v["chime"] = False
        v["speak_confirmations"] = False
        data.setdefault("ui", {})["hud_position"] = "top_left"
    if stored_version < 4:   # feedback 2026-11-19: talk faster, respond sooner, follow-up window that works
        v = data.setdefault("voice", {})
        if float(v.get("tts_speed", 1.4)) < 1.4:
            v["tts_speed"] = 1.4
        if float(v.get("followup_seconds", 8.0)) < 8.0:
            v["followup_seconds"] = 8.0
        if int(v.get("end_silence_ms", 500)) > 500:
            v["end_silence_ms"] = 500        # speech end is now detected by a voice model, not loudness
    data["settings_version"] = SETTINGS_VERSION
    return data


class Settings:
    def __init__(self, path: Path | None = None):
        self.path = path or paths.settings_path()
        self._lock = threading.RLock()
        self._data: dict[str, Any] = copy.deepcopy(DEFAULTS)
        self._listeners: list = []
        self.load()

    def load(self) -> None:
        with self._lock:
            if self.path.exists():
                try:
                    stored = json.loads(self.path.read_text())
                    version = int(stored.get("settings_version", 1))
                    self._data = _deep_merge(DEFAULTS, stored)
                    if version < SETTINGS_VERSION:
                        self._data = _migrate(self._data, version)
                        self.save()
                except (json.JSONDecodeError, OSError):
                    # Keep the broken file for inspection; run on defaults.
                    self.path.rename(self.path.with_suffix(".corrupt.json"))
                    self._data = copy.deepcopy(DEFAULTS)

    def save(self) -> None:
        with self._lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, indent=2, sort_keys=True))
            tmp.replace(self.path)

    def get(self, dotted: str, default: Any = None) -> Any:
        node: Any = self._data
        for part in dotted.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    def set(self, dotted: str, value: Any, save: bool = True) -> None:
        with self._lock:
            parts = dotted.split(".")
            node = self._data
            for part in parts[:-1]:
                node = node.setdefault(part, {})
            node[parts[-1]] = value
            if save:
                self.save()
        for fn in list(self._listeners):
            fn(dotted, value)

    def update(self, patch: dict) -> None:
        with self._lock:
            self._data = _deep_merge(self._data, patch)
            self.save()
        for fn in list(self._listeners):
            fn("*", patch)

    def on_change(self, fn) -> None:
        self._listeners.append(fn)

    def as_dict(self) -> dict:
        with self._lock:
            d = copy.deepcopy(self._data)
        if d.get("llm", {}).get("api_key"):
            d["llm"]["api_key"] = "********"
        return d

    def per_mode(self, dotted: str, mode: str, default: Any = None) -> Any:
        v = self.get(dotted)
        if isinstance(v, dict):
            return v.get(mode, default)
        return v if v is not None else default
