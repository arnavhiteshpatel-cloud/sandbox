/**
 * Case selection = spaced repetition + weakness weighting, as a weighted random draw.
 * Each weight is a sum of explainable terms, returned together with human-readable reasons.
 */
import type { TrainState } from "./types";
import { isDue, overdueDays } from "./srs";
import { caseStat, targetFor } from "./caseStats";

export interface Weighted {
  id: string;
  weight: number;
  reasons: string[];
}

const s = (ms: number) => (ms / 1000).toFixed(2) + "s";

export function drillWeights(state: TrainState, ids: string[], now: number, lastId?: string | null): Weighted[] {
  return ids.map((id) => {
    const card = state.srs[id];
    const target = targetFor(state, id);
    const st = caseStat(id, state.drill[id], state.recog[id], card, target);
    const reasons: string[] = [];
    let w = 0.6;
    if (!card || !st.count) {
      w += 2;
      reasons.push("not drilled yet");
    } else if (isDue(card, now)) {
      const od = overdueDays(card, now);
      w += 3 + Math.min(7, od) * 0.3;
      reasons.push(od >= 1 ? `review overdue by ${Math.floor(od)}d` : "due for review");
    }
    if (Number.isFinite(st.mean) && st.mean > target) {
      const extra = Math.min(2.5, (st.mean / target - 1) * 2);
      w += extra;
      if (extra > 0.3) reasons.push(`slow: mean ${s(st.mean)} vs target ${s(target)}`);
    }
    if (st.failRate > 0) {
      w += st.failRate * 3;
      reasons.push(`${Math.round(st.failRate * 100)}% failed recently`);
    }
    if (state.cases[id]?.status === "learning") {
      w += 0.8;
      reasons.push("marked as learning");
    }
    if (lastId && id === lastId && ids.length > 1) w *= 0.08;
    return { id, weight: w, reasons };
  });
}

export function recogWeights(state: TrainState, ids: string[], lastId?: string | null): Weighted[] {
  return ids.map((id) => {
    const r = state.recog[id] ?? [];
    const reasons: string[] = [];
    let w = 0.8;
    if (!r.length) {
      w += 1.5;
      reasons.push("not seen yet");
    } else {
      const r20 = r.slice(-20);
      const acc = r20.filter((x) => x.ok).length / r20.length;
      if (acc < 1) {
        w += (1 - acc) * 5;
        reasons.push(`${Math.round(acc * 100)}% recognised`);
      }
      const ok = r20.filter((x) => x.ok).map((x) => x.ms);
      const m = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN;
      if (m > 1500) {
        w += Math.min(2, (m - 1500) / 1000);
        reasons.push(`slow recognition (${s(m)})`);
      }
    }
    if (lastId && id === lastId && ids.length > 1) w *= 0.08;
    return { id, weight: w, reasons };
  });
}

/** Weighted random draw. `rand` returns [0,1). */
export function pickWeighted(items: Weighted[], rand: () => number = Math.random): Weighted | null {
  const total = items.reduce((a, b) => a + Math.max(0, b.weight), 0);
  if (!items.length || total <= 0) return items[0] ?? null;
  let x = rand() * total;
  for (const it of items) {
    x -= Math.max(0, it.weight);
    if (x < 0) return it;
  }
  return items[items.length - 1];
}
