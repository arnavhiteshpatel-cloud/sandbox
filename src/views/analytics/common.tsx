/** Shared building blocks for the Analytics screen: panels, tooltips, scales, drill-down modal. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Modal } from "../../ui/Overlay";
import { useStore } from "../../data/store";
import { fmtAvg, fmtDate, fmtSingle, fmtSolve } from "../../core/time";
import { summarize } from "../../core/stats";
import type { Dataset } from "../../core/analytics";

// ---------------------------------------------------------------- layout

export function Panel({ title, sub, right, children, className, testId }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={"an-panel glass-edge " + (className ?? "")} data-testid={testId}>
      <header className="an-ph">
        <div className="an-ph-l">
          <h2 className="an-title">{title}</h2>
          {sub && <div className="an-sub">{sub}</div>}
        </div>
        {right && <div className="an-ph-r">{right}</div>}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children, h = 160 }: { children: ReactNode; h?: number }) {
  return (
    <div className="an-empty" style={{ height: h }}>
      {children}
    </div>
  );
}

/** Element size via ResizeObserver (content box, integer px). */
export function useSize<T extends HTMLElement>(): [RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const upd = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// ---------------------------------------------------------------- tooltip

/** Floating tooltip anchored at (x, y) inside a positioned container of width `w`; flips to stay inside. */
export function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tw, setTw] = useState(180);
  useLayoutEffect(() => {
    if (ref.current) setTw(ref.current.offsetWidth);
  });
  const left = x + 14 + tw > w ? Math.max(0, x - 14 - tw) : x + 14;
  return (
    <div ref={ref} className="an-tip" style={{ left, top: Math.max(0, y - 10) }}>
      {children}
    </div>
  );
}

export function TipRow({ k, v, swatch, strong }: { k: ReactNode; v: ReactNode; swatch?: string; strong?: boolean }) {
  return (
    <div className={"an-tip-row" + (strong ? " strong" : "")}>
      <span className="k">
        {swatch && <i className="sw" style={{ background: swatch }} />}
        {k}
      </span>
      <span className="v num">{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------- scales & formatting

/** "Nice" tick values covering [lo, hi] with roughly `count` ticks. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 2.25 ? 2 : norm < 3.5 ? 2.5 : norm < 7.5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Axis label for a ms value: 12.5 → "12.5", 75000 → "1:15". */
export function axisSec(ms: number): string {
  const s = ms / 1000;
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${m}:${String(Math.round(r)).padStart(2, "0")}`;
  }
  return Number.isInteger(+s.toFixed(2)) ? String(Math.round(s)) : s.toFixed(s < 10 ? 2 : 1).replace(/0$/, "");
}

const NF = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const fmtInt = (n: number) => (Number.isFinite(n) ? NF.format(Math.round(n)) : "–");

// ---------------------------------------------------------------- memo across mounts

const derivedCache = new WeakMap<object, Map<string, unknown>>();
/**
 * Memoise a derived value on an object's identity (e.g. a Dataset) plus a key. Unlike
 * useMemo this survives unmounting, so returning to the Analytics view is instant.
 */
export function cached<T>(owner: object, key: string, fn: () => T): T {
  let m = derivedCache.get(owner);
  if (!m) derivedCache.set(owner, (m = new Map()));
  if (m.has(key)) return m.get(key) as T;
  const v = fn();
  m.set(key, v);
  return v;
}
export const fmtPct = (x: number, digits = 1) => (Number.isFinite(x) ? (x * 100).toFixed(digits) + "%" : "–");
export const fmtSd = (ms: number) => (Number.isFinite(ms) ? (ms / 1000).toFixed(2) : "–");

export function fmtDays(days: number | null): string {
  if (days == null || !Number.isFinite(days)) return "–";
  if (days < 1) return "same day";
  if (days < 60) return `${Math.round(days)} d`;
  if (days < 730) return `${(days / 30.44).toFixed(1)} mo`;
  return `${(days / 365.25).toFixed(1)} y`;
}

export function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h.toLocaleString("en-US")} h ${m} m` : `${m} m`;
}

/** Signed seconds delta: -0.42 → "−0.42 s". */
export function fmtDelta(ms: number, unit = " s"): string {
  if (!Number.isFinite(ms)) return "–";
  const sign = ms > 0 ? "+" : ms < 0 ? "−" : "±";
  return sign + (Math.abs(ms) / 1000).toFixed(2) + unit;
}

export const shortDate = (ms: number | null) => fmtDate(ms, false);

// ---------------------------------------------------------------- canvas colours

/** Resolve a CSS custom property to a concrete colour string (for canvas drawing). */
export function cssVar(name: string, fallback = "#ffffff"): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Apply an alpha multiplier to a hex/rgb/rgba colour. */
export function withAlpha(color: string, a: number): string {
  const c = color.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((x) => x + x).join("");
    const r = parseInt(h.slice(0, 2), 16),
      g = parseInt(h.slice(2, 4), 16),
      b = parseInt(h.slice(4, 6), 16);
    const a0 = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return `rgba(${r},${g},${b},${+(a0 * a).toFixed(3)})`;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const a0 = parts.length > 3 ? parts[3] : 1;
    return `rgba(${parts[0]},${parts[1]},${parts[2]},${+(a0 * a).toFixed(3)})`;
  }
  return c;
}

/** Re-render when the theme or accent changes (canvas charts must re-read colours). */
export function useThemeKey() {
  const theme = useStore((s) => s.settings.theme);
  const accent = useStore((s) => s.settings.accent);
  const key = theme + "|" + accent;
  // App applies theme variables in its own effect, which runs after ours: settle a frame later
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    if (settled === key) return;
    const r = requestAnimationFrame(() => setSettled(key));
    return () => cancelAnimationFrame(r);
  }, [key, settled]);
  return settled;
}

// ---------------------------------------------------------------- drill-down

const ROW_H = 34;

/**
 * Modal listing the solves behind a bar/day/period. The table is virtualised, so even a
 * selection of 20k solves opens instantly.
 */
export function DrillModal({ title, sub, ds, idx, onClose }: { title: ReactNode; sub?: ReactNode; ds: Dataset; idx: number[]; onClose: () => void }) {
  const d = useStore((s) => s.settings.decimals);
  const openSolve = useStore((s) => s.openSolve);
  const [order, setOrder] = useState<"asc" | "desc" | "fast">("asc");
  const rows = useMemo(() => {
    if (order === "asc") return idx;
    if (order === "desc") return [...idx].reverse();
    return [...idx].sort((a, b) => ds.values[a] - ds.values[b] || a - b);
  }, [idx, order, ds]);
  const sum = useMemo(() => summarize(idx.map((i) => ds.values[i])), [idx, ds]);
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const viewH = Math.min(520, Math.max(ROW_H * 4, rows.length * ROW_H));
  const first = Math.max(0, Math.floor(top / ROW_H) - 6);
  const last = Math.min(rows.length, Math.ceil((top + viewH) / ROW_H) + 6);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    setTop(0);
  }, [order]);
  return (
    <Modal title={title} onClose={onClose} wide testId="an-drill">
      <div className="an-drill-head">
        <div className="an-drill-stats num">
          <span>
            <b>{fmtInt(sum.count)}</b> solves
          </span>
          <span>
            mean <b>{fmtAvg(sum.mean, d)}</b>
          </span>
          <span>
            median <b>{fmtAvg(sum.median, d)}</b>
          </span>
          <span>
            best <b>{fmtSingle(sum.best, d)}</b>
          </span>
          <span>
            σ <b>{fmtSd(sum.sd)}</b>
          </span>
          {sum.dnf > 0 && (
            <span>
              DNF <b>{sum.dnf}</b>
            </span>
          )}
          {sub}
        </div>
        <div className="seg">
          {(
            [
              ["asc", "Oldest"],
              ["desc", "Newest"],
              ["fast", "Fastest"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={order === v ? "on" : ""} onClick={() => setOrder(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="an-drill-tbl">
        <div className="an-drill-row an-drill-th">
          <span>#</span>
          <span className="r">Time</span>
          <span>Date</span>
          <span>Scramble</span>
          <span>Comment</span>
        </div>
        <div ref={scroller} className="an-drill-scroll" style={{ height: viewH }} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
          <div style={{ height: rows.length * ROW_H, position: "relative" }}>
            {rows.slice(first, last).map((i, k) => {
              const s = ds.solves[i];
              return (
                <button key={s.id} className="an-drill-row" style={{ top: (first + k) * ROW_H }} onClick={() => openSolve(s.id)} data-testid="an-drill-row">
                  <span className="dim num">{fmtInt(i + 1)}</span>
                  <span className={"r num" + (s.penalty < 0 ? " bad" : "")}>{fmtSolve(s, d)}</span>
                  <span className="dim num">{fmtDate(s.date)}</span>
                  <span className="mono scr">{s.scramble}</span>
                  <span className="dim cmt">{s.comment}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export interface DrillReq {
  title: ReactNode;
  sub?: ReactNode;
  idx: number[];
}
