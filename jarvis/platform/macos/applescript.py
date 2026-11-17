"""osascript wrapper with readable errors."""
from __future__ import annotations

import subprocess

from ..base import AutomationError

ERROR_HINTS = {
    "-1743": "macOS blocked automation. Allow JARVIS under System Settings > Privacy & Security > Automation.",
    "-1719": "Accessibility permission is missing. Allow JARVIS under System Settings > Privacy & Security > Accessibility.",
    "-1728": "The target object doesn't exist (no window or tab?).",
    "-600": "The application isn't running.",
    "-1712": "The application took too long to respond.",
    "-2741": "AppleScript syntax error (this is a JARVIS bug).",
}


def quote(s: str) -> str:
    """Escape a Python string as an AppleScript string literal."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def run(script: str, timeout: float = 15.0, language: str = "AppleScript") -> str:
    args = ["osascript", "-l", language, "-e", script]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise AutomationError(f"osascript timed out after {timeout}s") from e
    if proc.returncode != 0:
        err = proc.stderr.strip()
        hint = next((h for code, h in ERROR_HINTS.items() if f"({code})" in err), "")
        raise AutomationError(f"{err} {hint}".strip())
    return proc.stdout.rstrip("\n")
