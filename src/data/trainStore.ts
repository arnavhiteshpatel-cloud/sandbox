/**
 * Training state (zustand). Stored as a single JSON value under the "train.state" setting,
 * written through the app backend with a short debounce (and flushed on page hide).
 */
import { create } from "zustand";
import { useStore } from "./store";
import { newId } from "../core/ids";
import { emptyTrainState, sanitizeTrainState, type Card, type CaseUser, type LearnStatus, type TrainPrefs, type TrainState, type CrossRec, type TimedRec, type PhaseRec } from "../core/train/types";
import { gradeExecution, review } from "../core/train/srs";
import { targetFor } from "../core/train/caseStats";

const KEY = "train.state";
const CAP_CASE = 60;
const CAP_LIST = 2000;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: TrainState | null = null;

function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const value = pending;
  pending = null;
  if (!value) return;
  const be = useStore.getState().backend;
  if (!be) return;
  be.apply([{ t: "setSetting", key: KEY, value }]).catch((e) => {
    console.error(e);
    useStore.getState().toast("Could not save training data.", "error");
  });
}

function schedule(s: TrainState) {
  pending = s;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 700);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
}

export interface LastReview {
  id: string;
  prevCard: Card | undefined;
  at: number;
  ms: number;
}

interface TrainStore {
  s: TrainState;
  lastReview: LastReview | null;
  set(fn: (s: TrainState) => TrainState): void;
  setPref<K extends keyof TrainPrefs>(k: K, v: TrainPrefs[K]): void;
  patchCase(id: string, patch: Partial<CaseUser>): void;
  setStatus(id: string, status: LearnStatus): void;
  addCustomAlg(id: string, alg: string): void;
  removeCustomAlg(id: string, alg: string): void;
  createCollection(name: string, caseIds?: string[]): string;
  renameCollection(cid: string, name: string): void;
  deleteCollection(cid: string): void;
  toggleInCollection(cid: string, caseId: string): void;
  recordDrill(id: string, ms: number, failed: boolean): void;
  setLastFailed(failed: boolean): void;
  recordRecog(id: string, ms: number, ok: boolean, ans?: string): void;
  recordCross(r: CrossRec): void;
  recordTimed(r: TimedRec): void;
  removeTimed(at: number): void;
  recordPhase(r: PhaseRec): void;
  removePhase(at: number): void;
  resetCaseStats(id: string): void;
}

function initial(): TrainState {
  try {
    return sanitizeTrainState((useStore.getState().settings as unknown as Record<string, unknown>)[KEY]);
  } catch {
    return emptyTrainState();
  }
}

const push = <T,>(arr: T[] | undefined, x: T, cap: number) => [...(arr ?? []), x].slice(-cap);

export const useTrain = create<TrainStore>((set, get) => {
  const update = (fn: (s: TrainState) => TrainState) => {
    const next = fn(get().s);
    set({ s: next });
    schedule(next);
  };
  return {
    s: initial(),
    lastReview: null,
    set: update,
    setPref: (k, v) => update((s) => ({ ...s, prefs: { ...s.prefs, [k]: v } })),
    patchCase: (id, patch) => update((s) => ({ ...s, cases: { ...s.cases, [id]: { ...s.cases[id], ...patch } } })),
    setStatus: (id, status) =>
      update((s) => ({ ...s, cases: { ...s.cases, [id]: { ...s.cases[id], status, learnedAt: status === "learned" ? Date.now() : s.cases[id]?.learnedAt } } })),
    addCustomAlg: (id, alg) =>
      update((s) => {
        const cu = s.cases[id] ?? {};
        if (cu.custom?.includes(alg)) return s;
        return { ...s, cases: { ...s.cases, [id]: { ...cu, custom: [...(cu.custom ?? []), alg] } } };
      }),
    removeCustomAlg: (id, alg) =>
      update((s) => {
        const cu = s.cases[id] ?? {};
        return { ...s, cases: { ...s.cases, [id]: { ...cu, custom: (cu.custom ?? []).filter((a) => a !== alg), preferred: cu.preferred === alg ? undefined : cu.preferred } } };
      }),
    createCollection: (name, caseIds = []) => {
      const id = newId("col_");
      update((s) => ({ ...s, collections: [...s.collections, { id, name, caseIds, createdAt: Date.now() }] }));
      return id;
    },
    renameCollection: (cid, name) => update((s) => ({ ...s, collections: s.collections.map((c) => (c.id === cid ? { ...c, name } : c)) })),
    deleteCollection: (cid) =>
      update((s) => ({
        ...s,
        collections: s.collections.filter((c) => c.id !== cid),
        prefs: {
          ...s.prefs,
          drillSet: s.prefs.drillSet === "col:" + cid ? "PLL" : s.prefs.drillSet,
          recogSet: s.prefs.recogSet === "col:" + cid ? "PLL" : s.prefs.recogSet,
        },
      })),
    toggleInCollection: (cid, caseId) =>
      update((s) => ({
        ...s,
        collections: s.collections.map((c) => (c.id !== cid ? c : { ...c, caseIds: c.caseIds.includes(caseId) ? c.caseIds.filter((x) => x !== caseId) : [...c.caseIds, caseId] })),
      })),
    recordDrill: (id, ms, failed) => {
      const now = Date.now();
      const s = get().s;
      const prevCard = s.srs[id];
      const card = review(prevCard, gradeExecution(ms, failed, targetFor(s, id)), now);
      set({ lastReview: { id, prevCard, at: now, ms } });
      update((s) => ({ ...s, drill: { ...s.drill, [id]: push(s.drill[id], { ms, at: now, ...(failed ? { failed } : {}) }, CAP_CASE) }, srs: { ...s.srs, [id]: card } }));
    },
    setLastFailed: (failed) => {
      const lr = get().lastReview;
      if (!lr) return;
      update((s) => {
        const list = (s.drill[lr.id] ?? []).map((r) => (r.at === lr.at ? { ...r, failed } : r));
        const card = review(lr.prevCard, gradeExecution(lr.ms, failed, targetFor(s, lr.id)), lr.at);
        return { ...s, drill: { ...s.drill, [lr.id]: list }, srs: { ...s.srs, [lr.id]: card } };
      });
    },
    recordRecog: (id, ms, ok, ans) => update((s) => ({ ...s, recog: { ...s.recog, [id]: push(s.recog[id], { ms, ok, at: Date.now(), ...(ans && !ok ? { ans } : {}) }, CAP_CASE) } })),
    recordCross: (r) => update((s) => ({ ...s, cross: push(s.cross, r, CAP_LIST) })),
    recordTimed: (r) => update((s) => ({ ...s, timed: push(s.timed, r, CAP_LIST) })),
    removeTimed: (at) => update((s) => ({ ...s, timed: s.timed.filter((r) => r.at !== at) })),
    recordPhase: (r) => update((s) => ({ ...s, phases: push(s.phases, r, CAP_LIST) })),
    removePhase: (at) => update((s) => ({ ...s, phases: s.phases.filter((r) => r.at !== at) })),
    resetCaseStats: (id) =>
      update((s) => {
        const drill = { ...s.drill };
        const recog = { ...s.recog };
        const srs = { ...s.srs };
        delete drill[id];
        delete recog[id];
        delete srs[id];
        return { ...s, drill, recog, srs };
      }),
  };
});

/** Re-read from the app settings (e.g. after a backup restore). */
export function reloadTrainState() {
  useTrain.setState({ s: initial(), lastReview: null });
}
