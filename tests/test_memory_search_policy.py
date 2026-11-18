import os
import time

from jarvis.agent import policy
from jarvis.memory import Memory
from jarvis.search import Search
from jarvis.search.indexer import Indexer


def test_memory_explicit_vs_inferred(db):
    m = Memory(db)
    a = m.add("I prefer Arc for school websites")
    b = m.add("User seems to study biology on Mondays", source="inferred", confidence=0.5)
    assert a["content"] == "User prefers Arc for school websites" and a["source"] == "explicit"
    assert b["source"] == "inferred"
    ctx = m.context_for("which browser for school")
    assert any("you told me" in l for l in ctx)
    assert m.search("arc")[0]["id"] == a["id"]
    assert m.update(a["id"], content="User prefers Safari")["content"] == "User prefers Safari"
    assert m.delete(b["id"])
    assert '"memories"' in m.export()


def _write(tmp, name, text, age_days=0):
    p = tmp / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    t = time.time() - age_days * 86400
    os.utime(p, (t, t))
    return p


async def test_index_and_search(tmp_path, settings, db):
    root = tmp_path / "home"
    _write(root, "Research/parkinsons_dopamine.md", "Dopaminergic neuron loss in Parkinson's disease and alpha-synuclein.")
    _write(root, "Research/resume_2023.txt", "Resume. Experience: lab assistant.", age_days=400)
    _write(root, "Docs/resume_2026.txt", "Resume. Experience: research intern at neuro lab.", age_days=3)
    _write(root, "Docs/copy_of_resume_2026.txt", "Resume. Experience: research intern at neuro lab.", age_days=3)
    _write(root, ".secret/keys.txt", "parkinson secret should never be indexed")
    _write(root, "Library/Caches/x.txt", "parkinson cache")
    settings.set("search.roots", [str(root)])
    st = Indexer(db, settings).run()
    assert st.indexed == 4 and st.errors == 0
    s = Search(db, settings)
    res = await s.search("Parkinson's research")
    assert res and res[0]["name"] == "parkinsons_dopamine.md"
    assert all(".secret" not in r["path"] and "Library" not in r["path"] for r in res)
    res = await s.search("most recent version of my resume")
    assert res[0]["name"] in ("resume_2026.txt", "copy_of_resume_2026.txt")
    dupes = s.duplicates()
    assert len(dupes) == 1 and len(dupes[0]) == 2
    # incremental: nothing changed -> nothing re-indexed
    st2 = Indexer(db, settings).run()
    assert st2.indexed == 0 and st2.unchanged == 4
    os.remove(root / "Research/resume_2023.txt")
    st3 = Indexer(db, settings).run()
    assert st3.removed == 1


def test_extract_office_formats(tmp_path):
    import docx
    import openpyxl
    from pptx import Presentation

    from jarvis.search.extract import extract_text

    d = docx.Document()
    d.add_paragraph("Enzyme kinetics lab report")
    d.save(tmp_path / "a.docx")
    prs = Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = "Lecture 5: Mitochondria"
    prs.save(tmp_path / "b.pptx")
    wb = openpyxl.Workbook()
    wb.active["A1"] = "Grade"
    wb.active["B1"] = 7
    wb.save(tmp_path / "c.xlsx")
    assert "Enzyme" in extract_text(str(tmp_path / "a.docx"))
    assert "Mitochondria" in extract_text(str(tmp_path / "b.pptx"))
    assert "Grade | 7" in extract_text(str(tmp_path / "c.xlsx"))


def test_policy(settings):
    v = policy.check("click", {}, user_text="open the assignment", settings=settings, element_label="Submit Assignment")
    assert v.confirm
    v = policy.check("click", {}, user_text="click submit", settings=settings, element_label="Submit")
    assert not v.confirm
    v = policy.check("click", {}, user_text="click buy now", settings=settings, element_label="Buy now")
    assert v.confirm   # purchases always confirm, even when asked
    assert not policy.check("open_url", {"url": "javascript:alert(1)"}, user_text="", settings=settings).allow
    assert policy.check("open_app", {"name": "Terminal"}, user_text="", settings=settings).allow   # every app reachable
    assert policy.check("type_text", {"text": "ls"}, user_text="", settings=settings, front_app="Terminal").confirm
    assert not policy.check("type_text", {"text": "hi"}, user_text="", settings=settings, front_app="Notes").confirm
    assert policy.check("script_app", {"script": 'tell application "Finder" to delete file "x"'}, user_text="", settings=settings).confirm
    assert policy.check("script_app", {"script": 'do shell script "rm x"'}, user_text="", settings=settings).confirm
    assert not policy.check("script_app", {"script": 'tell application "Music" to play playlist "Focus"'}, user_text="", settings=settings).confirm
    assert policy.check("send_message", {"to": "Mom", "text": "hi"}, user_text="text mom hi", settings=settings).confirm
    settings.set("security.blocked_apps", ["Terminal"])
    assert not policy.check("open_app", {"name": "Terminal"}, user_text="", settings=settings).allow
    assert policy.check("move_file", {"src": "/etc/hosts", "dst": "~/Documents/x"}, user_text="", settings=settings).confirm
    assert not policy.check("move_file", {"src": "~/Downloads/a.pdf", "dst": "~/Documents/Papers/"}, user_text="", settings=settings).confirm


def test_power_policy(settings):
    from jarvis.events import EventBus
    from jarvis.power import PowerManager, PowerState

    pm = PowerManager(settings, EventBus())
    pm.power_source_changed(PowerState("ac", 90, True))
    assert pm.wake_word_allowed()                           # user choice: wake word on AC
    pm.power_source_changed(PowerState("battery", 80, False))
    assert not pm.wake_word_allowed()                       # hold-to-talk only on battery
    settings.set("power.auto_switch", True)
    pm.power_source_changed(PowerState("battery", 20, False))
    assert pm.mode == "battery_saver"
    pm.task_started()
    pm.power_source_changed(PowerState("ac", 21, True))
    assert pm.mode == "battery_saver" and pm.pending_mode == "max_performance"   # never interrupts a task
    pm.task_finished()
    assert pm.mode == "max_performance"
    assert not pm.index_allowed() or pm.state.source == "ac"
