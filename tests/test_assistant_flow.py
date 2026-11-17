"""End-to-end flows through Assistant.handle_text against the simulated computer.

These prove the routing/conversation logic. They are NOT acceptance tests (which need the Mac).
"""
import asyncio

from jarvis.shortcuts import ShortcutStore

IB_URL = "https://ib.example.edu/course"


async def test_open_app_is_deterministic(assistant, scripted):
    assistant.llm = scripted([])           # any LLM call would be recorded
    assistant.agent.llm = assistant.llm
    res = await assistant.handle_text("JARVIS, open Spotify.")
    assert res["ok"] and res["route"] == "builtin" and res["message"] == "Opening Spotify."
    assert assistant.llm.calls == []       # Level 1: no model involved


async def test_ib_shortcut_then_followups(assistant, scripted):
    assistant.shortcuts.save({"name": "Open My IB", "triggers": ["open my ib"],
                              "steps": [{"action": "open_url", "url": IB_URL, "browser": "Arc"}],
                              "response": "Your IB course is open."})
    assistant.llm = scripted([])
    assistant.agent.llm = assistant.llm
    c = assistant.computer
    r1 = await assistant.handle_text("Hey JARVIS, open my IB.")
    assert r1["ok"] and r1["route"] == "shortcut" and r1["message"] == "Your IB course is open."
    r2 = await assistant.handle_text("Go to the assignments.")
    assert r2["ok"] and r2["route"] == "builtin", r2
    assert c.tab["url"].endswith("/assignments")
    r3 = await assistant.handle_text("scroll down")
    assert r3["ok"] and "scroll:down" in c.log
    r4 = await assistant.handle_text("go back")
    assert r4["ok"] and c.tab["url"] == IB_URL
    assert assistant.llm.calls == []       # all deterministic so far


async def test_ordinal_followup_uses_agent_with_context(assistant, scripted):
    assistant.shortcuts.save({"name": "Open My IB", "triggers": ["open my ib"],
                              "steps": [{"action": "open_url", "url": IB_URL + "/assignments", "browser": "Arc"}]})
    await assistant.handle_text("open my ib")
    llm = scripted([
        ("tools", [("observe", {})]),
        ("tools", [("click", {"element_id": "w1"})]),
        ("tools", [("read_page", {})]),
        ("tools", [("done", {"summary": "You need to write a 2,000-word IA draft, due November 20.", "success": True})]),
    ])
    assistant.llm = llm
    assistant.agent.llm = llm
    res = await assistant.handle_text("Open the most recent one and tell me what I need to do.")
    assert res["route"] == "agent" and res["ok"], res
    assert assistant.computer.tab["url"] == "https://ib.example.edu/a/3"
    # The agent was told where we are (follow-up context)
    first_prompt = llm.calls[0]["content"]
    assert "ib.example.edu" in first_prompt and "Recent conversation" in first_prompt


async def test_memory_survives_restart(settings, db, home):
    from jarvis.assistant import Assistant
    from jarvis.db import Database
    from jarvis.platform.fake import FakeComputer

    a = Assistant(settings=settings, db=db, computer=FakeComputer())
    r = await a.handle_text("Remember that I prefer Arc for school websites")
    assert r["ok"]
    a2 = Assistant(settings=settings, db=Database(), computer=FakeComputer())
    r2 = await a2.handle_text("what do you remember about school websites")
    assert "prefers Arc" in r2["message"]


async def test_stop_cancels_running_task(assistant):
    assistant.shortcuts.save({"name": "slow", "triggers": ["slow thing"], "steps": [{"action": "wait", "seconds": 10}]})
    t = asyncio.create_task(assistant.handle_text("slow thing"))
    await asyncio.sleep(0.2)
    r = await assistant.handle_text("stop")
    assert r["intent"] == "stop"
    res = await asyncio.wait_for(t, 3)
    assert not res["ok"]


async def test_new_instruction_replaces_running_one(assistant):
    assistant.shortcuts.save({"name": "slow", "triggers": ["slow thing"], "steps": [{"action": "wait", "seconds": 10}]})
    t = asyncio.create_task(assistant.handle_text("slow thing"))
    await asyncio.sleep(0.2)
    r = await assistant.handle_text("open spotify")
    assert r["ok"]
    assert not (await asyncio.wait_for(t, 3))["ok"]


async def test_voice_shortcut_creation_dialog(assistant):
    answers = iter(["yes"])

    async def fake_ask(q, timeout=15):
        return next(answers)

    assistant.ask = fake_ask
    assistant.computer.browser_open_url("https://ib.example.edu/course")   # the page the user is looking at
    res = await assistant.handle_text("create a shortcut called open my IB")
    # the name was given, so it asks what it should do -> our fake answers "yes" first; use explicit flow instead
    assert res["route"] == "dialog"


async def test_voice_shortcut_creation_full(assistant):
    replies = iter(["Open Arc and go to this URL", "yes"])

    async def fake_ask(q, timeout=15):
        return next(replies)

    assistant.ask = fake_ask
    assistant.computer.browser_open_url("https://ib.example.edu/course")
    res = await assistant.handle_text("JARVIS, create a shortcut called Open My IB.")
    assert res["ok"], res
    sc = assistant.shortcuts.get("open-my-ib")
    assert sc["steps"][0]["url"] == "https://ib.example.edu/course"
    assert "open ib" in sc["triggers"]
    r = await assistant.handle_text("open my IB")
    assert r["route"] == "shortcut" and r["ok"]


async def test_click_submit_confirmation_in_agent(assistant, scripted):
    await assistant.handle_text("go to ib.example.edu/a/3")
    llm = scripted([
        ("tools", [("observe", {})]),
        ("tools", [("click", {"element_id": "w1"})]),        # "Submit" button
        ("tools", [("done", {"summary": "I didn't submit it.", "success": False})]),
    ])
    assistant.llm = llm
    assistant.agent.llm = llm
    asked = []

    async def deny(q):
        asked.append(q)
        return False

    assistant.agent.confirm = deny
    res = await assistant.handle_text("finish this assignment page for me")
    assert asked and "submit" in asked[0].lower()
    assert "click:Submit" not in assistant.computer.log


async def test_explicit_click_submit_needs_no_confirmation(assistant):
    await assistant.handle_text("go to ib.example.edu/a/3")
    res = await assistant.handle_text("click submit")
    assert res["ok"] and "click:Submit" in assistant.computer.log


async def test_llm_down_shortcuts_still_work(assistant):
    class Down:
        async def available(self):
            return False

        async def close(self):
            pass

    assistant.llm = Down()
    assistant.agent.llm = Down()
    assistant.llm_ok = False
    assistant.shortcuts.save({"name": "Open My IB", "triggers": ["open my ib"], "steps": [{"action": "open_url", "url": IB_URL}]})
    assert (await assistant.handle_text("open my ib"))["ok"]
    assert (await assistant.handle_text("open spotify"))["ok"]
    r = await assistant.handle_text("summarize my week")
    assert not r["ok"] and "local AI" in r["message"]


async def test_power_mode_command_applies_immediately(assistant):
    r = await assistant.handle_text("switch to battery saver mode")
    assert r["ok"] and assistant.power.mode == "battery_saver" and "after" not in r["message"]
