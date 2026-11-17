import { it } from "vitest";
import { makeCsTimerBackup } from "./testdata";
import { parseBackup } from "./importer";
import * as A from "./analytics";
it("bench", () => {
  const parsed: any = parseBackup(JSON.stringify(makeCsTimerBackup()), "x.txt");
  const s0 = parsed.sessions[0];
  const solves = (s0.solves as any[]).map((p, i) => ({ id: "s" + i, sessionId: "a", ord: i, time: p.time, penalty: p.penalty, splits: null, scramble: p.scramble, comment: "", date: p.date, event: "333", importId: null, fp: "", extra: null, createdAt: 0, updatedAt: 0, deletedAt: null }));
  const T = (l: string, f: () => unknown) => { const t = performance.now(); const r = f(); console.log(l.padEnd(18), (performance.now() - t).toFixed(1)); return r as any; };
  for (let rep = 0; rep < 2; rep++) {
    const ds = T("dataset", () => A.buildDataset(solves));
    const r = T("rolling", () => A.computeRolling(ds.values));
    T("headline", () => A.headline(ds, r));
    T("agg week", () => A.aggregate(ds, "week", r.ao100.avg));
    T("agg day", () => A.aggregate(ds, "day"));
    T("improvement", () => A.improvementReport(ds, r.ao100.avg));
    T("milestones", () => A.milestones([{ label: "ao5", avg: r.ao5.avg }, { label: "ao12", avg: r.ao12.avg }, { label: "ao100", avg: r.ao100.avg }], ds.dates));
    T("pbs", () => [A.pbProgression(ds.values, ds.dates), A.pbProgression(r.ao5.avg, ds.dates)]);
    T("compare", () => A.compareGroups(ds.values.subarray(0, 1000), ds.values.subarray(ds.values.length - 1000)));
    T("sorted", () => A.finiteSorted(ds.values));
    T("consistency", () => A.consistencySeries(r.ao100, "sd"));
  }
});
