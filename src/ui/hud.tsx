/** HUD-style timer screen components: glass panels, live 3D cube, time ruler, insights. */
import { useEffect, useMemo, useRef, useState } from "react";
import { liveSessions, useStore } from "../data/store";
import type { SessionStats } from "../data/derived";
import { fmtAvg, fmtSingle, fmtSolve } from "../core/time";
import type { Solve } from "../core/types";
import { getEvent } from "../core/events";
import { pbThreshold, percentileRank, practiceStreak, isToday } from "../core/insights";
import { summarize } from "../core/stats";
import { NAV } from "./blocks";
import { IconPause, IconPlay, IconRefresh } from "./icons";
import { SessionPicker } from "./Sidebar";
import { ScrambleImage } from "./ScrambleImage";

const TWISTY_ID: Record<string, string> = { minx: "megaminx", pyram: "pyraminx", skewb: "skewb", sq1: "square1", clock: "clock", fto: "fto" };

export function twistyPuzzleFor(eventId: string): string | null {
  const ev = getEvent(eventId);
  if (ev.puzzle === "cube" || ev.puzzle === "none") {
    const n = ev.size ?? (/^222/.test(eventId) ? 2 : /^444/.test(eventId) ? 4 : /^555/.test(eventId) ? 5 : 3);
    return `${n}x${n}x${n}`;
  }
  return TWISTY_ID[ev.puzzle] ?? null;
}

/**
 * Live 3D model of the scrambled puzzle (cubing.js). In "guide" mode the scramble is
 * animated move by move from solved, reporting the current move index.
 */
export function Cube3D({ eventId, scramble, size, onMove, guideKey }: { eventId: string; scramble: string; size: number; onMove?: (i: number) => void; guideKey?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<any>(null);
  const puzzle = twistyPuzzleFor(eventId);
  useEffect(() => {
    let alive = true;
    if (!puzzle) return;
    import("cubing/twisty").then(({ TwistyPlayer }) => {
      if (!alive || !host.current) return;
      const p = new TwistyPlayer({
        puzzle: puzzle as any,
        experimentalSetupAlg: scramble,
        alg: "",
        background: "none",
        controlPanel: "none",
        hintFacelets: "none",
        backView: "none",
        cameraLatitude: 30,
        cameraLongitude: 30,
      } as any);
      p.style.width = size + "px";
      p.style.height = size + "px";
      host.current.innerHTML = "";
      host.current.appendChild(p);
      player.current = p;
      try {
        p.experimentalModel.currentMoveInfo.addFreshListener((info: any) => onMove?.(info.patternIndex));
      } catch {
        /* older cubing.js */
      }
    });
    return () => {
      alive = false;
      player.current?.remove();
      player.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puzzle, size]);
  // update scramble without recreating the WebGL context
  useEffect(() => {
    const p = player.current;
    if (!p) return;
    p.experimentalSetupAlg = scramble;
    p.alg = "";
  }, [scramble]);
  // guide playback: animate from solved through the scramble
  useEffect(() => {
    const p = player.current;
    if (!p || !guideKey) return;
    p.experimentalSetupAlg = "";
    p.alg = scramble;
    p.tempoScale = 1.6;
    p.jumpToStart?.();
    setTimeout(() => p.play?.(), 120);
  }, [guideKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!puzzle) return null;
  return <div ref={host} className="cube3d" style={{ width: size, height: size }} />;
}

/** Precision scale placing the latest solve against PB and current averages. */
export function TimeRuler({ value, marks, width = 680 }: { value: number | null; marks: { label: string; v: number }[]; width?: number }) {
  const finite = marks.filter((m) => Number.isFinite(m.v));
  if (!finite.length) return null;
  const all = [...finite.map((m) => m.v), ...(value != null && Number.isFinite(value) ? [value] : [])].map((v) => v / 1000);
  let lo = Math.floor(Math.min(...all) - 0.5);
  let hi = Math.ceil(Math.max(...all) + 0.5);
  if (hi - lo < 4) hi = lo + 4;
  const step = hi - lo > 30 ? 5 : hi - lo > 14 ? 1 : 0.25;
  const major = hi - lo > 30 ? 10 : hi - lo > 14 ? 5 : 1;
  const pad = 22;
  const X = (s: number) => pad + ((s - lo) / (hi - lo)) * (width - 2 * pad);
  const ticks = [];
  for (let t = lo; t <= hi + 1e-9; t += step) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-9;
    ticks.push(<line key={"t" + t} x1={X(t)} x2={X(t)} y1={isMajor ? 40 : 46} y2={54} className={isMajor ? "rt-major" : "rt-minor"} />);
    if (isMajor)
      ticks.push(
        <text key={"l" + t} x={X(t)} y={70} className="rt-num" textAnchor="middle">
          {t}
        </text>,
      );
  }
  const sorted = [...finite].sort((a, b) => a.v - b.v);
  let lastX = -1e9,
    lvl = 0;
  const mk = sorted.map((m) => {
    const x = X(m.v / 1000);
    lvl = x - lastX < 92 ? (lvl + 1) % 3 : 0;
    lastX = x;
    const y = 26 - lvl * 12;
    return (
      <g key={m.label}>
        <line x1={x} x2={x} y1={y + 3} y2={54} className="rt-mark" />
        <text x={x + 4} y={y} className="rt-label">
          {m.label} {fmtAvg(m.v)}
        </text>
      </g>
    );
  });
  const cx = value != null && Number.isFinite(value) ? X(value / 1000) : null;
  return (
    <svg className="ruler" width={width} height={78} data-testid="time-ruler">
      <line x1={pad} x2={width - pad} y1={54} y2={54} className="rt-base" />
      {ticks}
      {mk}
      {cx != null && (
        <g>
          <line x1={cx} x2={cx} y1={30} y2={58} className="rt-cur-glow" />
          <line x1={cx} x2={cx} y1={30} y2={58} className="rt-cur" />
        </g>
      )}
    </svg>
  );
}

export function HudTopBar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.currentSessionId);
  const solves = useStore((s) => s.solves);
  const saving = useStore((s) => s.saving);
  const ses = sessions.find((s) => s.id === current);
  const total = useMemo(() => solves.reduce((n, s) => n + (s.deletedAt ? 0 : 1), 0), [solves]);
  void liveSessions;
  return (
    <header className="hud-top fade-when-timing" data-tauri-drag-region>
      <div className="crumb">
        <SessionPicker showEvent={false} />
        <span className="sep">/</span>
        <span>{getEvent(ses?.event ?? "333").short}</span>
      </div>
      <nav className="pill glass-edge" data-testid="nav">
        {NAV.map((n) => (
          <button key={n.v} className={view === n.v ? "on" : ""} onClick={() => setView(n.v)} title={`${n.title}   ${n.key}`} data-testid={"nav-" + n.v}>
            {n.title.replace(" & data", "")}
          </button>
        ))}
      </nav>
      <div className="status mono">
        <span className={"dot" + (saving ? " busy" : "")} title={saving ? "Saving…" : "All solves saved locally"} />
        {total.toLocaleString()} SOLVES
      </div>
    </header>
  );
}

export function useInsights(solves: Solve[], stats: SessionStats, d: number, trimPct: number) {
  const allSolves = useStore((s) => s.solves);
  return useMemo(() => {
    const vals = stats.values;
    const thr = (label: string) => {
      const row = stats.rows.find((r) => r.label === label);
      if (!row) return null;
      return { label, r: pbThreshold(vals, row.spec, row.best, trimPct, d >= 3 ? 1 : 10) };
    };
    const ao12 = stats.rolling.get("ao12")?.avg;
    const curAo12 = ao12 && solves.length ? ao12[solves.length - 1] : NaN;
    const pct = ao12 && Number.isFinite(curAo12) ? percentileRank(ao12, curAo12) : NaN;
    const todayVals: number[] = [];
    solves.forEach((s, i) => isToday(s.date) && todayVals.push(vals[i]));
    const today = summarize(todayVals);
    const streak = practiceStreak(allSolves.filter((s) => !s.deletedAt).map((s) => s.date));
    return { thresholds: ["mo3", "ao5", "ao12", "ao100"].map(thr).filter(Boolean) as { label: string; r: ReturnType<typeof pbThreshold> }[], pct, today, streak };
  }, [solves, stats, d, trimPct, allSolves]);
}

export function LeftPanel({ eventId, scramble, solves, stats }: { eventId: string; scramble: string; solves: Solve[]; stats: SessionStats }) {
  const settings = useStore((s) => s.settings);
  const d = settings.decimals;
  const [guide, setGuide] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [moveIdx, setMoveIdx] = useState(-1);
  const ins = useInsights(solves, stats, d, settings.trimPct);
  const nMoves = scramble.split(/\s+/).filter(Boolean).length;
  useEffect(() => {
    setPlaying(false);
    setMoveIdx(-1);
  }, [scramble]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("facelet:guide", { detail: playing ? moveIdx : -1 }));
    if (playing && moveIdx >= nMoves) setTimeout(() => setPlaying(false), 600);
  }, [moveIdx, playing, nMoves]);
  const twisty = twistyPuzzleFor(eventId);
  return (
    <aside className="hud-panel hud-left fade-when-timing glass-edge" data-testid="left-panel">
      <div className="cap row-between">
        <span>Scramble state</span>
        {twisty && (
          <span className="mini-actions">
            <button
              title={playing ? "Stop guide" : "Animate the scramble move by move"}
              onClick={() => {
                if (playing) {
                  setPlaying(false);
                  setGuide(0);
                  window.dispatchEvent(new CustomEvent("facelet:guide", { detail: -1 }));
                } else {
                  setPlaying(true);
                  setGuide((g) => g + 1);
                }
              }}
              data-testid="guide-play"
            >
              {playing ? <IconPause size={13} /> : <IconPlay size={13} />}
            </button>
            {playing && (
              <button title="Restart" onClick={() => setGuide((g) => g + 1)}>
                <IconRefresh size={13} />
              </button>
            )}
          </span>
        )}
      </div>
      <div className="cube-stage">
        {settings.showCube3d && scramble ? (
          <Cube3D eventId={eventId} scramble={scramble} size={232} guideKey={playing ? guide : 0} onMove={(i) => setMoveIdx(i)} />
        ) : (
          <ScrambleImage eventId={eventId} scramble={scramble} colors={settings.cubeColors} width={230} />
        )}
      </div>
      {settings.showCube3d && settings.showScrambleImage && scramble && (
        <div className="net-wrap">
          <ScrambleImage eventId={eventId} scramble={scramble} colors={settings.cubeColors} width={172} />
        </div>
      )}
      <div className="tiles">
        <div className="tile">
          <span className="cap">Today</span>
          <b className="num">{ins.today.count}</b>
          <span className="sub num">{Number.isFinite(ins.today.mean) ? "mean " + fmtAvg(ins.today.mean, d) : "no solves yet"}</span>
        </div>
        <div className="tile">
          <span className="cap">Streak</span>
          <b className="num">{ins.streak}</b>
          <span className="sub">{ins.streak === 1 ? "day" : "days"}</span>
        </div>
        <div className="tile wide">
          <span className="cap">Form · ao12 percentile</span>
          <b className="num">{Number.isFinite(ins.pct) ? `top ${Math.max(1, Math.round((1 - ins.pct) * 100))}%` : "–"}</b>
          <span className="sub">of all your ao12s in this session</span>
        </div>
        <div className="tile wide" data-testid="pb-targets">
          <span className="cap">PB targets · next solve</span>
          {ins.thresholds.map(({ label, r }) => (
            <div key={label} className="target num">
              <span>{label}</span>
              <span className={r.kind === "none" ? "dim" : "acc"}>{r.kind === "any" ? "any time" : r.kind === "none" ? "out of reach" : "< " + fmtSingle(r.ms, d)}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

export function RightPanel({ solves, stats, onDetail }: { solves: Solve[]; stats: SessionStats; onDetail: (d: { label: string; end: number }) => void }) {
  const settings = useStore((s) => s.settings);
  const openSolve = useStore((s) => s.openSolve);
  const d = settings.decimals;
  const n = solves.length;
  const sum = stats.summary;
  const rows = settings.statsRows.map((l) => stats.rows.find((r) => r.label === l)).filter((r): r is NonNullable<typeof r> => !!r);
  return (
    <aside className="hud-panel hud-right fade-when-timing glass-edge" data-testid="sidebar">
      <div className="cap row-between">
        <span>Averages</span>
        <span>cur · best</span>
      </div>
      <div className="avg-table" data-testid="stats-table">
        <div className="ar">
          <span className="l">SINGLE</span>
          <button className="c num" onClick={() => n && openSolve(solves[n - 1].id)}>{n ? fmtSolve(solves[n - 1], d) : "–"}</button>
          <button className="b num" onClick={() => sum.bestIdx >= 0 && openSolve(solves[sum.bestIdx].id)}>{sum.bestIdx >= 0 ? fmtSingle(sum.best, d) : "–"}</button>
        </div>
        {rows.map((r) => {
          const curOk = !Number.isNaN(r.current);
          const isPb = curOk && r.bestEnd === n - 1 && n > r.spec.n;
          return (
            <div className={"ar" + (isPb ? " pb" : "")} key={r.label}>
              <span className="l">{r.label.toUpperCase()}</span>
              <button className={"c num" + (curOk ? "" : " na")} onClick={() => curOk && onDetail({ label: r.label, end: n - 1 })} data-testid={"cur-" + r.label}>
                {curOk ? fmtAvg(r.current, d) : "–"}
              </button>
              <button className={"b num" + (r.bestEnd >= 0 ? "" : " na")} onClick={() => r.bestEnd >= 0 && onDetail({ label: r.label, end: r.bestEnd })} data-testid={"best-" + r.label}>
                {r.bestEnd >= 0 ? fmtAvg(r.best, d) : "–"}
              </button>
            </div>
          );
        })}
      </div>
      <div className="cap row-between" style={{ marginTop: 14 }}>
        <span>Trend · 200</span>
        <span className="num" data-testid="summary" style={{ letterSpacing: "0.06em" }}>
          {sum.solved.toLocaleString()}/{sum.count.toLocaleString()} · μ {fmtAvg(sum.mean, d)}
        </span>
      </div>
      <TrendChart solves={solves} stats={stats} />
    </aside>
  );
}

function TrendChart({ solves, stats, n = 200 }: { solves: Solve[]; stats: SessionStats; n?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 280, h: 150 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { w, h } = box;
  const start = Math.max(0, solves.length - n);
  const vals = Array.from(stats.values.slice(start));
  const ao = stats.rolling.get("ao12")?.avg;
  const fin = vals.filter(Number.isFinite).sort((a, b) => a - b);
  if (fin.length < 3) return <div ref={ref} className="trend" />;
  const lo = fin[Math.floor(fin.length * 0.02)],
    hi = fin[Math.floor(fin.length * 0.96)];
  const pad = 6;
  const span = Math.max(2, Math.min(n, solves.length - start));
  const X = (i: number) => pad + (i / Math.max(1, span - 1)) * (w - 2 * pad);
  const Y = (v: number) => pad + (1 - (Math.max(lo, Math.min(v, hi)) - lo) / Math.max(1, hi - lo)) * (h - 2 * pad);
  let path = "";
  if (ao)
    for (let i = start; i < solves.length; i++) {
      const v = ao[i];
      if (!Number.isFinite(v)) continue;
      path += `${path ? "L" : "M"}${X(i - start).toFixed(1)},${Y(v).toFixed(1)}`;
    }
  return (
    <div ref={ref} className="trend">
      <svg width={w} height={h}>
        <defs>
          <filter id="tglow">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
        </defs>
        {vals.map((v, i) => (Number.isFinite(v) ? <circle key={i} cx={X(i)} cy={Y(v)} r={1.6} className="tdot" /> : <circle key={i} cx={X(i)} cy={pad} r={1.6} className="tdnf" />))}
        <path d={path} className="tline-glow" filter="url(#tglow)" />
        <path d={path} className="tline" />
      </svg>
    </div>
  );
}

export function RecentStrip({ solves }: { solves: Solve[] }) {
  const d = useStore((s) => s.settings.decimals);
  const openSolve = useStore((s) => s.openSolve);
  const items = solves.slice(-12).reverse();
  return (
    <div className="recent-strip fade-when-timing glass-edge" data-testid="recent">
      <span className="cap">Recent</span>
      <div className="rs-items">
        {items.map((s, i) => (
          <button key={s.id} className="rsi num" onClick={() => openSolve(s.id)} data-testid="solve-row" style={{ opacity: 1 - i * 0.055 }}>
            {fmtSolve(s, d)}
          </button>
        ))}
        {!items.length && <span className="dim">No solves yet — hold space to start</span>}
      </div>
    </div>
  );
}
