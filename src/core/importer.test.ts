import { describe, expect, it } from "vitest";
import { convertCsSolve, parseBackup, verifyAgainstCsStat } from "./importer";
import { planImport } from "./importPlan";
import { exportCsTimer, exportFacelet, exportSessionCsv, toCsTimerEntry } from "./exporter";
import { makeCsTimerBackup } from "./testdata";
import type { Session, Solve } from "./types";

describe("csTimer solve conversion", () => {
  it("converts plain, +2, DNF and multi-phase entries", () => {
    const a = convertCsSolve([[0, 14743], "R U", "", 1700000000], 0) as any;
    expect(a).toMatchObject({ time: 14743, penalty: 0, splits: null, date: 1700000000000 });
    const b = convertCsSolve([[2000, 9000], "R", "c", 1700000001], 1) as any;
    expect(b.penalty).toBe(2000);
    const c = convertCsSolve([[-1, 20000], "R", "", 0], 2) as any;
    expect(c.penalty).toBe(-1);
    expect(c.date).toBeNull();
    // 3 phases: phase ends at 4000, 11000, total 20000
    const d = convertCsSolve([[0, 20000, 11000, 4000], "R", "", 5], 3) as any;
    expect(d.splits).toEqual([4000, 11000, 20000]);
    // round trip
    const back = toCsTimerEntry({ ...d, extra: null } as Solve);
    expect(back[0]).toEqual([0, 20000, 11000, 4000]);
  });

  it("preserves extra fields and reports invalid entries", () => {
    const e = convertCsSolve([[0, 1000], "R", "", 5, ["R U", "333"]], 0) as any;
    expect(JSON.parse(e.extra)).toEqual([["R U", "333"]]);
    expect(typeof convertCsSolve("nope", 0)).toBe("string");
    expect(typeof convertCsSolve([[0, "abc"], "R"], 0)).toBe("string");
    expect(typeof convertCsSolve([[7, 1000], "R"], 0)).toBe("object"); // unusual positive penalty kept
    expect(typeof convertCsSolve([[-5, 1000], "R"], 0)).toBe("string");
  });
});

describe("full backup import", () => {
  const backup = makeCsTimerBackup();
  const text = JSON.stringify(backup);
  const parsed = parseBackup(text, "cstimer_20261117.txt");

  it("parses every session and solve", () => {
    expect(parsed.format).toBe("cstimer");
    expect(parsed.sessions.map((s) => s.name)).toEqual(["Session 1", "OH", "2x2", "Multiphase", "Old"]);
    expect(parsed.totalSolves).toBe(19043 + 400 + 300 + 120 + 150);
    expect(parsed.totalInvalid).toBe(0);
    expect(parsed.sessions[1].event).toBe("333oh");
    expect(parsed.sessions[3].phases).toBe(3);
  });

  it("matches csTimer's own cached statistics for every session", () => {
    for (const s of parsed.sessions) {
      const v = verifyAgainstCsStat(s);
      expect(v.match).toBe(true);
    }
  });

  it("preserves times, penalties, scrambles, comments and dates exactly", () => {
    const src = (backup as any).session1 as any[];
    const ps = parsed.sessions[0].solves;
    for (let i = 0; i < src.length; i += 1) {
      expect(ps[i].time).toBe(src[i][0][1]);
      expect(ps[i].penalty).toBe(src[i][0][0]);
      expect(ps[i].scramble).toBe(src[i][1]);
      expect(ps[i].comment).toBe(src[i][2]);
      expect(ps[i].date).toBe(src[i][3] ? src[i][3] * 1000 : null);
    }
  });

  it("plans import, then a re-import is entirely duplicates", () => {
    const plan = planImport(parsed, [], []);
    expect(plan.totals.toAdd).toBe(parsed.totalSolves);
    expect(plan.sessions.length).toBe(5);
    const again = planImport(parsed, plan.sessions, plan.solves);
    expect(again.totals.toAdd).toBe(0);
    expect(again.totals.duplicates).toBe(parsed.totalSolves);
    expect(again.sessions.length).toBe(0);
  });

  it("re-import of a newer backup adds only the new solves to the matching session", () => {
    const plan = planImport(parsed, [], []);
    const newer = makeCsTimerBackup();
    (newer as any).session1.push([[0, 12345], "R U F", "", 1800000000]);
    const p2 = planImport(parseBackup(JSON.stringify(newer)), plan.sessions, plan.solves);
    expect(p2.totals.toAdd).toBe(1);
    expect(p2.solves[0].sessionId).toBe(plan.sessions[0].id);
    expect(p2.solves[0].ord).toBe(19043);
  });

  it("csTimer export -> import round trip is lossless", () => {
    const plan = planImport(parsed, [], []);
    const exported = exportCsTimer(plan.sessions, plan.solves);
    const reparsed = parseBackup(exported);
    expect(reparsed.totalSolves).toBe(parsed.totalSolves);
    for (let si = 0; si < parsed.sessions.length; si++) {
      const a = parsed.sessions[si];
      const b = reparsed.sessions[si];
      expect(b.name).toBe(a.name);
      expect(b.event).toBe(a.event);
      expect(b.solves.map((x) => x.fp)).toEqual(a.solves.map((x) => x.fp));
      expect(b.solves.map((x) => x.extra)).toEqual(a.solves.map((x) => x.extra));
      expect(b.solves.map((x) => x.comment)).toEqual(a.solves.map((x) => x.comment));
    }
    // and importing our export on top of the original is all duplicates
    const p3 = planImport(reparsed, plan.sessions, plan.solves);
    expect(p3.totals.toAdd).toBe(0);
  });

  it("Facelet backup round trip", () => {
    const plan = planImport(parsed, [], []);
    const fb = parseBackup(exportFacelet(plan.sessions, plan.solves, {}, []));
    expect(fb.format).toBe("facelet");
    expect(fb.totalSolves).toBe(parsed.totalSolves);
  });

  it("csTimer CSV export parses back", () => {
    const plan = planImport(parsed, [], []);
    const mp = plan.sessions[3] as Session;
    const csv = exportSessionCsv(mp, plan.solves);
    const back = parseBackup(csv, "Multiphase.csv");
    expect(back.format).toBe("cstimer-csv");
    expect(back.totalSolves).toBe(120);
    const orig = plan.solves.filter((s) => s.sessionId === mp.id);
    // CSV has centisecond resolution: splits survive to 10ms
    back.sessions[0].solves.forEach((s, i) => {
      expect(s.penalty).toBe(orig[i].penalty);
      expect(Math.abs(s.time - orig[i].time)).toBeLessThan(40);
    });
  });

  it("parses large backups quickly", () => {
    const t0 = performance.now();
    const p = parseBackup(text);
    planImport(p, [], []);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
