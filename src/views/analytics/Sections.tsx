/** Table/tile sections of the Analytics screen. */
import { useMemo, useState } from "react";
import { useStore } from "../../data/store";
import { fmtAvg, fmtDate, fmtSingle } from "../../core/time";
import {
  compareGroups,
  fmtP,
  improvementReport,
  milestones,
  pbProgression,
  type Bucket,
  type Comparison,
  type Dataset,
  type Headline,
  type RollingSet,
} from "../../core/analytics";
import { cached, Empty, fmtDays, fmtDelta, fmtDuration, fmtInt, fmtPct, fmtSd, Panel, shortDate, type DrillReq } from "./common";
import { ImprovementChart } from "./Charts";

export type OpenAvg = (label: string, end: number) => void;

// ================================================================ headline tiles

export function HeadlineTiles({ h, ds, onAvg }: { h: Headline; ds: Dataset; onAvg: OpenAvg }) {
  const d = useStore((s) => s.settings.decimals);
  const openSolve = useStore((s) => s.openSolve);
  const best = (k: number) => h.bests[k];
  const bestTile = (k: number, label: string) => {
    const b = best(k);
    const ok = b.idx >= 0;
    return (
      <button
        key={label}
        className={"an-tile best" + (ok ? "" : " na")}
        onClick={() => ok && (k === 0 ? openSolve(ds.solves[b.idx].id) : onAvg(b.label, b.idx))}
        disabled={!ok}
        data-testid={"an-best-" + b.label}
      >
        <span className="cap">Best {label}</span>
        <b className="num">{ok ? (k === 0 ? fmtSingle(b.value, d) : fmtAvg(b.value, d)) : "–"}</b>
        <span className="sub num">{ok ? `${shortDate(b.date)} · #${fmtInt(b.idx + 1)}` : "not enough solves"}</span>
      </button>
    );
  };
  return (
    <div className="an-tiles" data-testid="an-tiles">
      <div className="an-tile">
        <span className="cap">Solves</span>
        <b className="num">{fmtInt(h.count)}</b>
        <span className="sub num">
          {fmtInt(h.solved)} completed · {fmtInt(h.plus2)} +2
        </span>
      </div>
      <div className="an-tile">
        <span className="cap">DNF rate</span>
        <b className="num">{fmtPct(h.dnfRate, 2)}</b>
        <span className="sub num">{fmtInt(h.dnf)} DNF</span>
      </div>
      <div className="an-tile">
        <span className="cap">Mean</span>
        <b className="num">{fmtAvg(h.mean, d)}</b>
        <span className="sub">all completed solves</span>
      </div>
      <div className="an-tile">
        <span className="cap">Median</span>
        <b className="num">{fmtAvg(h.median, d)}</b>
        <span className="sub">half of solves faster</span>
      </div>
      <div className="an-tile">
        <span className="cap">Std. deviation</span>
        <b className="num">{fmtSd(h.sd)}</b>
        <span className="sub">σ of completed solves (s)</span>
      </div>
      <div className="an-tile">
        <span className="cap">Time solving</span>
        <b className="num">{fmtDuration(h.totalTime)}</b>
        <span className="sub">sum of recorded times</span>
      </div>
      {bestTile(0, "single")}
      {bestTile(1, "ao5")}
      {bestTile(2, "ao12")}
      {bestTile(3, "ao100")}
      <div className="an-tile">
        <span className="cap">Practice days</span>
        <b className="num">{fmtInt(h.practiceDays)}</b>
        <span className="sub num">{h.firstDate != null ? `${shortDate(h.firstDate)} → ${shortDate(h.lastDate)}` : "no dated solves"}</span>
      </div>
      <div className="an-tile">
        <span className="cap">Current streak</span>
        <b className="num">
          {h.currentStreak} <small>{h.currentStreak === 1 ? "day" : "days"}</small>
        </b>
        <span className="sub num">longest {h.longestStreak} days</span>
      </div>
    </div>
  );
}

// ================================================================ PB progression

const PB_KEYS = ["single", "ao5", "ao12", "ao100"] as const;

export function PbPanel({ ds, rolling, onAvg }: { ds: Dataset; rolling: RollingSet; onAvg: OpenAvg }) {
  const d = useStore((s) => s.settings.decimals);
  const openSolve = useStore((s) => s.openSolve);
  const [k, setK] = useState<(typeof PB_KEYS)[number]>("single");
  const all = useMemo(
    () => cached(rolling, "pbs", () => ({
      single: pbProgression(ds.values, ds.dates),
      ao5: pbProgression(rolling.ao5.avg, ds.dates),
      ao12: pbProgression(rolling.ao12.avg, ds.dates),
      ao100: pbProgression(rolling.ao100.avg, ds.dates),
    })),
    [ds, rolling],
  );
  const list = all[k];
  const [all_, setAll] = useState(false);
  const rows = useMemo(() => [...list].reverse().slice(0, all_ ? undefined : 60), [list, all_]);
  const fmt = (v: number) => (k === "single" ? fmtSingle(v, d) : fmtAvg(v, d));
  const first = list[0],
    last = list[list.length - 1];
  return (
    <Panel
      title="Personal-best progression"
      sub={first && last ? <>{list.length} PBs · {fmt(first.value)} → {fmt(last.value)} ({fmtDelta(last.value - first.value)})</> : "No PBs yet"}
      testId="an-pbs"
      className="an-pb-panel"
      right={
        <div className="seg">
          {PB_KEYS.map((x) => (
            <button key={x} className={k === x ? "on" : ""} onClick={() => setK(x)} data-testid={"an-pb-" + x}>
              {x}
            </button>
          ))}
        </div>
      }
    >
      {rows.length ? (
        <div className="an-scroll">
          <table className="tbl an-tbl">
            <thead>
              <tr>
                <th>{k}</th>
                <th className="r">Gain</th>
                <th>Date</th>
                <th className="r">Solve</th>
                <th className="r">Since prev.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.idx} className="click" onClick={() => (k === "single" ? openSolve(ds.solves[p.idx].id) : onAvg(k, p.idx))}>
                  <td className={"num" + (i === 0 ? " acc" : "")}>{fmt(p.value)}</td>
                  <td className="r num good">{Number.isFinite(p.prev) ? fmtDelta(p.value - p.prev) : <span className="dim">first</span>}</td>
                  <td className="num dim">{fmtDate(p.date)}</td>
                  <td className="r num dim">#{fmtInt(p.idx + 1)}</td>
                  <td className="r num dim">{p.solves == null ? "" : `${fmtDays(p.days)} · ${fmtInt(p.solves)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!all_ && list.length > rows.length && (
            <button className="btn sm ghost an-more" onClick={() => setAll(true)}>
              Show all {list.length} PBs
            </button>
          )}
        </div>
      ) : (
        <Empty>Not enough solves for {k}.</Empty>
      )}
    </Panel>
  );
}

// ================================================================ milestones

export function MilestonesPanel({ ds, rolling, onAvg }: { ds: Dataset; rolling: RollingSet; onAvg: OpenAvg }) {
  const d = useStore((s) => s.settings.decimals);
  const res = useMemo(
    () => cached(rolling, "milestones", () =>
      milestones(
        [
          { label: "ao5", avg: rolling.ao5.avg },
          { label: "ao12", avg: rolling.ao12.avg },
          { label: "ao100", avg: rolling.ao100.avg },
        ],
        ds.dates,
      )),
    [ds, rolling],
  );
  // journey summary along ao12 (first → last milestone)
  const j = res.rows.filter((r) => r.cells.ao12);
  const journey =
    j.length >= 2
      ? (() => {
          const a = j[0].cells.ao12!,
            b = j[j.length - 1].cells.ao12!;
          const days = a.date != null && b.date != null ? (b.date - a.date) / 86400000 : null;
          return `ao12 went from sub-${j[0].threshold / 1000} to sub-${j[j.length - 1].threshold / 1000} in ${days != null ? fmtDays(days) + " and " : ""}${fmtInt(b.idx - a.idx)} solves.`;
        })()
      : null;
  return (
    <Panel title="Milestones" sub={journey ?? "First time each average went under a round number · Δ = time and solves since the previous milestone"} testId="an-milestones">
      {res.rows.length ? (
        <div className="an-scroll tall">
          <table className="tbl an-tbl an-ms">
            <thead>
              <tr>
                <th>Goal</th>
                {res.labels.map((l) => (
                  <th key={l}>First {l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {res.rows.map((r) => (
                <tr key={r.threshold}>
                  <td className="an-ms-goal num">sub-{r.threshold / 1000}</td>
                  {res.labels.map((l) => {
                    const c = r.cells[l];
                    if (!c)
                      return (
                        <td key={l} className="dim">
                          not yet
                        </td>
                      );
                    return (
                      <td key={l} className="an-ms-cell" onClick={() => onAvg(l, c.idx)} title={`${l} ${fmtAvg(c.value, d)} — click for the full average`}>
                        <div className="num">
                          {c.date != null ? shortDate(c.date) : "undated"} <span className="dim">#{fmtInt(c.idx + 1)}</span>
                        </div>
                        <div className="an-ms-d num">{c.atStart ? "from the start" : c.dSolves != null ? `Δ ${fmtDays(c.dDays)} · ${fmtInt(c.dSolves)} solves` : `${fmtAvg(c.value, d)}`}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {res.next && (
                <tr className="an-ms-next">
                  <td className="an-ms-goal num">sub-{res.next.threshold / 1000}</td>
                  <td colSpan={res.labels.length} className="dim">
                    Next goal · best {res.labels.map((l) => `${l} ${fmtAvg(res.next!.best[l], d)}`).join(" · ")} ({fmtDelta(res.next.best.ao5 - res.next.threshold).replace("+", "")} to go for ao5)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No milestones crossed yet in this scope.</Empty>
      )}
    </Panel>
  );
}

// ================================================================ comparison

function CompareTable({ c, names }: { c: Comparison; names: [string, string] }) {
  const d = useStore((s) => s.settings.decimals);
  const rows: { k: string; a: string; b: string; delta: number; lowerBetter: boolean; fmt: (x: number) => string }[] = [
    { k: "Solves", a: fmtInt(c.a.count), b: fmtInt(c.b.count), delta: NaN, lowerBetter: true, fmt: () => "" },
    { k: "Mean", a: fmtAvg(c.a.mean, d), b: fmtAvg(c.b.mean, d), delta: c.b.mean - c.a.mean, lowerBetter: true, fmt: (x) => fmtDelta(x) },
    { k: "Median", a: fmtAvg(c.a.median, d), b: fmtAvg(c.b.median, d), delta: c.b.median - c.a.median, lowerBetter: true, fmt: (x) => fmtDelta(x) },
    { k: "σ", a: fmtSd(c.a.sd), b: fmtSd(c.b.sd), delta: c.b.sd - c.a.sd, lowerBetter: true, fmt: (x) => fmtDelta(x) },
    { k: "Best", a: fmtSingle(c.a.best, d), b: fmtSingle(c.b.best, d), delta: c.b.best - c.a.best, lowerBetter: true, fmt: (x) => fmtDelta(x) },
    { k: "DNF rate", a: fmtPct(c.a.dnfRate), b: fmtPct(c.b.dnfRate), delta: c.b.dnfRate - c.a.dnfRate, lowerBetter: true, fmt: (x) => (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(x * 100).toFixed(1) + " pt" },
  ];
  return (
    <>
      <table className="tbl an-tbl an-cmp">
        <thead>
          <tr>
            <th />
            <th className="r">{names[0]}</th>
            <th className="r">{names[1]}</th>
            <th className="r">Δ (B − A)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}>
              <td className="dim">{r.k}</td>
              <td className="r num">{r.a}</td>
              <td className="r num">{r.b}</td>
              <td className={"r num " + (!Number.isFinite(r.delta) || Math.abs(r.delta) < 1e-9 ? "dim" : (r.delta < 0) === r.lowerBetter ? "good" : "bad")}>{Number.isFinite(r.delta) ? r.fmt(r.delta) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={"an-verdict" + (c.significant ? " sig" : "")} data-testid="an-verdict">
        <div>{c.verdict}</div>
        <div className="an-verdict-stats num">
          Welch t = {Number.isFinite(c.t) ? c.t.toFixed(2) : "–"} · df = {Number.isFinite(c.df) ? Math.round(c.df).toLocaleString("en-US") : "–"} · {fmtP(c.p)} · Cohen's d = {Number.isFinite(c.d) ? c.d.toFixed(2) : "–"}
        </div>
      </div>
    </>
  );
}

const toInput = (ms: number) => {
  const dt = new Date(ms);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};
const fromInput = (s: string, endOfDay = false) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3] + (endOfDay ? 1 : 0)).getTime();
};

export function ComparePanel({ ds }: { ds: Dataset }) {
  const n = ds.values.length;
  const [nStr, setN] = useState("1000");
  const N = Math.max(2, Math.min(Math.floor(+nStr) || 1000, 100000));
  // groups never overlap: N is capped at half of the solves
  const k = Math.min(N, Math.floor(n / 2));
  const firstLast = useMemo(() => {
    return cached(ds, "fl" + k, () => compareGroups(ds.values.subarray(0, k), ds.values.subarray(n - k), [`First ${fmtInt(k)}`, `Last ${fmtInt(k)}`]));
  }, [ds, k, n]);
  // default date ranges: last 90 days of data vs the 90 days before; short histories are split in half
  const span = useMemo(() => {
    let f = Infinity,
      l = -Infinity;
    for (let i = 0; i < n; i++) {
      const t = ds.dates[i];
      if (t > l) l = t;
      if (t < f) f = t;
    }
    return Number.isFinite(l) ? { f, l } : null;
  }, [ds, n]);
  const def = useMemo(() => {
    if (!span) return null;
    const DAY = 86400000;
    const { f, l } = span;
    if (l - f >= 180 * DAY) return { a0: toInput(l - 179 * DAY), a1: toInput(l - 90 * DAY), b0: toInput(l - 89 * DAY), b1: toInput(l) };
    const mid = f + (l - f) / 2;
    return { a0: toInput(f), a1: toInput(mid - DAY / 2), b0: toInput(mid + DAY / 2), b1: toInput(l) };
  }, [span]);
  const [rng, setRng] = useState<{ a0: string; a1: string; b0: string; b1: string } | null>(null);
  const r = rng ?? def;
  const dateCmp = useMemo(() => {
    if (!r) return null;
    const pick = (from: string, to: string) => {
      const lo = fromInput(from),
        hi = fromInput(to, true);
      const out: number[] = [];
      for (let i = 0; i < n; i++) if (ds.dates[i] >= lo && ds.dates[i] < hi) out.push(ds.values[i]);
      return out;
    };
    return compareGroups(pick(r.a0, r.a1), pick(r.b0, r.b1), ["A", "B"]);
  }, [r, ds, n]);
  const capped = N > k;
  return (
    <Panel title="Period comparison" sub="Welch's t-test on completed solves (DNFs excluded, their rate shown) · Cohen's d effect size" testId="an-compare">
      <div className="an-cmp-grid">
        <div className="an-cmp-card">
          <div className="an-cmp-head">
            <span className="cap">First N vs last N</span>
            <label className="an-inline-field">
              <span className="cap">N</span>
              <input className="input sm num" style={{ width: 84 }} type="number" min={2} value={nStr} onChange={(e) => setN(e.target.value)} data-testid="an-cmp-n" />
            </label>
          </div>
          {n >= 4 ? <CompareTable c={firstLast} names={[`First ${fmtInt(k)}`, `Last ${fmtInt(k)}`]} /> : <Empty h={120}>Needs at least 4 solves.</Empty>}
          {capped && n >= 4 && <div className="an-note">N capped at {fmtInt(k)} (half of the {fmtInt(n)} solves) so the groups don't overlap.</div>}
        </div>
        <div className="an-cmp-card">
          <div className="an-cmp-head">
            <span className="cap">Date range A vs B</span>
            {r && (
              <div className="an-ranges">
                <span className="an-rtag">A</span>
                <input className="input sm" type="date" value={r.a0} onChange={(e) => setRng({ ...r, a0: e.target.value })} />
                <span className="dim">–</span>
                <input className="input sm" type="date" value={r.a1} onChange={(e) => setRng({ ...r, a1: e.target.value })} />
                <span className="an-rtag b">B</span>
                <input className="input sm" type="date" value={r.b0} onChange={(e) => setRng({ ...r, b0: e.target.value })} />
                <span className="dim">–</span>
                <input className="input sm" type="date" value={r.b1} onChange={(e) => setRng({ ...r, b1: e.target.value })} />
              </div>
            )}
          </div>
          {dateCmp && r ? (
            <CompareTable c={dateCmp} names={["A", "B"]} />
          ) : (
            <Empty h={120}>No dated solves to compare.</Empty>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ================================================================ improvement & plateaus

export function ImprovementPanel({ ds, rolling, onDrill }: { ds: Dataset; rolling: RollingSet; onDrill: (r: DrillReq) => void }) {
  const d = useStore((s) => s.settings.decimals);
  const rep = useMemo(() => cached(rolling, "improve", () => improvementReport(ds, rolling.ao100.avg)), [ds, rolling]);
  const drillMonth = (b: Bucket) => onDrill({ title: b.label, idx: b.idx });
  const rangeIdx = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const rate = rep.slope;
  const pct = Number.isFinite(rate) && rep.used.length ? rate / rep.used[0].mean : NaN;
  return (
    <Panel
      title="Improvement rate & plateaus"
      sub="Linear trend of monthly means (months with ≥ 10 solves) · plateau = ≥ 60 days with < 2% change · fastest windows use ao100"
      testId="an-improve"
    >
      {rep.used.length >= 2 ? (
        <>
          <div className="an-kpis">
            <div className="an-kpi">
              <span className="cap">Trend</span>
              <b className={"num " + (rate < 0 ? "good" : rate > 0 ? "bad" : "")}>{fmtDelta(rate, "")}</b>
              <span className="sub">
                s / month · R² {Number.isFinite(rep.r2) ? rep.r2.toFixed(2) : "–"}
                {Number.isFinite(pct) ? ` · ${(pct * 100).toFixed(1)}%` : ""}
              </span>
            </div>
            <button className="an-kpi click" onClick={() => rep.bestMonth && drillMonth(rep.bestMonth)}>
              <span className="cap">Best month</span>
              <b className="num">{fmtAvg(rep.bestMonth?.mean ?? NaN, d)}</b>
              <span className="sub">{rep.bestMonth?.label}</span>
            </button>
            <button className="an-kpi click" onClick={() => rep.worstMonth && drillMonth(rep.worstMonth)}>
              <span className="cap">Slowest month</span>
              <b className="num">{fmtAvg(rep.worstMonth?.mean ?? NaN, d)}</b>
              <span className="sub">{rep.worstMonth?.label}</span>
            </button>
            <button className="an-kpi click" onClick={() => rep.biggestGain && drillMonth(rep.biggestGain.month)}>
              <span className="cap">Biggest monthly gain</span>
              <b className="num good">{rep.biggestGain ? fmtDelta(-rep.biggestGain.delta) : "–"}</b>
              <span className="sub">{rep.biggestGain ? `${rep.biggestGain.prev.label} → ${rep.biggestGain.month.label}` : "none"}</span>
            </button>
          </div>
          <ImprovementChart rep={rep} onMonth={drillMonth} />
          <div className="an-two">
            <div>
              <div className="an-minihead cap">Fastest 30-day improvements</div>
              {rep.windows.length ? (
                rep.windows.map((w, i) => (
                  <button key={i} className="an-li" onClick={() => onDrill({ title: `${shortDate(w.start)} → ${shortDate(w.end)}`, idx: rangeIdx(w.fromIdx, w.toIdx) })}>
                    <span className="num">
                      {shortDate(w.start)} → {shortDate(w.end)}
                    </span>
                    <span className="num">
                      <span className="dim">
                        {fmtAvg(w.from, d)} → {fmtAvg(w.to, d)}
                      </span>{" "}
                      <b className="good">{fmtDelta(-w.delta)}</b>
                    </span>
                  </button>
                ))
              ) : (
                <div className="dim an-li">No 30-day window improved ao100.</div>
              )}
            </div>
            <div>
              <div className="an-minihead cap">Plateaus</div>
              {rep.plateaus.length ? (
                rep.plateaus.map((p, i) => (
                  <button key={i} className="an-li" onClick={() => onDrill({ title: `Plateau ${shortDate(p.start)} → ${shortDate(p.end - 86400000)}`, idx: rangeIdx(p.firstIdx, p.lastIdx) })}>
                    <span className="num">
                      {shortDate(p.start)} → {shortDate(p.end - 86400000)}
                    </span>
                    <span className="num">
                      <span className="dim">
                        {p.days} d · {p.months} mo · ±{(p.change * 100).toFixed(1)}%
                      </span>{" "}
                      <b>{fmtAvg(p.mean, d)}</b>
                    </span>
                  </button>
                ))
              ) : (
                <div className="dim an-li">No plateaus — monthly means kept moving.</div>
              )}
            </div>
          </div>
        </>
      ) : (
        <Empty h={200}>Needs at least two months with 10+ dated solves.</Empty>
      )}
    </Panel>
  );
}
