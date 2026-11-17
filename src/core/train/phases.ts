/** Phase-split statistics for 3x3 solves recorded with cross / F2L / OLL / PLL splits. */
import type { PhaseRec } from "./types";

export const PHASE_NAMES = ["Cross", "F2L", "OLL", "PLL"];

/** Per-phase durations from cumulative splits. */
export function phaseDurations(splits: number[]): number[] {
  return splits.map((t, i) => t - (i ? splits[i - 1] : 0));
}

export interface PhaseBreakdown {
  n: number;
  /** mean duration per phase (ms) */
  means: number[];
  /** mean total (ms) */
  total: number;
  /** share of each phase in the mean total */
  share: number[];
}

/** Mean breakdown over the most recent `last` complete 4-phase records. */
export function phaseBreakdown(recs: PhaseRec[], last = 50): PhaseBreakdown {
  const ok = recs.filter((r) => r.splits.length === 4 && r.splits.every((x, i) => Number.isFinite(x) && x >= (i ? r.splits[i - 1] : 0))).slice(-last);
  const n = ok.length;
  const sums = [0, 0, 0, 0];
  for (const r of ok) phaseDurations(r.splits).forEach((d, i) => (sums[i] += d));
  const means = sums.map((s) => (n ? s / n : NaN));
  const total = n ? means.reduce((a, b) => a + b, 0) : NaN;
  return { n, means, total, share: means.map((m) => (n ? m / total : NaN)) };
}

/**
 * Typical CFOP proportions used only as a neutral reference when suggesting what to
 * practise (cross ≈ 12%, F2L ≈ 50%, OLL ≈ 17%, PLL ≈ 21% of the solve).
 */
export const REFERENCE_SHARE = [0.12, 0.5, 0.17, 0.21];
