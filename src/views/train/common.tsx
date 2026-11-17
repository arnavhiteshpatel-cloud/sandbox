/** Shared training UI pieces: navigation state, set picker, heat grid, small stat blocks. */
import { useMemo, type ReactNode } from "react";
import { create } from "zustand";
import { Menu, useMenu } from "../../ui/Overlay";
import { IconChevronDown } from "../../ui/icons";
import { useTrain } from "../../data/trainStore";
import { setOptions, setLabel, resolveSet } from "../../core/train/sets";
import { getCase, shortName } from "../../core/train/cases";
import { allStats, type CaseStat } from "../../core/train/caseStats";
import { fmtSingle } from "../../core/time";
import { heat } from "./diagram";

export type Tab = "library" | "recognition" | "drill" | "cross" | "f2l" | "phases" | "plan";

/** Ephemeral UI state: an ad-hoc case list (e.g. "weak cases" launched from the plan). */
interface Nav {
  adhoc: { label: string; ids: string[] } | null;
  openCase: string | null;
  setAdhoc(a: Nav["adhoc"]): void;
  setOpenCase(id: string | null): void;
}
export const useTrainNav = create<Nav>((set) => ({
  adhoc: null,
  openCase: null,
  setAdhoc: (adhoc) => set({ adhoc }),
  setOpenCase: (openCase) => set({ openCase }),
}));

export const ADHOC = "adhoc";

/** Resolve a set key (including the ad-hoc list) to case ids. */
export function useSetIds(key: string): string[] {
  const s = useTrain((t) => t.s);
  const adhoc = useTrainNav((n) => n.adhoc);
  return useMemo(() => (key === ADHOC ? adhoc?.ids ?? [] : resolveSet(s, key, Date.now())), [s, key, adhoc]);
}

export function SetPicker({ value, onChange, testId }: { value: string; onChange: (k: string) => void; testId?: string }) {
  const s = useTrain((t) => t.s);
  const adhoc = useTrainNav((n) => n.adhoc);
  const menu = useMenu();
  const opts = useMemo(() => setOptions(s, Date.now()), [s]);
  const label = value === ADHOC ? adhoc?.label ?? "Custom" : setLabel(s, value);
  const count = value === ADHOC ? adhoc?.ids.length ?? 0 : opts.find((o) => o.key === value)?.ids.length ?? 0;
  return (
    <>
      <button className="tr-picker" onClick={menu.open} data-testid={testId}>
        <span className="cap">Set</span>
        <span className="v">{label}</span>
        <span className="n num">{count}</span>
        <IconChevronDown size={12} />
      </button>
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          minWidth={240}
          items={[
            { group: "Algorithm sets" },
            ...opts.slice(0, 2).map((o) => ({ label: o.label, meta: o.ids.length, selected: o.key === value, onSelect: () => onChange(o.key), testId: "set-" + o.key })),
            { group: "By status" },
            ...opts.slice(2, 5).map((o) => ({ label: o.label, meta: o.ids.length, selected: o.key === value, onSelect: () => onChange(o.key), testId: "set-" + o.key })),
            ...(opts.length > 5 ? [{ group: "Collections" }, ...opts.slice(5).map((o) => ({ label: o.label, meta: o.ids.length, selected: o.key === value, onSelect: () => onChange(o.key) }))] : []),
            ...(adhoc ? [{ sep: true }, { label: adhoc.label, meta: adhoc.ids.length, selected: value === ADHOC, onSelect: () => onChange(ADHOC) }] : []),
          ]}
        />
      )}
    </>
  );
}

export function Stat({ label, value, sub, accent, testId }: { label: string; value: ReactNode; sub?: ReactNode; accent?: boolean; testId?: string }) {
  return (
    <div className="tr-stat" data-testid={testId}>
      <span className="cap">{label}</span>
      <b className={"num" + (accent ? " acc" : "")}>{value}</b>
      {sub != null && <span className="sub">{sub}</span>}
    </div>
  );
}

/** cubing.js writes half turns as "R2'"; show the conventional "R2". */
export const tidyScramble = (s: string) => s.replace(/2'/g, "2");

export const sec = (ms: number, d = 2) => (Number.isFinite(ms) ? fmtSingle(ms, d) : "–");

/** Heat grid of case mastery. */
export function HeatGrid({ ids, onPick, current, compact }: { ids: string[]; onPick?: (id: string) => void; current?: string | null; compact?: boolean }) {
  const s = useTrain((t) => t.s);
  const stats = useMemo(() => allStats(s, ids), [s, ids]);
  return (
    <div className={"tr-heat" + (compact ? " compact" : "")} data-testid="heat-grid">
      {ids.map((id) => {
        const st = stats.get(id)!;
        const c = getCase(id)!;
        return (
          <button
            key={id}
            className={"hc" + (current === id ? " cur" : "") + (st.mastery == null ? " none" : "")}
            style={{ ["--h" as any]: heat(st.mastery) }}
            onClick={() => onPick?.(id)}
            title={heatTitle(c.name, st)}
          >
            <span>{shortName(c)}</span>
          </button>
        );
      })}
    </div>
  );
}

function heatTitle(name: string, st: CaseStat) {
  if (st.mastery == null) return `${name} · no data yet`;
  const parts = [`${name} · mastery ${Math.round(st.mastery * 100)}%`];
  if (st.count) parts.push(`${st.count} drills · mean ${sec(st.mean)}${st.failRate ? ` · ${Math.round(st.failRate * 100)}% failed` : ""}`);
  if (st.recogCount) parts.push(`recognition ${Math.round(st.recogAcc * 100)}%`);
  return parts.join("\n");
}

export function HeatLegend() {
  return (
    <div className="tr-legend cap">
      <span>weak</span>
      <i style={{ background: "linear-gradient(90deg, var(--bad), var(--warn), var(--good))" }} />
      <span>mastered</span>
      <i className="none" />
      <span>no data</span>
    </div>
  );
}

/** Tiny sparkline of times (failed entries drawn as red dots). */
export function Spark({ values, width = 120, height = 28 }: { values: { ms: number; bad?: boolean }[]; width?: number; height?: number }) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const fin = values.map((v) => v.ms);
  const lo = Math.min(...fin),
    hi = Math.max(...fin);
  const X = (i: number) => 2 + (i / (values.length - 1)) * (width - 4);
  const Y = (v: number) => 3 + (1 - (v - lo) / Math.max(1, hi - lo)) * (height - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v.ms).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} className="tr-spark">
      <path d={d} />
      {values.map((v, i) => (v.bad ? <circle key={i} cx={X(i)} cy={Y(v.ms)} r={2} className="bad" /> : null))}
    </svg>
  );
}

export function TrendBadge({ slope }: { slope: number }) {
  if (!Number.isFinite(slope)) return <span className="dim">–</span>;
  const per10 = (slope * 10) / 1000;
  const improving = slope < 0;
  if (Math.abs(per10) < 0.02) return <span className="dim">flat</span>;
  return (
    <span className={improving ? "good" : "bad"} title="least-squares slope over the last 20 successful executions, per 10 attempts">
      {improving ? "↓" : "↑"} {Math.abs(per10).toFixed(2)}s/10
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="tr-empty">{children}</div>;
}
