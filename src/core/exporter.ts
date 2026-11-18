/**
 * Exporters:
 *  - csTimer-compatible JSON backup (can be imported back into csTimer, or into Parity)
 *  - Parity full backup (every field, ids, settings, import history)
 *  - csTimer-style CSV for a single session
 */
import type { ImportRecord, Session, Solve, SettingsMap } from "./types";
import { fmtCsDate, fmtSingle, fmtSolve } from "./time";

export function toCsTimerEntry(s: Solve): unknown[] {
  const tarr: number[] = [s.penalty, s.time];
  if (s.splits && s.splits.length > 1) {
    // forward cumulative [c1..ck] (ck = time) -> csTimer [pen, ck, c_{k-1}, ..., c1]
    for (let i = s.splits.length - 2; i >= 0; i--) tarr.push(s.splits[i]);
  }
  const entry: unknown[] = [tarr, s.scramble, s.comment, s.date == null ? 0 : Math.floor(s.date / 1000)];
  if (s.extra) {
    try {
      const ex = JSON.parse(s.extra);
      if (Array.isArray(ex)) entry.push(...ex);
    } catch {
      /* ignore malformed extra */
    }
  }
  return entry;
}

export function liveSolvesBySession(sessions: Session[], solves: Solve[]) {
  const map = new Map<string, Solve[]>();
  for (const s of sessions) map.set(s.id, []);
  for (const s of solves) if (!s.deletedAt) map.get(s.sessionId)?.push(s);
  for (const arr of map.values()) arr.sort((a, b) => a.ord - b.ord);
  return map;
}

export function exportCsTimer(sessions: Session[], solves: Solve[]): string {
  const live = sessions.filter((s) => !s.deletedAt).sort((a, b) => a.rank - b.rank);
  const by = liveSolvesBySession(live, solves);
  const out: Record<string, unknown> = {};
  const sessionData: Record<string, unknown> = {};
  live.forEach((ses, i) => {
    const idx = i + 1;
    const list = by.get(ses.id) ?? [];
    out["session" + idx] = list.map(toCsTimerEntry);
    const opt = { ...(ses.opt ?? {}) } as Record<string, unknown>;
    if (ses.event && ses.event !== "333") opt.scrType = ses.event;
    else delete opt.scrType;
    if (ses.phases > 1) opt.phases = ses.phases;
    sessionData[String(idx)] = {
      name: ses.name,
      opt,
      rank: idx,
      date: [list[0]?.date ? Math.floor(list[0].date / 1000) : null, list.at(-1)?.date ? Math.floor(list.at(-1)!.date! / 1000) : null],
    };
  });
  out.properties = { sessionData: JSON.stringify(sessionData), sessionN: live.length, session: 1 };
  return JSON.stringify(out);
}

export function exportParity(sessions: Session[], solves: Solve[], settings: SettingsMap, imports: ImportRecord[]): string {
  return JSON.stringify({
    app: "parity",
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: { sessions: sessions.length, solves: solves.length },
    sessions,
    solves,
    settings,
    imports: imports.map((i) => ({ ...i })),
  });
}

function csvField(v: string) {
  return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function exportSessionCsv(session: Session, solves: Solve[], decimals = 2): string {
  const list = solves.filter((s) => s.sessionId === session.id && !s.deletedAt).sort((a, b) => a.ord - b.ord);
  const phases = Math.max(1, session.phases, ...list.map((s) => s.splits?.length ?? 1));
  const head = ["No.", "Time", "Comment", "Scramble", "Date"];
  for (let i = 1; i <= phases; i++) head.push("P." + i);
  const lines = [head.join(";")];
  list.forEach((s, i) => {
    const row = [String(i + 1), fmtSolve(s, decimals), s.comment, s.scramble, fmtCsDate(s.date)];
    if (s.splits && s.splits.length > 1) {
      let prev = 0;
      for (const c of s.splits) {
        row.push(fmtSingle(c - prev, decimals));
        prev = c;
      }
    } else row.push(fmtSingle(s.time, decimals));
    while (row.length < head.length) row.push("");
    lines.push(row.map(csvField).join(";"));
  });
  return lines.join("\r\n");
}
