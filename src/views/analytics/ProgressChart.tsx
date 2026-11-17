/**
 * All-time progression: every solve as a dot, rolling averages, PB-single staircase.
 * uPlot (canvas) keeps 20k+ points interactive. Drag to zoom, wheel to zoom, shift/horizontal
 * wheel to pan, double-click or "Reset" to zoom out. Clicking a dot opens that solve.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useStore } from "../../data/store";
import { fmtAvg, fmtDate, fmtSolve } from "../../core/time";
import { runningBest, type Dataset, type Metric, type RollingSet } from "../../core/analytics";
import { axisSec, cached, cssVar, Empty, fmtInt, Panel, useThemeKey, withAlpha } from "./common";

type LineKey = "ao5" | "ao12" | "ao100" | "ao1000" | "pb";
const LINES: { k: LineKey; label: string }[] = [
  { k: "ao5", label: "ao5" },
  { k: "ao12", label: "ao12" },
  { k: "ao100", label: "ao100" },
  { k: "ao1000", label: "ao1000" },
  { k: "pb", label: "PB single" },
];

interface Prepared {
  xs: Float64Array;
  /** plotted point -> dataset index */
  map: Int32Array;
  ys: (number | null)[];
  lines: Record<LineKey, (number | null)[]>;
  /** dataset index -> plotted point (or -1) */
  inv: Int32Array;
}

function prepare(ds: Dataset, rolling: RollingSet, xMode: "index" | "date"): Prepared {
  const n = ds.values.length;
  let order: number[];
  if (xMode === "index") order = Array.from({ length: n }, (_, i) => i);
  else {
    order = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(ds.dates[i])) order.push(i);
    // uPlot needs ascending x; dates are almost always sorted already
    let sorted = true;
    for (let k = 1; k < order.length; k++) if (ds.dates[order[k]] < ds.dates[order[k - 1]]) sorted = false;
    if (!sorted) order.sort((a, b) => ds.dates[a] - ds.dates[b] || a - b);
  }
  const m = order.length;
  const xs = new Float64Array(m);
  const map = Int32Array.from(order);
  const inv = new Int32Array(n).fill(-1);
  const ys: (number | null)[] = new Array(m);
  const pbArr = runningBest(ds.values);
  const lines = { ao5: new Array(m), ao12: new Array(m), ao100: new Array(m), ao1000: new Array(m), pb: new Array(m) } as Record<LineKey, (number | null)[]>;
  const src: [LineKey, ArrayLike<number>][] = [
    ["ao5", rolling.ao5.avg],
    ["ao12", rolling.ao12.avg],
    ["ao100", rolling.ao100.avg],
    ["ao1000", rolling.ao1000.avg],
    ["pb", pbArr],
  ];
  for (let k = 0; k < m; k++) {
    const i = order[k];
    inv[i] = k;
    xs[k] = xMode === "index" ? i + 1 : ds.dates[i] / 1000;
    const v = ds.values[i];
    ys[k] = Number.isFinite(v) ? v / 1000 : null;
    for (const [key, arr] of src) {
      const a = arr[i];
      lines[key][k] = Number.isFinite(a) ? a / 1000 : null;
    }
  }
  return { xs, map, ys, lines, inv };
}

function lowerBound(xs: ArrayLike<number>, x: number) {
  let lo = 0,
    hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Robust y range (seconds) of singles + lines within the visible x window. */
function robustY(p: Prepared, a: number, b: number): [number, number] {
  const span = b - a;
  const stride = Math.max(1, Math.floor(span / 6000));
  const vals: number[] = [];
  for (let k = a; k < b; k += stride) {
    const y = p.ys[k];
    if (y != null) vals.push(y);
  }
  let lineMin = Infinity;
  for (let k = a; k < b; k++) {
    const pb = p.lines.pb[k];
    if (pb != null && pb < lineMin) lineMin = pb;
  }
  if (!vals.length) return [0, 60];
  vals.sort((x, y) => x - y);
  const lo = Math.min(vals[Math.floor(vals.length * 0.002)], lineMin);
  const hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))];
  const pad = (hi - lo) * 0.06 || 1;
  return [Math.max(0, lo - pad), hi + pad];
}

export function ProgressChart({ ds, rolling, metric }: { ds: Dataset; rolling: RollingSet; metric: Metric }) {
  const d = useStore((s) => s.settings.decimals);
  const themeKey = useThemeKey();
  const [xMode, setXMode] = useState<"index" | "date">("index");
  const [shown, setShown] = useState<Record<LineKey, boolean>>({ ao5: false, ao12: true, ao100: true, ao1000: true, pb: true });
  const [zoomed, setZoomed] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const effectiveX = xMode === "date" && ds.values.length - ds.undated < 2 ? "index" : xMode;
  const prep = useMemo(() => cached(rolling, "prep-" + effectiveX, () => prepare(ds, rolling, effectiveX)), [ds, rolling, effectiveX]);
  // the metric chosen at the top is always visible and emphasised
  const visible = useMemo(() => {
    const v = { ...shown };
    if (metric !== "single") v[metric] = true;
    return v;
  }, [shown, metric]);
  const visRef = useRef(visible);
  visRef.current = visible;

  useEffect(() => {
    const el = host.current;
    if (!el || prep.xs.length < 1) return;
    const fg = cssVar("--fg");
    const accent = cssVar("--accent", "#7fdcff");
    const good = cssVar("--good", "#5ef2a8");
    const grid = withAlpha(cssVar("--fg"), 0.06);
    const axisCol = withAlpha(fg, 0.42);
    const em = (k: LineKey) => k === metric;
    const lineStyle: Record<LineKey, { stroke: string; width: number; dash?: number[] }> = {
      ao5: { stroke: withAlpha(accent, 0.35), width: 1 },
      ao12: { stroke: withAlpha(accent, 0.32), width: 1 },
      ao100: { stroke: accent, width: 1.6 },
      ao1000: { stroke: withAlpha(fg, 0.9), width: 1.6, dash: [7, 4] },
      pb: { stroke: good, width: 1.4 },
    };
    for (const k of ["ao5", "ao12", "ao100", "ao1000"] as LineKey[]) if (em(k)) lineStyle[k] = { ...lineStyle[k], stroke: k === "ao1000" ? fg : accent, width: 2.4 };
    const full: [number, number] = [prep.xs[0], prep.xs[prep.xs.length - 1] + (effectiveX === "index" ? 0 : 1)];
    const font = `10px ${cssVar("--font-mono", "monospace")}`;
    const fmtX = effectiveX === "index" ? (v: number) => fmtInt(v) : null;
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: el.clientHeight,
      pxAlign: 0,
      legend: { show: false },
      padding: [10, 8, 0, 0],
      cursor: {
        points: { show: false },
        y: false,
        drag: { x: true, y: false, setScale: true },
        dataIdx: (_u, _s, idx) => idx,
      },
      select: { show: true, left: 0, top: 0, width: 0, height: 0 },
      scales: {
        x: { time: effectiveX === "date", range: (_u, mn, mx) => [mn, mx] },
        y: {
          // uPlot stores the visible index window of the pending x range in series[0].idxs
          range: (u) => {
            const idxs = (u.series[0] as unknown as { idxs?: [number | null, number | null] }).idxs;
            const a = idxs?.[0] ?? 0,
              b = idxs?.[1] ?? prep.xs.length - 1;
            return robustY(prep, a, Math.min(prep.xs.length, b + 1));
          },
        },
      },
      axes: [
        {
          stroke: axisCol,
          font,
          grid: { show: false },
          ticks: { show: true, stroke: grid, size: 4 },
          size: 30,
          ...(fmtX ? { values: (_u: uPlot, vals: number[]) => vals.map((v) => fmtX(v)) } : {}),
          space: 80,
        },
        {
          stroke: axisCol,
          font,
          grid: { stroke: grid, width: 1 },
          ticks: { show: false },
          size: 46,
          space: 36,
          values: (_u, vals) => vals.map((v) => axisSec(v * 1000)),
        },
      ],
      series: [
        {},
        {
          label: "single",
          stroke: "transparent",
          fill: withAlpha(fg, prep.xs.length > 8000 ? 0.27 : 0.38),
          width: 0,
          // squares are ~5x cheaper to rasterise than arcs; at 2 px they read as dots
          paths: (u: uPlot, sidx: number, i0: number, i1: number) => {
            const p = new Path2D();
            const sz = (prep.xs.length > 8000 ? 2 : 3) * (window.devicePixelRatio || 1);
            const xd = u.data[0],
              yd = u.data[sidx];
            for (let k = i0; k <= i1; k++) {
              const y = yd[k];
              if (y == null) continue;
              p.rect(Math.round(u.valToPos(xd[k], "x", true) - sz / 2), Math.round(u.valToPos(y as number, "y", true) - sz / 2), sz, sz);
            }
            return { stroke: new Path2D(), fill: p, clip: undefined, flags: 0 };
          },
          points: { show: false },
        },
        ...LINES.map(({ k, label }) => ({
          label,
          show: visRef.current[k],
          stroke: lineStyle[k].stroke,
          width: lineStyle[k].width,
          dash: lineStyle[k].dash,
          spanGaps: false,
          points: { show: false },
          ...(k === "pb" ? { paths: uPlot.paths.stepped!({ align: 1 }) } : {}),
        })),
      ],
      hooks: {
        setScale: [
          (u, key) => {
            if (key !== "x") return;
            const z = (u.scales.x.min ?? full[0]) > full[0] + 1e-9 || (u.scales.x.max ?? full[1]) < full[1] - 1e-9;
            setZoomed(z);
          },
        ],
        setCursor: [(u) => onCursor(u)],
      },
    };
    const data = [prep.xs, prep.ys, ...LINES.map((l) => prep.lines[l.k])] as unknown as uPlot.AlignedData;
    const u = new uPlot(opts, data, el);
    plot.current = u;
    setZoomed(false);

    let nearest = -1;
    function findNearest(u: uPlot, left: number, top: number): number {
      if (left < 0) return -1;
      const xmin = u.posToVal(left - 9, "x"),
        xmax = u.posToVal(left + 9, "x");
      const a = lowerBound(prep.xs, xmin),
        b = Math.min(prep.xs.length, lowerBound(prep.xs, xmax) + 1);
      const step = Math.max(1, Math.floor((b - a) / 3000));
      let best = -1,
        bd = 12 * 12;
      for (let k = a; k < b; k += step) {
        const y = prep.ys[k];
        if (y == null) continue;
        const dx = u.valToPos(prep.xs[k], "x") - left,
          dy = u.valToPos(y, "y") - top;
        const dd = dx * dx + dy * dy;
        if (dd < bd) {
          bd = dd;
          best = k;
        }
      }
      return best;
    }
    function onCursor(u: uPlot) {
      const t = tip.current,
        r = ring.current;
      if (!t || !r) return;
      const { left = -1, top = -1, idx } = u.cursor;
      if (left < 0 || idx == null) {
        t.style.display = "none";
        r.style.display = "none";
        nearest = -1;
        return;
      }
      nearest = findNearest(u, left, top);
      const k = nearest >= 0 ? nearest : idx;
      const i = prep.map[k];
      const s = ds.solves[i];
      const vis = visRef.current;
      const rows: string[] = [];
      const row = (key: string, v: string, sw?: string, strong = false) =>
        `<div class="an-tip-row${strong ? " strong" : ""}"><span class="k">${sw ? `<i class="sw" style="background:${sw}"></i>` : ""}${key}</span><span class="v num">${v}</span></div>`;
      rows.push(`<div class="an-tip-h num">#${fmtInt(i + 1)} · ${fmtDate(s.date)}</div>`);
      rows.push(row("single", fmtSolve(s, d), withAlpha(fg, 0.6), nearest >= 0));
      for (const { k: key, label } of LINES) {
        if (!vis[key]) continue;
        const v = key === "pb" ? prep.lines.pb[k] : prep.lines[key][k];
        const raw = key === "pb" ? (v == null ? NaN : v * 1000) : (rolling[key as Exclude<LineKey, "pb">].avg[i] as number);
        rows.push(row(label, Number.isNaN(raw) ? "–" : fmtAvg(raw, d), lineStyle[key].stroke, key === metric));
      }
      if (nearest >= 0) rows.push(`<div class="an-tip-foot">click to open solve</div>`);
      t.innerHTML = rows.join("");
      t.style.display = "block";
      const w = u.over.clientWidth;
      const tw = t.offsetWidth;
      const ox = u.over.offsetLeft,
        oy = u.over.offsetTop;
      t.style.left = (left + 16 + tw > w ? left - 16 - tw : left + 16) + ox + "px";
      t.style.top = Math.max(0, Math.min(top - 20, u.over.clientHeight - t.offsetHeight)) + oy + "px";
      if (nearest >= 0) {
        r.style.display = "block";
        r.style.left = u.valToPos(prep.xs[nearest], "x") + ox + "px";
        r.style.top = u.valToPos(prep.ys[nearest]!, "y") + oy + "px";
      } else r.style.display = "none";
    }
    // click (without drag) opens the nearest solve
    let down: { x: number; y: number } | null = null;
    const md = (e: MouseEvent) => (down = { x: e.clientX, y: e.clientY });
    const mu = (e: MouseEvent) => {
      if (down && Math.abs(e.clientX - down.x) < 4 && Math.abs(e.clientY - down.y) < 4 && nearest >= 0) {
        useStore.getState().openSolve(ds.solves[prep.map[nearest]].id);
      }
      down = null;
    };
    // wheel: zoom around cursor; shift / horizontal wheel pans
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const xs = u.scales.x;
      const mn = xs.min ?? full[0],
        mx = xs.max ?? full[1];
      const span = mx - mn;
      const pan = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      let nmn: number, nmx: number;
      if (pan) {
        const delta = ((e.shiftKey ? e.deltaY : e.deltaX) / u.over.clientWidth) * span;
        nmn = mn + delta;
        nmx = mx + delta;
        if (nmn < full[0]) (nmx += full[0] - nmn), (nmn = full[0]);
        if (nmx > full[1]) (nmn -= nmx - full[1]), (nmx = full[1]);
      } else {
        const f = Math.exp(e.deltaY * 0.0022);
        const cx = u.posToVal(u.cursor.left ?? u.over.clientWidth / 2, "x");
        nmn = cx - (cx - mn) * f;
        nmx = cx + (mx - cx) * f;
        const minSpan = effectiveX === "index" ? 20 : 3600;
        if (nmx - nmn < minSpan) return;
        nmn = Math.max(full[0], nmn);
        nmx = Math.min(full[1], nmx);
      }
      u.setScale("x", { min: nmn, max: nmx });
    };
    const leave = () => {
      if (tip.current) tip.current.style.display = "none";
      if (ring.current) ring.current.style.display = "none";
    };
    u.over.addEventListener("mousedown", md);
    u.over.addEventListener("mouseup", mu);
    u.over.addEventListener("wheel", wheel, { passive: false });
    u.over.addEventListener("mouseleave", leave);
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [prep, ds, rolling, d, metric, themeKey, effectiveX]);

  // toggle series without rebuilding the chart
  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    LINES.forEach(({ k }, j) => {
      if (u.series[j + 2].show !== visible[k]) u.setSeries(j + 2, { show: visible[k] });
    });
  }, [visible]);

  const reset = () => {
    const u = plot.current;
    if (!u) return;
    u.setScale("x", { min: prep.xs[0], max: prep.xs[prep.xs.length - 1] + (effectiveX === "index" ? 0 : 1) });
  };
  const swatch: Record<LineKey, string> = { ao5: "color-mix(in srgb, var(--accent) 40%, transparent)", ao12: "color-mix(in srgb, var(--accent) 45%, transparent)", ao100: "var(--accent)", ao1000: "var(--fg)", pb: "var(--good)" };

  return (
    <Panel
      title="All-time progression"
      sub={
        <>
          {fmtInt(ds.values.length)} solves · drag to zoom · scroll to zoom · shift-scroll to pan · click a dot to open it
          {effectiveX === "date" && ds.undated > 0 && <> · {fmtInt(ds.undated)} undated solves hidden</>}
        </>
      }
      testId="an-progress"
      right={
        <>
          <div className="an-legend">
            <span className="an-lg static">
              <i className="dot" /> single
            </span>
            {LINES.map(({ k, label }) => {
              const locked = k === metric;
              return (
                <button key={k} className={"an-lg" + (visible[k] ? " on" : "")} onClick={() => !locked && setShown((s) => ({ ...s, [k]: !s[k] }))} title={locked ? "Selected curve metric" : "Show / hide"} data-testid={"an-lg-" + k}>
                  <i className={k === "pb" ? "step" : k === "ao1000" ? "ln dash fg" : "ln"} style={{ background: swatch[k] }} /> {label}
                </button>
              );
            })}
          </div>
          <div className="seg">
            <button className={effectiveX === "index" ? "on" : ""} onClick={() => setXMode("index")}>
              Solve #
            </button>
            <button className={effectiveX === "date" ? "on" : ""} onClick={() => setXMode("date")} disabled={ds.values.length - ds.undated < 2}>
              Date
            </button>
          </div>
          <button className="btn sm" onClick={reset} disabled={!zoomed} data-testid="an-zoom-reset">
            Reset zoom
          </button>
        </>
      }
    >
      {prep.xs.length ? (
        <div className="an-uplot-wrap">
          <div ref={host} className="an-uplot" />
          <div ref={ring} className="an-ring" />
          <div ref={tip} className="an-tip" style={{ display: "none" }} />
        </div>
      ) : (
        <Empty h={360}>No solves in this scope.</Empty>
      )}
    </Panel>
  );
}
