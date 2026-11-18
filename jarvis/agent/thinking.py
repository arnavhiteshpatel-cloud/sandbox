"""Decide when the local model should use slow "thinking" (reasoning) mode.

Thinking makes Qwen-class models write a hidden chain of reasoning before acting: better on hard,
multistep problems, but often 5-20x slower. JARVIS therefore answers fast by default and thinks only
when the request needs it, or when a fast attempt is visibly struggling (see Agent escalation).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

FORCE_THINK = re.compile(r"\b(think (?:hard|carefully|it through|about it)|take your time|carefully|step by step|in depth|thoroughly)\b", re.I)
FORCE_FAST = re.compile(r"\b(quick(?:ly)?|fast|just|real quick|briefly|no need to think)\b", re.I)

COMPLEX = [
    (re.compile(r"\b(and then|then|after that|afterwards|once (?:that|it'?s) done|followed by)\b", re.I), 2, "several steps"),
    (re.compile(r"\b(compare|comparison|difference between|differences|versus|vs\.?|pros and cons|trade-?offs?)\b", re.I), 3, "comparison"),
    (re.compile(r"\b(organi[sz]e|sort out|clean up|tidy|categori[sz]e|group (?:them|these|my)|deduplicate|duplicates)\b", re.I), 3, "organizing"),
    (re.compile(r"\b(plan|schedule out|figure out|work out|decide|which (?:one )?(?:is|should)|best way|strategy|debug|why (?:is|does|did|isn't|doesn't))\b", re.I), 3, "reasoning"),
    (re.compile(r"\b(analy[sz]e|evaluate|review|summari[sz]e (?:all|each|every|them)|go through|look through|every|each of)\b", re.I), 1, "many items"),
    (re.compile(r"\b(first|second|third|next (?:two|three|few)|all (?:my|the|of))\b", re.I), 1, "multiple targets"),
    (re.compile(r"\b(unfamiliar|navigate this|find the information|research)\b", re.I), 1, "exploration"),
]


@dataclass
class ThinkDecision:
    think: bool
    reason: str
    may_escalate: bool


def decide(text: str, mode: str, policy: str = "auto") -> ThinkDecision:
    """policy: auto | always | never (Settings → Local AI)."""
    if policy == "always":
        return ThinkDecision(True, "always on (settings)", False)
    if policy == "never":
        return ThinkDecision(False, "off (settings)", False)
    if FORCE_THINK.search(text):
        return ThinkDecision(True, "you asked me to think it through", False)
    if mode == "battery_saver":
        return ThinkDecision(False, "Battery Saver", False)
    if FORCE_FAST.search(text):
        return ThinkDecision(False, "you asked for speed", mode != "battery_saver")
    score, why = 0, []
    for rx, w, label in COMPLEX:
        if rx.search(text):
            score += w
            why.append(label)
    actions = set(re.findall(r"\b(open|find|search|look|read|summari[sz]e|list|make|create|write|send|move|click|go|check|"
                             r"download|copy|reply|fill|submit|tell|compare|organi[sz]e|play|add|delete|rename)\b", text.lower()))
    if len(actions) >= 3:
        score += 2
        why.append(f"{len(actions)} actions")
    elif len(actions) == 2 and re.search(r",|\band\b", text):
        score += 1
        why.append("two actions")
    words = len(text.split())
    if words > 22:
        score += 1
        why.append("long request")
    threshold = 2 if mode == "max_performance" else 3
    if score >= threshold:
        return ThinkDecision(True, ", ".join(why), False)
    return ThinkDecision(False, "simple request", True)
