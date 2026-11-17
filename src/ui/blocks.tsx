/** Reusable stat/list/nav building blocks shared by the timer layouts. */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { sessionSolves, useStore, type View } from "../data/store";
import { neededLabels, sessionStats, type SessionStats } from "../data/derived";
import { fmtAvg, fmtSingle, fmtSolve } from "../core/time";
import type { Solve } from "../core/types";
import { IconChart, IconCube, IconGrid, IconList, IconSliders, IconTimer } from "./icons";

export function useSessionData() {
  const settings = useStore((s) => s.settings);
  const allSolves = useStore((s) => s.solves);
  const current = useStore((s) => s.currentSessionId);
  const solves = sessionSolves(allSolves, current);
  const labels = neededLabels(settings.statsRows, settings.listColumns, settings.showRolling, ["ao12"]);
  const stats = sessionStats(solves, labels, settings.decimals, settings.trimPct);
  return { settings, solves, stats, d: settings.decimals };
}

export const NAV: { v: View; icon: JSX.Element; title: string; key: string }[] = [
  { v: "timer", icon: <IconTimer />, title: "Timer", key: "⌥1" },
  { v: "history", icon: <IconList />, title: "History", key: "⌥2" },
  { v: "analytics", icon: <IconChart />, title: "Analytics", key: "⌥3" },
  { v: "train", icon: <IconCube />, title: "Training", key: "⌥4" },
  { v: "sessions", icon: <IconGrid />, title: "Sessions", key: "⌥5" },
  { v: "settings", icon: <IconSliders />, title: "Settings & data", key: "⌥," },
];

export function NavIcons({ vertical }: { vertical?: boolean }) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <nav className={"nav " + (vertical ? "vertical" : "horizontal")}>
      {NAV.map((n) => (
        <button key={n.v} className={"nav-btn" + (view === n.v ? " active" : "")} title={`${n.title}   ${n.key}`} onClick={() => setView(n.v)} data-testid={"nav-" + n.v}>
          {n.icon}
        </button>
      ))}
    </nav>
  );
}

type Detail = (d: { label: string; end: number }) => void;

/** Vertical current/best table. */
export function StatsTable({ solves, stats, d, onDetail }: { solves: Solve[]; stats: SessionStats; d: number; onDetail: Detail }) {
  const settings = useStore((s) => s.settings);
  const openSolve = useStore((s) => s.openSolve);
  const rows = settings.statsRows.map((l) => stats.rows.find((r) => r.label === l)).filter((r): r is NonNullable<typeof r> => !!r);
  const sum = stats.summary;
  const n = solves.length;
  return (
    <table className="stats-table" data-testid="stats-table">
      <thead>
        <tr>
          <th />
          <th>current</th>
          <th>best</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>single</td>
          <td className={"v num" + (n ? "" : " na")} onClick={() => n && openSolve(solves[n - 1].id)}>
            {n ? fmtSolve(solves[n - 1], d) : "–"}
          </td>
          <td className={"v num best" + (sum.bestIdx >= 0 ? "" : " na")} onClick={() => sum.bestIdx >= 0 && openSolve(solves[sum.bestIdx].id)}>
            {sum.bestIdx >= 0 ? fmtSingle(sum.best, d) : "–"}
          </td>
        </tr>
        {rows.map((r) => {
          const curOk = !Number.isNaN(r.current);
          const isPb = curOk && r.bestEnd === n - 1 && n > r.spec.n;
          return (
            <tr key={r.label} className={isPb ? "pb" : ""}>
              <td>{r.label}</td>
              <td className={"v cur num" + (curOk ? "" : " na")} onClick={() => curOk && onDetail({ label: r.label, end: n - 1 })} data-testid={"cur-" + r.label}>
                {curOk ? fmtAvg(r.current, d) : "–"}
              </td>
              <td className={"v best num" + (r.bestEnd >= 0 ? "" : " na")} onClick={() => r.bestEnd >= 0 && onDetail({ label: r.label, end: r.bestEnd })} data-testid={"best-" + r.label}>
                {r.bestEnd >= 0 ? fmtAvg(r.best, d) : "–"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Horizontal instrument-cluster of averages (current over best). */
export function StatsBand({ solves, stats, d, onDetail }: { solves: Solve[]; stats: SessionStats; d: number; onDetail: Detail }) {
  const settings = useStore((s) => s.settings);
  const openSolve = useStore((s) => s.openSolve);
  const n = solves.length;
  const sum = stats.summary;
  const rows = settings.statsRows.map((l) => stats.rows.find((r) => r.label === l)).filter((r): r is NonNullable<typeof r> => !!r);
  return (
    <div className="band" data-testid="stats-table">
      <div className="band-cell" onClick={() => sum.bestIdx >= 0 && openSolve(solves[sum.bestIdx].id)}>
        <div className="lbl">single</div>
        <div className="cur num">{n ? fmtSolve(solves[n - 1], d) : "–"}</div>
        <div className="bst num">{sum.bestIdx >= 0 ? fmtSingle(sum.best, d) : "–"}</div>
      </div>
      {rows.map((r) => {
        const curOk = !Number.isNaN(r.current);
        const isPb = curOk && r.bestEnd === n - 1 && n > r.spec.n;
        return (
          <div key={r.label} className={"band-cell" + (curOk ? "" : " na") + (isPb ? " pb" : "")} onClick={() => curOk && onDetail({ label: r.label, end: n - 1 })}>
            <div className="lbl">{r.label}</div>
            <div className="cur num" data-testid={"cur-" + r.label}>{curOk ? fmtAvg(r.current, d) : "–"}</div>
            <div className="bst num" data-testid={"best-" + r.label} onClick={(e) => { e.stopPropagation(); r.bestEnd >= 0 && onDetail({ label: r.label, end: r.bestEnd }); }}>
              {r.bestEnd >= 0 ? fmtAvg(r.best, d) : "–"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SummaryLine({ stats, d }: { stats: SessionStats; d: number }) {
  const sum = stats.summary;
  return (
    <div className="summary-line num" data-testid="summary">
      <span>
        <span className="k">solves</span> {sum.solved.toLocaleString()}
        <span className="dim">/{sum.count.toLocaleString()}</span>
      </span>
      <span>
        <span className="k">mean</span> {fmtAvg(sum.mean, d)}
      </span>
      <span>
        <span className="k sym">σ</span> {Number.isFinite(sum.sd) ? (sum.sd / 1000).toFixed(2) : "–"}
      </span>
    </div>
  );
}

/** Virtualised list of solves (newest first). */
export function SolveList({ solves, stats, d, columns }: { solves: Solve[]; stats: SessionStats; d: number; columns: string[] }) {
  const openSolve = useStore((s) => s.openSolve);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [h, setH] = useState(400);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ROW = 29;
  const n = solves.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 4);
  const count = Math.ceil(h / ROW) + 8;
  const rows = [];
  for (let r = first; r < Math.min(n, first + count); r++) {
    const i = n - 1 - r;
    const s = solves[i];
    rows.push(
      <div key={s.id} className="row num" style={{ top: r * ROW }} onClick={() => openSolve(s.id)} data-testid="solve-row">
        <div className="idx">{i + 1}</div>
        <div className={stats.pbSingle[i] && i > 0 ? "pb" : ""}>
          {fmtSolve(s, d)}
          {s.comment ? <span className="dim">·</span> : null}
        </div>
        {columns.map((l) => {
          const v = stats.rolling.get(l)?.avg[i] ?? NaN;
          return <div key={l} className="avgc">{Number.isNaN(v) ? <span className="dim">–</span> : fmtAvg(v, d)}</div>;
        })}
      </div>,
    );
  }
  return (
    <div className="solve-list" style={{ ["--cols" as any]: columns.length }}>
      <div className="head">
        <div>#</div>
        <div>time</div>
        {columns.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </div>
      <div className="scroller" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: n * ROW, position: "relative" }}>{rows}</div>
        {n === 0 && <div className="empty">No solves yet</div>}
      </div>
    </div>
  );
}

/** Last N solves as dots with a rolling ao12 line. */
export function Sparkline({ solves, stats, n = 100, height = 64 }: { solves: Solve[]; stats: SessionStats; n?: number; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(260);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const data = useMemo(() => {
    const start = Math.max(0, solves.length - n);
    const pts: { x: number; v: number; a: number }[] = [];
    const ao = stats.rolling.get("ao12")?.avg;
    for (let i = start; i < solves.length; i++) pts.push({ x: i - start, v: stats.values[i], a: ao ? ao[i] : NaN });
    return pts;
  }, [solves, stats, n]);
  const fin = data.map((p) => p.v).filter(Number.isFinite);
  if (fin.length < 3) return <div ref={ref} style={{ height }} />;
  const sorted = [...fin].sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted[Math.floor(sorted.length * 0.95)];
  const pad = 4;
  const y = (v: number) => pad + (1 - (Math.min(v, hi) - lo) / Math.max(1, hi - lo)) * (height - 2 * pad);
  const x = (i: number) => pad + (i / Math.max(1, n - 1)) * (w - 2 * pad);
  const line = data
    .filter((p) => Number.isFinite(p.a))
    .map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.a).toFixed(1)}`)
    .join("");
  return (
    <div ref={ref} className="spark" title={`Last ${data.length} solves · line = ao12`}>
      <svg width={w} height={height}>
        {data.map((p) =>
          Number.isFinite(p.v) ? <circle key={p.x} cx={x(p.x)} cy={y(p.v)} r={1.6} fill="var(--fg3)" /> : <circle key={p.x} cx={x(p.x)} cy={pad} r={1.6} fill="var(--bad)" opacity={0.6} />,
        )}
        <path d={line} fill="none" stroke="var(--fg)" strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function useDetailState() {
  return useState<{ label: string; end: number } | null>(null);
}

/** Compact grid of averages (current large, best small) for the studio dock. */
export function StatsGrid({ solves, stats, d, onDetail }: { solves: Solve[]; stats: SessionStats; d: number; onDetail: Detail }) {
  const settings = useStore((s) => s.settings);
  const openSolve = useStore((s) => s.openSolve);
  const n = solves.length;
  const sum = stats.summary;
  const rows = settings.statsRows.map((l) => stats.rows.find((r) => r.label === l)).filter((r): r is NonNullable<typeof r> => !!r);
  return (
    <div className="sgrid" data-testid="stats-table">
      <button className="sg" onClick={() => sum.bestIdx >= 0 && openSolve(solves[sum.bestIdx].id)}>
        <span className="l">single</span>
        <span className="c num">{n ? fmtSolve(solves[n - 1], d) : "–"}</span>
        <span className="b num">{sum.bestIdx >= 0 ? fmtSingle(sum.best, d) : "–"}</span>
      </button>
      {rows.map((r) => {
        const curOk = !Number.isNaN(r.current);
        const isPb = curOk && r.bestEnd === n - 1 && n > r.spec.n;
        return (
          <button key={r.label} className={"sg" + (curOk ? "" : " na") + (isPb ? " pb" : "")} onClick={() => curOk && onDetail({ label: r.label, end: n - 1 })}>
            <span className="l">{r.label}</span>
            <span className="c num" data-testid={"cur-" + r.label}>{curOk ? fmtAvg(r.current, d) : "–"}</span>
            <span
              className="b num"
              data-testid={"best-" + r.label}
              onClick={(e) => {
                e.stopPropagation();
                if (r.bestEnd >= 0) onDetail({ label: r.label, end: r.bestEnd });
              }}
            >
              {r.bestEnd >= 0 ? fmtAvg(r.best, d) : "–"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Most recent solves, newest first (compact). */
export function RecentSolves({ solves, stats, d, count = 9 }: { solves: Solve[]; stats: SessionStats; d: number; count?: number }) {
  const openSolve = useStore((s) => s.openSolve);
  const items = [];
  for (let i = solves.length - 1; i >= Math.max(0, solves.length - count); i--) {
    const s = solves[i];
    const ao5 = stats.rolling.get("ao5")?.avg[i] ?? NaN;
    items.push(
      <button key={s.id} className="rs" onClick={() => openSolve(s.id)} data-testid="solve-row">
        <span className="i num">{i + 1}</span>
        <span className={"t num" + (stats.pbSingle[i] && i > 0 ? " pb" : "")}>{fmtSolve(s, d)}</span>
        <span className="a num">{Number.isNaN(ao5) ? "" : fmtAvg(ao5, d)}</span>
      </button>,
    );
  }
  return <div className="recent">{items.length ? items : <div className="empty">No solves yet</div>}</div>;
}
