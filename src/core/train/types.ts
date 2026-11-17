/** Persistent training state (stored as one JSON value under the "train.state" setting). */

export type LearnStatus = "none" | "learning" | "learned";

/** SM-2 card for one algorithm case. Intervals are in days; `due` is an epoch ms timestamp. */
export interface Card {
  ef: number;
  reps: number;
  interval: number;
  due: number;
  lapses: number;
  last: number;
}

export interface CaseUser {
  status?: LearnStatus;
  /** user-added algorithms (validated) */
  custom?: string[];
  /** preferred algorithm (exact string; one of built-in or custom) */
  preferred?: string;
  notes?: string;
  /** when the status was last set to "learned" */
  learnedAt?: number;
}

export interface Collection {
  id: string;
  name: string;
  caseIds: string[];
  createdAt: number;
}

/** One timed execution of a case in the drill. `ms` excludes nothing: recognition + execution. */
export interface DrillRec {
  ms: number;
  at: number;
  failed?: boolean;
}

export interface RecogRec {
  ms: number;
  at: number;
  ok: boolean;
  /** the (wrong) answer given */
  ans?: string;
}

export interface CrossRec {
  at: number;
  colour: number;
  optimal: number;
  ok: boolean;
  planMs: number;
}

export interface TimedRec {
  at: number;
  ms: number;
  mode: "f2l" | "ls";
  scramble: string;
}

export interface PhaseRec {
  at: number;
  /** cumulative split timestamps: cross, F2L, OLL, PLL(total) */
  splits: number[];
  scramble: string;
}

export interface TrainPrefs {
  tab: string;
  drillSet: string;
  drillShowCase: boolean;
  recogSet: string;
  recogMode: "full" | "2side";
  crossColour: number; // 0..5 colour index or -1 = colour neutral
  crossPlanSec: number;
  f2lMode: "f2l" | "ls";
  f2lCross: "white" | "yellow";
  phaseInspection: boolean;
  libSet: "OLL" | "PLL";
  targetPLL: number;
  targetOLL: number;
}

export interface TrainState {
  v: 1;
  cases: Record<string, CaseUser>;
  collections: Collection[];
  srs: Record<string, Card>;
  drill: Record<string, DrillRec[]>;
  recog: Record<string, RecogRec[]>;
  cross: CrossRec[];
  timed: TimedRec[];
  phases: PhaseRec[];
  prefs: TrainPrefs;
}

export const DEFAULT_PREFS: TrainPrefs = {
  tab: "library",
  drillSet: "PLL",
  drillShowCase: false,
  recogSet: "PLL",
  recogMode: "full",
  crossColour: 0,
  crossPlanSec: 15,
  f2lMode: "f2l",
  f2lCross: "white",
  phaseInspection: true,
  libSet: "PLL",
  targetPLL: 2500,
  targetOLL: 2200,
};

export function emptyTrainState(): TrainState {
  return { v: 1, cases: {}, collections: [], srs: {}, drill: {}, recog: {}, cross: [], timed: [], phases: [], prefs: { ...DEFAULT_PREFS } };
}

/** Accept anything loaded from storage and return a well-formed state. */
export function sanitizeTrainState(raw: unknown): TrainState {
  const e = emptyTrainState();
  if (!raw || typeof raw !== "object") return e;
  const r = raw as Partial<TrainState>;
  const obj = <T,>(x: unknown, d: T): T => (x && typeof x === "object" && !Array.isArray(x) ? (x as T) : d);
  const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return {
    v: 1,
    cases: obj(r.cases, e.cases),
    collections: arr<Collection>(r.collections).filter((c) => c && typeof c.id === "string" && Array.isArray(c.caseIds)),
    srs: obj(r.srs, e.srs),
    drill: obj(r.drill, e.drill),
    recog: obj(r.recog, e.recog),
    cross: arr(r.cross),
    timed: arr(r.timed),
    phases: arr<PhaseRec>(r.phases).filter((p) => p && Array.isArray(p.splits)),
    prefs: { ...DEFAULT_PREFS, ...obj(r.prefs, {}) },
  };
}
