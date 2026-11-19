"""2026-11-19: "open my canvas homepage" took 30 s, opened Spotlight and went to the wrong page.
"Use the keyboard shortcuts built into Arc … look it up if it doesn't know … learn so it doesn't have to look it up."
"""
from __future__ import annotations

import sqlite3

import pytest


def make_history(path, rows):
    """A browser History database in the Chromium/Arc format (urls table)."""
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)")
    con.executemany("INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?,?,?,0)", rows)
    con.commit()
    con.close()


HISTORY = [
    ("https://lincoln.instructure.com/", "Dashboard", 240),
    ("https://lincoln.instructure.com/courses/1234", "IB Biology HL", 90),
    ("https://www.google.com/search?q=canvas+login", "canvas login - Google Search", 30),
    ("https://www.instructure.com/canvas", "Canvas LMS | Instructure", 2),
    ("https://lincoln.managebac.com/student", "ManageBac", 120),
    ("https://mail.google.com/mail/u/0/#inbox", "Inbox (3) - Gmail", 400),
    ("https://www.adobe.com/products/photoshop.html", "Photoshop", 3),
]


@pytest.fixture()
def hist(tmp_path, monkeypatch):
    from jarvis import sites

    f = tmp_path / "History"
    make_history(f, HISTORY)
    monkeypatch.setattr(sites, "history_files", lambda: [str(f)])
    return str(f)


def test_finds_your_canvas_from_history(hist):
    from jarvis.sites import frequent_sites, search_history

    assert search_history("my canvas homepage") == "https://lincoln.instructure.com/"
    assert search_history("canvas") == "https://lincoln.instructure.com/"
    assert search_history("my school email") == "https://mail.google.com/"
    assert search_history("photoshop", strict=True) is None                 # a page *about* it isn't the app's site
    assert search_history("my blackboard") is None
    hosts = [h for h, _ in frequent_sites(5)]
    assert hosts[0] == "mail.google.com" and "lincoln.instructure.com" in hosts and "www.google.com" not in hosts


async def test_open_my_canvas_homepage_learns_it(assistant, hist):
    class NoAI:
        async def chat(self, *a, **k):
            raise AssertionError("no AI needed")

        async def available(self):
            return True
    assistant.llm = assistant.agent.llm = NoAI()
    r = await assistant.handle_text("open my canvas homepage")
    assert r["ok"] and assistant.computer.tab["url"] == "https://lincoln.instructure.com/"
    assert any("lincoln.instructure.com" in m["content"] for m in assistant.memory.all())   # learned
    # next time: no history lookup needed
    import jarvis.sites as S
    S.history_files = lambda: []
    r = await assistant.handle_text("go to my canvas")
    assert r["ok"] and assistant.computer.tab["url"] == "https://lincoln.instructure.com/"


async def test_unknown_personal_site_asks_once_then_remembers(assistant, hist):
    asked = []

    async def ask(q, timeout=15.0):
        asked.append(q)
        return "lincoln dot schoology dot com"
    assistant.ask = ask
    r = await assistant.handle_text("open my schoology homepage")
    assert asked and "schoology" in asked[0].lower() and r["ok"]
    assert "schoology.com" in assistant.computer.tab["url"]
    r = await assistant.handle_text("open my schoology homepage")
    assert len(asked) == 1                                                  # never asked again


def test_app_shortcuts_and_learning(settings):
    from jarvis.agent import app_keys

    assert app_keys.match_action("toggle the sidebar", "Arc", settings) == ("toggle sidebar", "cmd+s")
    assert app_keys.match_action("copy the url", "Arc", settings) == ("copy url", "cmd+shift+c")
    assert app_keys.match_action("go to folder", "Finder", settings) == ("go to folder", "cmd+shift+g")
    assert app_keys.match_action("how are you doing today", "Arc", settings) is None
    app_keys.learn(settings, "Arc", "split view", "ctrl+shift+=")
    assert app_keys.shortcuts_for("Arc", settings)["split view"] == "ctrl+shift+="
    assert app_keys.valid_combo("cmd+shift+t") and not app_keys.valid_combo("press the thing")


async def test_saying_an_apps_shortcut_presses_it_instantly(assistant):
    assistant.computer.front = "Arc"
    r = await assistant.handle_text("toggle the sidebar")
    assert "keys:cmd+s" in assistant.computer.log and r["ok"]


async def test_agent_gets_tabs_sites_and_shortcuts_as_context(assistant, hist):
    assistant.computer.front = "Arc"
    assistant.computer.browser_open_url("https://ib.example.edu/course")
    ctx = await assistant._agent_context("open my biology course")
    assert "lincoln.instructure.com" in ctx and "toggle sidebar" in ctx and "Open apps:" in ctx


async def test_agent_can_learn_a_looked_up_shortcut(settings, scripted):
    from jarvis.agent import Agent, ToolContext
    from jarvis.agent.app_keys import shortcuts_for
    from jarvis.platform.fake import FakeComputer
    from jarvis.shortcuts import CancelToken

    llm = scripted([("tools", [("press_keys", {"combo": "ctrl+shift+="})]),
                    ("tools", [("learn_app_shortcut", {"app": "Arc", "action": "split view", "combo": "ctrl+shift+="})]),
                    ("tools", [("done", {"summary": "Split view on."})])])
    res = await Agent(llm, settings).run("split view", ToolContext(computer=FakeComputer(), settings=settings),
                                         mode="balanced", model="m", cancel=CancelToken())
    assert res.ok and shortcuts_for("Arc", settings)["split view"] == "ctrl+shift+="


# --- it gets faster with use: what the AI worked out once is replayed instantly ---------------------------
async def test_multi_step_task_is_learned_and_replayed_without_ai(assistant, scripted):
    import asyncio

    async def yes(q):
        return True
    assistant.confirm = yes
    llm = scripted([("tools", [("open_app", {"name": "Arc"})]),
                    ("tools", [("press_keys", {"combo": "cmd+s"})]),
                    ("tools", [("done", {"summary": "Arc is open with the sidebar hidden."})])])
    assistant.llm = assistant.agent.llm = llm
    r = await assistant.handle_text("set up arc for focus")
    assert r["route"] == "agent" and r["ok"]
    await asyncio.sleep(0.6)
    learned = assistant.learner.all()
    assert learned and learned[0]["tool"] == "sequence" and len(learned[0]["args"]["steps"]) == 2
    calls = len(llm.calls)
    assistant.computer.log.clear()
    r = await assistant.handle_text("set up arc for focus")
    assert r["route"] == "learned" and len(llm.calls) == calls                 # no AI the second time
    assert assistant.computer.log[:2] == ["open_app:Arc", "keys:cmd+s"]


async def test_broken_recipe_is_forgotten_and_worked_out_again(assistant, scripted):
    assistant.learner.learn("set up arc for focus", "sequence",
                            {"steps": [{"tool": "open_app", "args": {"name": "Arc"}}, {"tool": "press_keys", "args": {"combo": "cmd+s"}}]})
    assistant.computer.fail_next["press_keys"] = 1
    llm = scripted([("tools", [("done", {"summary": "Done another way."})])])
    assistant.llm = assistant.agent.llm = llm
    r = await assistant.handle_text("set up arc for focus")
    assert r["route"] == "agent" and assistant.learner.all() == []


def test_screen_dependent_steps_are_never_learned(db):
    from jarvis.learning import PhraseLearner

    pl = PhraseLearner(db)
    steps = [{"tool": "open_app", "args": {"name": "Arc"}, "raw_args": {"name": "Arc"}, "ok": True},
             {"tool": "click", "args": {"element_id": "w3"}, "raw_args": {"element_id": "w3"}, "ok": True}]
    assert pl.candidate("open my grades", steps) is None


async def test_my_site_while_browsing_opens_the_site_not_a_link(assistant, hist):
    assistant.computer.browser_open_url("https://ib.example.edu/course")
    assistant.session.browser_active = True
    assistant.computer.front = "Arc"
    r = await assistant.handle_text("open my canvas")
    assert r["ok"] and assistant.computer.tab["url"] == "https://lincoln.instructure.com/"


# --- navigating a school site step by step (2026-11-19: "made it to canvas, didn't think to go to the course
#     dashboard, then opened it in Safari and gave up") ---------------------------------------------------------
CANVAS = {
    "https://lincoln.instructure.com/": {
        "title": "Dashboard",
        "elements": [{"role": "link", "name": "Account", "href": "https://lincoln.instructure.com/profile"}]
                    + [{"role": "link", "name": f"Announcement {i}", "href": f"https://lincoln.instructure.com/a/{i}"} for i in range(1, 70)]
                    + [{"role": "link", "name": "IB Biology HL - Lincoln", "href": "https://lincoln.instructure.com/courses/77"},
                       {"role": "link", "name": "IB English A", "href": "https://lincoln.instructure.com/courses/78"}],
        "text": "Dashboard. To Do: nothing.",
    },
    "https://lincoln.instructure.com/courses/77": {
        "title": "IB Biology HL",
        "elements": [{"role": "link", "name": "Home", "href": "https://lincoln.instructure.com/courses/77"},
                     {"role": "link", "name": "Assignments", "href": "https://lincoln.instructure.com/courses/77/assignments"}],
        "text": "Course home.",
    },
    "https://lincoln.instructure.com/courses/77/assignments": {
        "title": "Assignments: IB Biology HL",
        "elements": [{"role": "link", "name": "Photosynthesis worksheet (due Nov 21)",
                      "href": "https://lincoln.instructure.com/courses/77/assignments/5"}],
        "text": "Upcoming assignments: Photosynthesis worksheet due Nov 21.",
    },
}


async def test_agent_sees_each_new_page_and_how_canvas_works(settings, scripted):
    from jarvis.agent import Agent, ToolContext
    from jarvis.platform.fake import FakeComputer
    from jarvis.shortcuts import CancelToken

    c = FakeComputer(sites=CANVAS)
    llm = scripted([
        ("tools", [("open_url", {"url": "https://lincoln.instructure.com/", "browser": "Safari"})]),   # model picks Safari
        ("tools", [("find_on_page", {"query": "biology"})]),
        ("tools", [("click", {"text": "IB Biology HL - Lincoln"})]),
        ("tools", [("click", {"text": "Assignments"})]),
        ("tools", [("done", {"summary": "Your biology homework: the Photosynthesis worksheet, due Nov 21."})])])
    ctx = ToolContext(computer=c, settings=settings, user_text="go to canvas, then my biology course, and find my homework")
    res = await Agent(llm, settings).run(ctx.user_text, ctx, mode="balanced", model="m", cancel=CancelToken())
    assert res.ok and c.tab["url"].endswith("/courses/77/assignments")
    tool_msgs = [m["content"] for m in llm.calls if m.get("role") == "tool"]
    opened = tool_msgs[0]
    assert "how_this_site_works" in opened and "Assignments" in opened          # Canvas know-how right after opening
    assert "IB Biology HL" in tool_msgs[1]                                       # found beyond the first 45 elements
    assert "Photosynthesis worksheet" in tool_msgs[3]                            # sees the assignments page after the click
    assert ctx.browser == "Arc"                                                  # never switched to Safari


async def test_web_links_never_open_in_the_macs_default_browser(settings):
    from jarvis.agent.tools import TOOL_MAP, ToolContext
    from jarvis.platform.fake import FakeComputer

    c = FakeComputer(sites=CANVAS)
    ctx = ToolContext(computer=c, settings=settings, user_text="open canvas")
    await TOOL_MAP["system"].fn(ctx, {"action": "open_location", "value": "https://lincoln.instructure.com/"})
    await TOOL_MAP["run_shell"].fn(ctx, {"command": "open https://lincoln.instructure.com/courses/77"})
    assert not any(e.startswith(("location:", "shell:")) for e in c.log)       # both went through the browser instead
    assert c.tab["url"] == "https://lincoln.instructure.com/courses/77" and ctx.browser == "Arc"


async def test_quitting_jarvis_releases_its_ai_models(assistant):
    """2026-11-19: "I just quit JARVIS and my Mac is lagging": Ollama kept ~10 GB of models loaded."""
    unloaded = []

    class LLM:
        async def unload(self, m):
            unloaded.append(m)

        async def close(self):
            pass
    assistant.llm = LLM()
    await assistant.shutdown()
    assert {"qwen3.5:9b", "qwen3.5:4b"} <= set(unloaded)


async def test_multi_step_request_does_the_first_step_then_the_ai_continues(assistant, hist, scripted):
    """The exact request that crashed: Canvas opens instantly, the AI is told it's there and continues."""
    llm = scripted([("tools", [("done", {"summary": "Week 13 homework: lab write-up."})])])
    assistant.llm = assistant.agent.llm = llm
    r = await assistant.handle_text("open canvas, find my ib 150 class, navigate to online course resources, "
                                    "and find week 13 homework")
    assert r["route"] == "agent" and r["ok"]
    assert assistant.computer.tab["url"] == "https://lincoln.instructure.com/"
    first_prompt = "\n".join(str(m) for m in llm.calls)
    assert "Step already done" in first_prompt and "find my ib 150 class" in first_prompt


def test_page_script_results_decode_in_every_browser(monkeypatch):
    import json
    import sys
    import types

    class Stub(types.ModuleType):
        def __getattr__(self, n):
            if n.startswith("__"):
                raise AttributeError(n)
            return lambda *a, **k: None
    for m in ("Quartz", "AppKit", "ApplicationServices", "Foundation", "Vision", "AVFoundation", "objc", "CoreFoundation"):
        monkeypatch.setitem(sys.modules, m, sys.modules.get(m) or Stub(m))
    from jarvis.platform.macos.browser import decode_js_result as d

    obj = {"url": "https://x", "ready": "complete"}
    assert d(json.dumps(obj)) == obj                         # Chrome
    assert d(json.dumps(json.dumps(obj))) == obj             # Arc: a quoted JSON string (this crashed every page action)
    assert d("") == {} and d("missing value") == {} and d("oops") == {"raw": "oops"}


# --- 2026-11-19 log: "learn this…" was answered "I have memorized that" (nothing saved); "open my ib150 course"
#     opened a LabFlow page and remembered it; "yes" -> "Opening IB150 now" (nothing happened) ----------------------
async def test_learn_this_is_actually_saved(assistant):
    r = await assistant.handle_text("learn this, for canvas, you need to click the book icon the second one down from "
                                    "my profile picture to get to the class dashboard")
    assert r["route"] == "builtin" and r["message"] == "Noted."
    assert any("book icon" in m["content"] for m in assistant.memory.all())


async def test_canvas_tips_reach_the_ai_when_you_are_on_canvas(assistant, hist):
    await assistant.handle_text("remember this, on canvas, if clicking the book doesnt open the course sidebar, click it again")
    assistant.computer.front = "Arc"
    assistant.computer.browser_open_url("https://lincoln.instructure.com/")
    ctx = await assistant._agent_context("navigate to my ib150 class")          # doesn't say "canvas"
    assert "click it again" in ctx


def test_generic_words_never_pick_a_site(tmp_path, monkeypatch):
    from jarvis import sites

    f = tmp_path / "H"
    make_history(f, HISTORY + [("https://courses.labflow.com/student/42", "LabFlow course", 50)])
    monkeypatch.setattr(sites, "history_files", lambda: [str(f)])
    assert sites.search_history("my ib150 course", strict=True) is None
    assert sites.search_history("ib150") is None


async def test_weak_guess_is_not_remembered(assistant, tmp_path, monkeypatch):
    from jarvis import sites

    f = tmp_path / "H"
    make_history(f, [("https://app.example.com/x", "IB150 notes", 40)])         # name only in the title, not the address
    monkeypatch.setattr(sites, "history_files", lambda: [str(f)])
    assistant._remember_site("my ib150 site", "https://app.example.com/x", "browser history")
    assert not [m for m in assistant.memory.all() if m.get("kind") == "website"]


async def test_chat_never_claims_to_act_it_hands_over(assistant):
    from jarvis.llm import ChatResult, ToolCall

    class LLM:
        def __init__(self):
            self.n = 0

        async def chat(self, messages, model, tools=None, **k):
            self.n += 1
            if tools:
                return ChatResult("", [ToolCall("done", {"summary": "Opened IB150."})], 5, model)
            return ChatResult("ACTION: open my IB150 course on Canvas", [], 5, model)

        async def available(self):
            return True
    assistant.llm = assistant.agent.llm = LLM()
    r = await assistant.handle_text("yes")
    assert r["route"] == "agent" and r["message"] == "Opened IB150."              # really done by the agent


def test_held_back_action_and_lookup_are_never_spoken():
    from jarvis.llm import SpokenStream

    s = SpokenStream()
    assert s.feed("ACTION: open my IB150 course.") == [] and s.flush() == [] and s.lookup


CHATGPT = {"https://chatgpt.com/": {"title": "ChatGPT", "elements": [
    {"role": "button", "name": "Canvas"}, {"role": "button", "name": "New chat"}, {"role": "input:text", "name": "Message ChatGPT"}],
    "text": "What can I help with?"}}


async def test_open_canvas_from_a_chatgpt_tab_opens_your_canvas(assistant, hist, scripted):
    """ChatGPT has a 'Canvas' button; JARVIS clicked it and then wandered around ChatGPT."""
    assistant.computer.sites.update(CHATGPT)
    assistant.computer.browser_open_url("https://chatgpt.com/")
    assistant.session.browser_active, assistant.computer.front = True, "Arc"
    llm = scripted([("tools", [("done", {"summary": "Found week 13 homework."})])])
    assistant.llm = assistant.agent.llm = llm
    await assistant.handle_text("open canvas, find my ib 150 class, navigate to online course resources, and find week 13 homework")
    assert assistant.computer.tab["url"] == "https://lincoln.instructure.com/"
    assert not any("Canvas" in e and "click" in e for e in assistant.computer.log)


async def test_course_link_on_canvas_is_still_clicked(assistant, hist):
    assistant.computer.sites.update(CANVAS)
    assistant.computer.browser_open_url("https://lincoln.instructure.com/")
    assistant.session.browser_active, assistant.computer.front = True, "Arc"
    await assistant.handle_text("open my ib biology hl course")
    assert assistant.computer.tab["url"] == "https://lincoln.instructure.com/courses/77"


async def test_battery_rules_for_models(assistant):
    """2026-11-19: "it's also draining the f*** out of my battery"."""
    warmed = []

    class LLM:
        async def warm(self, m, keep):
            warmed.append((m, keep))
    assistant.llm = LLM()
    assistant.settings.set("llm.smart_model", "gemma4:26b")
    assistant.power.state.source = "battery"
    assistant.power.mode = "balanced"
    assert assistant.task_model == "qwen3.5:9b"                     # the 17 GB model is never used on battery…
    await assistant._warm()
    assert warmed == [("qwen3.5:4b", "5m")]                         # …or pre-loaded; only the small chat model, 5 min
    assistant.power.state.source = "ac"
    warmed.clear()
    await assistant._warm()
    assert "gemma4:26b" not in [m for m, _ in warmed]                # never pre-loaded, even plugged in
    assert assistant.task_model == "gemma4:26b" and assistant._keep_alive("gemma4:26b") == "2m"
