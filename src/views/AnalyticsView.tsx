/**
 * Analytics: long-term statistics over any scope of recorded solves (a session, every session
 * of an event, or everything), optionally limited to a date range. All numbers are computed
 * from recorded solves only; heavy work lives in pure functions (core/analytics.ts) memoised
 * on the solves array identity, so hovering and toggling never recompute them.
 */
import { startTransition, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import "../styles/analytics.css";
import { liveSessions, sessionSolves, useStore } from "../data/store";
import { getEvent } from "../core/events";
import { buildDataset, computeRolling, filterByDate, headline, mergeChronological, METRICS, type Metric } from "../core/analytics";
import { Menu, useMenu, type MenuItem } from "../ui/Overlay";
import { AvgDetail } from "../ui/AvgDetail";
import { IconChevronDown } from "../ui/icons";
import { cached, DrillModal, fmtInt, shortDate, type DrillReq } from "./analytics/common";
import { ProgressChart } from "./analytics/ProgressChart";
import { AggregatesPanel, ConsistencyPanel, DistributionPanel } from "./analytics/Charts";
import { ComparePanel, HeadlineTiles, ImprovementPanel, MilestonesPanel, PbPanel } from "./analytics/Sections";
import { CalendarPanel } from "./analytics/Calendar";

type Scope = { kind: "current" } | { kind: "session"; id: string } | { kind: "event"; event: string } | { kind: "all" };
type Range = "all" | "30d" | "90d" | "1y" | "custom";

// Remember the scope while the app is open (switching views unmounts this component).
const memo: { scope: Scope; range: Range; from: string; to: string; metric: Metric } = { scope: { kind: "current" }, range: "all", from: "", to: "", metric: "ao100" };

const DAY = 86400000;
const warm = new WeakSet<object>();
const parseDay = (s: string, next = false) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3] + (next ? 1 : 0)).getTime() : null;
};

export default function AnalyticsView() {
  const allSolves = useStore((s) => s.solves);
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.currentSessionId);
  const decimals = useStore((s) => s.settings.decimals);
  const trimPct = useStore((s) => s.settings.trimPct);
  const [scope, setScopeS] = useState<Scope>(memo.scope);
  const [range, setRangeS] = useState<Range>(memo.range);
  const [from, setFromS] = useState(memo.from);
  const [to, setToS] = useState(memo.to);
  const [metric, setMetricS] = useState<Metric>(memo.metric);
  const setScope = (v: Scope) => setScopeS((memo.scope = v));
  const setRange = (v: Range) => setRangeS((memo.range = v));
  const setFrom = (v: string) => setFromS((memo.from = v));
  const setTo = (v: string) => setToS((memo.to = v));
  const setMetric = (v: Metric) => setMetricS((memo.metric = v));
  const [drill, setDrill] = useState<DrillReq | null>(null);
  const [avg, setAvg] = useState<{ label: string; end: number } | null>(null);
  const menu = useMenu();

  const live = useMemo(() => liveSessions(sessions), [sessions]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of allSolves) if (!s.deletedAt) m.set(s.sessionId, (m.get(s.sessionId) ?? 0) + 1);
    return m;
  }, [allSolves]);

  // resolve scope (a deleted session falls back to the current one)
  const eff: Scope = scope.kind === "session" && !live.some((s) => s.id === scope.id) ? { kind: "current" } : scope;
  const scopeKey = eff.kind === "current" ? "s:" + current : eff.kind === "session" ? "s:" + eff.id : eff.kind === "event" ? "e:" + eff.event : "all";
  const scoped = useMemo(() => {
    const ids = scopeKey.startsWith("s:") ? [scopeKey.slice(2)] : scopeKey === "all" ? live.map((s) => s.id) : live.filter((s) => "e:" + s.event === scopeKey).map((s) => s.id);
    return mergeChronological(ids.map((id) => sessionSolves(allSolves, id)));
  }, [allSolves, live, scopeKey]);

  const bounds = useMemo((): [number | null, number | null] => {
    const now = Date.now();
    const today = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate() + 1).getTime();
    switch (range) {
      case "all":
        return [null, null];
      case "30d":
        return [today - 30 * DAY, null];
      case "90d":
        return [today - 90 * DAY, null];
      case "1y":
        return [today - 365 * DAY, null];
      case "custom":
        return [parseDay(from), parseDay(to, true)];
    }
  }, [range, from, to]);

  const filtered = useMemo(() => filterByDate(scoped, bounds[0], bounds[1]), [scoped, bounds]);
  // cached on the filtered array identity: unchanged data => no recomputation on revisit
  const ds = useMemo(() => cached(filtered, "ds" + decimals, () => buildDataset(filtered, decimals)), [filtered, decimals]);
  const rolling = useMemo(() => cached(ds, "rolling" + trimPct, () => computeRolling(ds.values, trimPct)), [ds, trimPct]);
  const head = useMemo(() => cached(rolling, "head", () => headline(ds, rolling)), [ds, rolling]);
  // Progressive render: on a cold cache paint the top (tiles + progression) first, then the
  // rest in a transition on the next frame so the view appears immediately.
  const [stage, setStage] = useState(() => (warm.has(rolling) ? 2 : 1));
  useEffect(() => {
    warm.add(rolling);
    if (stage === 2) return;
    let t = 0;
    const raf = requestAnimationFrame(() => (t = window.setTimeout(() => startTransition(() => setStage(2)), 0)));
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [rolling, stage]);
  const later = (node: ReactNode, h: number) => (stage === 2 ? node : <div className="an-panel glass-edge an-skel" style={{ height: h }} />);
  const onAvg = useCallback((label: string, end: number) => setAvg({ label, end }), []);
  const onDrill = useCallback((r: DrillReq) => setDrill(r), []);

  const scopeLabel = (() => {
    if (eff.kind === "all") return "All sessions";
    if (eff.kind === "event") return `All ${getEvent(eff.event).short} sessions`;
    const id = eff.kind === "current" ? current : eff.id;
    const s = live.find((x) => x.id === id);
    return (s?.name ?? "Session") + (eff.kind === "current" ? " (current)" : "");
  })();
  const events = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of live) m.set(s.event, (m.get(s.event) ?? 0) + 1);
    return [...m.entries()].filter(([, c]) => c >= 2);
  }, [live]);
  const items: MenuItem[] = [
    { label: "Current session", meta: fmtInt(counts.get(current) ?? 0), selected: eff.kind === "current", onSelect: () => setScope({ kind: "current" }) },
    { label: "All sessions", meta: fmtInt([...counts.entries()].reduce((n, [id, c]) => n + (live.some((s) => s.id === id) ? c : 0), 0)), selected: eff.kind === "all", onSelect: () => setScope({ kind: "all" }) },
    ...(events.length ? [{ sep: true } as MenuItem, { group: "By event" } as MenuItem] : []),
    ...events.map(([ev, c]) => ({
      label: `All ${getEvent(ev).short} sessions`,
      meta: `${c} sessions`,
      selected: eff.kind === "event" && eff.event === ev,
      onSelect: () => setScope({ kind: "event", event: ev }),
    })),
    { sep: true },
    { group: "Sessions" },
    ...live.map((s) => ({
      label: (
        <span className="an-menu-ses">
          {s.name} <span className="dim">{getEvent(s.event).short}</span>
        </span>
      ),
      meta: fmtInt(counts.get(s.id) ?? 0),
      selected: eff.kind === "session" && eff.id === s.id,
      onSelect: () => setScope({ kind: "session", id: s.id }),
    })),
  ];
  const ranges: { v: Range; l: string }[] = [
    { v: "all", l: "All time" },
    { v: "30d", l: "30 d" },
    { v: "90d", l: "90 d" },
    { v: "1y", l: "1 y" },
    { v: "custom", l: "Custom" },
  ];
  const n = ds.values.length;
  const multiEvent = eff.kind === "all" && new Set(live.map((s) => s.event)).size > 1;

  return (
    <div className="page an-page" data-testid="analytics">
      <div className="an-head">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-sub">
            {n ? (
              <>
                <span className="num">{fmtInt(n)}</span> solves
                {head.firstDate != null && (
                  <>
                    {" "}
                    · <span className="num">{shortDate(head.firstDate)}</span> → <span className="num">{shortDate(head.lastDate)}</span>
                  </>
                )}
              </>
            ) : (
              "No solves in this scope"
            )}
          </p>
        </div>
      </div>

      <div className="an-scope glass-edge" data-testid="an-scope">
        <div className="an-field">
          <span className="cap">Scope</span>
          <button className="btn an-scope-btn" onClick={menu.open} data-testid="an-scope-btn">
            <span className="an-ellipsis">{scopeLabel}</span>
            <IconChevronDown size={13} />
          </button>
        </div>
        <div className="an-field">
          <span className="cap">Range</span>
          <div className="seg">
            {ranges.map((r) => (
              <button key={r.v} className={range === r.v ? "on" : ""} onClick={() => setRange(r.v)} data-testid={"an-range-" + r.v}>
                {r.l}
              </button>
            ))}
          </div>
          {range === "custom" && (
            <span className="an-dates">
              <input className="input sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
              <span className="dim">–</span>
              <input className="input sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            </span>
          )}
        </div>
        <div className="an-field">
          <span className="cap">Curves</span>
          <div className="seg">
            {METRICS.map((m) => (
              <button key={m} className={metric === m ? "on" : ""} onClick={() => setMetric(m)} data-testid={"an-metric-" + m}>
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>
      {(ds.undated > 0 || multiEvent || range !== "all") && (
        <div className="an-notes">
          {ds.undated > 0 && (
            <span>
              <i className="an-dot" />
              {fmtInt(ds.undated)} solves have no date: they count in index-based charts (progression by solve #, averages, PBs, distribution) and are left out of date-based ones (calendar, periods, date comparisons).
            </span>
          )}
          {range !== "all" && scoped.length !== filtered.length && (
            <span>
              <i className="an-dot" />
              Date range active: {fmtInt(filtered.length)} of {fmtInt(scoped.length)} solves; undated solves are excluded.
            </span>
          )}
          {multiEvent && (
            <span>
              <i className="an-dot" />
              This scope mixes different events.
            </span>
          )}
        </div>
      )}

      {n === 0 ? (
        <div className="an-panel glass-edge an-none">
          <div className="cap">Nothing to analyse</div>
          <p className="dim">{scoped.length ? "No solves fall in the selected date range." : "This scope has no solves yet. Time some solves or import a csTimer backup in Settings."}</p>
        </div>
      ) : (
        <div className="an-grid">
          <div className="span-12">
            <HeadlineTiles h={head} ds={ds} onAvg={onAvg} />
          </div>
          <div className="span-12">
            <ProgressChart ds={ds} rolling={rolling} metric={metric} />
          </div>
          <div className="span-8">
            {later(<AggregatesPanel ds={ds} rolling={rolling} metric={metric} onDrill={onDrill} />, 420)}
          </div>
          <div className="span-4">
            {later(<PbPanel ds={ds} rolling={rolling} onAvg={onAvg} />, 420)}
          </div>
          <div className="span-6">
            {later(<DistributionPanel ds={ds} rolling={rolling} onDrill={onDrill} />, 400)}
          </div>
          <div className="span-6">
            {later(<ConsistencyPanel ds={ds} rolling={rolling} onWindow={onAvg} />, 400)}
          </div>
          <div className="span-7">
            {later(<ImprovementPanel ds={ds} rolling={rolling} onDrill={onDrill} />, 640)}
          </div>
          <div className="span-5">
            {later(<MilestonesPanel ds={ds} rolling={rolling} onAvg={onAvg} />, 640)}
          </div>
          <div className="span-12">
            {later(<ComparePanel ds={ds} />, 380)}
          </div>
          <div className="span-12">
            {later(<CalendarPanel ds={ds} onDrill={onDrill} />, 280)}
          </div>
        </div>
      )}

      {menu.anchor && <Menu anchor={menu.anchor} items={items} onClose={menu.close} minWidth={300} />}
      {drill && <DrillModal title={drill.title} sub={drill.sub} ds={ds} idx={drill.idx} onClose={() => setDrill(null)} />}
      {avg && <AvgDetail solves={ds.solves} label={avg.label} end={avg.end} onClose={() => setAvg(null)} />}
    </div>
  );
}
