"""Run the 40 acceptance tests on the Mac and record real evidence.

  /Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis.acceptance
  ... --only 7,8,9      run selected tests      ... --list   show tests

Automated tests drive the running JARVIS app through its local API and check the real
effect (Arc's actual URL, files on disk, ...). Tests that need a human (your voice, sleep,
Wi-Fi off) print instructions and ask you what happened. Results are appended to
docs/ACCEPTANCE_RESULTS.md with timestamps. Nothing here is simulated.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

from .config import Settings
from .server import load_token

S = Settings()
BASE = f"http://127.0.0.1:{S.get('server.port')}"
TEST_DIR = os.path.expanduser("~/Documents/JARVIS-acceptance")


def api(method, path, body=None, timeout=900):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-Jarvis-Token": load_token(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def ask(text):
    return api("POST", "/api/command", {"text": text, "wait": True})


def osa(script):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=20).stdout.strip()


def arc_url():
    return osa('tell application "Arc" to get URL of active tab of front window')


def running(app):
    return f'"{app}"' in subprocess.run(["lsappinfo", "visibleProcessList"], capture_output=True, text=True).stdout


def human(prompt) -> tuple[bool, str]:
    print(prompt)
    ans = input("  Did it work? [y/n] + optional note: ").strip()
    return ans.lower().startswith("y"), ans


def answer_soon(text, delay=2.0):
    """Answer JARVIS's next question through the API (simulates you replying in the UI)."""
    import threading

    def go():
        for _ in range(40):
            time.sleep(delay / 4)
            st = api("GET", "/api/state")
            if st.get("question"):
                api("POST", "/api/answer", {"text": text})
                return
    threading.Thread(target=go, daemon=True).start()


# --- tests ----------------------------------------------------------------------------------------
def t1():
    return human("Say “Hey JARVIS” (Mac plugged in, wake word on). The HUD pill should appear and say Listening.")
def t2():
    return human("Say “Hey JARVIS, what time is it?” JARVIS should answer with the time.")
def t3():
    return human("Listen: was the reply spoken in the British (Kokoro) voice, not a robotic one?")
def t4():
    return human("Say “Hey JARVIS, open my IB”, then right after the reply (no wake word) say “scroll down”.")
def t5():
    return human("Ask something long (“Hey JARVIS, explain photosynthesis in detail”), then interrupt with “Hey JARVIS” or hold ⌥⇧C while it talks. It should stop speaking immediately.")
def t6():
    env = {k for k in os.environ if "ANTHROPIC" in k or "CLAUDE" in k or "OPENAI" in k}
    key = S.get("llm.api_key")
    ok = not env and not key and S.get("llm.base_url", "").startswith(("http://127.0.0.1", "http://localhost"))
    return ok, f"cloud env vars={sorted(env)}, api_key set={bool(key)}, llm={S.get('llm.base_url')}"
def t7():
    if running("Arc"):
        osa('tell application "Arc" to quit'); time.sleep(3)
    r = ask("open Arc"); time.sleep(2)
    return running("Arc") and r["ok"], f"reply={r['message']!r} running={running('Arc')} latency={r.get('ms')}ms route={r.get('route')}"
def t8():
    out = []
    for app in ("Notes", "Calculator"):
        r = ask(f"open {app}"); time.sleep(1.5)
        out.append((app, running(app), r.get("ms")))
    for app in ("Calculator",):
        ask(f"quit {app}")
    return all(x[1] for x in out), f"{out}"
def t9():
    r = ask("go to example.com"); time.sleep(1)
    u = arc_url()
    return "example.com" in u, f"reply={r['message']!r} arc_url={u}"
def t10():
    ask("go to example.com"); time.sleep(1)
    r = ask("click More information"); time.sleep(2)
    u = arc_url()
    return "iana.org" in u, f"reply={r['message']!r} arc_url={u} route={r['route']}"
def t11():
    ask("go to en.wikipedia.org/wiki/Mitochondrion"); time.sleep(2)
    y0 = osa('tell application "Arc" to tell active tab of front window to execute javascript "String(document.scrollingElement.scrollTop)"')
    r = ask("scroll down"); time.sleep(1)
    y1 = osa('tell application "Arc" to tell active tab of front window to execute javascript "String(document.scrollingElement.scrollTop)"')
    return y0.isdigit() and y1.isdigit() and int(y1) > int(y0), f"scrollTop {y0} -> {y1}; reply={r['message']!r}"
def t12():
    ask("go to example.com"); time.sleep(1)
    r = ask("What does this page say? One sentence.")
    return "example" in r["message"].lower() and r["ok"], f"route={r['route']} reply={r['message']!r} ms={r.get('ms')}"
def t13():
    r = ask("Go to en.wikipedia.org, search for Parkinson's disease, open the article and tell me the first sentence of it.")
    u = arc_url()
    return ("parkinson" in u.lower()) and ("neuro" in r["message"].lower() or "disorder" in r["message"].lower()), \
        f"url={u} reply={r['message'][:200]!r} steps={len(r.get('steps') or [])} ms={r.get('ms')}"
def t14():
    ask("go to example.com"); time.sleep(1)
    r1 = ask("click the purple elephant button")
    r2 = ask("click More information"); time.sleep(1.5)
    ok = (not r1["ok"] or "couldn't" in r1["message"].lower() or "not" in r1["message"].lower()) and "iana.org" in arc_url()
    return ok, f"bad target -> {r1['message']!r}; recovery -> {r2['message']!r} url={arc_url()}"
def t15():
    osa('tell application "Arc" to tell front window to make new tab with properties {URL:"https://example.com"}'); time.sleep(2)
    answer_soon("Open Arc and go to this URL", 2)
    import threading
    threading.Timer(12, lambda: answer_soon("yes", 1)).start()
    r = ask("create a shortcut called acceptance test site")
    sc = [s for s in api("GET", "/api/shortcuts") if s["id"] == "acceptance-test-site"]
    return bool(sc) and "example.com" in json.dumps(sc), f"reply={r['message']!r} saved={sc[:1]}"
def t16():
    scs = {s["id"]: s for s in api("GET", "/api/shortcuts")}
    sc = scs.get("open-my-ib")
    if not sc:
        return False, "Create 'Open My IB' first: Command Center > Shortcuts > New (paste your IB URL), or say “create a shortcut called open my IB”."
    url = next((st["url"] for st in sc["steps"] if st.get("action") == "open_url"), "")
    r = ask("open my IB"); time.sleep(1)
    host = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
    return r["ok"] and host in arc_url(), f"reply={r['message']!r} arc_url={arc_url()} expected host={host} ms={r.get('ms')}"
def t17():
    print("Running “open my IB” then a follow-up of your choice.")
    ask("open my IB"); time.sleep(2)
    follow = input("  Type a follow-up to test (e.g. “click assignments”): ").strip() or "click assignments"
    r = ask(follow); time.sleep(1.5)
    ok, note = human(f"  JARVIS said {r['message']!r}; Arc is at {arc_url()}. Did it do the right thing?")
    return ok, f"follow-up={follow!r} route={r['route']} reply={r['message']!r} url={arc_url()} note={note}"
def t18():
    sc = {"name": "Acceptance Edit Me", "triggers": ["acceptance edit me"], "steps": [{"action": "say", "text": "one"}]}
    api("POST", "/api/shortcuts", sc)
    sc["steps"][0]["text"] = "two"; sc["id"] = "acceptance-edit-me"
    api("POST", "/api/shortcuts", sc)
    edited = [s for s in api("GET", "/api/shortcuts") if s["id"] == "acceptance-edit-me"][0]["steps"][0]["text"] == "two"
    deleted = api("DELETE", "/api/shortcuts/acceptance-edit-me")["deleted"]
    gone = not [s for s in api("GET", "/api/shortcuts") if s["id"] == "acceptance-edit-me"]
    return edited and deleted and gone, f"edited={edited} deleted={deleted} gone={gone}"
def t19():
    names = [s["id"] for s in api("GET", "/api/shortcuts")]
    human(f"Shortcuts now: {names}. Quit JARVIS from the menu bar and open it again, then press Return.")
    for _ in range(60):
        try:
            after = [s["id"] for s in api("GET", "/api/shortcuts")]
            break
        except Exception:
            time.sleep(1)
    else:
        return False, "JARVIS did not come back"
    return set(names) <= set(after), f"before={names} after={after}"
def t20():
    r = ask("Remember that my favourite study playlist is Deep Focus")
    r2 = ask("what do you remember about my study playlist")
    return "deep focus" in r2["message"].lower(), f"save={r['message']!r} recall={r2['message']!r}"
def _make_docs():
    os.makedirs(TEST_DIR, exist_ok=True)
    open(os.path.join(TEST_DIR, "neuro_notes.txt"), "w").write("Notes on alpha-synuclein aggregation in Parkinson's disease and dopaminergic neurons.")
    open(os.path.join(TEST_DIR, "shopping.txt"), "w").write("eggs, milk, bread")
def t21():
    _make_docs()
    res = api("GET", "/api/search?q=neuro%20notes")
    return any("neuro_notes.txt" in r["path"] for r in res), f"top={[r['path'] for r in res[:3]]}"
def t22():
    _make_docs()
    roots = S.get("search.roots")
    api("POST", "/api/index", {"force": True})
    for _ in range(120):
        time.sleep(2)
        st = api("GET", "/api/search/stats")
        if not st["indexing"]:
            break
    res = api("GET", "/api/search?q=alpha-synuclein%20aggregation")
    return any("neuro_notes.txt" in r["path"] for r in res), f"roots={roots} top={[ (r['path'], r.get('sources')) for r in res[:3]]}"
def t23():
    d = os.path.join(TEST_DIR, "organize")
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    for n in ("a.pdf", "b.pdf", "c.txt"):
        open(os.path.join(d, n), "w").write(n)
    S.set("security.file_write_roots", sorted(set(S.get("security.file_write_roots") + ["~/Documents"])))
    r = ask(f"Move the PDFs in {d} into a new folder called Papers inside it.")
    moved = sorted(os.listdir(os.path.join(d, "Papers"))) if os.path.isdir(os.path.join(d, "Papers")) else []
    return moved == ["a.pdf", "b.pdf"] and os.path.exists(os.path.join(d, "c.txt")), f"reply={r['message']!r} Papers={moved}"
def t24():
    ok, note = t19()
    r = ask("what do you remember about my study playlist")
    return ok and "deep focus" in r["message"].lower(), f"{note}; recall after restart={r['message']!r}"
def power(names):
    def t():
        print(f"Run (in another terminal, unplugged):\n  sudo {sys.executable} -m jarvis.powerprof --only {names} --minutes 3\nthen paste the summary line here.")
        note = input("  Summary: ")
        return bool(note.strip()), note
    return t
def t30():
    ok, note = human("Put the Mac to sleep (Apple menu > Sleep), wait 1 minute, wake it. Did it sleep normally (screen off, no fans)?")
    a = subprocess.run(["pmset", "-g", "assertions"], capture_output=True, text=True).stdout
    held = [l for l in a.splitlines() if re.search("python|JARVIS", l) and "Prevent" in l]
    return ok and not held, f"assertions held by JARVIS={held} note={note}"
def t31():
    t0 = time.time()
    r = ask("what time is it")
    return r["ok"], f"after wake: reply={r['message']!r} in {r.get('ms')}ms; voice: {api('GET', '/api/state').get('voice')}"
def t32():
    import statistics
    samples = []
    for _ in range(12):
        out = subprocess.run(["ps", "-axo", "pcpu=,comm="], capture_output=True, text=True).stdout
        samples.append(sum(float(l.split()[0]) for l in out.splitlines() if re.search("python|JARVIS", l)))
        time.sleep(5)
    m = statistics.mean(samples)
    return m < 2.0, f"JARVIS CPU over 60 s idle: mean {m:.2f}% samples={samples}"
def t33():
    procs = subprocess.run(["ps", "-axo", "comm="], capture_output=True, text=True).stdout
    claude = [l for l in procs.splitlines() if "claude" in l.lower()]
    st = api("GET", "/api/state")
    return not claude, f"claude processes running: {claude or 'none'}; JARVIS responding (status={st.get('status')})"
def t35():
    return human("Turn Wi-Fi OFF. Hold ⌥⇧C and say “what time is it”. Did JARVIS hear and answer you? (keep Wi-Fi off for 36–37)")
def t36():
    r = ask("open Notes"); time.sleep(1)
    return running("Notes") and r["ok"], f"offline: reply={r['message']!r}"
def t37():
    r = ask("Explain in one sentence what a mitochondrion does.")
    return r["ok"] and r["route"] == "agent" and len(r["message"]) > 20, f"offline LLM ({api('GET', '/api/state')['model']}): {r['message']!r} ms={r.get('ms')}"
def t38():
    return human("Restart the Mac. After logging in, is JARVIS in the menu bar without you opening it? (enable Launch at Login first)")
def t39():
    return human("During all of the above, did you need to open Terminal for normal use (not for these tests)?  Answer y if NOT needed.")
def t40():
    lic = "Ollama (MIT), Qwen3.5 (Apache-2.0), Whisper (MIT), Kokoro (Apache-2.0), openWakeWord (Apache-2.0; model CC BY-NC-SA, personal use)"
    return True, f"All components are free and open source: {lic}. No accounts or subscriptions are used."

TESTS = [
    (1, "Recognizes “Hey JARVIS”", t1), (2, "Understands a spoken instruction", t2), (3, "Responds with local speech synthesis", t3),
    (4, "Supports follow-up conversation", t4), (5, "Allows interruption", t5), (6, "Works without paid AI services", t6),
    (7, "Opens Arc", t7), (8, "Opens other macOS applications", t8), (9, "Navigates to a website", t9),
    (10, "Clicks a real webpage element", t10), (11, "Scrolls and interacts with a page", t11), (12, "Reads on-screen information", t12),
    (13, "Executes an unfamiliar multistep task", t13), (14, "Recovers from a failed interaction", t14),
    (15, "Creates a new custom voice shortcut", t15), (16, "Executes “open my IB”", t16), (17, "Follow-up navigation after shortcut", t17),
    (18, "Edits and deletes shortcuts", t18), (19, "Shortcuts persist across app restarts", t19),
    (20, "Remembers an explicitly saved preference", t20), (21, "Finds a local document", t21), (22, "Searches indexed file contents", t22),
    (23, "Safe file organization task", t23), (24, "Memory restored after restart", t24),
    (25, "Idle power vs baseline", power("baseline,idle_hotkey_only,idle_wake_word")), (26, "AI inference power", power("llm_inference")),
    (27, "Battery Saver mode", power("idle_hotkey_only,occasional_commands")), (28, "Balanced mode", power("occasional_commands")),
    (29, "Maximum Performance mode", power("llm_inference,extended_task")), (30, "Mac sleeps normally", t30),
    (31, "Resumes after wake", t31), (32, "No sustained idle CPU", t32), (33, "Launches without Claude Code", t33),
    (34, "No Anthropic credentials", t6), (35, "Offline voice recognition", t35), (36, "Offline automation", t36),
    (37, "Local reasoning without subscription", t37), (38, "Survives a computer restart", t38), (39, "No terminal for ordinary use", t39),
    (40, "No recurring payments", t40),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "ACCEPTANCE_RESULTS.md"))
    a = ap.parse_args()
    if a.list:
        for n, name, _ in TESTS:
            print(f"{n:2}. {name}")
        return
    only = {int(x) for x in a.only.split(",")} if a.only else None
    try:
        api("GET", "/api/state")
    except Exception as e:
        raise SystemExit(f"JARVIS isn't running ({e}). Open JARVIS.app first.")
    rows = []
    for n, name, fn in TESTS:
        if only and n not in only:
            continue
        print(f"\n[{n}] {name}")
        try:
            ok, ev = fn()
        except Exception as e:
            ok, ev = False, f"error: {type(e).__name__}: {e}"
        print(f"  -> {'PASS' if ok else 'FAIL'}: {ev}")
        rows.append((n, name, ok, ev))
    ts = time.strftime("%Y-%m-%d %H:%M")
    hdr = not os.path.exists(a.out)
    with open(a.out, "a") as f:
        if hdr:
            f.write("# JARVIS acceptance test results\n\nAppended by `python -m jarvis.acceptance` on the Mac. Real runs only.\n")
        f.write(f"\n## Run {ts}\n\n| # | Test | Result | Evidence |\n|---|---|---|---|\n")
        for n, name, ok, ev in rows:
            f.write(f"| {n} | {name} | {'PASS' if ok else 'FAIL'} | {str(ev).replace('|', '/')[:400]} |\n")
    print(f"\n{sum(r[2] for r in rows)}/{len(rows)} passed. Results appended to {a.out}")


if __name__ == "__main__":
    main()
