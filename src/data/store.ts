/**
 * Application state (zustand). All persistent mutations go through `commit()`, which
 *  1. writes the operation to a synchronous localStorage journal (crash safety),
 *  2. updates memory optimistically,
 *  3. persists via the backend in one atomic transaction,
 *  4. records an undo/redo entry.
 * The journal is replayed on startup, so a completed solve is never silently lost even
 * if the app is killed between the timer stopping and the database write.
 */
import { create } from "zustand";
import type { ImportRecord, Op, Session, Solve } from "../core/types";
import { getBackend, type Backend } from "./backend";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { newId } from "../core/ids";
import { solveFingerprint } from "../core/importer";

export type View = "timer" | "history" | "analytics" | "train" | "sessions" | "settings";

export interface Toast {
  id: string;
  text: string;
  kind?: "info" | "error" | "success";
  action?: { label: string; run: () => void };
}

interface Change {
  label: string;
  solves: { prev: Solve | null; next: Solve | null }[];
  sessions: { prev: Session | null; next: Session | null }[];
}

const JOURNAL_KEY = "facelet.journal.v1";
let initStarted = false;

function readJournal(): { id: string; ops: Op[] }[] {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) || "[]");
  } catch {
    return [];
  }
}
function writeJournal(j: { id: string; ops: Op[] }[]) {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(j));
  } catch {
    /* storage full / unavailable: database write still proceeds */
  }
}

export interface AppStore {
  ready: boolean;
  fatal: string | null;
  backend: Backend | null;
  sessions: Session[];
  solves: Solve[];
  settings: Settings;
  imports: ImportRecord[];
  currentSessionId: string;
  view: View;
  toasts: Toast[];
  undoStack: Change[];
  redoStack: Change[];
  /** true while the timer is holding/inspecting/running (UI hides chrome). */
  timing: boolean;
  /** id of solve detail sheet currently open */
  openSolveId: string | null;
  saving: number;

  init(): Promise<void>;
  reload(): Promise<void>;
  setView(v: View): void;
  toast(text: string, kind?: Toast["kind"], action?: Toast["action"]): void;
  dismissToast(id: string): void;
  setTiming(t: boolean): void;
  openSolve(id: string | null): void;

  addSolve(s: { time: number; penalty: number; splits?: number[] | null; scramble: string; comment?: string; sessionId?: string }): Solve;
  updateSolves(ids: string[], fn: (s: Solve) => Partial<Solve>, label: string): void;
  deleteSolves(ids: string[]): void;
  restoreSolves(ids: string[]): void;
  moveSolves(ids: string[], toSessionId: string): void;

  createSession(p: { name: string; event?: string; phases?: number }): string;
  updateSession(id: string, patch: Partial<Session>, label?: string): void;
  deleteSession(id: string): void;
  mergeSessions(sourceIds: string[], targetId: string, mode: "append" | "chronological"): void;
  splitSession(id: string, fromIndex: number, name: string): string;
  reorderSessions(ids: string[]): void;
  setCurrentSession(id: string): void;

  updateSettings(patch: Partial<Settings>): void;
  undo(): void;
  redo(): void;
}

const liveSorted = (solves: Solve[], sessionId: string) =>
  solves.filter((s) => s.sessionId === sessionId && !s.deletedAt).sort((a, b) => a.ord - b.ord);

export const useStore = create<AppStore>((set, get) => {
  /** Persist a change set (records only), journaling first. */
  async function persist(ops: Op[]) {
    const be = get().backend!;
    const jid = newId("j_");
    const j = readJournal();
    j.push({ id: jid, ops });
    writeJournal(j);
    set((s) => ({ saving: s.saving + 1 }));
    try {
      await be.apply(ops);
      writeJournal(readJournal().filter((x) => x.id !== jid));
    } catch (e) {
      console.error(e);
      get().toast("Could not save to the database — the change is kept in the recovery journal and will be retried on next launch.", "error");
    } finally {
      set((s) => ({ saving: s.saving - 1 }));
    }
  }

  function applyLocal(solvePuts: Solve[], solveDeletes: string[], sessionPuts: Session[], sessionDeletes: string[]) {
    set((st) => {
      let solves = st.solves;
      if (solvePuts.length || solveDeletes.length) {
        const map = new Map(solves.map((s) => [s.id, s]));
        for (const s of solvePuts) map.set(s.id, s);
        for (const id of solveDeletes) map.delete(id);
        solves = [...map.values()];
      }
      let sessions = st.sessions;
      if (sessionPuts.length || sessionDeletes.length) {
        const map = new Map(sessions.map((s) => [s.id, s]));
        for (const s of sessionPuts) map.set(s.id, s);
        for (const id of sessionDeletes) map.delete(id);
        sessions = [...map.values()];
      }
      return { solves, sessions };
    });
  }

  function run(change: Change, record = true) {
    const solvePuts = change.solves.filter((c) => c.next).map((c) => c.next!);
    const solveDel = change.solves.filter((c) => !c.next).map((c) => c.prev!.id);
    const sesPuts = change.sessions.filter((c) => c.next).map((c) => c.next!);
    const sesDel = change.sessions.filter((c) => !c.next).map((c) => c.prev!.id);
    applyLocal(solvePuts, solveDel, sesPuts, sesDel);
    const ops: Op[] = [];
    if (sesPuts.length) ops.push({ t: "putSessions", sessions: sesPuts });
    if (solvePuts.length) ops.push({ t: "putSolves", solves: solvePuts });
    if (solveDel.length) ops.push({ t: "hardDeleteSolves", ids: solveDel });
    if (sesDel.length) ops.push({ t: "hardDeleteSessions", ids: sesDel });
    if (record) set((s) => ({ undoStack: [...s.undoStack.slice(-199), change], redoStack: [] }));
    return persist(ops);
  }

  const invert = (c: Change): Change => ({
    label: c.label,
    solves: c.solves.map((x) => ({ prev: x.next, next: x.prev })),
    sessions: c.sessions.map((x) => ({ prev: x.next, next: x.prev })),
  });

  const solveById = (id: string) => get().solves.find((s) => s.id === id);

  return {
    ready: false,
    fatal: null,
    backend: null,
    sessions: [],
    solves: [],
    settings: DEFAULT_SETTINGS,
    imports: [],
    currentSessionId: "",
    view: "timer",
    toasts: [],
    undoStack: [],
    redoStack: [],
    timing: false,
    openSolveId: null,
    saving: 0,

    async init() {
      if (initStarted) return;
      initStarted = true;
      try {
        const backend = await getBackend();
        set({ backend });
        // Replay any journaled operations that may not have reached the database.
        const journal = readJournal();
        for (const entry of journal) {
          try {
            await backend.apply(entry.ops);
          } catch (e) {
            console.error("journal replay failed", e);
          }
        }
        if (journal.length) writeJournal([]);
        await get().reload();
        if (journal.length) get().toast(`Recovered ${journal.length} unsaved change(s) from the crash-recovery journal.`, "success");
        set({ ready: true });
      } catch (e) {
        console.error(e);
        set({ fatal: String((e as Error)?.message ?? e) });
      }
    },

    async reload() {
      const be = get().backend!;
      const data = await be.load();
      const settings: Settings = { ...DEFAULT_SETTINGS, ...(data.settings as Partial<Settings>) };
      let sessions = data.sessions;
      let current = String(data.settings.currentSessionId ?? "");
      if (!sessions.some((s) => !s.deletedAt)) {
        const now = Date.now();
        const s: Session = {
          id: newId("ses_"),
          name: "Session 1",
          rank: 1,
          event: "333",
          phases: 1,
          opt: { autoCreated: true },
          createdAt: now,
          updatedAt: now,
          importId: null,
          sourceKey: null,
          archived: false,
          deletedAt: null,
        };
        await be.apply([{ t: "putSessions", sessions: [s] }]);
        sessions = [...sessions, s];
      }
      if (!sessions.some((s) => s.id === current && !s.deletedAt)) {
        current = [...sessions].filter((s) => !s.deletedAt).sort((a, b) => a.rank - b.rank)[0].id;
      }
      set({ sessions, solves: data.solves, settings, imports: data.imports, currentSessionId: current, undoStack: [], redoStack: [] });
      import("./trainStore").then((m) => (m as any).reloadTrainState?.()).catch(() => {});
    },

    setView(v) {
      set({ view: v });
    },
    toast(text, kind = "info", action) {
      const id = newId();
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind, action }] }));
      setTimeout(() => get().dismissToast(id), action ? 7000 : 4200);
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
    setTiming(t) {
      if (get().timing !== t) set({ timing: t });
    },
    openSolve(id) {
      set({ openSolveId: id });
    },

    addSolve(p) {
      const st = get();
      const sessionId = p.sessionId ?? st.currentSessionId;
      const ses = st.sessions.find((s) => s.id === sessionId)!;
      const list = st.solves.filter((s) => s.sessionId === sessionId);
      const ord = list.reduce((m, s) => Math.max(m, s.ord), -1) + 1;
      const now = Date.now();
      const base = { time: Math.round(p.time), penalty: p.penalty, splits: p.splits ?? null, scramble: p.scramble, date: now };
      const solve: Solve = {
        id: newId("sol_"),
        sessionId,
        ord,
        ...base,
        comment: p.comment ?? "",
        event: ses?.event ?? "333",
        importId: null,
        fp: solveFingerprint(base),
        extra: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      run({ label: "Add solve", solves: [{ prev: null, next: solve }], sessions: [] });
      return solve;
    },

    updateSolves(ids, fn, label) {
      const now = Date.now();
      const changes = ids
        .map((id) => solveById(id))
        .filter((s): s is Solve => !!s)
        .map((prev) => {
          const next = { ...prev, ...fn(prev), updatedAt: now };
          next.fp = solveFingerprint(next);
          return { prev, next };
        });
      if (changes.length) run({ label, solves: changes, sessions: [] });
    },

    deleteSolves(ids) {
      const now = Date.now();
      get().updateSolves(ids, () => ({ deletedAt: now }), ids.length === 1 ? "Delete solve" : `Delete ${ids.length} solves`);
      get().toast(ids.length === 1 ? "Solve deleted" : `${ids.length} solves deleted`, "info", { label: "Undo", run: () => get().undo() });
    },

    restoreSolves(ids) {
      get().updateSolves(ids, () => ({ deletedAt: null }), "Restore solves");
    },

    moveSolves(ids, toSessionId) {
      const st = get();
      const target = st.sessions.find((s) => s.id === toSessionId);
      if (!target) return;
      let ord = st.solves.filter((s) => s.sessionId === toSessionId).reduce((m, s) => Math.max(m, s.ord), -1);
      const moving = ids
        .map((id) => solveById(id))
        .filter((s): s is Solve => !!s)
        .sort((a, b) => a.ord - b.ord);
      const now = Date.now();
      run({
        label: `Move ${moving.length} solves`,
        solves: moving.map((prev) => ({ prev, next: { ...prev, sessionId: toSessionId, ord: ++ord, updatedAt: now } })),
        sessions: [],
      });
    },

    createSession({ name, event = "333", phases = 1 }) {
      const st = get();
      const now = Date.now();
      const rank = st.sessions.filter((s) => !s.deletedAt).reduce((m, s) => Math.max(m, s.rank), 0) + 1;
      const s: Session = { id: newId("ses_"), name, rank, event, phases, opt: {}, createdAt: now, updatedAt: now, importId: null, sourceKey: null, archived: false, deletedAt: null };
      run({ label: "Create session", solves: [], sessions: [{ prev: null, next: s }] });
      get().setCurrentSession(s.id);
      return s.id;
    },

    updateSession(id, patch, label = "Edit session") {
      const prev = get().sessions.find((s) => s.id === id);
      if (!prev) return;
      run({ label, solves: [], sessions: [{ prev, next: { ...prev, ...patch, updatedAt: Date.now() } }] });
    },

    deleteSession(id) {
      const st = get();
      const prev = st.sessions.find((s) => s.id === id);
      if (!prev) return;
      const now = Date.now();
      const solves = st.solves.filter((s) => s.sessionId === id && !s.deletedAt).map((p) => ({ prev: p, next: { ...p, deletedAt: now, updatedAt: now } }));
      run({ label: `Delete session "${prev.name}"`, solves, sessions: [{ prev, next: { ...prev, deletedAt: now, updatedAt: now } }] });
      if (st.currentSessionId === id) {
        const other = get().sessions.filter((s) => !s.deletedAt).sort((a, b) => a.rank - b.rank)[0];
        if (other) get().setCurrentSession(other.id);
        else get().createSession({ name: "Session 1" });
      }
      get().toast(`Deleted "${prev.name}"`, "info", { label: "Undo", run: () => get().undo() });
    },

    mergeSessions(sourceIds, targetId, mode) {
      const st = get();
      const target = st.sessions.find((s) => s.id === targetId);
      if (!target) return;
      const now = Date.now();
      const all = [targetId, ...sourceIds.filter((x) => x !== targetId)];
      const groups = all.map((sid) => liveSorted(st.solves, sid));
      let ordered: Solve[];
      if (mode === "append") ordered = groups.flat();
      else {
        // stable chronological merge; undated solves keep their position relative to neighbours
        const tagged = groups.flatMap((g, gi) => g.map((s, i) => ({ s, gi, i, d: s.date })));
        let lastDate = 0;
        const withKey = tagged.map((t) => {
          if (t.d != null) lastDate = t.d;
          return { ...t, key: t.d ?? lastDate };
        });
        withKey.sort((a, b) => a.key - b.key || a.gi - b.gi || a.i - b.i);
        ordered = withKey.map((t) => t.s);
      }
      const solves = ordered.map((p, i) => ({ prev: p, next: { ...p, sessionId: targetId, ord: i, updatedAt: now } }));
      const sessions = sourceIds
        .filter((x) => x !== targetId)
        .map((sid) => st.sessions.find((s) => s.id === sid)!)
        .map((prev) => ({ prev, next: { ...prev, deletedAt: now, updatedAt: now } }));
      run({ label: "Merge sessions", solves, sessions });
      get().setCurrentSession(targetId);
    },

    splitSession(id, fromIndex, name) {
      const st = get();
      const src = st.sessions.find((s) => s.id === id)!;
      const list = liveSorted(st.solves, id);
      const now = Date.now();
      const rank = st.sessions.filter((s) => !s.deletedAt).reduce((m, s) => Math.max(m, s.rank), 0) + 1;
      const ns: Session = { ...src, id: newId("ses_"), name, rank, createdAt: now, updatedAt: now, importId: null, sourceKey: null, deletedAt: null };
      const moving = list.slice(fromIndex);
      run({
        label: "Split session",
        solves: moving.map((p, i) => ({ prev: p, next: { ...p, sessionId: ns.id, ord: i, updatedAt: now } })),
        sessions: [{ prev: null, next: ns }],
      });
      return ns.id;
    },

    reorderSessions(ids) {
      const st = get();
      const now = Date.now();
      const sessions = ids
        .map((id, i) => {
          const prev = st.sessions.find((s) => s.id === id)!;
          return prev.rank === i + 1 ? null : { prev, next: { ...prev, rank: i + 1, updatedAt: now } };
        })
        .filter((x): x is { prev: Session; next: Session } => !!x);
      if (sessions.length) run({ label: "Reorder sessions", solves: [], sessions });
    },

    setCurrentSession(id) {
      set({ currentSessionId: id });
      get().backend?.apply([{ t: "setSetting", key: "currentSessionId", value: id }]).catch(console.error);
    },

    updateSettings(patch) {
      set((s) => ({ settings: { ...s.settings, ...patch } }));
      const ops: Op[] = Object.entries(patch).map(([key, value]) => ({ t: "setSetting", key, value }));
      persist(ops);
    },

    undo() {
      const st = get();
      const c = st.undoStack[st.undoStack.length - 1];
      if (!c) return;
      set({ undoStack: st.undoStack.slice(0, -1), redoStack: [...st.redoStack, c] });
      run(invert(c), false);
      get().toast(`Undid: ${c.label}`);
    },
    redo() {
      const st = get();
      const c = st.redoStack[st.redoStack.length - 1];
      if (!c) return;
      set({ redoStack: st.redoStack.slice(0, -1), undoStack: [...st.undoStack, c] });
      run(c, false);
      get().toast(`Redid: ${c.label}`);
    },
  };
});

// ---------- selectors with memoisation ----------

let cacheSolves: Solve[] | null = null;
let cacheMap = new Map<string, Solve[]>();
/** Live solves of a session in chronological order (memoised per solves array). */
export function sessionSolves(solves: Solve[], sessionId: string): Solve[] {
  if (solves !== cacheSolves) {
    cacheSolves = solves;
    cacheMap = new Map();
  }
  let r = cacheMap.get(sessionId);
  if (!r) {
    r = liveSorted(solves, sessionId);
    cacheMap.set(sessionId, r);
  }
  return r;
}

export function liveSessions(sessions: Session[]) {
  return sessions.filter((s) => !s.deletedAt).sort((a, b) => a.rank - b.rank);
}
