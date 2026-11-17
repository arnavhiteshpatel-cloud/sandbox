"""The bounded agent loop: OBSERVE -> UNDERSTAND -> PLAN -> ACT -> VERIFY -> CONTINUE.

Hard limits (steps, wall-clock, repeated failures) and the safety policy are enforced here,
in code, not left to the model.
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from ..llm import LLMClient, LLMError
from ..shortcuts.engine import Cancelled, CancelToken
from . import policy
from .prompts import context_block, system_prompt
from .tools import TOOL_MAP, TOOLS, ToolContext, validate_args

MAX_RESULT_CHARS = 6000


@dataclass
class AgentResult:
    ok: bool
    message: str
    steps: list[dict] = field(default_factory=list)
    model: str = ""
    llm_ms: int = 0
    llm_calls: int = 0
    asked_user: bool = False
    error: str | None = None       # set when the model/runtime failed (never counted as success)


Confirm = Callable[[str], Awaitable[bool]]
Progress = Callable[[dict], None]


class Agent:
    def __init__(self, llm: LLMClient, settings, confirm: Confirm | None = None, progress: Progress | None = None):
        self.llm = llm
        self.settings = settings
        self.confirm = confirm
        self.progress = progress or (lambda e: None)

    def _compact_history(self, messages: list[dict], budget_chars: int = 40000) -> None:
        """Append-only history keeps the runtime's prompt cache valid (each step then only
        evaluates the new tokens; hybrid models like Qwen3.5 cannot reuse a partially changed
        prefix). Only when the context grows past the budget are older observations replaced
        by stubs, all at once, costing a single full re-evaluation."""
        if sum(len(m.get("content") or "") for m in messages) < budget_chars:
            return
        obs_idx = [i for i, m in enumerate(messages) if m["role"] == "tool" and m.get("name") in ("observe", "read_page", "look_at_screen")]
        for i in obs_idx[:-1]:
            if not messages[i]["content"].startswith("[older"):
                messages[i]["content"] = "[older observation removed; call observe for the current state]"

    async def run(self, objective: str, ctx: ToolContext, *, mode: str, model: str, cancel: CancelToken,
                  context: str = "", think: bool = False, max_steps: int | None = None) -> AgentResult:
        max_steps = max_steps or int(self.settings.per_mode("agent.max_steps", mode, 20))
        deadline = time.monotonic() + (90 if mode == "battery_saver" else 300 if mode == "balanced" else 900)
        keep_alive = {"battery_saver": "30s", "balanced": "5m", "max_performance": "30m"}.get(mode, "5m")
        tools = [t.schema() for t in TOOLS if ctx.allow_vision or t.name != "look_at_screen"]
        messages: list[dict] = [
            {"role": "system", "content": system_prompt(self.settings, mode)},
            {"role": "user", "content": (context + "\n\n" if context else "") + f"Request: {objective}"},
        ]
        ctx.cancel = cancel
        steps: list[dict] = []
        res = AgentResult(False, "", steps, model)
        seen_calls: dict[str, int] = {}
        failures = 0
        nudged = False
        for step in range(max_steps):
            cancel.check()
            if time.monotonic() > deadline:
                res.message = "That's taking longer than I allow for one task, so I've stopped. " + _summary(steps)
                return res
            self.progress({"type": "agent_thinking", "step": step + 1, "max_steps": max_steps})
            try:
                chat_task = asyncio.create_task(self.llm.chat(
                    messages, model=model, tools=tools, think=think, keep_alive=keep_alive,
                    temperature=float(self.settings.get("llm.temperature", 0.2)), num_ctx=int(self.settings.get("llm.num_ctx", 16384))))
                cancel_task = asyncio.create_task(cancel._ev.wait())
                done_set, _ = await asyncio.wait({chat_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED)
                if cancel_task in done_set:
                    chat_task.cancel()
                    raise Cancelled(cancel.reason)
                cancel_task.cancel()
                reply = chat_task.result()
            except LLMError as e:
                res.message = f"My local AI model isn't responding: {e}"
                res.error = str(e)
                return res
            res.llm_ms += reply.ms
            res.llm_calls += 1
            if not reply.tool_calls:
                text = reply.content.strip()
                if not text and not nudged:
                    nudged = True
                    messages.append({"role": "user", "content": "Continue: call a tool, or call done with your answer."})
                    continue
                # A plain answer counts as completion (conversational replies).
                res.ok, res.message = True, text or "Done."
                return res
            messages.append({"role": "assistant", "content": reply.content or "",
                             "tool_calls": [{"id": tc.id, "name": tc.name, "arguments": tc.arguments} for tc in reply.tool_calls]})
            for tc in reply.tool_calls[:3]:
                cancel.check()
                tool = TOOL_MAP.get(tc.name)
                if tool is None:
                    out = {"ok": False, "error": f"Unknown tool '{tc.name}'. Available: {', '.join(TOOL_MAP)}"}
                else:
                    err = validate_args(tool, tc.arguments)
                    out = {"ok": False, "error": err} if err else await self._execute(tool, tc.arguments, ctx, objective)
                if tc.name == "ask_user":
                    res.asked_user = True
                key = tc.name + json.dumps(tc.arguments, sort_keys=True)
                seen_calls[key] = seen_calls.get(key, 0) + 1
                entry = {"step": step + 1, "tool": tc.name, "args": _short(tc.arguments), "ok": bool(out.get("ok")),
                         "result": _short(out, 300)}
                steps.append(entry)
                self.progress({"type": "agent_step", **entry})
                if tc.name == "done":
                    res.ok = bool(tc.arguments.get("success", True))
                    res.message = tc.arguments.get("summary") or "Done."
                    return res
                if not out.get("ok"):
                    failures += 1
                else:
                    failures = max(0, failures - 1)
                content = json.dumps(out, ensure_ascii=False, default=str)
                if seen_calls[key] >= 3:
                    content += "\nSYSTEM: You have made this exact call 3 times. Try a different approach or call done."
                if len(content) > MAX_RESULT_CHARS:
                    content = content[:MAX_RESULT_CHARS] + "…[truncated]"
                messages.append({"role": "tool", "name": tc.name, "tool_call_id": tc.id, "content": content})
            if failures >= 5 or max(seen_calls.values()) >= 5:
                res.message = "I keep running into problems, so I've stopped rather than guess. " + _summary(steps)
                return res
            self._compact_history(messages)
        res.message = f"I reached my limit of {max_steps} steps before finishing. " + _summary(steps)
        return res

    async def _execute(self, tool, args: dict, ctx: ToolContext, objective: str) -> dict:
        label = ""
        if tool.name == "click" and args.get("element_id"):
            label = (ctx.last_elements.get(args["element_id"]) or {}).get("name", "")
        elif tool.name in ("click", "click_screen_text"):
            label = args.get("text", "")
        elif tool.name == "type_text" and args.get("element_id"):
            label = (ctx.last_elements.get(args["element_id"]) or {}).get("name", "")
        verdict = policy.check(tool.name, args, user_text=objective, settings=self.settings, element_label=label)
        if not verdict.allow:
            return {"ok": False, "error": f"Blocked by safety policy: {verdict.reason}"}
        if verdict.confirm and self.settings.get("agent.confirm_high_risk", True):
            if self.confirm is None:
                return {"ok": False, "error": f"Needs the user's confirmation ({verdict.reason}) but none is possible."}
            what = _describe_action(tool.name, args, label)
            approved = await self.confirm(f"{verdict.reason} Shall I {what}?")
            if not approved:
                return {"ok": False, "error": "The user declined. Do not retry this action; continue or finish."}
        try:
            timeout = float(self.settings.get("agent.step_timeout_s", 60))
            return await asyncio.wait_for(tool.fn(ctx, args), timeout=timeout)
        except Cancelled:
            raise
        except asyncio.TimeoutError:
            return {"ok": False, "error": f"{tool.name} timed out."}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _short(v, n: int = 160):
    s = json.dumps(v, ensure_ascii=False, default=str) if not isinstance(v, str) else v
    return s if len(s) <= n else s[:n] + "…"


def _describe_action(name: str, args: dict, label: str) -> str:
    if name == "click":
        return f"click “{label or args.get('text') or args.get('element_id')}”"
    if name == "trash_files":
        paths = args.get("paths") or []
        return "move " + (", ".join(p.split("/")[-1] for p in paths[:3]) + (f" and {len(paths) - 3} more" if len(paths) > 3 else "")) + " to the Trash"
    if name == "press_keys":
        return f"press {args.get('combo')}"
    if name == "move_file":
        return f"move {args.get('src')} to {args.get('dst')}"
    return name.replace("_", " ")


def _summary(steps: list[dict]) -> str:
    oks = [s for s in steps if s["ok"] and s["tool"] not in ("observe", "wait", "recall")]
    if not oks:
        return ""
    last = oks[-1]
    return f"The last thing that worked was {last['tool'].replace('_', ' ')}."
