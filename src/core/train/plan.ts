/**
 * Deterministic practice plan. Every suggestion is computed from the stored training data
 * with fixed rules and carries a plain-language explanation of the rule that produced it.
 */
import { caseLabel, casesOfSet, getCase } from "./cases";
import { allStats, countSince, targetFor, weekAgo } from "./caseStats";
import { isDue, overdueDays, DAY } from "./srs";
import { phaseBreakdown, PHASE_NAMES, REFERENCE_SHARE } from "./phases";
import type { TrainState } from "./types";

/** A common beginner-to-advanced PLL learning order (easy, frequent cases first). */
export const PLL_ORDER = ["Ua", "Ub", "T", "Aa", "Ab", "Jb", "H", "Z", "Ja", "Y", "F", "Ra", "Rb", "V", "Ga", "Gb", "Gc", "Gd", "E", "Na", "Nb"].map((n) => "PLL-" + n);
/** OLL: short 2-look-friendly shapes first, then by group. */
export const OLL_ORDER = [27, 26, 21, 22, 23, 24, 25, 45, 44, 43, 33, 37, 35, 51, 48, 47, 52, 55, 56, 53, 54, 49, 50, 31, 32, 28, 57, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 9, 10, 29, 30, 39, 40, 41, 42, 34, 46, 36, 38, 1, 2, 3, 4, 17, 18, 19, 20].map((n) => "OLL" + n);

export type PlanAction = { tab: "drill" | "recognition" | "cross" | "f2l" | "phases" | "library"; set?: string; ids?: string[] };

export interface PlanItem {
  title: string;
  detail: string;
  why: string;
  minutes: number;
  action: PlanAction;
  ids?: string[];
}

export interface Target {
  label: string;
  current: number;
  goal: number;
  unit: string;
  why: string;
  /** lower is better (e.g. none yet) */
  pct: number;
}

export interface Plan {
  due: { id: string; overdue: number }[];
  weakExec: { id: string; mean: number; target: number; failRate: number; score: number }[];
  weakRecog: { id: string; acc: number; ms: number }[];
  mix: PlanItem[];
  targets: Target[];
  nextToLearn: string[];
}

const sec = (ms: number) => (ms / 1000).toFixed(2) + "s";
const names = (ids: string[]) => ids.map((id) => caseLabel(getCase(id)!)).join(", ");

export function computePlan(state: TrainState, now: number): Plan {
  const ids = [...casesOfSet("PLL"), ...casesOfSet("OLL")].map((c) => c.id);
  const stats = allStats(state, ids);

  const due = ids
    .filter((id) => isDue(state.srs[id], now))
    .map((id) => ({ id, overdue: overdueDays(state.srs[id], now) }))
    .sort((a, b) => b.overdue - a.overdue);

  // weakest execution: ratio of mean to target, plus failure share; needs ≥ 3 executions
  const weakExec = ids
    .map((id) => stats.get(id)!)
    .filter((s) => s.count >= 3 && Number.isFinite(s.mean))
    .map((s) => {
      const target = targetFor(state, s.id);
      return { id: s.id, mean: s.mean, target, failRate: s.failRate, score: s.mean / target + s.failRate * 1.5 };
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const weakRecog = ids
    .map((id) => stats.get(id)!)
    .filter((s) => s.recogCount >= 3 && (s.recogAcc < 0.9 || s.recogMs > 2000))
    .map((s) => ({ id: s.id, acc: s.recogAcc, ms: s.recogMs }))
    .sort((a, b) => a.acc - b.acc || b.ms - a.ms)
    .slice(0, 6);

  const status = (id: string) => state.cases[id]?.status ?? "none";
  const learningIds = ids.filter((id) => status(id) === "learning");
  const pllLeft = PLL_ORDER.filter((id) => status(id) === "none");
  const nextToLearn = (pllLeft.length ? pllLeft : OLL_ORDER.filter((id) => status(id) === "none")).slice(0, 3);

  const mix: PlanItem[] = [];
  if (due.length) {
    mix.push({
      title: `Due reviews · ${due.length} case${due.length === 1 ? "" : "s"}`,
      detail: names(due.slice(0, 8).map((d) => d.id)) + (due.length > 8 ? ` +${due.length - 8}` : ""),
      why: "Spaced repetition (SM-2): these cases reached their review date. Reviewing on time is what keeps intervals growing.",
      minutes: Math.max(2, Math.round(due.length * 0.4)),
      action: { tab: "drill", set: "due" },
      ids: due.map((d) => d.id),
    });
  }
  if (weakExec.length) {
    const w = weakExec.slice(0, 4);
    mix.push({
      title: `Weak-case drill · ${names(w.map((x) => x.id))}`,
      detail: w.map((x) => `${caseLabel(getCase(x.id)!)} ${sec(x.mean)}${x.failRate ? ` · ${Math.round(x.failRate * 100)}% failed` : ""}`).join("  ·  "),
      why: "Ranked by mean of the last 12 executions divided by your target time, plus 1.5× the recent failure share. Only cases with ≥ 3 executions count.",
      minutes: 5,
      action: { tab: "drill", ids: w.map((x) => x.id) },
      ids: w.map((x) => x.id),
    });
  }
  if (weakRecog.length) {
    mix.push({
      title: `Recognition · ${names(weakRecog.slice(0, 4).map((x) => x.id))}`,
      detail: weakRecog
        .slice(0, 4)
        .map((x) => `${caseLabel(getCase(x.id)!)} ${Math.round(x.acc * 100)}%`)
        .join("  ·  "),
      why: "Below 90% recognition accuracy or slower than 2 s over the last 20 attempts.",
      minutes: 3,
      action: { tab: "recognition", ids: weakRecog.map((x) => x.id) },
      ids: weakRecog.map((x) => x.id),
    });
  }
  if (learningIds.length) {
    mix.push({
      title: `Learning queue · ${learningIds.length} case${learningIds.length === 1 ? "" : "s"}`,
      detail: names(learningIds.slice(0, 8)),
      why: "Cases you marked as learning are weighted up in the drill until you mark them learned.",
      minutes: Math.max(3, Math.min(10, learningIds.length * 1.5)),
      action: { tab: "drill", set: "learning" },
      ids: learningIds,
    });
  }
  if (learningIds.length < 3 && nextToLearn.length) {
    mix.push({
      title: `Start learning · ${names(nextToLearn)}`,
      detail: pllLeft.length ? "Next PLLs in a common learning order (easy, frequent cases first)." : "Next OLLs, short shapes first.",
      why: `Only ${learningIds.length} case${learningIds.length === 1 ? " is" : "s are"} in your learning queue; keeping 2–3 there keeps progress steady without overload.`,
      minutes: 5,
      action: { tab: "library" },
      ids: nextToLearn,
    });
  }

  const recent = (arr: { at: number }[], n: number) => arr.slice(-n);
  const cross20 = recent(state.cross, 20) as typeof state.cross;
  const crossRate = cross20.length ? cross20.filter((c) => c.ok).length / cross20.length : NaN;
  if (!cross20.length || crossRate < 0.8) {
    mix.push({
      title: "Cross planning · 10 scrambles",
      detail: cross20.length ? `Planning success ${Math.round(crossRate * 100)}% over the last ${cross20.length}.` : "No cross planning recorded yet.",
      why: "Planning the whole cross during inspection is the cheapest time saving in CFOP; aim for ≥ 80% success.",
      minutes: 5,
      action: { tab: "cross" },
    });
  }

  const pb = phaseBreakdown(state.phases);
  if (pb.n >= 5) {
    // phase with the largest excess over the reference share
    let worst = -1,
      excess = 0;
    pb.share.forEach((s, i) => {
      const e = s - REFERENCE_SHARE[i];
      if (e > excess) {
        excess = e;
        worst = i;
      }
    });
    if (worst >= 0 && excess > 0.03) {
      const tab = worst === 0 ? "cross" : worst === 1 ? "f2l" : "drill";
      mix.push({
        title: `${PHASE_NAMES[worst]} focus`,
        detail: `${PHASE_NAMES[worst]} takes ${Math.round(pb.share[worst] * 100)}% of your solve (reference ≈ ${Math.round(REFERENCE_SHARE[worst] * 100)}%).`,
        why: `From ${pb.n} solves recorded with phase splits: this phase exceeds the typical CFOP share the most.`,
        minutes: 8,
        action: worst >= 2 ? { tab, set: worst === 2 ? "OLL" : "PLL" } : { tab },
      });
    }
  } else {
    mix.push({
      title: "Record 5 solves with phase splits",
      detail: pb.n ? `${pb.n} recorded so far.` : "No phase-split solves yet.",
      why: "Phase splits show where your time actually goes; with ≥ 5 the plan can point at the slowest phase.",
      minutes: 4,
      action: { tab: "phases" },
    });
  }

  // ---------- weekly targets ----------
  const since = weekAgo(now);
  const drillWeek = countSince(state.drill, since);
  const drillPrev = countSince(state.drill, since - 7 * DAY) - drillWeek;
  const drillGoal = Math.max(100, Math.min(600, Math.round((drillPrev * 1.1) / 10) * 10));
  const recogAll = Object.values(state.recog).flat().sort((a, b) => a.at - b.at).slice(-50);
  const recogAcc = recogAll.length ? recogAll.filter((r) => r.ok).length / recogAll.length : 0;
  const learnedWeek = ids.filter((id) => (state.cases[id]?.learnedAt ?? 0) >= since && status(id) === "learned").length;
  const crossWeek = state.cross.filter((c) => c.at >= since).length;
  const phasesWeek = state.phases.filter((p) => p.at >= since).length;
  const t = (label: string, current: number, goal: number, unit: string, why: string): Target => ({ label, current, goal, unit, why, pct: Math.max(0, Math.min(1, goal ? current / goal : 1)) });
  const targets: Target[] = [
    t("Drill executions", drillWeek, drillGoal, "", drillPrev ? `10% above last week (${drillPrev}), between 100 and 600.` : "Baseline of 100 executions per week."),
    t("New cases learned", learnedWeek, 3, "", "Three new algorithms a week is sustainable alongside reviews."),
    t("Recognition accuracy", Math.round(recogAcc * 100), 95, "%", recogAll.length ? `Last ${recogAll.length} recognition answers.` : "No recognition answers yet."),
    t("Cross plans", crossWeek, 30, "", "About four planned crosses a day."),
    t("Phase-split solves", phasesWeek, 10, "", "Keeps the phase breakdown current."),
  ];

  return { due, weakExec, weakRecog, mix, targets, nextToLearn };
}
