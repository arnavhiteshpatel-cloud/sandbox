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
