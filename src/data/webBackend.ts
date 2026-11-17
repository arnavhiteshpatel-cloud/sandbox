/**
 * Browser backend (IndexedDB). Used for development, automated E2E tests and as a
 * fallback when the UI runs outside the native shell. Mirrors the Rust semantics:
 * atomic batches, import records with preserved source text, rollback and snapshots.
 */
import type { BackupInfo, ImportRecord, LoadedData, Op, Solve } from "../core/types";
import type { Backend, IntegrityReport } from "./backend";

const DB_NAME = "facelet";
const STORES = ["sessions", "solves", "settings", "imports", "backups"] as const;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === "settings" ? "key" : s === "backups" ? "path" : "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx(db: IDBDatabase, stores: readonly string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => void): Promise<void> {
  return new Promise((res, rej) => {
    const t = db.transaction(stores as string[], mode);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new Error("transaction aborted"));
    try {
      fn(t);
    } catch (e) {
      t.abort();
      rej(e);
    }
  });
}

function validateSolve(s: Solve) {
  if (!s.id || !s.sessionId) throw new Error("solve id/session id must not be empty");
  if (!(s.time >= 0)) throw new Error("time must be >= 0");
  if (!(s.penalty >= -1)) throw new Error("bad penalty");
}

export async function createWebBackend(): Promise<Backend> {
  const db = await openDb();
  const getAll = async (store: string) => {
    let out: any[] = [];
    await tx(db, [store], "readonly", (t) => {
      req(t.objectStore(store).getAll()).then((v) => (out = v));
    });
    return out;
  };
  const snapshot = async (reason: string): Promise<BackupInfo> => {
    const data = await backend.load();
    const now = Date.now();
    const name = `facelet-${new Date(now).toISOString().replace(/[:.]/g, "")}-${reason}.json`;
    const json = JSON.stringify(data);
    const info: BackupInfo = { path: "idb://" + name, name, size: json.length, createdAt: now, reason };
    await tx(db, ["backups"], "readwrite", (t) => t.objectStore("backups").put({ ...info, json }));
    // prune automatic backups beyond 30
    const all = (await getAll("backups")).sort((a, b) => b.createdAt - a.createdAt);
    const auto = all.filter((b) => b.reason.startsWith("auto")).slice(30);
    if (auto.length) await tx(db, ["backups"], "readwrite", (t) => auto.forEach((b) => t.objectStore("backups").delete(b.path)));
    return info;
  };

  const backend: Backend = {
    kind: "web",
    async load(): Promise<LoadedData> {
      const [sessions, solves, settingsRows, imports] = await Promise.all([getAll("sessions"), getAll("solves"), getAll("settings"), getAll("imports")]);
      const settings: Record<string, unknown> = {};
      for (const r of settingsRows) settings[r.key] = r.value;
      return { sessions, solves, settings, imports: imports.map(({ sourceText, ...r }: any) => r) };
    },
    async apply(ops: Op[]) {
      for (const op of ops) if (op.t === "putSolves") op.solves.forEach(validateSolve);
      await tx(db, ["sessions", "solves", "settings"], "readwrite", (t) => {
        for (const op of ops) {
          if (op.t === "putSolves") op.solves.forEach((s) => t.objectStore("solves").put(s));
          else if (op.t === "putSessions") op.sessions.forEach((s) => t.objectStore("sessions").put(s));
          else if (op.t === "hardDeleteSolves") op.ids.forEach((id) => t.objectStore("solves").delete(id));
          else if (op.t === "hardDeleteSessions") op.ids.forEach((id) => t.objectStore("sessions").delete(id));
          else if (op.t === "setSetting") t.objectStore("settings").put({ key: op.key, value: op.value });
        }
      });
    },
    async importCommit(record: ImportRecord, sessions, solves, sourceText) {
      solves.forEach(validateSolve);
      await snapshot("pre-import");
      await tx(db, ["sessions", "solves", "imports"], "readwrite", (t) => {
        t.objectStore("imports").add({ ...record, sourceText });
        sessions.forEach((s) => t.objectStore("sessions").put(s));
        solves.forEach((s) => t.objectStore("solves").put(s));
      });
    },
    async importRollback(importId) {
      await snapshot("pre-rollback");
      const solves = (await getAll("solves")) as Solve[];
      const sessions = await getAll("sessions");
      const remove = solves.filter((s) => s.importId === importId);
      const removeIds = new Set(remove.map((s) => s.id));
      const remainingBySession = new Map<string, number>();
      for (const s of solves) if (!removeIds.has(s.id)) remainingBySession.set(s.sessionId, (remainingBySession.get(s.sessionId) ?? 0) + 1);
      await tx(db, ["sessions", "solves", "imports"], "readwrite", (t) => {
        remove.forEach((s) => t.objectStore("solves").delete(s.id));
        sessions
          .filter((s: any) => s.importId === importId && !remainingBySession.get(s.id))
          .forEach((s: any) => t.objectStore("sessions").delete(s.id));
        const st = t.objectStore("imports");
        req(st.get(importId)).then((rec: any) => rec && st.put({ ...rec, rolledBackAt: Date.now() }));
      });
      return remove.length;
    },
    async importSource(importId) {
      const all = await getAll("imports");
      return all.find((r: any) => r.id === importId)?.sourceText ?? null;
    },
    backupCreate: (reason) => snapshot(reason),
    async backupList() {
      return (await getAll("backups")).map(({ json, ...b }: any) => b).sort((a: BackupInfo, b: BackupInfo) => b.createdAt - a.createdAt);
    },
    async backupRestore(path) {
      const all = await getAll("backups");
      const b = all.find((x: any) => x.path === path);
      if (!b) throw new Error("backup not found");
      const data = JSON.parse(b.json) as LoadedData;
      await snapshot("pre-restore");
      await tx(db, ["sessions", "solves", "settings"], "readwrite", (t) => {
        for (const s of ["sessions", "solves", "settings"]) t.objectStore(s).clear();
        data.sessions.forEach((s) => t.objectStore("sessions").put(s));
        data.solves.forEach((s) => t.objectStore("solves").put(s));
        Object.entries(data.settings).forEach(([key, value]) => t.objectStore("settings").put({ key, value }));
      });
      return data.solves.length;
    },
    async integrity(): Promise<IntegrityReport> {
      const d = await backend.load();
      const ids = new Set(d.sessions.map((s) => s.id));
      const orphans = d.solves.filter((s) => !ids.has(s.sessionId)).length;
      return {
        ok: orphans === 0,
        message: orphans ? `${orphans} solves reference missing sessions` : "ok",
        sessions: d.sessions.filter((s) => !s.deletedAt).length,
        solves: d.solves.length,
        liveSolves: d.solves.filter((s) => !s.deletedAt).length,
        orphanSolves: orphans,
        schemaVersion: 1,
        dbPath: "IndexedDB (browser)",
        dbSize: 0,
      };
    },
    async paths() {
      return { dataDir: "IndexedDB (browser)", dbPath: "IndexedDB:facelet", backupDir: "IndexedDB:backups" };
    },
    pickOpenFile(filters) {
      return new Promise((res) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = filters.flatMap((f) => f.extensions.map((e) => "." + e)).join(",");
        input.setAttribute("data-testid", "file-input");
        input.style.display = "none";
        input.onchange = async () => {
          const f = input.files?.[0];
          input.remove();
          if (!f) return res(null);
          res({ name: f.name, text: await f.text(), size: f.size });
        };
        document.body.appendChild(input);
        input.click();
      });
    },
    async pickDirectory() {
      return null;
    },
    async saveTextFile(defaultName, text) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = defaultName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return defaultName;
    },
    async setFullscreen(on) {
      try {
        if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
        if (!on && document.fullscreenElement) await document.exitFullscreen();
      } catch {
        /* not allowed (e.g. headless) */
      }
    },
    async isFullscreen() {
      return !!document.fullscreenElement;
    },
    async reveal() {},
  };
  return backend;
}
