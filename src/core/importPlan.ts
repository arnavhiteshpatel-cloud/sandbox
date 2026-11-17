/**
 * Turns a parsed backup into concrete database rows, detecting duplicates against
 * existing data. Pure function: nothing is written until the caller commits the plan.
 */
import type { ImportRecord, Session, Solve } from "./types";
import type { ParsedBackup } from "./importer";
import { newId } from "./ids";
import { verifyAgainstCsStat } from "./importer";

export interface ImportOptions {
  /** Session keys (ParsedSession.key) to import. Default: all non-empty. */
  include?: Set<string>;
  /** Append to an existing session with the same origin key & name (re-imports). Default true. */
  mergeMatching?: boolean;
  /** Skip solves whose fingerprint already exists in the database. Default true. */
  skipDuplicates?: boolean;
}

export interface SessionPlan {
  key: string;
  name: string;
  event: string;
  target: "new" | "existing";
  targetSessionId: string;
  targetName: string;
  sourceSolves: number;
  invalid: number;
  toAdd: number;
  duplicates: number;
  verify: ReturnType<typeof verifyAgainstCsStat>;
  firstDate: number | null;
  lastDate: number | null;
}

export interface ImportPlan {
  importId: string;
  sessions: Session[];
  solves: Solve[];
  perSession: SessionPlan[];
  totals: { source: number; toAdd: number; duplicates: number; invalid: number; newSessions: number };
}

export function planImport(
  parsed: ParsedBackup,
  existingSessions: Session[],
  existingSolves: Solve[],
  opts: ImportOptions = {},
): ImportPlan {
  const importId = newId("imp_");
  const now = Date.now();
  const mergeMatching = opts.mergeMatching ?? true;
  const skipDup = opts.skipDuplicates ?? true;
  // multiset of fingerprints already present (live solves only)
  const fpCount = new Map<string, number>();
  for (const s of existingSolves) if (!s.deletedAt) fpCount.set(s.fp, (fpCount.get(s.fp) ?? 0) + 1);
  const liveSessions = existingSessions.filter((s) => !s.deletedAt);
  let maxRank = liveSessions.reduce((m, s) => Math.max(m, s.rank), 0);
  const maxOrd = new Map<string, number>();
  for (const s of existingSolves) maxOrd.set(s.sessionId, Math.max(maxOrd.get(s.sessionId) ?? -1, s.ord));

  const sessions: Session[] = [];
  const solves: Solve[] = [];
  const perSession: SessionPlan[] = [];
  const prefix = parsed.format === "cstimer" ? "cstimer:" : parsed.format + ":";

  for (const ps of parsed.sessions) {
    const included = opts.include ? opts.include.has(ps.key) : ps.solves.length > 0;
    if (!included) continue;
    const sourceKey = prefix + ps.key;
    const match = mergeMatching ? liveSessions.find((s) => s.sourceKey === sourceKey && s.name === ps.name) : undefined;
    let target: Session;
    if (match) target = match;
    else {
      target = {
        id: newId("ses_"),
        name: ps.name,
        rank: ++maxRank,
        event: ps.event,
        phases: ps.phases,
        opt: ps.opt,
        createdAt: now,
        updatedAt: now,
        importId,
        sourceKey,
        archived: false,
        deletedAt: null,
      };
      sessions.push(target);
    }
    let ord = maxOrd.get(target.id) ?? -1;
    let dups = 0,
      add = 0;
    for (const s of ps.solves) {
      const c = fpCount.get(s.fp) ?? 0;
      if (skipDup && c > 0) {
        fpCount.set(s.fp, c - 1);
        dups++;
        continue;
      }
      add++;
      solves.push({
        id: newId("sol_"),
        sessionId: target.id,
        ord: ++ord,
        time: s.time,
        penalty: s.penalty,
        splits: s.splits,
        scramble: s.scramble,
        comment: s.comment,
        date: s.date,
        event: ps.event,
        importId,
        fp: s.fp,
        extra: s.extra,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }
    maxOrd.set(target.id, ord);
    const dates = ps.solves.map((s) => s.date).filter((d): d is number => d != null);
    perSession.push({
      key: ps.key,
      name: ps.name,
      event: ps.event,
      target: match ? "existing" : "new",
      targetSessionId: target.id,
      targetName: target.name,
      sourceSolves: ps.solves.length,
      invalid: ps.invalid.length,
      toAdd: add,
      duplicates: dups,
      verify: verifyAgainstCsStat(ps),
      firstDate: dates.length ? Math.min(...dates) : null,
      lastDate: dates.length ? Math.max(...dates) : null,
    });
  }
  return {
    importId,
    sessions,
    solves,
    perSession,
    totals: {
      source: perSession.reduce((s, p) => s + p.sourceSolves, 0),
      toAdd: solves.length,
      duplicates: perSession.reduce((s, p) => s + p.duplicates, 0),
      invalid: perSession.reduce((s, p) => s + p.invalid, 0),
      newSessions: sessions.length,
    },
  };
}

export function importRecordFor(plan: ImportPlan, fileName: string, format: string, fileHash: string, fileSize: number, parsedWarnings: string[]): ImportRecord {
  return {
    id: plan.importId,
    createdAt: Date.now(),
    fileName,
    format,
    fileHash,
    fileSize,
    solvesAdded: plan.totals.toAdd,
    duplicatesSkipped: plan.totals.duplicates,
    invalidSkipped: plan.totals.invalid,
    sessionsCreated: plan.totals.newSessions,
    report: JSON.stringify({ perSession: plan.perSession, warnings: parsedWarnings }),
    rolledBackAt: null,
  };
}
