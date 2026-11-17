/**
 * Self-test for the native app (Tauri + SQLite). Activated only when the FACELET_SELFTEST
 * environment variable is set. Phase "write" imports a large synthetic csTimer backup and times
 * solves; phase "verify" runs after a restart and checks persistence, duplicate detection,
 * rollback and backup/restore against the real database. Result is written to FACELET_SELFTEST_OUT.
 */
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./data/store";
import { makeCsTimerBackup } from "./core/testdata";
import { parseBackup } from "./core/importer";
import { planImport, importRecordFor } from "./core/importPlan";
import { sessionSolves } from "./data/store";

export async function runSelfTest(phase: string) {
  const log: string[] = [];
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  try {
    for (let i = 0; i < 200 && !useStore.getState().ready; i++) await new Promise((r) => setTimeout(r, 50));
    const st = () => useStore.getState();
    const be = st().backend!;
    check("backend is native SQLite", be.kind === "tauri", be.kind);
    const text = JSON.stringify(makeCsTimerBackup());
    const parsed = parseBackup(text, "selftest.txt");
    if (phase === "write") {
      let t = performance.now();
      const plan = planImport(parsed, st().sessions, st().solves);
      await be.importCommit(importRecordFor(plan, "selftest.txt", parsed.format, "selftest", text.length, []), plan.sessions, plan.solves, text);
      const importMs = performance.now() - t;
      t = performance.now();
      await st().reload();
      const loadMs = performance.now() - t;
      check("import of full backup", st().solves.length === parsed.totalSolves, `${st().solves.length} solves; commit ${importMs.toFixed(0)} ms; reload ${loadMs.toFixed(0)} ms`);
      st().setCurrentSession(plan.sessions[0].id);
      const s1 = st().addSolve({ time: 12345, penalty: 0, scramble: "R U R' U'" });
      const s2 = st().addSolve({ time: 9876, penalty: 0, scramble: "F R U" });
      st().updateSolves([s2.id], () => ({ penalty: 2000, comment: "selftest +2" }), "t");
      await new Promise((r) => setTimeout(r, 500));
      const b = await be.backupCreate("selftest");
      check("backup created", b.size > 0, b.path);
      const integ = await be.integrity();
      check("integrity", integ.ok, JSON.stringify(integ));
      log.push(JSON.stringify({ s1: s1.id, s2: s2.id, total: st().solves.length, backup: b.path }));
    } else {
      const all = st().solves;
      const expected = parsed.totalSolves + 2;
      check("solves persisted across restart", all.length === expected, `${all.length} / ${expected}`);
      const ses = st().sessions.find((s) => s.sourceKey === "cstimer:session1")!;
      const list = sessionSolves(all, ses.id);
      const last = list[list.length - 1];
      check("timed solve fields persisted", last.time === 9876 && last.penalty === 2000 && last.comment === "selftest +2" && last.scramble === "F R U", JSON.stringify({ t: last.time, p: last.penalty, c: last.comment }));
      const plan = planImport(parsed, st().sessions, st().solves);
      check("re-import detects all duplicates", plan.totals.toAdd === 0 && plan.totals.duplicates === parsed.totalSolves, JSON.stringify(plan.totals));
      const imp = st().imports.find((i) => !i.rolledBackAt)!;
      const removed = await be.importRollback(imp.id);
      await st().reload();
      check("rollback removes only imported solves", removed === parsed.totalSolves && st().solves.length === 2, `removed ${removed}, left ${st().solves.length}`);
      const backups = await be.backupList();
      const b = backups.find((x) => x.reason === "selftest")!;
      const n = await be.backupRestore(b.path);
      await st().reload();
      check("restore from backup", n === expected && st().solves.length === expected, `${n} restored`);
      const integ = await be.integrity();
      check("integrity after restore", integ.ok, integ.message);
    }
  } catch (e) {
    check("exception", false, String((e as Error)?.stack ?? e));
  }
  const ok = checks.every((c) => c.ok);
  await invoke("selftest_report", { report: JSON.stringify({ phase, ok, checks, log }, null, 2), ok });
}
