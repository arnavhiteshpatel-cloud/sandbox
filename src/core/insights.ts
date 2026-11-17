/** "Advanced" live readouts for the timer screen, all derived from recorded solves only. */
import { averageOf, type AvgSpec } from "./stats";

/**
 * Largest next-solve value (ms, at the given resolution) that would set a new best for `spec`,
 * given the last n-1 values. Returns:
 *   { kind: "any" }        every result (even DNF) sets a PB (no best yet)
 *   { kind: "below", ms }  next solve must be strictly below ms
 *   { kind: "none" }       impossible with any time
 */
export function pbThreshold(values: ArrayLike<number>, spec: AvgSpec, best: number, trimPct = 5, unit = 10):
  | { kind: "any" }
  | { kind: "below"; ms: number }
  | { kind: "none" } {
  const n = spec.n;
  if (values.length < n - 1) return { kind: "none" };
  if (!Number.isFinite(best)) return { kind: "any" };
  const prev: number[] = [];
  for (let i = values.length - (n - 1); i < values.length; i++) prev.push(values[i]);
  const avgWith = (t: number) => averageOf([...prev, t], spec, trimPct);
  if (!(avgWith(0) < best)) return { kind: "none" };
  if (avgWith(Infinity) < best) return { kind: "any" };
  // average is non-decreasing in t: binary search on the grid of `unit`
  let lo = 0,
    hi = 24 * 3600 * 1000;
  while (hi - lo > unit) {
    const mid = Math.floor((lo + hi) / 2 / unit) * unit;
    if (mid <= lo) break;
    if (avgWith(mid) < best) lo = mid;
    else hi = mid;
  }
  // lo is the largest grid value that still works → solve must be < lo + unit
  return { kind: "below", ms: lo + unit };
}

/** Fraction (0..1) of historical finite values that are strictly worse than `v` (higher = better). */
export function percentileRank(history: ArrayLike<number>, v: number): number {
  let total = 0,
    worse = 0;
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (Number.isNaN(h)) continue;
    total++;
    if (h > v) worse++;
  }
  return total ? worse / total : NaN;
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

/** Consecutive days (ending today or yesterday) with at least one solve. */
export function practiceStreak(dates: (number | null)[], now = Date.now()): number {
  const days = new Set<number>();
  for (const d of dates) if (d != null) days.add(dayKey(d));
  let streak = 0;
  const cur = new Date(now);
  cur.setHours(12, 0, 0, 0);
  if (!days.has(dayKey(cur.getTime()))) cur.setDate(cur.getDate() - 1);
  while (days.has(dayKey(cur.getTime()))) {
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

export function isToday(ms: number | null, now = Date.now()) {
  return ms != null && dayKey(ms) === dayKey(now);
}
