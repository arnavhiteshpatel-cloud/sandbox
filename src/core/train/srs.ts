/**
 * Spaced repetition: SuperMemo-2 (Wozniak, 1990) with a short relearning step.
 *
 *   grade q ∈ 0..5;  q < 3 → lapse: repetition count resets and the card is due again in
 *   RELEARN_MIN minutes;  q ≥ 3 → interval 1 d, then 4 d, then round(prev · EF).
 *   EF' = max(1.3, EF + 0.1 − (5 − q)(0.08 + (5 − q)·0.02))
 *
 * Several reviews of the same card on one day are allowed (drilling); a successful review
 * that happens before the card is due does not grow the interval beyond what was already
 * scheduled, so cramming a case 20 times does not push it a year into the future.
 */
import type { Card } from "./types";

export const DAY = 86_400_000;
export const RELEARN_MIN = 10;

export function newCard(now: number): Card {
  return { ef: 2.5, reps: 0, interval: 0, due: now, lapses: 0, last: 0 };
}

export function review(card: Card | undefined, q: number, now: number): Card {
  const c = card ? { ...card } : newCard(now);
  q = Math.max(0, Math.min(5, Math.round(q)));
  c.ef = Math.max(1.3, c.ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (q < 3) {
    if (c.reps > 0) c.lapses++;
    c.reps = 0;
    c.interval = 0;
    c.due = now + RELEARN_MIN * 60_000;
  } else if (card && card.reps > 0 && now < card.due) {
    // early review: keep the schedule (only the ease factor moves)
    c.due = Math.max(card.due, now);
  } else {
    c.reps++;
    c.interval = c.reps === 1 ? 1 : c.reps === 2 ? 4 : Math.round(Math.max(1, c.interval) * c.ef);
    c.due = now + c.interval * DAY;
  }
  c.last = now;
  return c;
}

/**
 * Grade a timed execution: failed/needed help → 1; otherwise by time relative to the target
 * (≤ target → 5, ≤ 1.5× → 4, slower → 3).
 */
export function gradeExecution(ms: number, failed: boolean, targetMs: number): number {
  if (failed) return 1;
  if (ms <= targetMs) return 5;
  if (ms <= targetMs * 1.5) return 4;
  return 3;
}

export const isDue = (c: Card | undefined, now: number) => !!c && c.due <= now;

/** Days overdue (0 if not due). */
export const overdueDays = (c: Card | undefined, now: number) => (c && c.due <= now ? (now - c.due) / DAY : 0);
