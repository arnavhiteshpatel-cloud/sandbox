"""Measure JARVIS's real power cost on the Mac.

  sudo /Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis.powerprof --minutes 3
  (sudo is needed for powermetrics; run UNPLUGGED for battery-discharge numbers)

For each scenario it records, side by side:
  * SoC power (CPU + GPU + ANE) from `powermetrics` (measured, mW)
  * Whole-system battery discharge power from the battery gauge: voltage x current via ioreg
    (measured, only valid on battery; includes display, SSD, Wi-Fi, everything)
  * CPU %, wakeups/s and memory of JARVIS processes (python, JARVIS, ollama)
  * Sleep-preventing power assertions held by JARVIS
Each scenario is compared with a baseline taken with JARVIS quit. Battery-life effects are
*estimates* computed from the measured deltas and the stated capacity, and labelled as such.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import threading
import time

CAPACITY_WH_NEW = 72.4  # user's MacBook Pro 14" (2024) design capacity
PROC_RX = re.compile(r"(python|JARVIS|ollama)", re.I)

SCENARIOS = [
    ("baseline", "Quit JARVIS (menu bar > Quit) and Ollama. Leave the Mac idle, screen on, same brightness.", None),
    ("idle_hotkey_only", "Start JARVIS. Set Settings > Voice > wake word to 'Never — hotkey only'. Leave idle.", None),
    ("idle_wake_word", "Set wake word to 'Always'. Leave the room quiet and the Mac idle.", None),
    ("idle_wake_word_noisy", "Wake word still 'Always'. Play speech/music nearby (e.g. a podcast) to measure the gate under sound.", None),
    ("stt_loop", "Measures speech recognition: runs the voice self-test in a loop.", "stt"),
    ("llm_inference", "Measures local LLM inference: repeated agent requests.", "llm"),
    ("screenshot_analysis", "Measures screenshot + vision analysis.", "vision"),
    ("browser_automation", "Measures Arc automation: open, scroll, click loop. Arc must be installed.", "browser"),
    ("occasional_commands", "Realistic use: one voice-style command per minute.", "occasional"),
    ("extended_task", "An extended autonomous task (file organization in a temp folder).", "extended"),
]


def sh(cmd: list[str], timeout: float = 30) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception as e:
        return f"ERR {e}"


def battery_sample() -> dict:
    out = sh(["ioreg", "-rn", "AppleSmartBattery"])
    def val(k):
        m = re.search(rf'"{k}"\s*=\s*(-?\d+)', out)
        return int(m.group(1)) if m else None
    v, a = val("Voltage"), val("InstantAmperage") or val("Amperage")
    if a is not None and a > 2**63:
        a -= 2**64
    ext = '"ExternalConnected" = Yes' in out
    return {"mV": v, "mA": a, "external": ext, "watts": (v * -a / 1e6) if (v and a is not None and a < 0) else None}


class PowerMetrics(threading.Thread):
    def __init__(self, seconds: int):
        super().__init__(daemon=True)
        self.seconds = seconds
        self.samples: list[float] = []
        self.cpu_mw: list[float] = []
        self.gpu_mw: list[float] = []
        self.ane_mw: list[float] = []
        self.thermal: list[str] = []
        self.error = None

    def run(self):
        cmd = ["powermetrics", "--samplers", "cpu_power,gpu_power,ane_power,thermal", "-i", "1000", "-n", str(self.seconds)]
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        except FileNotFoundError:
            self.error = "powermetrics not found"
            return
        for line in p.stdout:
            for rx, arr in ((r"Combined Power \(CPU \+ GPU \+ ANE\):\s*(\d+)\s*mW", self.samples), (r"^CPU Power:\s*(\d+)\s*mW", self.cpu_mw),
                            (r"^GPU Power:\s*(\d+)\s*mW", self.gpu_mw), (r"^ANE Power:\s*(\d+)\s*mW", self.ane_mw)):
                m = re.search(rx, line.strip())
                if m:
                    arr.append(float(m.group(1)))
            m = re.search(r"Current pressure level:\s*(\w+)", line)
            if m:
                self.thermal.append(m.group(1))
        p.wait()
        if p.returncode != 0 and not self.samples:
            self.error = (p.stderr.read() or "powermetrics failed (run with sudo)").strip()[:200]


def proc_sample() -> dict:
    out = sh(["ps", "-axo", "pid=,pcpu=,rss=,comm="])
    cpu, rss, procs = 0.0, 0, []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4 and PROC_RX.search(os.path.basename(parts[3])):
            cpu += float(parts[1])
            rss += int(parts[2])
            procs.append(os.path.basename(parts[3]))
    return {"cpu_pct": cpu, "rss_mb": rss / 1024, "procs": sorted(set(procs))}


def wakeups() -> float | None:
    # top's IDLEW column: idle wakeups per process over the sample interval
    out = sh(["top", "-l", "2", "-s", "5", "-stats", "pid,command,idlew", "-o", "idlew"], timeout=20)
    blocks = out.split("PID")
    if len(blocks) < 3:
        return None
    total = 0.0
    for line in blocks[-1].splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 3 and PROC_RX.search(parts[1]):
            try:
                total += float(parts[-1].rstrip("+")) / 5.0
            except ValueError:
                pass
    return round(total, 2)


def assertions() -> list[str]:
    out = sh(["pmset", "-g", "assertions"])
    return [l.strip() for l in out.splitlines() if PROC_RX.search(l) and ("PreventUserIdle" in l or "PreventSystemSleep" in l or "NoIdleSleep" in l)]


def drive(kind: str | None, stop: threading.Event) -> None:
    """Generate the workload for a scenario using the running JARVIS service."""
    if kind is None:
        return
    py = sys.executable
    def ask(text):
        subprocess.run([py, "-m", "jarvis", "ask", text], capture_output=True, timeout=600)
    while not stop.is_set():
        if kind == "stt":
            subprocess.run([py, "-m", "jarvis.voice.selftest"], capture_output=True, timeout=900)
        elif kind == "llm":
            ask("In two sentences, what is the difference between mitosis and meiosis?")
        elif kind == "vision":
            ask("Look at my screen and describe what is on it in one sentence.")
        elif kind == "browser":
            for c in ("go to en.wikipedia.org/wiki/Mitochondrion", "scroll down", "scroll down", "click Function", "go back"):
                ask(c)
        elif kind == "occasional":
            for c in ("what time is it", "open Notes", "scroll down", "what's my battery"):
                ask(c)
                if stop.wait(60):
                    return
        elif kind == "extended":
            d = "/tmp/jarvis-power-extended"
            os.makedirs(d, exist_ok=True)
            for i in range(30):
                open(f"{d}/report_{i}.{'pdf' if i % 3 == 0 else 'txt'}", "w").write(f"file {i}")
            ask(f"Go through {d}, move all PDFs into a folder called Papers inside it and tell me how many you moved.")
            subprocess.run(["rm", "-rf", d])


def run_scenario(name: str, seconds: int, kind: str | None) -> dict:
    pm = PowerMetrics(seconds)
    stop = threading.Event()
    worker = threading.Thread(target=drive, args=(kind, stop), daemon=True)
    t_end = time.time() + seconds
    pm.start()
    worker.start()
    batt, procs = [], []
    wk = wakeups()
    while time.time() < t_end:
        batt.append(battery_sample())
        procs.append(proc_sample())
        time.sleep(5)
    stop.set()
    pm.join(timeout=15)
    w = [b["watts"] for b in batt if b["watts"] is not None]
    res = {
        "scenario": name, "seconds": seconds,
        "soc_mw_mean": round(statistics.mean(pm.samples), 1) if pm.samples else None,
        "soc_mw_median": round(statistics.median(pm.samples), 1) if pm.samples else None,
        "cpu_mw_mean": round(statistics.mean(pm.cpu_mw), 1) if pm.cpu_mw else None,
        "gpu_mw_mean": round(statistics.mean(pm.gpu_mw), 1) if pm.gpu_mw else None,
        "ane_mw_mean": round(statistics.mean(pm.ane_mw), 1) if pm.ane_mw else None,
        "battery_w_mean": round(statistics.mean(w), 3) if w else None,
        "on_battery": not any(b["external"] for b in batt),
        "jarvis_cpu_pct_mean": round(statistics.mean(p["cpu_pct"] for p in procs), 2) if procs else None,
        "jarvis_rss_mb_max": round(max(p["rss_mb"] for p in procs), 1) if procs else None,
        "jarvis_idle_wakeups_per_s": wk,
        "thermal": sorted(set(pm.thermal)),
        "sleep_assertions": assertions(),
        "powermetrics_error": pm.error,
    }
    return res


def report(results: list[dict], path: str) -> str:
    base = next((r for r in results if r["scenario"] == "baseline"), None)
    lines = ["# JARVIS power profile", "", f"Measured {time.strftime('%Y-%m-%d %H:%M')} on {sh(['sysctl', '-n', 'machdep.cpu.brand_string']).strip()} "
             f"(macOS {sh(['sw_vers', '-productVersion']).strip()}).", "",
             "SoC = CPU+GPU+ANE from powermetrics (measured). Battery W = whole-system discharge from the battery gauge (measured; only on battery).",
             "Δ = scenario minus baseline. Battery-life effect is an **estimate**: Δ W × hours vs. the "
             f"{CAPACITY_WH_NEW} Wh design capacity (actual capacity is lower as the battery ages).", "",
             "| Scenario | SoC mW | Δ SoC mW | Battery W | Δ Battery W | JARVIS CPU % | JARVIS RAM MB | Wakeups/s | Thermal | Sleep blocked? |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        ds = (r["soc_mw_mean"] - base["soc_mw_mean"]) if base and r["soc_mw_mean"] is not None and base["soc_mw_mean"] is not None else None
        db = (r["battery_w_mean"] - base["battery_w_mean"]) if base and r["battery_w_mean"] is not None and base["battery_w_mean"] is not None else None
        r["delta_soc_mw"], r["delta_battery_w"] = ds, db
        lines.append(f"| {r['scenario']} | {r['soc_mw_mean']} | {round(ds, 1) if ds is not None else '—'} | {r['battery_w_mean'] or '—'} | "
                     f"{round(db, 3) if db is not None else '—'} | {r['jarvis_cpu_pct_mean']} | {r['jarvis_rss_mb_max']} | "
                     f"{r['jarvis_idle_wakeups_per_s']} | {', '.join(r['thermal']) or '—'} | {'YES' if r['sleep_assertions'] else 'no'} |")
    lines += ["", "## Estimated battery-life effect (from measured Δ)", ""]
    for r in results:
        d = r.get("delta_battery_w")
        if d is None:
            d = (r.get("delta_soc_mw") or 0) / 1000 if r.get("delta_soc_mw") is not None else None
            src = "SoC Δ (excludes display/SSD effects)"
        else:
            src = "battery Δ"
        if d is not None and r["scenario"] != "baseline":
            lines.append(f"- {r['scenario']}: {d:+.3f} W → over 10 h ≈ {d * 10:+.2f} Wh ≈ {100 * d * 10 / CAPACITY_WH_NEW:+.1f}% of a new battery ({src}).")
    txt = "\n".join(lines) + "\n"
    with open(path + ".md", "w") as f:
        f.write(txt)
    with open(path + ".json", "w") as f:
        json.dump(results, f, indent=2)
    return txt


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--minutes", type=float, default=3)
    ap.add_argument("--only", default=None, help="comma-separated scenario names")
    ap.add_argument("--out", default=f"power-{time.strftime('%Y%m%d-%H%M')}")
    ap.add_argument("--yes", action="store_true", help="don't pause for setup prompts")
    a = ap.parse_args()
    if os.geteuid() != 0:
        print("Note: not running as root, so powermetrics (SoC power) will be unavailable. Battery-gauge numbers still work.")
    only = set(a.only.split(",")) if a.only else None
    results = []
    for name, instructions, kind in SCENARIOS:
        if only and name not in only:
            continue
        print(f"\n=== {name} ===\n{instructions}")
        if not a.yes:
            input("Press Return when ready (the Mac should be on battery, display brightness fixed)… ")
        print("  settling 30 s…")
        time.sleep(30)
        r = run_scenario(name, int(a.minutes * 60), kind)
        print(json.dumps({k: v for k, v in r.items() if k != "sleep_assertions"}, indent=1))
        results.append(r)
    print(report(results, a.out))
    print(f"Saved {a.out}.md / .json")


if __name__ == "__main__":
    main()
