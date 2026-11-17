"""Platform selection."""
from __future__ import annotations

import logging
import os
import sys

from .base import ActionResult, AutomationError, Computer

log = logging.getLogger("jarvis.platform")


def get_computer(default_browser: str = "Arc") -> Computer:
    forced = os.environ.get("JARVIS_PLATFORM")
    if forced == "fake" or (forced is None and sys.platform != "darwin"):
        from .fake import FakeComputer

        log.warning("Using the SIMULATED computer (not macOS). Actions affect nothing real.")
        return FakeComputer()
    from .macos import MacComputer

    return MacComputer(default_browser)


__all__ = ["ActionResult", "AutomationError", "Computer", "get_computer"]
