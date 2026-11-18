"""System-wide controls and built-in app integrations (works regardless of the front app).

Media keys act on whatever is playing (Music, Spotify, a video in a browser…). App integrations use
each app's AppleScript dictionary. macOS asks once per app ("JARVIS wants to control Notes").
"""
from __future__ import annotations

import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

from ..base import ActionResult, AutomationError
from . import applescript as AS

# NX_KEYTYPE_* codes for "system defined" auxiliary key events (media keys).
NX_KEYS = {"brightness_up": 2, "brightness_down": 3, "play": 16, "next": 17, "previous": 18,
           "keyboard_light_up": 21, "keyboard_light_down": 22}

SETTINGS_PANES = {
    "wifi": "com.apple.wifi-settings-extension", "wi-fi": "com.apple.wifi-settings-extension",
    "bluetooth": "com.apple.BluetoothSettings", "network": "com.apple.Network-Settings.extension",
    "sound": "com.apple.Sound-Settings.extension", "display": "com.apple.Displays-Settings.extension",
    "displays": "com.apple.Displays-Settings.extension", "battery": "com.apple.Battery-Settings.extension",
    "notifications": "com.apple.Notifications-Settings.extension", "focus": "com.apple.Focus-Settings.extension",
    "keyboard": "com.apple.Keyboard-Settings.extension", "trackpad": "com.apple.Trackpad-Settings.extension",
    "mouse": "com.apple.Mouse-Settings.extension", "privacy": "com.apple.settings.PrivacySecurity.extension",
    "security": "com.apple.settings.PrivacySecurity.extension", "appearance": "com.apple.Appearance-Settings.extension",
    "wallpaper": "com.apple.Wallpaper-Settings.extension", "desktop": "com.apple.Desktop-Settings.extension",
    "dock": "com.apple.Desktop-Settings.extension", "general": "com.apple.systempreferences.GeneralSettings",
    "software update": "com.apple.Software-Update-Settings.extension", "storage": "com.apple.settings.Storage",
    "accessibility": "com.apple.Accessibility-Settings.extension", "users": "com.apple.Users-Groups-Settings.extension",
    "printers": "com.apple.Print-Scanner-Settings.extension", "screen time": "com.apple.Screen-Time-Settings.extension",
    "siri": "com.apple.Siri-Settings.extension", "lock screen": "com.apple.Lock-Screen-Settings.extension",
}

WINDOW_KEYS = {"minimize": "cmd+m", "fullscreen": "ctrl+cmd+f", "hide": "cmd+h", "new_window": "cmd+n",
               "close_window": "cmd+w", "new_tab": "cmd+t", "close_tab": "cmd+w", "back": "cmd+[", "forward": "cmd+]",
               "reload": "cmd+r"}


def media_key(name: str) -> ActionResult:
    if name not in NX_KEYS:
        return ActionResult.fail(f"Unknown media key {name}.")
    import Quartz  # type: ignore
    from AppKit import NSEvent  # type: ignore

    code = NX_KEYS[name]
    for down in (True, False):
        flags = 0xA00 if down else 0xB00
        ev = NSEvent.otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2_(
            14, (0, 0), flags, 0, 0, None, 8, (code << 16) | ((0xA if down else 0xB) << 8), -1)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev.CGEvent())
        time.sleep(0.01)
    label = {"play": "Play/pause.", "next": "Next track.", "previous": "Previous track."}.get(name, name.replace("_", " ").capitalize() + ".")
    return ActionResult(True, label)


def set_appearance(dark: bool | None) -> ActionResult:
    val = "not dark mode" if dark is None else ("true" if dark else "false")
    try:
        AS.run(f'tell application "System Events" to tell appearance preferences to set dark mode to {val}')
        now = AS.run('tell application "System Events" to tell appearance preferences to get dark mode')
    except AutomationError as e:
        return ActionResult.fail(str(e))
    is_dark = now.strip() == "true"
    return ActionResult(True, "Dark mode on." if is_dark else "Light mode on.", {"dark": is_dark}, verified=dark is None or is_dark == dark)


def _wifi_device() -> str | None:
    out = subprocess.run(["networksetup", "-listallhardwareports"], capture_output=True, text=True, timeout=10).stdout
    m = re.search(r"Hardware Port: Wi-Fi\s*\nDevice: (\S+)", out)
    return m.group(1) if m else None


def set_wifi(on: bool) -> ActionResult:
    dev = _wifi_device()
    if not dev:
        return ActionResult.fail("I couldn't find a Wi-Fi interface.")
    p = subprocess.run(["networksetup", "-setairportpower", dev, "on" if on else "off"], capture_output=True, text=True, timeout=15)
    if p.returncode != 0 or "Error" in p.stdout:
        return ActionResult.fail(f"macOS refused to change Wi-Fi: {(p.stderr or p.stdout).strip()[:150]}")
    state = subprocess.run(["networksetup", "-getairportpower", dev], capture_output=True, text=True, timeout=10).stdout
    ok = ("On" in state) == on
    return ActionResult(True, f"Wi-Fi {'on' if on else 'off'}.", verified=ok)


def open_settings(pane: str) -> ActionResult:
    key = pane.lower().replace(" settings", "").strip()
    ext = SETTINGS_PANES.get(key)
    url = f"x-apple.systempreferences:{ext}" if ext else "x-apple.systempreferences:"
    subprocess.run(["open", url], timeout=10)
    return ActionResult(True, f"{pane.strip().capitalize()} settings." if ext else "System Settings.")


def take_screenshot(path: str | None = None) -> ActionResult:
    path = os.path.expanduser(path or f"~/Desktop/Screenshot {time.strftime('%Y-%m-%d at %H.%M.%S')}.png")
    p = subprocess.run(["screencapture", "-x", path], capture_output=True, timeout=15)
    ok = p.returncode == 0 and os.path.exists(path)
    return ActionResult(ok, "Screenshot saved to your Desktop." if ok else "Screen capture failed (Screen Recording permission?).",
                        {"path": path}, verified=ok)


def app_script(script: str, language: str = "AppleScript") -> ActionResult:
    lang = "JavaScript" if language.lower() in ("javascript", "jxa", "js") else "AppleScript"
    try:
        out = AS.run(script, timeout=45, language=lang)
    except AutomationError as e:
        return ActionResult.fail(str(e))
    return ActionResult(True, (out or "Done.")[:4000], {"output": out[:4000]})


def app_dictionary(app_path: str, max_chars: int = 6000) -> str:
    """Summarize an app's scripting dictionary (commands and classes) so the model knows what it can do."""
    p = subprocess.run(["sdef", app_path], capture_output=True, text=True, timeout=20)
    if p.returncode != 0 or not p.stdout.strip():
        return "This app has no AppleScript dictionary; use its menus and the accessibility tree instead."
    try:
        root = ET.fromstring(p.stdout)
    except ET.ParseError:
        return p.stdout[:max_chars]
    lines = []
    for suite in root.iter("suite"):
        if suite.get("name") in ("Standard Suite", "Text Suite", "Type Definitions") and len(lines) > 10:
            continue
        lines.append(f"[{suite.get('name')}]")
        for cmd in suite.findall("command"):
            params = ", ".join(pa.get("name") for pa in cmd.findall("parameter") if pa.get("name"))
            lines.append(f"  command {cmd.get('name')}" + (f" ({params})" if params else "") + (f" — {cmd.get('description')}" if cmd.get("description") else ""))
        for cl in suite.findall("class"):
            props = ", ".join(pr.get("name") for pr in cl.findall("property") if pr.get("name"))[:220]
            elems = ", ".join(e.get("type") for e in cl.findall("element") if e.get("type"))[:160]
            lines.append(f"  class {cl.get('name')}: properties {props}" + (f"; elements {elems}" if elems else ""))
    return "\n".join(lines)[:max_chars]


def create_note(body: str, title: str | None = None) -> ActionResult:
    title = title or (body.split(".")[0][:60] if body else "Note")
    html = "<h1>" + _esc_html(title) + "</h1><div>" + _esc_html(body).replace("\n", "<br>") + "</div>"
    try:
        AS.run(f'tell application "Notes" to make new note with properties {{body:{AS.quote(html)}}}', timeout=20)
    except AutomationError as e:
        return ActionResult.fail(str(e))
    return ActionResult(True, "Note created.", {"title": title}, verified=True)


def create_reminder(text: str, due_in_s: float | None = None) -> ActionResult:
    props = f"name:{AS.quote(text)}"
    script = f'tell application "Reminders" to make new reminder with properties {{{props}}}'
    if due_in_s:
        script = (f'set d to (current date) + {int(due_in_s)}\n'
                  f'tell application "Reminders" to make new reminder with properties {{{props}, due date:d, remind me date:d}}')
    try:
        AS.run(script, timeout=20)
    except AutomationError as e:
        return ActionResult.fail(str(e))
    when = ""
    if due_in_s:
        when = " for " + time.strftime("%A %-I:%M %p", time.localtime(time.time() + due_in_s))
    return ActionResult(True, f"Reminder set{when}.", verified=True)


def calendar_events(day_offset: int = 0, days: int = 1) -> ActionResult:
    script = f'''
set d0 to (current date)
set time of d0 to 0
set d0 to d0 + ({int(day_offset)} * days)
set d1 to d0 + ({max(1, int(days))} * days)
set out to ""
tell application "Calendar"
  repeat with c in calendars
    try
      set evs to (every event of c whose start date ≥ d0 and start date < d1)
      repeat with e in evs
        set out to out & (start date of e as «class isot» as string) & "|" & (summary of e) & "|" & (name of c) & linefeed
      end repeat
    end try
  end repeat
end tell
return out'''
    try:
        out = AS.run(script, timeout=60)
    except AutomationError as e:
        return ActionResult.fail(str(e))
    events = []
    for line in out.splitlines():
        parts = line.split("|")
        if len(parts) >= 2:
            events.append({"start": parts[0], "title": parts[1], "calendar": parts[2] if len(parts) > 2 else ""})
    events.sort(key=lambda e: e["start"])
    return ActionResult(True, f"{len(events)} event(s).", {"events": events}, verified=True)


def compose_email(to: list[str], subject: str, body: str) -> ActionResult:
    recips = "\n".join(f"make new to recipient at end of to recipients with properties {{address:{AS.quote(a)}}}" for a in to)
    script = f'''tell application "Mail"
  set m to make new outgoing message with properties {{subject:{AS.quote(subject)}, content:{AS.quote(body)}, visible:true}}
  tell m
    {recips}
  end tell
  activate
end tell'''
    try:
        AS.run(script, timeout=20)
    except AutomationError as e:
        return ActionResult.fail(str(e))
    return ActionResult(True, "Draft open in Mail. It has not been sent.", verified=True)


def send_message(to: str, text: str) -> ActionResult:
    """Send an iMessage. `to` is a phone number, email, or a contact name (looked up in Contacts)."""
    handle = to.strip()
    if not re.fullmatch(r"[+\d][\d\s().-]{5,}|\S+@\S+", handle):
        try:
            handle = AS.run(f'''tell application "Contacts"
  set p to first person whose name contains {AS.quote(handle)}
  if (count of phones of p) > 0 then return value of first phone of p
  return value of first email of p
end tell''', timeout=15).strip()
        except AutomationError:
            return ActionResult.fail(f"I couldn't find {to} in your contacts.")
    script = f'''tell application "Messages"
  set s to 1st account whose service type = iMessage
  send {AS.quote(text)} to participant {AS.quote(handle)} of s
end tell'''
    try:
        AS.run(script, timeout=20)
    except AutomationError as e:
        return ActionResult.fail(str(e))
    return ActionResult(True, f"Message sent to {to}.", {"handle": handle})


def _esc_html(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
