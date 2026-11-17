"""Keyboard and mouse synthesis via Quartz CGEvents (requires Accessibility permission)."""
from __future__ import annotations

import time

from ..base import ActionResult

try:
    import Quartz  # type: ignore
    HAVE_QUARTZ = True
except Exception:  # pragma: no cover
    HAVE_QUARTZ = False

KEYCODES = {
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
    "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
    ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
    "f11": 103, "f12": 111, "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
}
MODS = {}
if HAVE_QUARTZ:
    MODS = {
        "cmd": Quartz.kCGEventFlagMaskCommand, "command": Quartz.kCGEventFlagMaskCommand,
        "shift": Quartz.kCGEventFlagMaskShift, "alt": Quartz.kCGEventFlagMaskAlternate,
        "option": Quartz.kCGEventFlagMaskAlternate, "opt": Quartz.kCGEventFlagMaskAlternate,
        "ctrl": Quartz.kCGEventFlagMaskControl, "control": Quartz.kCGEventFlagMaskControl,
        "fn": Quartz.kCGEventFlagMaskSecondaryFn,
    }


def parse_combo(combo: str) -> tuple[int, list[str]]:
    parts = [p.strip().lower() for p in combo.replace(" ", "").split("+") if p.strip()]
    if not parts:
        raise ValueError("empty key combo")
    key = parts[-1]
    mods = parts[:-1]
    if key not in KEYCODES:
        raise ValueError(f"unknown key '{key}'")
    for m in mods:
        if m not in ("cmd", "command", "shift", "alt", "option", "opt", "ctrl", "control", "fn"):
            raise ValueError(f"unknown modifier '{m}'")
    return KEYCODES[key], mods


def press_keys(combo: str) -> ActionResult:
    try:
        code, mods = parse_combo(combo)
    except ValueError as e:
        return ActionResult.fail(str(e))
    flags = 0
    for m in mods:
        flags |= MODS[m]
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    down = Quartz.CGEventCreateKeyboardEvent(src, code, True)
    up = Quartz.CGEventCreateKeyboardEvent(src, code, False)
    Quartz.CGEventSetFlags(down, flags)
    Quartz.CGEventSetFlags(up, flags)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    time.sleep(0.01)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
    return ActionResult(True, f"Pressed {combo}.")


def type_text(text: str) -> ActionResult:
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    for i in range(0, len(text), 16):
        chunk = text[i:i + 16]
        for down in (True, False):
            ev = Quartz.CGEventCreateKeyboardEvent(src, 0, down)
            Quartz.CGEventKeyboardSetUnicodeString(ev, len(chunk), chunk)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
        time.sleep(0.012)
    return ActionResult(True, "Typed the text.")


def click_at(x: float, y: float, button: str = "left", count: int = 1) -> ActionResult:
    pt = Quartz.CGPoint(x, y)
    if button == "right":
        dn, upk, btn = Quartz.kCGEventRightMouseDown, Quartz.kCGEventRightMouseUp, Quartz.kCGMouseButtonRight
    else:
        dn, upk, btn = Quartz.kCGEventLeftMouseDown, Quartz.kCGEventLeftMouseUp, Quartz.kCGMouseButtonLeft
    move = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, pt, btn)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)
    time.sleep(0.03)
    for i in range(1, count + 1):
        d = Quartz.CGEventCreateMouseEvent(None, dn, pt, btn)
        u = Quartz.CGEventCreateMouseEvent(None, upk, pt, btn)
        Quartz.CGEventSetIntegerValueField(d, Quartz.kCGMouseEventClickState, i)
        Quartz.CGEventSetIntegerValueField(u, Quartz.kCGMouseEventClickState, i)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, d)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, u)
        time.sleep(0.04)
    return ActionResult(True, f"Clicked at ({int(x)}, {int(y)}).")


def scroll(direction: str = "down", amount: int = 5) -> ActionResult:
    dy = -amount if direction == "down" else amount if direction == "up" else 0
    dx = -amount if direction == "right" else amount if direction == "left" else 0
    ev = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, dy, dx)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
    return ActionResult(True, f"Scrolled {direction}.")
