"""Credentials in the macOS Keychain (never in settings.json or logs).

Uses the `security` CLI so no extra entitlements are needed. On non-macOS systems the
functions are no-ops that return None.
"""
from __future__ import annotations

import subprocess
import sys

SERVICE = "JARVIS"


def get(name: str) -> str | None:
    if sys.platform != "darwin":
        return None
    p = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-a", name, "-w"],
                       capture_output=True, text=True, timeout=10)
    return p.stdout.rstrip("\n") if p.returncode == 0 else None


def set(name: str, value: str) -> bool:  # noqa: A001 - mirrors keychain verb
    if sys.platform != "darwin":
        return False
    # -U updates an existing item. The value is passed as an argument to `security`, which is
    # visible to other processes of the same user for an instant; acceptable for a local single-user Mac.
    p = subprocess.run(["security", "add-generic-password", "-s", SERVICE, "-a", name, "-w", value, "-U"],
                       capture_output=True, text=True, timeout=10)
    return p.returncode == 0


def delete(name: str) -> bool:
    if sys.platform != "darwin":
        return False
    p = subprocess.run(["security", "delete-generic-password", "-s", SERVICE, "-a", name], capture_output=True, timeout=10)
    return p.returncode == 0
