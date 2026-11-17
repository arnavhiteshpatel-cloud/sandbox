/**
 * Deterministic synthetic csTimer backup generator, used by unit tests, E2E tests and
 * performance testing. Produces exactly the structure csTimer writes to its .txt export.
 */
import { solveValue } from "./time";

export function lcg(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const FACES = ["U", "D", "L", "R", "F", "B"];
function fakeScramble(r: () => number, len = 20) {
  const out: string[] = [];
  let last = -1;
  for (let i = 0; i < len; i++) {
    let f: number;
    do f = Math.floor(r() * 6);
    while (f === last || (last >= 0 && f >> 1 === last >> 1 && f > last));
    last = f;
    out.push(FACES[f] + ["", "'", "2"][Math.floor(r() * 3)]);
  }
  return out.join(" ");
}

export interface GenOptions {
  sessions?: { name: string; count: number; scrType?: string; phases?: number; stringEncoded?: boolean }[];
  seed?: number;
  startDate?: number; // unix seconds
}

/** Returns the backup object (stringify it to get the file contents). */
export function makeCsTimerBackup(opts: GenOptions = {}) {
  const r = lcg(opts.seed ?? 7);
  const sessions = opts.sessions ?? [
    { name: "Session 1", count: 19043 },
    { name: "OH", count: 400, scrType: "333oh" },
    { name: "2x2", count: 300, scrType: "222so" },
    { name: "Multiphase", count: 120, phases: 3 },
    { name: "Old", count: 150, stringEncoded: true },
  ];
  const out: Record<string, unknown> = {};
  const sessionData: Record<string, unknown> = {};
  let t = opts.startDate ?? 1546300800; // 2019-01-01
  sessions.forEach((s, si) => {
    const idx = si + 1;
    const list: unknown[] = [];
    let level = 32000; // improving over time
    const target = 13500;
    for (let i = 0; i < s.count; i++) {
      level = target + (level - target) * 0.99975;
      const base = Math.max(5000, Math.round(level * (0.82 + r() * 0.38 + (r() < 0.03 ? 0.4 : 0))));
      const pr = r();
      const pen = pr < 0.012 ? -1 : pr < 0.03 ? 2000 : 0;
      const tarr: number[] = [pen, base];
      if ((s.phases ?? 1) > 1) {
        const k = s.phases!;
        const cuts: number[] = [];
        let acc = 0;
        for (let p = 0; p < k - 1; p++) {
          acc += Math.round((base / k) * (0.6 + r() * 0.8));
          cuts.push(Math.min(acc, base - 1));
        }
        for (let p = cuts.length - 1; p >= 0; p--) tarr.push(cuts[p]);
      }
      t += 20 + Math.floor(r() * 60) + (r() < 0.02 ? 86400 * Math.floor(1 + r() * 4) : 0);
      const comment = r() < 0.01 ? "lucky skip" : r() < 0.005 ? 'great "PB"; felt fast' : "";
      const entry: unknown[] = [tarr, fakeScramble(r, s.scrType === "222so" ? 9 : 20), comment, i % 997 === 13 ? 0 : t];
      if (i % 1500 === 7) entry.push(["R U R' U'", "333"]); // smart-cube style extra data
      list.push(entry);
    }
    out["session" + idx] = s.stringEncoded ? JSON.stringify(list) : list;
    // csTimer's cached stat: [count, dnf, mean of non-DNF (truncated to 10ms)]
    const vals = list.map((e: any) => solveValue({ penalty: e[0][0], time: e[0][1] }, 2));
    const fin = vals.filter((v) => Number.isFinite(v));
    const mean = fin.length ? fin.reduce((a, b) => a + b, 0) / fin.length : -1;
    const opt: Record<string, unknown> = {};
    if (s.scrType) opt.scrType = s.scrType;
    if (s.phases) opt.phases = s.phases;
    sessionData[String(idx)] = { name: s.name, opt, rank: idx, stat: [list.length, vals.length - fin.length, mean], date: [null, null] };
  });
  // csTimer always has several empty default sessions
  for (let i = sessions.length + 1; i <= sessions.length + 3; i++) sessionData[String(i)] = { name: i, opt: {}, rank: i };
  out.properties = {
    sessionData: JSON.stringify(sessionData),
    sessionN: sessions.length + 3,
    session: 1,
    useMilli: false,
    statalu: "mo3 ao5 ao12 ao25 ao50 ao100 ao200 ao500 ao1000 ao2000 ao5000 ao10000",
  };
  return out;
}
