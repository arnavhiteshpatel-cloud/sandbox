import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { sessionSolves, useStore } from "../data/store";
import { neededLabels, sessionStats } from "../data/derived";
import { EVENTS, EVENT_GROUPS, getEvent } from "../core/events";
import { fmtAvg, fmtSingle, parseTypedEntry } from "../core/time";
import { useScramble } from "../scramble/useScramble";
import { TimerEngine, type Phase } from "../timer/engine";
import { inspectionWarning } from "../timer/feedback";
import { Menu, useMenu, layersOpen } from "../ui/Overlay";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconComment, IconTrash } from "../ui/icons";
import { AvgDetail } from "../ui/AvgDetail";
import { LeftPanel, RecentStrip, RightPanel } from "../ui/hud";

/** Single shared engine so global shortcuts can see whether a solve is in progress. */
export const engine = new TimerEngine({ holdMs: 300, inspection: true, inspectionMs: 15000, phases: 1, startKey: "space" });

function isEditable(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function usePhase(): Phase {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.phase,
  );
}

function fmtRunning(ms: number, mode: string, decimals: number) {
  if (mode === "hidden") return "solving";
  if (mode === "seconds") return String(Math.floor(ms / 1000));
  if (mode === "tenths") return fmtSingle(Math.floor(ms / 100) * 100, 2).slice(0, -1);
  return fmtSingle(ms, decimals);
}

function EventPicker() {
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.currentSessionId);
  const updateSession = useStore((s) => s.updateSession);
  const ses = sessions.find((s) => s.id === current);
  const menu = useMenu();
  const ev = getEvent(ses?.event ?? "333");
  return (
    <>
      <button className="event-btn" onClick={menu.open} data-testid="event-picker">
        <span className="cap">{ev.group === "WCA" ? "WCA" : ev.group}</span>
        <span>{ev.name}</span>
        <IconChevronDown size={12} />
      </button>
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          minWidth={270}
          items={EVENT_GROUPS.flatMap((g) => [
            { group: g },
            ...EVENTS.filter((e) => e.group === g).map((e) => ({
              label: e.name,
              meta: e.short,
              selected: e.id === ev.id,
              testId: "event-" + e.id,
              onSelect: () => ses && updateSession(ses.id, { event: e.id }, "Change scramble type"),
            })),
          ])}
        />
      )}
    </>
  );
}

/** Scramble text with per-move spans so the 3D guide can highlight the current move. */
function ScrambleText({ scramble, error, loading }: { scramble: string; error: string | null; loading: boolean }) {
  const [guideIdx, setGuideIdx] = useState(-1);
  useEffect(() => {
    const h = (e: Event) => setGuideIdx((e as CustomEvent).detail as number);
    window.addEventListener("facelet:guide", h);
    return () => window.removeEventListener("facelet:guide", h);
  }, []);
  useEffect(() => setGuideIdx(-1), [scramble]);
  const settings = useStore((s) => s.settings);
  const scr = useScramble();
  const box = useRef<HTMLDivElement>(null);
  const long = scramble.length > 120; // 5x5+ / megaminx cannot sensibly fit on one line
  // Fit the scramble on one line: start large and scale down to the available width.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || long) return;
    const fit = () => {
      const max = Math.min(window.innerHeight * 0.075, window.innerWidth * 0.042) * settings.scrambleScale;
      el.style.fontSize = max + "px";
      const avail = el.clientWidth;
      const need = el.scrollWidth;
      if (need > avail) el.style.fontSize = Math.max(12, Math.floor(max * (avail / need) * 0.98)) + "px";
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement ?? el);
    return () => ro.disconnect();
  }, [scramble, long, settings.scrambleScale, settings.scrambleFont]);
  if (!scramble) return <div className="scramble loading">{error ? <span className="bad">{error}</span> : loading ? "generating scramble…" : ""}</div>;
  let k = 0;
  return (
    <>
      <div
        ref={box}
        className={"scramble" + (settings.scrambleFont === "mono" ? " mono-scr" : "") + (long ? " long" : " one-line")}
        style={{ ["--scr-scale" as any]: settings.scrambleScale }}
        data-testid="scramble"
        onDoubleClick={() => {
          const s = window.prompt("Enter a custom scramble for the next solve", scramble);
          if (s != null && s.trim()) scr.setManual(s.trim());
        }}
      >
        {scramble.split("\n").map((line, li) => (
          <div key={li}>
            {line
              .split(/\s+/)
              .filter(Boolean)
              .map((m) => {
                const i = k++;
                const cls = guideIdx < 0 ? "" : i < guideIdx ? " done" : i === guideIdx ? " now" : " todo";
                return (
                  <span key={i} className={"mv" + cls}>
                    {m}{" "}
                  </span>
                );
              })}
          </div>
        ))}
      </div>
    </>
  );
}

export function TimerView() {
  const settings = useStore((s) => s.settings);
  const allSolves = useStore((s) => s.solves);
  const sessions = useStore((s) => s.sessions);
  const currentId = useStore((s) => s.currentSessionId);
  const addSolve = useStore((s) => s.addSolve);
  const updateSolves = useStore((s) => s.updateSolves);
  const deleteSolves = useStore((s) => s.deleteSolves);
  const setTiming = useStore((s) => s.setTiming);
  const openSolve = useStore((s) => s.openSolve);
  const session = sessions.find((s) => s.id === currentId);
  const eventId = session?.event ?? "333";
  const solves = sessionSolves(allSolves, currentId);
  const labels = neededLabels(settings.statsRows, settings.listColumns, ["ao5", "ao12", "ao100"]);
  const stats = sessionStats(solves, labels, settings.decimals, settings.trimPct);
  const scr = useScramble();
  const scramble = scr.seen[scr.pos] ?? "";
  const phase = usePhase();
  const display = useRef<HTMLSpanElement>(null);
  const [detail, setDetail] = useState<{ label: string; end: number } | null>(null);
  const [justSolved, setJustSolved] = useState(false);
  const last = solves[solves.length - 1];
  const d = settings.decimals;

  useEffect(() => {
    engine.opts = {
      holdMs: settings.holdMs,
      inspection: settings.inspection && getEvent(eventId).inspection !== false,
      inspectionMs: settings.inspectionSeconds * 1000,
      phases: Math.max(1, session?.phases ?? 1),
      startKey: settings.startKey,
    };
  }, [settings.holdMs, settings.inspection, settings.inspectionSeconds, settings.startKey, session?.phases, eventId]);

  useEffect(() => {
    scr.setEvent(eventId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const bestRef = useRef(Infinity);
  bestRef.current = stats.summary.best;
  const scrambleRef = useRef(scramble);
  scrambleRef.current = scramble;
  useEffect(() => {
    engine.onSolve = (r) => {
      const st = useStore.getState();
      const scr = scrambleRef.current;
      const save = () => {
        st.addSolve({ time: r.time, penalty: r.penalty, splits: r.splits, scramble: scr });
        setJustSolved(true);
        useScramble.getState().next();
      };
      // Accidental stop filter: a "solve" far faster than your best single is almost certainly a mis-stop.
      if (st.settings.shortFilter === "auto" && r.penalty >= 0) {
        const best = bestRef.current;
        const limit = Number.isFinite(best) ? Math.max(1000, best * st.settings.shortRatio) : 1000;
        if (r.time < limit) {
          st.toast(`Ignored ${fmtSingle(r.time, st.settings.decimals)} — under ${fmtSingle(limit, 2)}, likely an accidental stop. Same scramble kept.`, "info", { label: "Keep it", run: save });
          return;
        }
      }
      save();
    };
    engine.onInspectionWarning = (sec) => {
      const st = useStore.getState().settings;
      inspectionWarning(sec, st.inspectionVoice, st.inspectionBeep);
    };
    return () => {
      engine.onSolve = null;
    };
  }, [addSolve]);

  // PB celebrations — only for the solve just completed
  const pbFor = useRef<string | null>(null);
  useEffect(() => {
    if (!justSolved || !last || pbFor.current === last.id) return;
    pbFor.current = last.id;
    const n = solves.length;
    const hits: { label: string; value: string; gain: string | null }[] = [];
    if (n > 1 && stats.pbSingle[n - 1]) {
      let prev = Infinity;
      for (let i = 0; i < n - 1; i++) prev = Math.min(prev, stats.values[i]);
      hits.push({ label: "single", value: fmtSingle(stats.values[n - 1], d), gain: Number.isFinite(prev) ? "−" + fmtSingle(prev - stats.values[n - 1], d) : null });
    }
    for (const r of stats.rows) {
      if (!["mo3", "ao5", "ao12", "ao50", "ao100", "ao1000"].includes(r.label)) continue;
      if (r.bestEnd !== n - 1 || n <= r.spec.n || !Number.isFinite(r.best)) continue;
      const roll = stats.rolling.get(r.label)!.avg;
      let prev = Infinity;
      for (let i = 0; i < n - 1; i++) if (roll[i] < prev) prev = roll[i];
      hits.push({ label: r.label, value: fmtAvg(r.best, d), gain: Number.isFinite(prev) ? "−" + fmtAvg(prev - r.best, d) : null });
    }
    if (hits.length) window.dispatchEvent(new CustomEvent("facelet:pb", { detail: hits }));
  }, [justSolved, last?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!justSolved) return;
    const t = setTimeout(() => setJustSolved(false), 3500);
    return () => clearTimeout(t);
  }, [justSolved, last?.id]);

  useEffect(() => {
    if (settings.inputMode === "typing") return;
    const down = (e: KeyboardEvent) => {
      if (layersOpen() || isEditable(e.target)) return;
      if (engine.phase === "idle" && (e.metaKey || e.ctrlKey || e.altKey)) return;
      if (engine.phase === "idle" && e.code !== "Space" && settings.startKey === "space") return;
      if (engine.keyDown({ code: e.code, key: e.key, timeStamp: e.timeStamp, repeat: e.repeat })) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (layersOpen() && engine.phase === "idle") return;
      if (engine.keyUp({ code: e.code, key: e.key, timeStamp: e.timeStamp })) e.preventDefault();
    };
    const blur = () => engine.blur();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      engine.cancel();
    };
  }, [settings.inputMode, settings.startKey]);

  useEffect(() => {
    setTiming(settings.hideUiWhileTiming && phase !== "idle" && phase !== "done");
  }, [phase, settings.hideUiWhileTiming, setTiming]);
  useEffect(() => () => setTiming(false), [setTiming]);

  // running/inspection display via rAF (no React re-render per frame)
  useLayoutEffect(() => {
    let raf = 0;
    const el = display.current;
    if (!el) return;
    const tick = () => {
      const now = performance.now();
      if (engine.phase === "run") {
        if (settings.runningDisplay !== "hidden") el.textContent = fmtRunning(engine.elapsed(now), settings.runningDisplay, d);
      } else if (engine.phase === "inspect" || engine.inspectingHold()) {
        const e = engine.elapsed(now) / 1000;
        const left = settings.inspectionSeconds - Math.floor(e);
        el.textContent = left > 0 ? String(left) : left > -2 ? "+2" : "DNF";
        const p = el.parentElement!;
        p.classList.toggle("warn8", e >= 8 && e < 12);
        p.classList.toggle("warn12", e >= 12);
      }
      raf = requestAnimationFrame(tick);
    };
    if (phase === "inspect" || engine.inspectingHold() || (phase === "run" && settings.runningDisplay !== "hidden")) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, settings.runningDisplay, settings.inspectionSeconds, d]);

  let intPart = "0";
  let decPart = d === 3 ? ".000" : ".00";
  let pen: string | null = null;
  if (last) {
    let txt: string;
    if (last.penalty < 0) {
      txt = "DNF";
      pen = `(${fmtSingle(last.time, d)})`;
    } else txt = fmtSingle(last.time + last.penalty, d) + (last.penalty > 0 ? "+" : "");
    const i = txt.lastIndexOf(".");
    intPart = i >= 0 ? txt.slice(0, i) : txt;
    decPart = i >= 0 ? txt.slice(i) : "";
  }
  const inInspection = phase === "inspect" || phase === "preinspect" || engine.inspectingHold();
  const isRunning = phase === "run" || inInspection;
  const timerCls = [
    "timer num",
    phase === "hold" ? "hold" : "",
    phase === "ready" ? "ready" : "",
    inInspection ? "inspect" : "",
    phase === "run" && settings.runningDisplay === "hidden" ? "concealed" : "",
  ].join(" ");

  const typed = useRef<HTMLInputElement>(null);
  const submitTyped = useCallback(() => {
    const p = parseTypedEntry(typed.current?.value ?? "");
    if (!p) return;
    addSolve({ time: p.time, penalty: p.penalty, scramble });
    typed.current!.value = "";
    useScramble.getState().next();
  }, [addSolve, scramble]);

  return (
    <div className="hud-body">
      <LeftPanel eventId={eventId} scramble={scramble} solves={solves} stats={stats} />
      <section className="hud-center">
        <div className="scr-head fade-when-timing">
          <EventPicker />
          <div className="scr-nav">
            <button onClick={() => scr.prev()} disabled={scr.pos <= 0} title="Previous scramble  ←" data-testid="scr-prev">
              <IconChevronLeft size={14} />
            </button>
            <span className="cap">scramble {Math.max(1, scr.pos + 1)}</span>
            <button onClick={() => scr.next()} title="Next scramble  →" data-testid="scr-next">
              <IconChevronRight size={14} />
            </button>
          </div>
        </div>
        <div className="fade-when-timing scr-wrap">
          <ScrambleText scramble={scramble} error={scr.error} loading={scr.loading} />
        </div>
        <div className="stage">
          {settings.inputMode === "typing" ? (
            <input ref={typed} className="typing-input num" placeholder={d === 3 ? "0.000" : "0.00"} data-testid="typing-input" onKeyDown={(e) => e.key === "Enter" && submitTyped()} autoFocus />
          ) : (
            <div className={timerCls} data-testid="timer" data-phase={phase} style={{ ["--timer-scale" as any]: settings.timerScale }}>
              {isRunning ? (
                <span ref={display}>{phase === "run" ? fmtRunning(0, settings.runningDisplay, d) : String(settings.inspectionSeconds)}</span>
              ) : (
                <span ref={display}>
                  {intPart}
                  <span className={"dec" + (settings.smallDecimals ? " small" : "")}>{decPart}</span>
                </span>
              )}
              {!isRunning && pen && <span className="pen num">{pen}</span>}
            </div>
          )}
          {engine.phase === "run" && (session?.phases ?? 1) > 1 && (
            <div className="dim num" style={{ marginTop: 18, fontSize: 18 }}>
              phase {engine.splits.length + 1} / {session?.phases}
            </div>
          )}
          {last && phase === "idle" && (
            <div className={"postsolve fade-when-timing" + (justSolved ? " show" : "")} data-testid="postsolve">
              <button className={"chip" + (last.penalty === 0 ? " on" : "")} onClick={() => updateSolves([last.id], () => ({ penalty: 0 }), "Set OK")}>OK</button>
              <button className={"chip" + (last.penalty > 0 ? " on" : "")} onClick={() => updateSolves([last.id], () => ({ penalty: 2000 }), "Set +2")} data-testid="pen-plus2">+2</button>
              <button className={"chip" + (last.penalty < 0 ? " on" : "")} onClick={() => updateSolves([last.id], () => ({ penalty: -1 }), "Set DNF")} data-testid="pen-dnf">DNF</button>
              <button className="chip" onClick={() => openSolve(last.id)} title="Comment / details  ⌘E"><IconComment size={14} /></button>
              <button className="chip" onClick={() => deleteSolves([last.id])} title="Delete  ⌥Z"><IconTrash size={14} /></button>
            </div>
          )}
          <div className="hint fade-when-timing">{phase === "idle" && settings.inputMode === "timer" ? (settings.inspection ? "space · inspect" : "hold space") : ""}</div>
        </div>
        <RecentStrip solves={solves} />
      </section>
      <RightPanel solves={solves} stats={stats} onDetail={setDetail} />
      {detail && <AvgDetail solves={solves} label={detail.label} end={detail.end} onClose={() => setDetail(null)} />}
    </div>
  );
}
