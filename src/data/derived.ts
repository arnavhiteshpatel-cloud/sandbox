import { parseAvgLabel, rollingAverage, bestOf, summarize, type AvgSpec, type RollingResult, type SummaryStats } from "../core/stats";
import { solveValue } from "../core/time";
import type { Solve } from "../core/types";

export interface SessionStats {
  values: Float64Array;
  rolling: Map<string, RollingResult>;
  rows: { label: string; spec: AvgSpec; current: number; best: number; bestEnd: number }[];
  summary: SummaryStats;
  /** best single so far at each index (for PB markers) */
  pbSingle: boolean[];
}

const cache = new WeakMap<Solve[], Map<string, SessionStats>>();

/** Compute every statistic for a session's ordered solves. Memoised per solves array. */
export function sessionStats(solves: Solve[], labels: string[], decimals: number, trimPct: number): SessionStats {
  const key = labels.join(",") + "|" + decimals + "|" + trimPct;
  let m = cache.get(solves);
  if (!m) cache.set(solves, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const values = new Float64Array(solves.length);
  const pens = new Float64Array(solves.length);
  for (let i = 0; i < solves.length; i++) {
    values[i] = solveValue(solves[i], decimals);
    pens[i] = solves[i].penalty;
  }
  const rolling = new Map<string, RollingResult>();
  const rows: SessionStats["rows"] = [];
  for (const label of labels) {
    const spec = parseAvgLabel(label);
    if (!spec) continue;
    const r = rollingAverage(values, spec, trimPct);
    rolling.set(label, r);
    const b = bestOf(r.avg);
    rows.push({ label, spec, current: values.length ? r.avg[values.length - 1] : NaN, best: b.value, bestEnd: b.end });
  }
  const pbSingle: boolean[] = [];
  let best = Infinity;
  for (let i = 0; i < values.length; i++) {
    pbSingle.push(values[i] < best);
    if (values[i] < best) best = values[i];
  }
  const res: SessionStats = { values, rolling, rows, summary: summarize(values, pens), pbSingle };
  m.set(key, res);
  return res;
}

/** Ensure the label set includes everything the UI needs (stats rows + list columns + rolling lines). */
export function neededLabels(...lists: string[][]) {
  return [...new Set(lists.flat())].filter((l) => !!parseAvgLabel(l));
}
