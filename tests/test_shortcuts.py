import json

import pytest

from jarvis.platform.fake import FakeComputer
from jarvis.shortcuts import CancelToken, ShortcutEngine, ShortcutError, ShortcutStore, match, validate
from jarvis.shortcuts.builder import describe, parse_description

IB_URL = "https://ib.example.edu/course"   # test fixture only; the real URL comes from the user

IB = {
    "name": "Open My IB",
    "triggers": ["open my ib", "open ib"],
    "steps": [
        {"action": "open_url", "url": IB_URL, "browser": "Arc", "new_tab": True},
        {"action": "verify", "condition": {"type": "url_contains", "value": "ib.example.edu"}},
    ],
    "response": "Your IB course is open.",
}


def test_validate_rejects_bad():
    with pytest.raises(ShortcutError):
        validate({"name": "x", "steps": []})
    with pytest.raises(ShortcutError):
        validate({"name": "x", "steps": [{"action": "launch_missiles"}]})
    with pytest.raises(ShortcutError):
        validate({"name": "x", "steps": [{"action": "open_url"}]})


def test_params_declared_from_triggers():
    sc = validate({"name": "yt", "triggers": ["search youtube for {query}"],
                   "steps": [{"action": "open_url", "url": "https://youtube.com/results?search_query={query|url}"}]})
    assert sc["params"] == [{"name": "query"}]


def test_match_exact_param_and_no_false_positive(db):
    store = ShortcutStore(db)
    store.save(IB)
    store.save({"name": "yt", "triggers": ["search youtube for {query}"], "steps": [{"action": "open_url", "url": "https://y/{query|url}"}]})
    scs = store.list()
    assert match("JARVIS, open my I.B.", scs).shortcut["id"] == "open-my-ib"
    m = match("search youtube for lo-fi beats", scs)
    assert m.params["query"] == "lo-fi beats"
    assert match("open arc", scs) is None


async def test_engine_runs_ib(db, settings):
    c = FakeComputer()
    store = ShortcutStore(db)
    sc = store.save(IB)
    eng = ShortcutEngine(c, store, settings)
    res = await eng.run(sc)
    assert res.ok, res.message
    assert res.message == "Your IB course is open."
    assert c.tab["url"] == IB_URL
    assert "open_app:Arc" in c.log
    runs = store.runs(sc["id"])
    assert runs[0]["status"] == "ok" and len(runs[0]["log"]) == 2


async def test_engine_retry_then_success(db, settings):
    c = FakeComputer()
    c.fail_next["browser_open_url"] = 1   # first attempt fails, retry succeeds
    store = ShortcutStore(db)
    res = await ShortcutEngine(c, store, settings).run(store.save(IB))
    assert res.ok
    assert [(e["attempt"], e["ok"]) for e in res.log[:2]] == [(1, False), (2, True)]


async def test_engine_verification_failure_reported(db, settings):
    c = FakeComputer()
    store = ShortcutStore(db)
    bad = dict(IB, id="bad", steps=[IB["steps"][0], {"action": "verify", "condition": {"type": "url_contains", "value": "nope.edu"}}])
    res = await ShortcutEngine(c, store, settings).run(store.save(bad))
    assert not res.ok and "Condition not met" in res.message


async def test_engine_branch_reusable_block_and_params(db, settings):
    c = FakeComputer()
    store = ShortcutStore(db)
    store.save({"name": "focus block", "steps": [{"action": "macos_shortcut", "name": "JARVIS Focus On"}]})
    sc = store.save({"name": "study mode", "triggers": ["study mode"], "steps": [
        {"action": "open_app", "app": "spotify"},
        {"action": "if", "condition": {"type": "app_running", "value": "Spotify"},
         "then": [{"action": "run_shortcut", "shortcut": "focus-block"}],
         "else": [{"action": "say", "text": "no"}]},
        {"action": "arrange_windows", "layout": "halves", "apps": ["Arc", "Spotify"]},
    ]})
    res = await ShortcutEngine(c, store, settings).run(sc)
    assert res.ok, res.message
    assert "macos_shortcut:JARVIS Focus On" in c.log and "arrange:halves:Arc,Spotify" in c.log


async def test_engine_cancel(db, settings):
    c = FakeComputer()
    store = ShortcutStore(db)
    sc = store.save({"name": "slow", "steps": [{"action": "wait", "seconds": 5}, {"action": "open_app", "app": "Spotify"}]})
    tok = CancelToken()
    import asyncio

    task = asyncio.create_task(ShortcutEngine(c, store, settings).run(sc, cancel=tok))
    await asyncio.sleep(0.1)
    tok.cancel("test")
    res = await task
    assert not res.ok and "Stopped" in res.message
    assert "open_app:Spotify" not in c.log


async def test_shell_requires_authorization_for_voice_created(db, settings):
    store = ShortcutStore(db)
    sc = store.save({"name": "danger", "steps": [{"action": "shell", "command": "rm -rf /tmp/x"}]}, created_by="voice")
    asked = []

    async def deny(q):
        asked.append(q)
        return False

    res = await ShortcutEngine(FakeComputer(), store, settings, confirm=deny).run(sc)
    assert not res.ok and asked


def test_persistence_edit_delete_import_export(home):
    from jarvis.db import Database

    store = ShortcutStore(Database())
    store.save(IB)
    sc = store.get("open-my-ib")
    sc["triggers"].append("go to my ib course")
    store.save(sc)
    exported = store.export()
    # "Restart": brand new connection to the same file
    store2 = ShortcutStore(Database())
    assert "go to my ib course" in store2.get("open-my-ib")["triggers"]
    assert store2.delete("open-my-ib")
    assert store2.get("open-my-ib") is None
    res = store2.import_(json.loads(json.dumps(exported)))
    assert res["added"] == ["open-my-ib"]


def test_builder_parses_open_arc_this_url():
    steps, notes = parse_description("Open Arc and go to this URL", lambda s: {"arc": "Arc"}.get(s.lower()),
                                     current_url="https://ib.example.edu/course", clipboard_url=None)
    assert steps == [{"action": "open_url", "url": "https://ib.example.edu/course", "browser": "Arc", "new_tab": True}]
    assert describe({"steps": steps}).startswith("open ib.example.edu")


def test_builder_unknown_goes_to_llm():
    steps, _ = parse_description("water my plants", lambda s: None, None, None)
    assert steps is None
