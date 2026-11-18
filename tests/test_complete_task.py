"""“JARVIS, do it”: autonomous completion of a task on screen, stopping before submit."""
from jarvis.agent.calc import safe_eval

QUIZ = "https://school.example.edu/practice/cells"


def test_calculator():
    assert safe_eval("12*7") == 84 and safe_eval("2^10") == 1024 and safe_eval("sqrt(16)+1") == 5
    for bad in ('__import__("os")', "open('x')", "9**99999999", "[1]"):
        try:
            safe_eval(bad)
            raise AssertionError(bad)
        except (ValueError, SyntaxError):
            pass


async def test_do_it_completes_quiz_and_stops_before_submit(assistant, scripted):
    c = assistant.computer
    c.browser_open_url(QUIZ)
    llm = scripted([
        ("tools", [("observe", {})]),
        ("tools", [("calculate", {"expression": "12*7"})]),
        ("tools", [("type_text", {"element_id": "w1", "text": "Mitochondria"}),
                   ("type_text", {"element_id": "w2", "text": "84 hours"}),
                   ("type_text", {"element_id": "w3", "text": "Nucleus"})]),
        ("tools", [("observe", {})]),
        ("tools", [("click", {"element_id": "w4"})]),            # Next page
        ("tools", [("observe", {})]),
        ("tools", [("type_text", {"element_id": "w1", "text": "Photosynthesis"}), ("click", {"element_id": "w2"})]),
        ("tools", [("click", {"element_id": "w4"})]),            # Submit quiz: must be stopped
        ("tools", [("done", {"summary": "Answered all 5 questions; none uncertain. Ready for you to review and submit.", "success": True})]),
    ])
    assistant.llm = llm
    assistant.agent.llm = llm
    asked = []

    async def deny(q):
        asked.append(q)
        return False
    assistant.agent.confirm = deny
    assistant.confirm = deny          # the final "…Submit?" question: answer no
    assistant.say = lambda *a, **k: _noop()
    r = await assistant.handle_text("JARVIS, do it")
    assert r["message"] == "Okay, not submitted." and "Submit?" in asked[-1]
    assert r["ok"] and r["route"] == "agent", r
    p1, p2 = c.field_values(QUIZ), c.field_values(QUIZ + "/2")
    assert p1 == {"Answer to question 1": "Mitochondria", "Answer to question 2": "84 hours", "Answer to question 3": "Nucleus"}
    assert p2["Answer to question 4"] == "Photosynthesis" and p2["True"] is True and not p2.get("False")
    assert asked and "hand this in" in asked[0]
    assert "click:Submit quiz" not in c.log
    # completion mode ran with thinking and the completion rules
    sys_prompt = llm.calls[0]["content"] if llm.calls[0]["role"] == "system" else ""
    assert "Request:" in llm.calls[0]["content"]


async def _noop():
    return None


async def test_dropdown_rejects_unknown_option(assistant):
    c = assistant.computer
    c.browser_open_url(QUIZ)
    c.browser_snapshot()
    r = c.browser_type("w3", "Golgi body")
    assert not r.ok and "Nucleus" in r.message


def test_snapshot_shows_options_and_groups():
    from jarvis.agent.tools import _fmt_elements

    text = _fmt_elements([{"id": "w3", "role": "select", "name": "Q3", "options": ["Ribosome", "Nucleus"], "value": "Nucleus"},
                          {"id": "w5", "role": "input:radio", "name": "True", "group": "q5", "checked": True}])
    assert 'options=["Ribosome", "Nucleus"]' in text and "group=q5" in text and "(checked)" in text


def test_finalize_buttons_always_ask_in_completion_mode(settings):
    from jarvis.agent import policy

    for label in ("Submit quiz", "Finish attempt", "Turn in", "Complete quiz"):
        v = policy.check("click", {}, user_text="complete this quiz and submit", settings=settings, element_label=label,
                         strict_finalize=True)
        assert v.confirm, label
    assert not policy.check("click", {}, user_text="do it", settings=settings, element_label="Next page", strict_finalize=True).confirm


async def test_type_dictation_and_compose(assistant, scripted):
    from jarvis.assistant import dictation_text
    from jarvis.router import route

    c = assistant.computer
    assert route("take dictation").name == "dictation" and route("stop dictation").args["on"] is False
    assert route("write a paragraph about photosynthesis").name == "compose"
    assert route("write an email to mom") is None or route("write an email to mom").name != "compose"
    assert dictation_text("Dear Ms Smith comma new line thanks for the feedback period") == "Dear Ms Smith,\nthanks for the feedback. "
    r = await assistant.handle_text("take dictation")
    assert "Dictation on" in r["message"]
    await assistant.handle_text("hello world comma this is a test period", source="voice")
    assert "text:hello world, this is a test. " in c.log
    await assistant.handle_text("stop dictation", source="voice")
    assert not assistant.dictation
    llm = scripted([("text", "Photosynthesis turns light, water and carbon dioxide into glucose and oxygen.")])
    assistant.llm = llm
    r = await assistant.handle_text("write a sentence about photosynthesis")
    assert r["route"] == "compose" and "words" in r["message"]
    assert any(e.startswith("text:Photosynthesis turns light") for e in c.log)
    c.focus_is_text = False
    r = await assistant.handle_text("type hello")
    assert not r["ok"] and "Click where" in r["message"]


async def test_agent_types_for_real_when_direct_fill_fails(settings):
    from jarvis.agent.tools import ToolContext, type_text
    from jarvis.platform.base import ActionResult
    from jarvis.platform.fake import FakeComputer

    c = FakeComputer()
    c.browser_open_url("https://school.example.edu/practice/cells")
    c.browser_snapshot()
    c.browser_type = lambda *a, **k: ActionResult(True, "typed", verified=False)    # a rich editor ignoring the direct fill
    out = await type_text(ToolContext(computer=c, settings=settings, last_elements={"w1": {"role": "textbox"}}),
                          {"element_id": "w1", "text": "Line one\nLine two"})
    assert out["ok"] and "text:Line one\nLine two" in c.log


async def test_clicking_a_dropdown_option_selects_it(settings):
    """Reproduces the real-model run: click the dropdown, then click the option's text."""
    from jarvis.agent.tools import ToolContext, click, observe
    from jarvis.platform.fake import FakeComputer

    c = FakeComputer()
    c.browser_open_url(QUIZ)
    ctx = ToolContext(computer=c, settings=settings, browser="Arc")
    await observe(ctx, {})
    await click(ctx, {"element_id": "w3"})
    out = await click(ctx, {"text": "Nucleus"})
    assert out["ok"] and c.field_values(QUIZ)["Answer to question 3"] == "Nucleus"
    out = await click(ctx, {"element_id": "w3", "text": "Ribosome"})
    assert out["ok"] and c.field_values(QUIZ)["Answer to question 3"] == "Ribosome"


async def test_do_it_asks_then_submits_on_yes(assistant, scripted):
    c = assistant.computer
    c.browser_open_url(QUIZ + "/2")
    llm = scripted([
        ("tools", [("type_text", {"element_id": "w1", "text": "Photosynthesis"}), ("click", {"element_id": "w2"})]),
        ("tools", [("done", {"summary": "Answered 2 of 2; unsure about none.", "success": True})]),
    ])
    assistant.llm = llm
    assistant.agent.llm = llm
    questions = []

    async def yes(q):
        questions.append(q)
        return True
    assistant.confirm = yes
    r = await assistant.handle_text("do it")
    assert questions == ["Answered 2 of 2; unsure about none. Submit?"]
    assert "click:Submit quiz" in c.log and c.tab["url"].endswith("/submitted") and r["message"] == "Submitted."
