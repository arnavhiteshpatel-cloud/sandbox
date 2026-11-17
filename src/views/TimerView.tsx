import type { JSX } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { sessionSolves, useStore } from "../data/store";
import { neededLabels, sessionStats } from "../data/derived";
import { EVENTS, EVENT_GROUPS, getEvent } from "../core/events";
import { fmtAvg, fmtSingle, parseTypedEntry, solveValue } from "../core/time";
import { useScramble } from "../scramble/useScramble";
import { TimerEngine, type Phase } from "../timer/engine";
import { inspectionWarning } from "../timer/feedback";
import { Menu, useMenu, layersOpen } from "../ui/Overlay";
import { ScrambleImage } from "../ui/ScrambleImage";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconComment, IconTrash } from "../ui/icons";
import { AvgDetail } from "../ui/AvgDetail";
import { NavIcons } from "../ui/blocks";
import { SessionPicker, StageFooter } from "../ui/Sidebar";

/** Single shared engine so global shortcuts can see whether a solve is in progress. */
export const engine = new TimerEngine({ holdMs: 300, inspection: false, inspectionMs: 15000, phases: 1, startKey: "space" });

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
  if (mode === "tenths") {
    const s = fmtSingle(Math.floor(ms / 100) * 100, 2);
    return s.slice(0, -1);
  }
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
      <span className="dim" style={{ fontSize: 13 }}>{ev.group === "WCA" ? "WCA" : ev.group}</span>
      <button className="pick" onClick={menu.open} data-testid="event-picker">
        {ev.name} <IconChevronDown size={12} />
      </button>
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          minWidth={260}
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

export function TimerView({ layout = "rail" }: { layout?: "rail" | "stage" }) {
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
  const labels = neededLabels(settings.statsRows, settings.listColumns, settings.showRolling);
  const stats = sessionStats(solves, labels, settings.decimals, settings.trimPct);
  const scr = useScramble();
  const scramble = scr.seen[scr.pos] ?? "";
  const phase = usePhase();
  const display = useRef<HTMLSpanElement>(null);
  const [bigImage, setBigImage] = useState(false);
  const [detail, setDetail] = useState<{ label: string; end: number } | null>(null);
  const [justSolved, setJustSolved] = useState(false);
  const last = solves[solves.length - 1];
  const prev = solves[solves.length - 2];
  const d = settings.decimals;

  // keep engine options in sync with settings/session
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

  // solve completion → persist immediately, advance scramble
  const scrambleRef = useRef(scramble);
  scrambleRef.current = scramble;
  useEffect(() => {
    engine.onSolve = (r) => {
      addSolve({ time: r.time, penalty: r.penalty, splits: r.splits, scramble: scrambleRef.current });
      setJustSolved(true);
      useScramble.getState().next();
    };
    engine.onInspectionWarning = (sec) => {
      const st = useStore.getState().settings;
      inspectionWarning(sec, st.inspectionVoice, st.inspectionBeep);
    };
    return () => {
      engine.onSolve = null;
    };
  }, [addSolve]);

  useEffect(() => {
    if (!justSolved) return;
    const t = setTimeout(() => setJustSolved(false), 3500);
    return () => clearTimeout(t);
  }, [justSolved, last?.id]);

  // keyboard → engine
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

  // UI chrome hides while timing
  useEffect(() => {
    setTiming(settings.hideUiWhileTiming && phase !== "idle" && phase !== "done");
  }, [phase, settings.hideUiWhileTiming, setTiming]);
  useEffect(() => () => setTiming(false), [setTiming]);

  // running display via rAF (no React re-render per frame)
  useLayoutEffect(() => {
    let raf = 0;
    const el = display.current;
    if (!el) return;
    const tick = () => {
      const now = performance.now();
      if (engine.phase === "run") {
        el.textContent = fmtRunning(engine.elapsed(now), settings.runningDisplay, d);
      } else if (engine.phase === "inspect" || engine.inspectingHold()) {
        const left = settings.inspectionSeconds - Math.floor(engine.elapsed(now) / 1000);
        el.textContent = left > 0 ? String(left) : left > -2 ? "+2" : "DNF";
        const p = el.parentElement!;
        const e = engine.elapsed(now) / 1000;
        p.classList.toggle("warn8", e >= 8 && e < 12);
        p.classList.toggle("warn12", e >= 12);
      }
      raf = requestAnimationFrame(tick);
    };
    if (phase === "run" || phase === "inspect" || engine.inspectingHold()) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, settings.runningDisplay, settings.inspectionSeconds, d]);

  // pointer/trackpad support: press anywhere on the stage like the spacebar
  const stageDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,.scr-image,.rolling,.postsolve,.topbar,.scramble,input")) return;
    engine.keyDown({ code: "Space", timeStamp: e.timeStamp });
  };
  const stageUp = (e: React.PointerEvent) => {
    engine.keyUp({ code: "Space", timeStamp: e.timeStamp });
  };

  // static display (idle/done/hold/ready)
  let staticText = "0.00";
  let pen: string | null = null;
  if (last) {
    if (last.penalty < 0) {
      staticText = "DNF";
      pen = `(${fmtSingle(last.time, d)})`;
    } else staticText = fmtSingle(last.time + last.penalty, d);
    if (last.penalty > 0) staticText += "+";
  } else staticText = d === 3 ? "0.000" : "0.00";
  const isRunning = phase === "run" || phase === "inspect" || engine.inspectingHold();
  if (phase === "preinspect") staticText = String(settings.inspectionSeconds);

  let delta: JSX.Element | null = null;
  if (last && prev && !isRunning) {
    const a = solveValue(last, d),
      b = solveValue(prev, d);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const dd = a - b;
      delta = (
        <span className="delta num" style={{ color: dd <= 0 ? "var(--good)" : "var(--bad)" }}>
          ({dd <= 0 ? "-" : "+"}
          {fmtSingle(Math.abs(dd), d)})
        </span>
      );
    }
  }

  const timerCls = ["timer", "num", phase === "hold" ? "hold" : "", phase === "ready" ? "ready" : "", phase === "inspect" || phase === "preinspect" ? "inspect" : "", phase === "run" && settings.runningDisplay === "hidden" ? "concealed" : ""].join(" ");
  const dec = (txt: string) => {
    if (!settings.smallDecimals) return txt;
    const i = txt.lastIndexOf(".");
    if (i < 0) return txt;
    return (
      <>
        {txt.slice(0, i)}
        <span className="dec small">{txt.slice(i)}</span>
      </>
    );
  };

  const typed = useRef<HTMLInputElement>(null);
  const submitTyped = useCallback(() => {
    const v = typed.current?.value ?? "";
    const p = parseTypedEntry(v);
    if (!p) return;
    addSolve({ time: p.time, penalty: p.penalty, scramble });
    typed.current!.value = "";
    useScramble.getState().next();
  }, [addSolve, scramble]);

  const ev = getEvent(eventId);
  const longScramble = scramble.length > 90;
  const rollingRows = settings.showRolling
    .map((l) => stats.rows.find((r) => r.label === l))
    .filter((r): r is NonNullable<typeof r> => !!r);

  return (
    <div className={"main layout-" + layout} onPointerDown={settings.inputMode === "timer" ? stageDown : undefined} onPointerUp={settings.inputMode === "timer" ? stageUp : undefined}>
      <div className="topbar fade-when-timing">
        {layout === "stage" && (
          <div className="topbar-left">
            <NavIcons />
          </div>
        )}
        {layout === "stage" && <SessionPicker showEvent={false} />}
        <EventPicker />
        <div className="scr-nav">
          <button onClick={() => scr.prev()} disabled={scr.pos <= 0} title="Previous scramble  ←" data-testid="scr-prev">
            <IconChevronLeft size={15} />
          </button>
          <span>last/next scramble</span>
          <button onClick={() => scr.next()} title="Next scramble  →" data-testid="scr-next">
            <IconChevronRight size={15} />
          </button>
        </div>
      </div>
      <div
        className={"scramble fade-when-timing" + (settings.scrambleFont === "sans" ? " sans" : "") + (longScramble ? " long" : "") + (!scramble ? " loading" : "")}
        style={{ ["--scr-scale" as any]: settings.scrambleScale }}
        data-testid="scramble"
        onDoubleClick={() => {
          const s = window.prompt("Enter a custom scramble for the next solve", scramble);
          if (s != null && s.trim()) scr.setManual(s.trim());
        }}
      >
        {scramble ? scramble.split("\n").map((line, i) => <div key={i}>{line}</div>) : scr.error ? <span className="bad" style={{ fontSize: 14 }}>{scr.error}</span> : ev.puzzle === "none" ? "" : "generating scramble…"}
      </div>
      <div className="stage">
        {settings.inputMode === "typing" ? (
          <input
            ref={typed}
            className="typing-input num"
            placeholder={d === 3 ? "0.000" : "0.00"}
            data-testid="typing-input"
            onKeyDown={(e) => e.key === "Enter" && submitTyped()}
            autoFocus
          />
        ) : (
          <div className={timerCls} data-testid="timer" data-phase={phase} style={{ ["--timer-scale" as any]: settings.timerScale }}>
            <span ref={display}>{isRunning ? (phase === "run" ? fmtRunning(0, settings.runningDisplay, d) : String(settings.inspectionSeconds)) : dec(staticText)}</span>
            {!isRunning && pen && <span className="pen num">{pen}</span>}
            {!isRunning && phase !== "hold" && phase !== "ready" && delta}
          </div>
        )}
        {engine.phase === "run" && (session?.phases ?? 1) > 1 && (
          <div className="dim num" style={{ marginTop: 18, fontSize: 18 }}>
            phase {engine.splits.length + 1} / {session?.phases}
          </div>
        )}
        <div className="rolling num fade-when-timing" data-testid="rolling">
          {rollingRows.map((r) => (
            <button key={r.label} className="roll" onClick={() => !Number.isNaN(r.current) && setDetail({ label: r.label, end: solves.length - 1 })}>
              <span className="lbl">{r.label}</span>
              <span className="val">{Number.isNaN(r.current) ? "–" : fmtAvg(r.current, d)}</span>
            </button>
          ))}
        </div>
        {last && phase === "idle" && (
          <div className={"postsolve fade-when-timing" + (justSolved ? " show" : "")} data-testid="postsolve">
            <button className={"chip" + (last.penalty === 0 ? " on" : "")} onClick={() => updateSolves([last.id], () => ({ penalty: 0 }), "Set OK")}>
              OK
            </button>
            <button className={"chip" + (last.penalty > 0 ? " on" : "")} onClick={() => updateSolves([last.id], () => ({ penalty: 2000 }), "Set +2")} data-testid="pen-plus2">
              +2
            </button>
            <button className={"chip" + (last.penalty < 0 ? " on" : "")} onClick={() => updateSolves([last.id], () => ({ penalty: -1 }), "Set DNF")} data-testid="pen-dnf">
              DNF
            </button>
            <button className="chip" onClick={() => openSolve(last.id)} title="Comment / details">
              <IconComment size={14} />
            </button>
            <button className="chip" onClick={() => deleteSolves([last.id])} title="Delete  ⌘⌫">
              <IconTrash size={14} />
            </button>
          </div>
        )}
      </div>
      {settings.showScrambleImage && scramble && (
        <div className={"scr-image fade-when-timing" + (bigImage ? " big" : "")} onClick={() => setBigImage((b) => !b)} title="Click to enlarge">
          <ScrambleImage eventId={eventId} scramble={scramble} colors={settings.cubeColors} />
        </div>
      )}
      {layout === "stage" && <StageFooter />}
      <div className="hint-text fade-when-timing">
        {phase === "idle" && settings.inputMode === "timer" ? (settings.inspection ? "Space to inspect" : "Hold space") : ""}
      </div>
      {detail && <AvgDetail solves={solves} label={detail.label} end={detail.end} onClose={() => setDetail(null)} />}
    </div>
  );
}

export function useLastSolveId() {
  const allSolves = useStore((s) => s.solves);
  const current = useStore((s) => s.currentSessionId);
  return useMemo(() => sessionSolves(allSolves, current).at(-1)?.id ?? null, [allSolves, current]);
}
