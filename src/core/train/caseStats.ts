/** Conventional per-case statistics and a transparent mastery score for the heat grid. */
import { linreg } from "../stats";
import type { Card, DrillRec, RecogRec, TrainState } from "./types";
import { DAY } from "./srs";

export interface CaseStat {
  id: string;
  count: number;
  /** mean of the last 12 successful executions */
  mean: number;
  best: number;
  last5: number[];
  /** least-squares slope in ms per attempt over the last 20 successful executions (negative = improving) */
  trend: number;
  /** failure share of the last 10 executions */
  failRate: number;
  recogCount: number;
  recogAcc: number;
  recogMs: number;
  card?: Card;
  /** 0..1, or null when there is no data at all */
  mastery: number | null;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

export function caseStat(id: string, drill: DrillRec[] | undefined, recog: RecogRec[] | undefined, card: Card | undefined, targetMs: number): CaseStat {
  const d = drill ?? [];
  const r = recog ?? [];
  const okTimes = d.filter((x) => !x.failed).map((x) => x.ms);
  const last12 = okTimes.slice(-12);
  const m = mean(last12);
  const best = okTimes.length ? Math.min(...okTimes) : NaN;
  const t20 = okTimes.slice(-20);
  const trend = t20.length >= 4 ? linreg(t20.map((_, i) => i), t20).slope : NaN;
  const last10 = d.slice(-10);
  const failRate = last10.length ? last10.filter((x) => x.failed).length / last10.length : 0;
  const r20 = r.slice(-20);
  const recogAcc = r20.length ? r20.filter((x) => x.ok).length / r20.length : NaN;
  const recogMs = mean(r20.filter((x) => x.ok).map((x) => x.ms));

  let mastery: number | null = null;
  if (d.length) {
    const speed = Number.isFinite(m) ? clamp01((3 * targetMs - m) / (2 * targetMs)) : 0;
    const success = 1 - failRate;
    const rec = Number.isFinite(recogAcc) ? recogAcc : success;
    const retention = card ? clamp01(card.interval / 21) : 0;
    // confidence: fewer than 5 executions cannot be "mastered"
    const conf = Math.min(1, d.length / 5);
    mastery = clamp01((0.45 * speed + 0.25 * success + 0.15 * rec + 0.15 * retention) * (0.6 + 0.4 * conf));
  } else if (r.length) {
    const rspeed = Number.isFinite(recogMs) ? clamp01((4000 - recogMs) / 3000) : 0;
    mastery = 0.5 * clamp01(0.7 * (recogAcc || 0) + 0.3 * rspeed);
  }
  return { id, count: d.length, mean: m, best, last5: d.slice(-5).map((x) => (x.failed ? -x.ms : x.ms)), trend, failRate, recogCount: r.length, recogAcc, recogMs, card, mastery };
}

export function targetFor(state: TrainState, caseId: string) {
  return caseId.startsWith("OLL") ? state.prefs.targetOLL : state.prefs.targetPLL;
}

export function allStats(state: TrainState, ids: string[]): Map<string, CaseStat> {
  const out = new Map<string, CaseStat>();
  for (const id of ids) out.set(id, caseStat(id, state.drill[id], state.recog[id], state.srs[id], targetFor(state, id)));
  return out;
}

/** Records within the last `days` days across all cases (for weekly targets). */
export function countSince<T extends { at: number }>(recs: Record<string, T[]> | T[], since: number): number {
  const lists = Array.isArray(recs) ? [recs] : Object.values(recs);
  let n = 0;
  for (const l of lists) for (const r of l) if (r.at >= since) n++;
  return n;
}

export const weekAgo = (now: number) => now - 7 * DAY;
