/** GitHub-style practice calendar: one year at a time, colour by solve count or by daily mean. */
import { useMemo, useState } from "react";
import { useStore } from "../../data/store";
import { fmtAvg, fmtSingle } from "../../core/time";
import { aggregate, dayKeyOf, type Bucket, type Dataset } from "../../core/analytics";
import { percentile } from "../../core/stats";
import { cached, Empty, fmtInt, Panel, Tip, TipRow, useSize, type DrillReq } from "./common";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Mon", "", "Wed", "", "Fri", "", ""];
const LEVELS = 5;

export function CalendarPanel({ ds, onDrill }: { ds: Dataset; onDrill: (r: DrillReq) => void }) {
  const d = useStore((s) => s.settings.decimals);
  const days = useMemo(() => cached(ds, "agg-day", () => aggregate(ds, "day")), [ds]);
  const byKey = useMemo(() => {
    const m = new Map<number, Bucket>();
    for (const b of days) m.set(dayKeyOf(b.start), b);
    return m;
  }, [days]);
  const years = useMemo(() => [...new Set(days.map((b) => new Date(b.start).getFullYear()))].sort((a, b) => a - b), [days]);
  const [yearSel, setYear] = useState<number | null>(null);
  const year = yearSel != null && years.includes(yearSel) ? yearSel : years[years.length - 1];
  const [mode, setMode] = useState<"count" | "mean">("count");
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ b: Bucket | null; t: number; x: number; y: number } | null>(null);

  const yearDays = useMemo(() => days.filter((b) => new Date(b.start).getFullYear() === year), [days, year]);
  const ySum = useMemo(() => {
    let n = 0,
      s = 0,
      c = 0;
    for (const b of yearDays) {
      n += b.count;
      if (b.n) (s += b.mean * b.n), (c += b.n);
    }
    return { solves: n, days: yearDays.length, mean: c ? s / c : NaN };
  }, [yearDays]);

  // thresholds for colour levels (quantiles over the year's active days)
  const scale = useMemo(() => {
    const vals = yearDays.map((b) => (mode === "count" ? b.count : b.mean)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!vals.length) return { lv: () => 0, edges: [] as number[] };
    const edges = [0.2, 0.4, 0.6, 0.8].map((p) => percentile(vals, p));
    const lv = (v: number) => {
      if (!Number.isFinite(v)) return 0;
      let k = 0;
      while (k < edges.length && (mode === "count" ? v > edges[k] : v < edges[edges.length - 1 - k])) k++;
      return k + 1; // 1..5
    };
    return { lv, edges };
  }, [yearDays, mode]);

  const L = 34,
    T = 22;
  const cell = w ? Math.max(8, Math.min(22, Math.floor((w - L - 4) / 53) - 3)) : 12;
  const g = 3;
  const grid = useMemo(() => {
    if (year == null) return null;
    const jan1 = new Date(year, 0, 1);
    const offset = (jan1.getDay() + 6) % 7; // Monday-based row of Jan 1
    const n = (new Date(year + 1, 0, 1).getTime() - jan1.getTime()) / 86400000;
    const cells: { t: number; col: number; row: number; b: Bucket | null }[] = [];
    const monthCols: { m: number; col: number }[] = [];
    for (let i = 0; i < Math.round(n); i++) {
      const dt = new Date(year, 0, 1 + i);
      const pos = offset + i;
      const col = Math.floor(pos / 7),
        row = pos % 7;
      if (dt.getDate() === 1) monthCols.push({ m: dt.getMonth(), col: row === 0 ? col : col + 1 });
      const key = year * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate();
      cells.push({ t: dt.getTime(), col, row, b: byKey.get(key) ?? null });
    }
    const at = new Map(cells.map((c) => [c.col * 8 + c.row, c]));
    return { cells, at, monthCols, cols: Math.floor((offset + n - 1) / 7) + 1 };
  }, [year, byKey]);
  const rx = Math.min(3, cell / 4);
  // one path per colour level: ~6 DOM nodes instead of 365
  const levelPaths = useMemo(() => {
    const out = new Array<string>(LEVELS + 1).fill("");
    if (!grid) return out;
    const r = rx,
      e = cell - 2 * r;
    for (const c of grid.cells) {
      const lv = c.b ? scale.lv(mode === "count" ? c.b.count : c.b.mean) : 0;
      const x = L + c.col * (cell + g),
        y = T + c.row * (cell + g);
      out[lv] += `M${x + r},${y}h${e}a${r},${r} 0 0 1 ${r},${r}v${e}a${r},${r} 0 0 1 ${-r},${r}h${-e}a${r},${r} 0 0 1 ${-r},${-r}v${-e}a${r},${r} 0 0 1 ${r},${-r}z`;
    }
    return out;
  }, [grid, scale, mode, cell, rx]);

  const H = T + 7 * (cell + g);
  const idx = years.indexOf(year);
  return (
    <Panel
      title="Practice calendar"
      sub={
        year != null ? (
          <>
            {year}: <b className="num">{fmtInt(ySum.solves)}</b> solves on <b className="num">{ySum.days}</b> days · mean <b className="num">{fmtAvg(ySum.mean, d)}</b> · click a day to list its solves
          </>
        ) : undefined
      }
      testId="an-calendar"
      right={
        years.length ? (
          <>
            <div className="seg">
              <button className={mode === "count" ? "on" : ""} onClick={() => setMode("count")}>
                Solves
              </button>
              <button className={mode === "mean" ? "on" : ""} onClick={() => setMode("mean")}>
                Mean
              </button>
            </div>
            <div className="an-year">
              <button className="btn ghost sm" disabled={idx <= 0} onClick={() => setYear(years[idx - 1])} aria-label="Previous year">
                ‹
              </button>
              <select className="input sm num" value={year} onChange={(e) => setYear(+e.target.value)} data-testid="an-year">
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <button className="btn ghost sm" disabled={idx >= years.length - 1} onClick={() => setYear(years[idx + 1])} aria-label="Next year">
                ›
              </button>
            </div>
          </>
        ) : undefined
      }
    >
      {grid ? (
        <div ref={ref} className="an-chart an-cal" style={{ height: H + 26 }}>
          {w > 0 && (
            <svg
              width={L + grid.cols * (cell + g)}
              height={H}
              data-testid="an-cal-svg"
              onMouseLeave={() => setHover(null)}
              onMouseMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const mx = e.clientX - r.left - L,
                  my = e.clientY - r.top - T;
                const col = Math.floor(mx / (cell + g)),
                  row = Math.floor(my / (cell + g));
                const c = mx >= 0 && my >= 0 && mx % (cell + g) < cell && my % (cell + g) < cell ? grid.at.get(col * 8 + row) : undefined;
                if (!c) return hover && setHover(null);
                if (hover?.t !== c.t) setHover({ b: c.b, t: c.t, x: L + col * (cell + g) + cell, y: T + row * (cell + g) });
              }}
              onClick={() => hover?.b && onDrill({ title: hover.b.label, idx: hover.b.idx })}
              style={{ cursor: hover?.b ? "pointer" : undefined }}
            >
              {grid.monthCols.map(({ m, col }) => (
                <text key={m} x={L + col * (cell + g)} y={12} className="an-ax">
                  {MONTHS[m]}
                </text>
              ))}
              {WD.map((l, r) =>
                l ? (
                  <text key={r} x={L - 8} y={T + r * (cell + g) + cell / 2 + 3.5} className="an-ax" textAnchor="end">
                    {l}
                  </text>
                ) : null,
              )}
              {levelPaths.map((d, lv) => (d ? <path key={lv} d={d} className={"an-cell l" + lv} /> : null))}
              {hover && <rect x={hover.x - cell} y={hover.y} width={cell} height={cell} rx={rx} className="an-cell hot" />}
            </svg>
          )}
          {hover && (
            <Tip x={hover.x} y={hover.y} w={w}>
              <div className="an-tip-h num">{new Date(hover.t).toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</div>
              {hover.b ? (
                <>
                  <TipRow k="solves" v={fmtInt(hover.b.count) + (hover.b.dnf ? ` · ${hover.b.dnf} DNF` : "")} strong={mode === "count"} />
                  <TipRow k="mean" v={fmtAvg(hover.b.mean, d)} strong={mode === "mean"} />
                  <TipRow k="best" v={fmtSingle(hover.b.best, d)} />
                </>
              ) : (
                <div className="dim" style={{ fontSize: 12 }}>
                  No solves
                </div>
              )}
            </Tip>
          )}
          <div className="an-cal-legend">
            <span className="dim">{mode === "count" ? "fewer" : "slower"}</span>
            {Array.from({ length: LEVELS + 1 }, (_, k) => (
              <i key={k} className={"an-cell-sw l" + k} />
            ))}
            <span className="dim">{mode === "count" ? "more" : "faster"}</span>
          </div>
        </div>
      ) : (
        <Empty h={140}>No dated solves in this scope.</Empty>
      )}
    </Panel>
  );
}
