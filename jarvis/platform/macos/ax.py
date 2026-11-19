"""Accessibility (AXUIElement) inspection and control for native apps.

Produces a compact, indexed element list ("a17: AXButton 'Save'") the agent can act on by id,
which is far more robust than clicking screen coordinates.
"""
from __future__ import annotations

import time
from typing import Any

from ..base import ActionResult

try:  # pyobjc is only present on macOS
    import ApplicationServices as AXS  # type: ignore
    from ApplicationServices import (  # type: ignore
        AXIsProcessTrusted,
        AXUIElementCopyAttributeValue,
        AXUIElementCreateApplication,
        AXUIElementPerformAction,
        AXUIElementSetAttributeValue,
        AXUIElementSetMessagingTimeout,
        AXValueGetValue,
    )
    HAVE_AX = True
except Exception:  # pragma: no cover
    HAVE_AX = False

INTERACTIVE = {
    "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXComboBox", "AXMenuButton", "AXMenuItem", "AXTab", "AXSlider", "AXDisclosureTriangle",
    "AXCell", "AXRow", "AXSegmentedControl", "AXIncrementor", "AXSwitch", "AXToolbarButton",
}
TEXTUAL = {"AXStaticText", "AXHeading"}
SKIP_SUBTREE = {"AXMenuBar"}  # menus are reached via menu_select


AX_API_DISABLED = -25211   # kAXErrorAPIDisabled: this process really isn't allowed (yet)
PERMISSION_MESSAGE = ("Accessibility permission missing, so I can't read or click inside this app's own controls. Everything "
                      "else still works: web pages in the browser (open_url, browser_nav, click/type on pages), keyboard "
                      "shortcuts, menus by script, files, the web. Continue with those; mention the permission only if "
                      "nothing else can do the task.")


def _attr(el, name: str) -> Any:
    err, val = AXUIElementCopyAttributeValue(el, name, None)
    return val if err == 0 else None


def _point(v) -> tuple[float, float] | None:
    if v is None:
        return None
    ok, p = AXValueGetValue(v, AXS.kAXValueCGPointType, None)
    return (p.x, p.y) if ok else None


def _size(v) -> tuple[float, float] | None:
    if v is None:
        return None
    ok, s = AXValueGetValue(v, AXS.kAXValueCGSizeType, None)
    return (s.width, s.height) if ok else None


class AXController:
    def __init__(self):
        self._registry: dict[str, Any] = {}
        self._seq = 0

    @staticmethod
    def trusted() -> bool:
        """macOS's answer for THIS process. It can stay False after you grant access (the answer is cached
        per process), so actions never rely on it: they try, and only a real 'API disabled' error counts."""
        return bool(HAVE_AX and AXIsProcessTrusted())

    @staticmethod
    def api_disabled(el) -> bool:
        err, _ = AXUIElementCopyAttributeValue(el, "AXRole", None)
        return err == AX_API_DISABLED

    def app_element(self, pid: int):
        el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, 1.5)
        return el

    def snapshot(self, pid: int, app_name: str, max_elements: int = 150, max_nodes: int = 4000) -> dict:
        self._registry.clear()
        app = self.app_element(pid)
        if self.api_disabled(app):
            return {"error": PERMISSION_MESSAGE, "permission": "accessibility"}
        window = _attr(app, "AXFocusedWindow") or (_attr(app, "AXWindows") or [None])[0]
        if window is None:
            return {"app": app_name, "window": None, "elements": [], "note": "The app has no open window."}
        title = _attr(window, "AXTitle") or ""
        elements: list[dict] = []
        texts: list[str] = []
        queue = [(window, 0)]
        nodes = 0
        while queue and nodes < max_nodes and len(elements) < max_elements:
            el, depth = queue.pop(0)
            nodes += 1
            role = _attr(el, "AXRole") or ""
            if role in SKIP_SUBTREE:
                continue
            if role in INTERACTIVE or role in TEXTUAL:
                name = (_attr(el, "AXTitle") or _attr(el, "AXDescription") or _attr(el, "AXHelp") or "")
                value = _attr(el, "AXValue")
                if role in TEXTUAL:
                    if isinstance(value, str) and value.strip():
                        texts.append(value.strip()[:200])
                else:
                    self._seq += 1
                    eid = f"a{self._seq}"
                    self._registry[eid] = el
                    pos, size = _point(_attr(el, "AXPosition")), _size(_attr(el, "AXSize"))
                    item = {"id": eid, "role": role.removeprefix("AX"), "name": str(name)[:120]}
                    if isinstance(value, (str, int, float)) and str(value).strip():
                        item["value"] = str(value)[:80]
                    if _attr(el, "AXEnabled") is False:
                        item["disabled"] = True
                    if pos and size:
                        item["frame"] = [round(pos[0]), round(pos[1]), round(size[0]), round(size[1])]
                    elements.append(item)
            if depth < 30:
                for child in (_attr(el, "AXChildren") or []):
                    queue.append((child, depth + 1))
        return {"app": app_name, "window": title, "elements": elements, "text": " | ".join(texts)[:3000]}

    def press(self, element_id: str) -> ActionResult:
        el = self._registry.get(element_id)
        if el is None:
            return ActionResult.fail(f"Unknown element {element_id}; take a new snapshot first.")
        for action in ("AXPress", "AXConfirm", "AXPick", "AXShowMenu"):
            if AXUIElementPerformAction(el, action) == 0:
                return ActionResult(True, f"Pressed {element_id}.")
        return ActionResult.fail(f"{element_id} did not accept a press action.")

    def set_value(self, element_id: str, text: str) -> ActionResult:
        el = self._registry.get(element_id)
        if el is None:
            return ActionResult.fail(f"Unknown element {element_id}; take a new snapshot first.")
        AXUIElementSetAttributeValue(el, "AXFocused", True)
        err = AXUIElementSetAttributeValue(el, "AXValue", text)
        if err != 0:
            return ActionResult.fail(f"Couldn't set the value (AX error {err}). Try typing instead.")
        got = _attr(el, "AXValue")
        return ActionResult(True, "Entered the text.", verified=(got == text))

    def menu_select(self, pid: int, path: list[str]) -> ActionResult:
        app = self.app_element(pid)
        if self.api_disabled(app):
            return ActionResult.fail(PERMISSION_MESSAGE)
        node = _attr(app, "AXMenuBar")
        for i, title in enumerate(path):
            if node is None:
                return ActionResult.fail(f"Menu path broke at '{title}'.")
            children = _attr(node, "AXChildren") or []
            if i > 0 and children and (_attr(children[0], "AXRole") == "AXMenu"):
                children = _attr(children[0], "AXChildren") or []
            match = None
            for c in children:
                t = (_attr(c, "AXTitle") or "").lower()
                if t == title.lower() or (match is None and title.lower() in t):
                    match = c
                    if t == title.lower():
                        break
            if match is None:
                return ActionResult.fail(f"No menu item named '{title}'.")
            AXUIElementPerformAction(match, "AXPress")
            time.sleep(0.15)
            node = match
        return ActionResult(True, "Selected " + " > ".join(path) + ".", verified=False)

    def set_window_frame(self, pid: int, x: float, y: float, w: float, h: float) -> bool:
        import Quartz  # type: ignore

        app = self.app_element(pid)
        win = _attr(app, "AXFocusedWindow") or (_attr(app, "AXWindows") or [None])[0]
        if win is None:
            return False
        pos = AXS.AXValueCreate(AXS.kAXValueCGPointType, Quartz.CGPoint(x, y))
        size = AXS.AXValueCreate(AXS.kAXValueCGSizeType, Quartz.CGSize(w, h))
        e1 = AXUIElementSetAttributeValue(win, "AXPosition", pos)
        e2 = AXUIElementSetAttributeValue(win, "AXSize", size)
        return e1 == 0 and e2 == 0
