/**
 * Core data model.
 *
 * Conventions intentionally mirror csTimer so that data round-trips losslessly:
 *  - `time` is the raw solve time in integer milliseconds, *excluding* penalty.
 *  - `penalty` uses csTimer's encoding: 0 = OK, 2000 = +2 (ms added), -1 = DNF.
 *  - `splits` are cumulative phase end times in forward order (last === time),
 *    or null for single-phase solves.
 *  - `event` is a csTimer scramble-type code ("333", "222so", "444wca", ...).
 */

export type Penalty = number; // 0 | 2000 | -1 (other positive values = ms added)

export const PEN_OK = 0;
export const PEN_PLUS2 = 2000;
export const PEN_DNF = -1;

export interface Solve {
  id: string;
  sessionId: string;
  /** Chronological order key within the session (ascending). */
  ord: number;
  time: number;
  penalty: Penalty;
  splits: number[] | null;
  scramble: string;
  comment: string;
  /** Unix epoch milliseconds, or null when the source did not record a date. */
  date: number | null;
  event: string;
  /** Import batch that created this solve, null for solves timed in-app. */
  importId: string | null;
  /** Content fingerprint used for duplicate detection on re-imports. */
  fp: string;
  /** JSON-encoded extra fields preserved verbatim from the source (e.g. csTimer time[4+]). */
  extra: string | null;
  createdAt: number;
  updatedAt: number;
  /** Soft-delete tombstone (ms). Deleted solves are hidden but recoverable. */
  deletedAt: number | null;
}

export interface Session {
  id: string;
  name: string;
  rank: number;
  event: string;
  phases: number;
  /** Raw option object (csTimer session opt is preserved verbatim here). */
  opt: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  importId: string | null;
  /** Origin key, e.g. "cstimer:session3", used to re-attach re-imports. */
  sourceKey: string | null;
  archived: boolean;
  deletedAt: number | null;
}

export interface ImportRecord {
  id: string;
  createdAt: number;
  fileName: string;
  format: string;
  fileHash: string;
  fileSize: number;
  solvesAdded: number;
  duplicatesSkipped: number;
  invalidSkipped: number;
  sessionsCreated: number;
  report: string; // JSON
  rolledBackAt: number | null;
}

export type SettingsMap = Record<string, unknown>;

/** Atomic mutation ops; a batch of ops is applied in one database transaction. */
export type Op =
  | { t: "putSolves"; solves: Solve[] }
  | { t: "putSessions"; sessions: Session[] }
  | { t: "hardDeleteSolves"; ids: string[] }
  | { t: "hardDeleteSessions"; ids: string[] }
  | { t: "setSetting"; key: string; value: unknown };

export interface LoadedData {
  sessions: Session[];
  solves: Solve[];
  settings: SettingsMap;
  imports: ImportRecord[];
}

export interface BackupInfo {
  path: string;
  name: string;
  size: number;
  createdAt: number;
  reason: string;
}
