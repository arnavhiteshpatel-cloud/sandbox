"""Filesystem locations. Everything JARVIS stores lives under one data directory."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    override = os.environ.get("JARVIS_HOME")
    if override:
        p = Path(override).expanduser()
    elif sys.platform == "darwin":
        p = Path.home() / "Library" / "Application Support" / "JARVIS"
    else:
        p = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "jarvis"
    p.mkdir(parents=True, exist_ok=True)
    return p


def models_dir() -> Path:
    p = data_dir() / "models"
    p.mkdir(parents=True, exist_ok=True)
    return p


def logs_dir() -> Path:
    if sys.platform == "darwin" and not os.environ.get("JARVIS_HOME"):
        p = Path.home() / "Library" / "Logs" / "JARVIS"
    else:
        p = data_dir() / "logs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> Path:
    return data_dir() / "jarvis.sqlite3"


def settings_path() -> Path:
    return data_dir() / "settings.json"


def token_path() -> Path:
    return data_dir() / "api-token"


def ui_dir() -> Path:
    return Path(__file__).parent / "ui"


IS_MAC = sys.platform == "darwin"
