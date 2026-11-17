"""Match a spoken command against shortcut trigger phrases (with {param} slots)."""
from __future__ import annotations

import re
from dataclasses import dataclass

from rapidfuzz import fuzz

from ..router import match_key, normalize


@dataclass
class Match:
    shortcut: dict
    params: dict
    score: float
    trigger: str


def _trigger_regex(trigger: str) -> re.Pattern:
    key = normalize(trigger)
    parts = re.split(r"({\w+})", key)
    rx = ""
    for p in parts:
        m = re.fullmatch(r"{(\w+)}", p)
        rx += f"(?P<{m.group(1)}>.+?)" if m else re.escape(p)
    return re.compile(rf"^{rx}$")


def match(text: str, shortcuts: list[dict], min_fuzzy: float = 90) -> Match | None:
    key = match_key(text)
    light = normalize(text).rstrip(".")
    if not key:
        return None
    best: Match | None = None
    for sc in shortcuts:
        if not sc.get("enabled", True):
            continue
        for trig in sc.get("triggers", []):
            if "{" in trig:
                m = _trigger_regex(trig).match(light)
                if m:
                    cand = Match(sc, {k: v.strip() for k, v in m.groupdict().items()}, 99.0, trig)
                    if best is None or cand.score > best.score:
                        best = cand
                continue
            tkey = match_key(trig)
            if key == tkey:
                return Match(sc, {}, 100.0, trig)
            # Fuzzy only for longer phrases; short triggers must match exactly to avoid
            # "open arc" firing "open ib".
            if len(tkey) >= 8:
                score = fuzz.ratio(key, tkey)
                if score >= min_fuzzy and (best is None or score > best.score):
                    best = Match(sc, {}, float(score), trig)
    return best
