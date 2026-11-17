import type { BackupInfo, ImportRecord, LoadedData, Op, Session, Solve } from "../core/types";

export interface IntegrityReport {
  ok: boolean;
  message: string;
  sessions: number;
  solves: number;
  liveSolves: number;
  orphanSolves: number;
  schemaVersion: number;
  dbPath: string;
  dbSize: number;
}

export interface AppPaths {
  dataDir: string;
  dbPath: string;
  backupDir: string;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface Backend {
  kind: "tauri" | "web";
  load(): Promise<LoadedData>;
  apply(ops: Op[]): Promise<void>;
  importCommit(record: ImportRecord, sessions: Session[], solves: Solve[], sourceText: string): Promise<void>;
  importRollback(importId: string): Promise<number>;
  importSource(importId: string): Promise<string | null>;
  backupCreate(reason: string): Promise<BackupInfo>;
  backupList(): Promise<BackupInfo[]>;
  backupRestore(path: string): Promise<number>;
  integrity(): Promise<IntegrityReport>;
  paths(): Promise<AppPaths>;
  pickOpenFile(filters: FileFilter[]): Promise<{ name: string; text: string; size: number } | null>;
  pickDirectory(): Promise<string | null>;
  saveTextFile(defaultName: string, text: string, filters: FileFilter[]): Promise<string | null>;
  setFullscreen(on: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
  reveal(path: string): Promise<void>;
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let backendPromise: Promise<Backend> | null = null;
export function getBackend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = isTauri()
      ? import("./tauriBackend").then((m) => m.createTauriBackend())
      : import("./webBackend").then((m) => m.createWebBackend());
  }
  return backendPromise;
}
