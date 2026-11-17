"""Agent-loop control logic with a scripted model: limits, recovery, validation, cancellation."""
import asyncio

from jarvis.agent import Agent, ToolContext
from jarvis.platform.fake import FakeComputer
from jarvis.shortcuts import CancelToken


def ctx(settings):
    return ToolContext(computer=FakeComputer(), settings=settings)


async def test_invalid_args_are_reported_back(settings, scripted):
    llm = scripted([("tools", [("open_url", {})]), ("tools", [("open_url", {"url": "ib.example.edu/course"})]),
                    ("tools", [("done", {"summary": "Open."})])])
    res = await Agent(llm, settings).run("open ib", ctx(settings), mode="balanced", model="m", cancel=CancelToken())
    assert res.ok
    assert res.steps[0]["ok"] is False and "missing required" in res.steps[0]["result"]


async def test_unknown_tool_then_recovery(settings, scripted):
    llm = scripted([("tools", [("teleport", {"to": "mars"})]), ("tools", [("done", {"summary": "ok"})])])
    res = await Agent(llm, settings).run("x", ctx(settings), mode="balanced", model="m", cancel=CancelToken())
    assert res.ok and "Unknown tool" in res.steps[0]["result"]


async def test_failure_recovery_after_click_fails(settings, scripted):
    c = ctx(settings)
    c.computer.browser_open_url("https://ib.example.edu/course")
    c.computer.fail_next["browser_click"] = 1
    llm = scripted([("tools", [("observe", {})]), ("tools", [("click", {"element_id": "w2"})]),
                    ("tools", [("observe", {})]), ("tools", [("click", {"element_id": "w2"})]),
                    ("tools", [("done", {"summary": "Assignments open."})])])
    res = await Agent(llm, settings).run("open assignments", c, mode="balanced", model="m", cancel=CancelToken())
    assert res.ok
    assert [s["ok"] for s in res.steps if s["tool"] == "click"] == [False, True]
    assert c.computer.tab["url"].endswith("/assignments")


async def test_step_limit(settings, scripted):
    llm = scripted([("tools", [("wait", {"seconds": 0})])] * 50)
    res = await Agent(llm, settings).run("loop", ctx(settings), mode="battery_saver", model="m", cancel=CancelToken())
    assert not res.ok and ("limit" in res.message or "problems" in res.message)
    assert len(res.steps) <= 8


async def test_repeated_identical_failures_stop(settings, scripted):
    llm = scripted([("tools", [("click", {"element_id": "w99"})])] * 30)
    c = ctx(settings)
    c.computer.browser_open_url("https://ib.example.edu/course")
    res = await Agent(llm, settings).run("click", c, mode="max_performance", model="m", cancel=CancelToken())
    assert not res.ok and len(res.steps) <= 6


async def test_cancel_mid_task(settings):
    class Slow:
        async def chat(self, *a, **k):
            await asyncio.sleep(10)

    tok = CancelToken()
    agent = Agent(Slow(), settings)
    task = asyncio.create_task(agent.run("x", ctx(settings), mode="balanced", model="m", cancel=tok))
    await asyncio.sleep(0.1)
    tok.cancel("user")
    from jarvis.shortcuts.engine import Cancelled

    try:
        await asyncio.wait_for(task, 2)
        raised = False
    except Cancelled:
        raised = True
    assert raised


async def test_trash_always_confirms(settings, scripted, tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("x")
    llm = scripted([("tools", [("trash_files", {"paths": [str(f)]})]), ("tools", [("done", {"summary": "kept"})])])
    asked = []

    async def deny(q):
        asked.append(q)
        return False

    res = await Agent(llm, settings, confirm=deny).run("delete a.txt", ctx(settings), mode="balanced", model="m", cancel=CancelToken())
    assert asked and f.exists()


async def test_plain_text_answer_completes(settings, scripted):
    llm = scripted([("text", "It's a fine day, sir.")])
    res = await Agent(llm, settings).run("how are you", ctx(settings), mode="balanced", model="m", cancel=CancelToken())
    assert res.ok and res.message.startswith("It's")


async def test_untrusted_content_is_wrapped(settings, scripted):
    c = ctx(settings)
    c.computer.browser_open_url("https://ib.example.edu/a/3")
    llm = scripted([("tools", [("read_page", {})]), ("tools", [("done", {"summary": "ok"})])])
    await Agent(llm, settings).run("read", c, mode="balanced", model="m", cancel=CancelToken())
    tool_msg = llm.calls[1]
    assert "<untrusted" in tool_msg["content"]
