/** SVG charts for the Analytics screen. Static layers are memoised; hover only redraws overlays. */
import { useMemo, useState, type ReactNode } from "react";
import { useStore } from "../../data/store";
import { fmtAvg, fmtSingle } from "../../core/time";
import {
  aggregate,
  consistencySeries,
  downsample,
  finiteSorted,
  histogram,
  histRange,
  PERCENTILES,
  type Bucket,
  type Dataset,
  type ImprovementReport,
  type Metric,
  type Period,
  type RollingSet,
  metricSeries,
} from "../../core/analytics";
import { percentile } from "../../core/stats";
import { axisSec, cached, Empty, fmtDelta, fmtInt, fmtPct, fmtSd, niceTicks, Panel, shortDate, Tip, TipRow, useSize, type DrillReq } from "./common";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Calendar-aligned time ticks between t0 and t1 (ms). */
function timeTicks(t0: number, t1: number, max: number): { t: number; label: string }[] {
  const span = t1 - t0;
  const DAY = 86400000;
  const steps: { unit: "d" | "m" | "y"; n: number }[] = [
    { unit: "d", n: 1 },
    { unit: "d", n: 7 },
    { unit: "m", n: 1 },
    { unit: "m", n: 2 },
    { unit: "m", n: 3 },
    { unit: "m", n: 6 },
    { unit: "y", n: 1 },
    { unit: "y", n: 2 },
    { unit: "y", n: 5 },
  ];
  const approx = (s: (typeof steps)[number]) => (s.unit === "d" ? s.n * DAY : s.unit === "m" ? s.n * 30.44 * DAY : s.n * 365.25 * DAY);
  const st = steps.find((s) => span / approx(s) <= max) ?? steps[steps.length - 1];
  const out: { t: number; label: string }[] = [];
  const d0 = new Date(t0);
  let cur: Date;
  if (st.unit === "d") cur = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1);
  else if (st.unit === "m") {
    cur = new Date(d0.getFullYear(), d0.getMonth() + 1, 1);
    while (cur.getMonth() % st.n) cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  } else {
    cur = new Date(d0.getFullYear() + 1, 0, 1);
    while (cur.getFullYear() % st.n) cur = new Date(cur.getFullYear() + 1, 0, 1);
  }
  if (st.unit === "d" && st.n === 7) while (cur.getDay() !== 1) cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  let guard = 0;
  while (cur.getTime() <= t1 && guard++ < 200) {
    const t = cur.getTime();
    const label =
      st.unit === "y" ? String(cur.getFullYear()) : st.unit === "m" ? (cur.getMonth() === 0 ? String(cur.getFullYear()) : MONTHS[cur.getMonth()]) : `${MONTHS[cur.getMonth()]} ${cur.getDate()}`;
    out.push({ t, label });
    cur =
      st.unit === "d"
        ? new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + st.n)
        : st.unit === "m"
          ? new Date(cur.getFullYear(), cur.getMonth() + st.n, 1)
          : new Date(cur.getFullYear() + st.n, 0, 1);
  }
  return out;
}

function pathOf(pts: [number, number][]): string {
  let s = "";
  for (let i = 0; i < pts.length; i++) s += (i ? "L" : "M") + pts[i][0].toFixed(1) + "," + pts[i][1].toFixed(1);
  return s;
}

function YAxis({ ticks, Y, x0, x1, fmt = axisSec }: { ticks: number[]; Y: (v: number) => number; x0: number; x1: number; fmt?: (v: number) => string }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x0} x2={x1} y1={Y(t)} y2={Y(t)} className="an-gl" />
          <text x={x0 - 8} y={Y(t) + 3.5} className="an-ax" textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

const METRIC_LABEL: Record<Metric, string> = { single: "singles", ao5: "ao5s", ao12: "ao12s", ao100: "ao100s", ao1000: "ao1000s" };

// ================================================================ aggregates

export function AggregatesPanel({ ds, rolling, metric, onDrill }: { ds: Dataset; rolling: RollingSet; metric: Metric; onDrill: (r: DrillReq) => void }) {
  const [period, setPeriod] = useState<Period>("week");
  const series = metricSeries(metric, ds.values, rolling);
  const buckets = useMemo(() => cached(series, "agg-" + period, () => aggregate(ds, period, series)), [ds, period, series]);
  const datedCount = ds.values.length - ds.undated;
  return (
    <Panel
      title="Practice volume & pace"
      sub={
        <>
          Solves per {period} (bars) · mean, median and p10–p90 band of {METRIC_LABEL[metric]} · click a {period} to list its solves
        </>
      }
      testId="an-aggregates"
      right={
        <div className="seg">
          {(["day", "week", "month", "year"] as Period[]).map((p) => (
            <button key={p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)} data-testid={"an-period-" + p}>
              {p === "day" ? "Daily" : p === "week" ? "Weekly" : p === "month" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      }
    >
      {buckets.length ? (
        <AggChart buckets={buckets} period={period} onDrill={(b) => onDrill({ title: b.label, idx: b.idx })} />
      ) : (
        <Empty h={300}>{datedCount ? "No dated solves in this scope." : "These solves have no dates, so calendar aggregates are unavailable."}</Empty>
      )}
    </Panel>
  );
}

function AggChart({ buckets, period, onDrill }: { buckets: Bucket[]; period: Period; onDrill: (b: Bucket) => void }) {
  const d = useStore((s) => s.settings.decimals);
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const H = 300,
    L = 50,
    R = 12,
    T = 10,
    topH = 196,
    gap = 22,
    botH = 50;
  const geo = useMemo(() => {
    if (!w) return null;
    const t0 = buckets[0].start,
      t1 = buckets[buckets.length - 1].end;
    const X = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (w - L - R);
    const p10s = buckets.map((b) => b.p10).filter(Number.isFinite);
    const p90s = buckets.map((b) => b.p90).filter(Number.isFinite).sort((a, b) => a - b);
    const means = buckets.map((b) => b.mean).filter(Number.isFinite);
    if (!p10s.length) return null;
    let lo = Math.min(...p10s, ...means);
    let hi = Math.max(percentile(p90s, buckets.length > 20 ? 0.97 : 1), ...means);
    const pad = (hi - lo) * 0.06 || 500;
    lo = Math.max(0, lo - pad);
    hi += pad;
    const Y = (v: number) => T + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * topH;
    const maxC = Math.max(...buckets.map((b) => b.count));
    const cTop = T + topH + gap;
    const C = (c: number) => cTop + botH - (c / maxC) * botH;
    const cx = (b: Bucket) => (X(b.start) + X(b.end)) / 2;
    const fin = buckets.filter((b) => Number.isFinite(b.mean));
    const band = fin.length ? pathOf([...fin.map((b) => [cx(b), Y(b.p90)] as [number, number]), ...[...fin].reverse().map((b) => [cx(b), Y(b.p10)] as [number, number])]) + "Z" : "";
    const meanP = pathOf(fin.map((b) => [cx(b), Y(b.mean)]));
    const medP = pathOf(fin.map((b) => [cx(b), Y(b.median)]));
    const ticks = niceTicks(lo, hi, 5);
    const tt = timeTicks(t0, t1, Math.max(3, Math.floor((w - L - R) / 90)));
    const bars = buckets.map((b, i) => {
      const x0 = X(b.start),
        x1 = X(b.end);
      const bw = Math.max(0.8, x1 - x0 - (x1 - x0 > 5 ? 2 : x1 - x0 > 2 ? 1 : 0));
      return <rect key={i} x={x0 + (x1 - x0 - bw) / 2} y={C(b.count)} width={bw} height={Math.max(0.5, cTop + botH - C(b.count))} rx={Math.min(2, bw / 2)} className="an-bar" />;
    });
    const layer = (
      <g>
        <YAxis ticks={ticks} Y={Y} x0={L} x1={w - R} />
        <path d={band} className="an-band" />
        <path d={medP} className="an-line2" />
        <path d={meanP} className="an-line" />
        {fin.length < 60 && fin.map((b, i) => <circle key={i} cx={cx(b)} cy={Y(b.mean)} r={2.4} className="an-pt" />)}
        <line x1={L} x2={w - R} y1={cTop + botH} y2={cTop + botH} className="an-gl strong" />
        <text x={L - 8} y={cTop + 4} className="an-ax" textAnchor="end">
          {fmtInt(maxC)}
        </text>
        <text x={L - 8} y={cTop + botH} className="an-ax" textAnchor="end">
          0
        </text>
        {bars}
        {tt.map((t) => (
          <g key={t.t}>
            <line x1={X(t.t)} x2={X(t.t)} y1={cTop + botH} y2={cTop + botH + 4} className="an-gl strong" />
            <text x={X(t.t)} y={H - 2} className="an-ax" textAnchor="middle">
              {t.label}
            </text>
          </g>
        ))}
      </g>
    );
    return { X, Y, C, cx, layer, t0, t1, cTop };
  }, [buckets, w]);

  const pick = (mx: number) => {
    if (!geo) return -1;
    const t = geo.t0 + ((mx - L) / (w - L - R)) * (geo.t1 - geo.t0);
    let lo = 0,
      hi = buckets.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (buckets[m].start <= t) lo = m;
      else hi = m - 1;
    }
    // choose closer of lo / lo+1 by center distance
    const a = buckets[lo],
      b = buckets[lo + 1];
    if (b && Math.abs(geo.cx(b) - mx) < Math.abs(geo.cx(a) - mx)) return lo + 1;
    return lo;
  };
  const hb = hover ? buckets[hover.i] : null;
  return (
    <div ref={ref} className="an-chart" style={{ height: H }}>
      {geo && (
        <svg
          width={w}
          height={H}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const mx = e.clientX - r.left;
            if (mx < L - 4) return setHover(null);
            setHover({ i: pick(mx), x: mx, y: e.clientY - r.top });
          }}
          onMouseLeave={() => setHover(null)}
          onClick={() => hb && onDrill(hb)}
          style={{ cursor: hb ? "pointer" : undefined }}
        >
          {geo.layer}
          {hb && (
            <g className="an-hover">
              <line x1={geo.cx(hb)} x2={geo.cx(hb)} y1={10} y2={geo.cTop + 50} className="an-guide" />
              <rect
                x={geo.X(hb.start)}
                y={geo.C(hb.count)}
                width={Math.max(1.5, geo.X(hb.end) - geo.X(hb.start))}
                height={Math.max(0.5, geo.cTop + 50 - geo.C(hb.count))}
                className="an-bar hot"
              />
              {Number.isFinite(hb.mean) && <circle cx={geo.cx(hb)} cy={geo.Y(hb.mean)} r={4} className="an-pt hot" />}
              {Number.isFinite(hb.median) && <circle cx={geo.cx(hb)} cy={geo.Y(hb.median)} r={3} className="an-pt2" />}
            </g>
          )}
        </svg>
      )}
      {hb && hover && (
        <Tip x={hover.x} y={hover.y} w={w}>
          <div className="an-tip-h">{hb.label}</div>
          <TipRow k="solves" v={fmtInt(hb.count) + (hb.dnf ? ` · ${hb.dnf} DNF` : "")} />
          <TipRow k="mean" v={fmtAvg(hb.mean, d)} swatch="var(--accent)" strong />
          <TipRow k="median" v={fmtAvg(hb.median, d)} swatch="var(--fg2)" />
          <TipRow k="p10 – p90" v={`${fmtAvg(hb.p10, d)} – ${fmtAvg(hb.p90, d)}`} swatch="color-mix(in srgb, var(--accent) 30%, transparent)" />
          <TipRow k="best" v={fmtSingle(hb.best, d)} />
          <div className="an-tip-foot">click to list solves</div>
        </Tip>
      )}
      <div className="an-legend inline">
        <span className="an-lg static">
          <i className="ln" style={{ background: "var(--accent)" }} /> mean
        </span>
        <span className="an-lg static">
          <i className="ln dash" /> median
        </span>
        <span className="an-lg static">
          <i className="blk" style={{ background: "color-mix(in srgb, var(--accent) 22%, transparent)" }} /> p10–p90
        </span>
        <span className="an-lg static">
          <i className="blk" style={{ background: "color-mix(in srgb, var(--fg) 30%, transparent)" }} /> solves
        </span>
      </div>
    </div>
  );
}

// ================================================================ distribution

const BINS = [0, 100, 250, 500, 1000, 2000] as const;

function autoBin(range: number): number {
  const target = range / 48;
  const opts = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
  return opts.find((o) => o >= target) ?? 60000;
}

type Overlay = "none" | "first1000" | "last1000" | "last100" | "prevYear";

export function DistributionPanel({ ds, rolling, onDrill }: { ds: Dataset; rolling: RollingSet; onDrill: (r: DrillReq) => void }) {
  const d = useStore((s) => s.settings.decimals);
  const [metric, setSrc] = useState<Metric>("single");
  const [binSel, setBinSel] = useState<number>(0);
  const [overlay, setOverlay] = useState<Overlay>("last1000");
  const series = metricSeries(metric, ds.values, rolling);
  const sorted = useMemo(() => cached(series, "sorted", () => finiteSorted(series)), [series]);
  const n = ds.values.length;
  const ovIdx = useMemo((): [number, number] | null => {
    if (overlay === "none") return null;
    if (overlay === "first1000") return [0, Math.min(n, 1000)];
    if (overlay === "last1000") return [Math.max(0, n - 1000), n];
    if (overlay === "last100") return [Math.max(0, n - 100), n];
    // previous 365 days, relative to the newest dated solve
    let last = -Infinity;
    for (let i = 0; i < n; i++) if (ds.dates[i] > last) last = ds.dates[i];
    if (!Number.isFinite(last)) return null;
    let a = n;
    for (let i = 0; i < n; i++)
      if (ds.dates[i] >= last - 365 * 86400000) {
        a = i;
        break;
      }
    return [a, n];
  }, [overlay, n, ds]);
  const view = useMemo(() => {
    if (!sorted.length) return null;
    const range = percentile(sorted, 0.995) - percentile(sorted, 0.005);
    const bin = binSel || autoBin(range);
    const [lo, hi] = histRange(sorted, bin);
    const main = histogram(series, bin, lo, hi);
    const ov = ovIdx ? histogram(series.subarray(ovIdx[0], ovIdx[1]), bin, lo, hi) : null;
    const pct = PERCENTILES.map((p) => ({ p, v: percentile(sorted, p) }));
    return { bin, lo, hi, main, ov, pct };
  }, [sorted, series, binSel, ovIdx]);
  const ovLabel: Record<Overlay, string> = { none: "None", first1000: "First 1000", last1000: "Last 1000", last100: "Last 100", prevYear: "Last 365 days" };
  return (
    <Panel
      title="Distribution"
      sub={
        <>
          {METRIC_LABEL[metric]} · share of solves per bin{view ? ` (${axisSec(view.bin)} s bins)` : ""} · percentile markers · click a bin to list its solves
        </>
      }
      testId="an-distribution"
      right={
        <>
          <label className="an-inline-field">
            <span className="cap">Of</span>
            <select className="input sm" value={metric} onChange={(e) => setSrc(e.target.value as Metric)} data-testid="an-dist-src">
              {(["single", "ao5", "ao12", "ao100"] as Metric[]).map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="an-inline-field">
            <span className="cap">Bin</span>
            <select className="input sm" value={binSel} onChange={(e) => setBinSel(+e.target.value)} data-testid="an-bin">
              {BINS.map((b) => (
                <option key={b} value={b}>
                  {b ? axisSec(b) + " s" : "Auto"}
                </option>
              ))}
            </select>
          </label>
          <label className="an-inline-field">
            <span className="cap">Compare</span>
            <select className="input sm" value={overlay} onChange={(e) => setOverlay(e.target.value as Overlay)} data-testid="an-overlay">
              {(Object.keys(ovLabel) as Overlay[]).map((o) => (
                <option key={o} value={o}>
                  {ovLabel[o]}
                </option>
              ))}
            </select>
          </label>
        </>
      }
    >
      {view ? (
        <HistChart
          view={view}
          overlayLabel={overlay === "none" ? null : ovLabel[overlay]}
          fmtV={(v) => fmtAvg(v, d)}
          onBin={(a, b, label) => {
            const idx: number[] = [];
            for (let i = 0; i < series.length; i++) {
              const v = series[i];
              if (Number.isFinite(v) && v >= a && v < b) idx.push(i);
            }
            onDrill({ title: label, idx });
          }}
        />
      ) : (
        <Empty h={280}>No finite {METRIC_LABEL[metric]} yet.</Empty>
      )}
    </Panel>
  );
}

function HistChart({
  view,
  overlayLabel,
  fmtV,
  onBin,
}: {
  view: { bin: number; lo: number; hi: number; main: ReturnType<typeof histogram>; ov: ReturnType<typeof histogram> | null; pct: { p: number; v: number }[] };
  overlayLabel: string | null;
  fmtV: (v: number) => string;
  onBin: (a: number, b: number, label: string) => void;
}) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const H = 280,
    L = 44,
    R = 12,
    T = 44,
    B = 22;
  const { main, ov, bin, lo, hi, pct } = view;
  const geo = useMemo(() => {
    if (!w) return null;
    const share = main.counts.map((c) => (main.total ? c / main.total : 0));
    const oshare = ov ? ov.counts.map((c) => (ov.total ? c / ov.total : 0)) : null;
    const maxS = Math.max(...share, ...(oshare ?? [0])) * 1.08 || 1;
    const X = (v: number) => L + ((v - lo) / (hi - lo)) * (w - L - R);
    const Y = (s: number) => T + (1 - s / maxS) * (H - T - B);
    const nb = main.counts.length;
    const bw = (w - L - R) / nb;
    const yt = niceTicks(0, maxS, 4);
    const xt = niceTicks(lo, hi, Math.max(3, Math.floor((w - L - R) / 70)));
    let ovPath = "";
    if (oshare) {
      ovPath = `M${X(lo)},${Y(0)}`;
      oshare.forEach((s, i) => (ovPath += `L${(L + i * bw).toFixed(1)},${Y(s).toFixed(1)}L${(L + (i + 1) * bw).toFixed(1)},${Y(s).toFixed(1)}`));
      ovPath += `L${X(hi)},${Y(0)}`;
    }
    // percentile labels: greedy placement on up to three rows so they never collide
    const rowEnd = [-1e9, -1e9, -1e9];
    const pm = pct.map(({ p, v }) => {
      const x = X(Math.min(hi, Math.max(lo, v)));
      const lw = 22 + fmtV(v).length * 6.2;
      let row = rowEnd.findIndex((e) => x >= e + 6);
      if (row < 0) row = rowEnd.indexOf(Math.min(...rowEnd));
      rowEnd[row] = x + lw;
      return { p, v, x, row };
    });
    const layer = (
      <g>
        <YAxis ticks={yt} Y={Y} x0={L} x1={w - R} fmt={(s) => Math.round(s * 100) + "%"} />
        {share.map((s, i) => (s > 0 ? <rect key={i} x={L + i * bw + (bw > 4 ? 1 : 0)} y={Y(s)} width={Math.max(0.6, bw - (bw > 4 ? 2 : 0.5))} height={Y(0) - Y(s)} rx={Math.min(2, bw / 3)} className="an-hbar" /> : null))}
        {ovPath && (
          <>
            <path d={ovPath + "Z"} className="an-ovfill" />
            <path d={ovPath} className="an-ovline" />
          </>
        )}
        {pm.map(({ p, v, x, row }) => (
          <g key={p}>
            <line x1={x} x2={x} y1={T - 14 - row * 12} y2={H - B} className={"an-pct" + (p === 0.5 ? " med" : "")} />
            <text x={x + 4} y={T - 8 - row * 12} className="an-pct-l">
              p{Math.round(p * 100)} {fmtV(v)}
            </text>
          </g>
        ))}
        {xt.map((t) => (
          <text key={t} x={X(t)} y={H - 4} className="an-ax" textAnchor="middle">
            {axisSec(t)}
          </text>
        ))}
        <line x1={L} x2={w - R} y1={Y(0)} y2={Y(0)} className="an-gl strong" />
      </g>
    );
    return { layer, bw, share, oshare, X, Y };
  }, [w, main, ov, lo, hi, pct, fmtV]);
  const hi_ = hover?.i;
  const a = hi_ != null ? lo + hi_ * bin : 0,
    b = a + bin;
  const label = hi_ != null ? `${hi_ === 0 && main.under ? "≤ " : ""}${axisSec(a)} – ${hi_ === main.counts.length - 1 && main.over ? "≥ " : ""}${axisSec(b)} s` : "";
  let cum = 0;
  if (hi_ != null) for (let i = 0; i <= hi_; i++) cum += main.counts[i];
  return (
    <div ref={ref} className="an-chart" style={{ height: H }}>
      {geo && (
        <svg
          width={w}
          height={H}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const mx = e.clientX - r.left;
            const i = Math.floor((mx - L) / geo.bw);
            if (i < 0 || i >= main.counts.length) return setHover(null);
            setHover({ i, x: mx, y: e.clientY - r.top });
          }}
          onMouseLeave={() => setHover(null)}
          onClick={() => {
            if (hi_ == null || !main.counts[hi_]) return;
            const lo2 = hi_ === 0 ? -Infinity : a,
              hi2 = hi_ === main.counts.length - 1 ? Infinity : b;
            onBin(lo2, hi2, label);
          }}
          style={{ cursor: hi_ != null && main.counts[hi_] ? "pointer" : undefined }}
        >
          {geo.layer}
          {hi_ != null && <rect x={L + hi_ * geo.bw} y={geo.Y(geo.share[hi_])} width={Math.max(1, geo.bw)} height={geo.Y(0) - geo.Y(geo.share[hi_])} className="an-hbar hot" />}
        </svg>
      )}
      {hover && hi_ != null && (
        <Tip x={hover.x} y={hover.y} w={w}>
          <div className="an-tip-h num">{label}</div>
          <TipRow k="solves" v={fmtInt(main.counts[hi_])} swatch="var(--accent)" strong />
          <TipRow k="share" v={fmtPct(geo!.share[hi_])} />
          <TipRow k="cumulative" v={fmtPct(main.total ? cum / main.total : NaN)} />
          {ov && geo?.oshare && <TipRow k={overlayLabel ?? "compare"} v={fmtPct(geo.oshare[hi_])} swatch="var(--fg)" />}
        </Tip>
      )}
      <div className="an-legend inline">
        <span className="an-lg static">
          <i className="blk" style={{ background: "color-mix(in srgb, var(--accent) 55%, transparent)" }} /> all in scope ({fmtInt(main.total)})
        </span>
        {ov && overlayLabel && (
          <span className="an-lg static">
            <i className="ln" style={{ background: "var(--fg)" }} /> {overlayLabel} ({fmtInt(ov.total)})
          </span>
        )}
        {main.dnf > 0 && <span className="an-lg static dim">{fmtInt(main.dnf)} DNF not shown</span>}
      </div>
    </div>
  );
}

// ================================================================ consistency

export function ConsistencyPanel({ ds, rolling, onWindow }: { ds: Dataset; rolling: RollingSet; onWindow: (label: string, end: number) => void }) {
  const d = useStore((s) => s.settings.decimals);
  const [mode, setMode] = useState<"sd" | "cv">("sd");
  const [win, setWin] = useState<"ao100" | "ao1000">("ao100");
  const series = useMemo(() => cached(rolling[win], "cons-" + mode, () => consistencySeries(rolling[win], mode)), [rolling, win, mode]);
  const fmtY = (v: number) => (mode === "sd" ? fmtSd(v) + " s" : fmtPct(v));
  const has = series.some(Number.isFinite);
  return (
    <Panel
      title="Consistency"
      sub={<>Rolling {mode === "sd" ? "standard deviation" : "coefficient of variation (σ ÷ mean)"} of the counted solves in each {win} window · lower is steadier</>}
      testId="an-consistency"
      right={
        <>
          <div className="seg">
            <button className={mode === "sd" ? "on" : ""} onClick={() => setMode("sd")}>
              σ
            </button>
            <button className={mode === "cv" ? "on" : ""} onClick={() => setMode("cv")}>
              CV
            </button>
          </div>
          <div className="seg">
            <button className={win === "ao100" ? "on" : ""} onClick={() => setWin("ao100")}>
              100
            </button>
            <button className={win === "ao1000" ? "on" : ""} onClick={() => setWin("ao1000")}>
              1000
            </button>
          </div>
        </>
      }
    >
      {has ? (
        <LineChart
          ys={series}
          fmtY={fmtY}
          axisFmt={mode === "sd" ? (v) => (v / 1000).toFixed(v < 10000 ? 1 : 0) : (v) => Math.round(v * 100) + "%"}
          tip={(i) => (
            <>
              <div className="an-tip-h num">
                {win} ending at #{fmtInt(i + 1)}
              </div>
              <TipRow k={mode === "sd" ? "σ" : "CV"} v={fmtY(series[i])} swatch="var(--accent)" strong />
              <TipRow k={win} v={fmtAvg(rolling[win].avg[i], d)} />
              <TipRow k="ended" v={shortDate(ds.solves[i].date)} />
              <div className="an-tip-foot">click to inspect the window</div>
            </>
          )}
          onClick={(i) => onWindow(win, i)}
        />
      ) : (
        <Empty h={240}>Needs at least {win === "ao100" ? 100 : 1000} solves.</Empty>
      )}
    </Panel>
  );
}

/** Index-based line chart with exact hover values. */
function LineChart({ ys, fmtY, axisFmt, tip, onClick, H = 286 }: { ys: Float64Array; fmtY: (v: number) => string; axisFmt: (v: number) => string; tip: (i: number) => ReactNode; onClick?: (i: number) => void; H?: number }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const L = 46,
    R = 12,
    T = 12,
    B = 22;
  const geo = useMemo(() => {
    if (!w) return null;
    const pts = downsample(ys, Math.max(50, Math.floor((w - L - R) / 1.5)));
    if (!pts.length) return null;
    let first = 0;
    while (first < ys.length && !Number.isFinite(ys[first])) first++;
    const n = ys.length;
    const sorted = finiteSorted(ys);
    let lo = percentile(sorted, 0.002),
      hi = percentile(sorted, 0.998);
    const pad = (hi - lo) * 0.1 || hi * 0.1 || 1;
    lo = Math.max(0, lo - pad);
    hi += pad;
    const X = (i: number) => L + ((i - first) / Math.max(1, n - 1 - first)) * (w - L - R);
    const Y = (v: number) => T + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - T - B);
    const line = pathOf(pts.map((p) => [X(p.x), Y(p.y)]));
    const area = line + `L${X(pts[pts.length - 1].x).toFixed(1)},${H - B}L${X(pts[0].x).toFixed(1)},${H - B}Z`;
    const med = percentile(sorted, 0.5);
    const yt = niceTicks(lo, hi, 4);
    const xt = niceTicks(first + 1, n, Math.max(3, Math.floor((w - L - R) / 90)));
    const layer = (
      <g>
        <defs>
          <linearGradient id="an-area-g" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <YAxis ticks={yt} Y={Y} x0={L} x1={w - R} fmt={axisFmt} />
        <path d={area} fill="url(#an-area-g)" />
        <line x1={L} x2={w - R} y1={Y(med)} y2={Y(med)} className="an-ref" />
        <text x={w - R - 2} y={Y(med) - 5} className="an-ax" textAnchor="end">
          median {fmtY(med)}
        </text>
        <path d={line} className="an-line" />
        {xt.map((t) => (
          <text key={t} x={X(t - 1)} y={H - 4} className="an-ax" textAnchor="middle">
            #{fmtInt(t)}
          </text>
        ))}
      </g>
    );
    return { layer, X, Y, first, n };
  }, [w, ys, H, fmtY, axisFmt]);
  const hi_ = hover?.i;
  return (
    <div ref={ref} className="an-chart" style={{ height: H }}>
      {geo && (
        <svg
          width={w}
          height={H}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const mx = e.clientX - r.left;
            const i = Math.round(geo.first + ((mx - L) / (w - L - R)) * (geo.n - 1 - geo.first));
            if (i < geo.first || i >= geo.n || !Number.isFinite(ys[i])) return setHover(null);
            setHover({ i, x: mx, y: e.clientY - r.top });
          }}
          onMouseLeave={() => setHover(null)}
          onClick={() => hi_ != null && onClick?.(hi_)}
          style={{ cursor: hi_ != null && onClick ? "pointer" : undefined }}
        >
          {geo.layer}
          {hi_ != null && (
            <g>
              <line x1={geo.X(hi_)} x2={geo.X(hi_)} y1={12} y2={H - 22} className="an-guide" />
              <circle cx={geo.X(hi_)} cy={geo.Y(ys[hi_])} r={4} className="an-pt hot" />
            </g>
          )}
        </svg>
      )}
      {hover && hi_ != null && (
        <Tip x={hover.x} y={hover.y} w={w}>
          {tip(hi_)}
        </Tip>
      )}
    </div>
  );
}

// ================================================================ improvement chart

export function ImprovementChart({ rep, onMonth }: { rep: ImprovementReport; onMonth: (b: Bucket) => void }) {
  const d = useStore((s) => s.settings.decimals);
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const H = 200,
    L = 46,
    R = 12,
    T = 12,
    B = 22;
  const months = rep.used;
  const geo = useMemo(() => {
    if (!w || months.length < 1) return null;
    const t0 = months[0].start,
      t1 = months[months.length - 1].end;
    const X = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (w - L - R);
    const vals = months.map((m) => m.mean);
    let lo = Math.min(...vals),
      hi = Math.max(...vals);
    const pad = (hi - lo) * 0.12 || 500;
    lo -= pad;
    hi += pad;
    const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const cx = (m: Bucket) => (X(m.start) + X(m.end)) / 2;
    const monthNo = (t: number) => new Date(t).getFullYear() * 12 + new Date(t).getMonth();
    const m0 = monthNo(months[0].start);
    const reg = Number.isFinite(rep.slope) ? [months[0], months[months.length - 1]].map((m) => [cx(m), Y(rep.intercept + rep.slope * (monthNo(m.start) - m0))] as [number, number]) : null;
    const yt = niceTicks(lo, hi, 4);
    const tt = timeTicks(t0, t1, Math.max(3, Math.floor((w - L - R) / 80)));
    const layer = (
      <g>
        <YAxis ticks={yt} Y={Y} x0={L} x1={w - R} />
        {rep.plateaus.map((p, i) => (
          <g key={"p" + i}>
            <rect x={X(Math.max(t0, p.start))} y={T} width={Math.max(2, X(Math.min(t1, p.end)) - X(Math.max(t0, p.start)))} height={H - T - B} className="an-plateau" />
          </g>
        ))}
        {rep.windows.map((wd, i) => (
          <g key={"w" + i}>
            <line x1={X(wd.start)} x2={X(wd.end + 86400000)} y1={H - B - 3} y2={H - B - 3} className="an-win" />
          </g>
        ))}
        {reg && <path d={pathOf(reg)} className="an-reg" />}
        <path d={pathOf(months.map((m) => [cx(m), Y(m.mean)]))} className="an-line" />
        {months.map((m, i) => (
          <circle key={i} cx={cx(m)} cy={Y(m.mean)} r={2.6} className="an-pt" />
        ))}
        {tt.map((t) => (
          <text key={t.t} x={X(t.t)} y={H - 4} className="an-ax" textAnchor="middle">
            {t.label}
          </text>
        ))}
      </g>
    );
    return { layer, X, Y, cx };
  }, [w, months, rep]);
  const hm = hover ? months[hover.i] : null;
  const prev = hover && hover.i > 0 ? months[hover.i - 1] : null;
  return (
    <div ref={ref} className="an-chart" style={{ height: H }}>
      {geo && (
        <svg
          width={w}
          height={H}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const mx = e.clientX - r.left;
            let best = -1,
              bd = Infinity;
            months.forEach((m, i) => {
              const dd = Math.abs(geo.cx(m) - mx);
              if (dd < bd) (bd = dd), (best = i);
            });
            setHover(best >= 0 ? { i: best, x: mx, y: e.clientY - r.top } : null);
          }}
          onMouseLeave={() => setHover(null)}
          onClick={() => hm && onMonth(hm)}
          style={{ cursor: hm ? "pointer" : undefined }}
        >
          {geo.layer}
          {hm && (
            <g>
              <line x1={geo.cx(hm)} x2={geo.cx(hm)} y1={12} y2={H - 22} className="an-guide" />
              <circle cx={geo.cx(hm)} cy={geo.Y(hm.mean)} r={4.5} className="an-pt hot" />
            </g>
          )}
        </svg>
      )}
      {hm && hover && (
        <Tip x={hover.x} y={hover.y} w={w}>
          <div className="an-tip-h">{hm.label}</div>
          <TipRow k="mean" v={fmtAvg(hm.mean, d)} swatch="var(--accent)" strong />
          <TipRow k="median" v={fmtAvg(hm.median, d)} />
          <TipRow k="solves" v={fmtInt(hm.count)} />
          {prev && <TipRow k={"vs " + prev.label} v={fmtDelta(hm.mean - prev.mean)} />}
          <div className="an-tip-foot">click to list solves</div>
        </Tip>
      )}
      <div className="an-legend inline">
        <span className="an-lg static">
          <i className="ln" style={{ background: "var(--accent)" }} /> monthly mean
        </span>
        <span className="an-lg static">
          <i className="ln dash" /> trend
        </span>
        <span className="an-lg static">
          <i className="blk" style={{ background: "color-mix(in srgb, var(--fg) 9%, transparent)", boxShadow: "inset 0 0 0 1px var(--line2)" }} /> plateau
        </span>
        <span className="an-lg static">
          <i className="ln" style={{ background: "var(--good)" }} /> fastest 30 days
        </span>
      </div>
    </div>
  );
}
