import { describe, expect, it } from "vitest";
import { Cube, invertAlg } from "../cube";
import { OLL, PLL } from "../algs";
import { solveCross, solveAllColours, crossDistanceHistogram, CROSS_ROTATION } from "./cross";
import { validateAlg, pllArrows, relabel, Z2, caseView } from "./cases";
import { review, gradeExecution, newCard, DAY } from "./srs";
import { drillWeights, pickWeighted, recogWeights } from "./select";
import { caseStat } from "./caseStats";
import { phaseBreakdown, phaseDurations } from "./phases";
import { computePlan } from "./plan";
import { emptyTrainState, sanitizeTrainState } from "./types";
import { resolveSet } from "./sets";

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function randomMoves(n: number, rand: () => number) {
  const faces = "URFDLB";
  const out: string[] = [];
  let last = -1;
  while (out.length < n) {
    const f = Math.floor(rand() * 6);
    if (f === last) continue;
    last = f;
    out.push(faces[f] + ["", "2", "'"][Math.floor(rand() * 3)]);
  }
  return out.join(" ");
}

function crossOnD(c: Cube) {
  const fl = c.facelets();
  const cc = fl.D[4];
  return [1, 3, 5, 7].every((i) => fl.D[i] === cc) && (["F", "R", "B", "L"] as const).every((f) => fl[f][7] === fl[f][4]);
}

describe("cross solver", () => {
  it("distance table matches the known optimal cross distribution", () => {
    expect(crossDistanceHistogram()).toEqual([1, 15, 158, 1394, 9809, 46381, 97254, 34966, 102]);
  });

  it("rotations bring each colour to D", () => {
    CROSS_ROTATION.forEach((r, c) => expect(new Cube().apply(r).facelets().D[4]).toBe(c));
  });

  it("solutions solve the cross, are optimal (≤ scramble length) and fast", () => {
    const rand = seeded(7);
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) {
      const k = 1 + (i % 7);
      const scr = randomMoves(k, rand);
      // the scramble only touches D-cross pieces in ways its inverse fixes → optimal ≤ k
      const s = solveCross(scr, 3);
      expect(s.length).toBeLessThanOrEqual(k);
      for (const sol of s.solutions) {
        expect(sol.split(" ").filter(Boolean).length).toBe(s.length);
        expect(crossOnD(new Cube().apply(`${scr} ${s.rotation} ${sol}`))).toBe(true);
      }
    }
    for (let i = 0; i < 20; i++) {
      const scr = randomMoves(25, rand);
      for (const s of solveAllColours(scr)) {
        expect(s.length).toBeLessThanOrEqual(8);
        expect(crossOnD(new Cube().apply(`${scr} ${s.rotation} ${s.solutions[0]}`))).toBe(true);
        expect(new Cube().apply(`${scr} ${s.rotation}`).facelets().D[4]).toBe(s.colour);
      }
    }
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it("a solved cross needs 0 moves; a single turn needs 1", () => {
    expect(solveCross("R U R' U2 F' U' F", 3).length).toBe(0);
    expect(solveCross("D", 3).length).toBe(1);
    expect(solveCross("D", 3).solutions[0]).toBe("D'");
    expect(solveCross("F", 3).solutions).toContain("F'");
  });
});

describe("case verification", () => {
  it("accepts every library alg, with any AUF before/after", () => {
    for (const c of [...OLL, ...PLL]) {
      for (const a of c.algs) expect(validateAlg(c.id, a).ok, c.id).toBe(true);
      expect(validateAlg(c.id, `U ${c.algs[0]} U2`).ok, c.id + " auf").toBe(true);
    }
  });

  it("accepts known alternative algs", () => {
    expect(validateAlg("PLL-T", "(R U R' U') R' F R2 U' R' U' (R U R' F')").ok).toBe(true);
    expect(validateAlg("PLL-Ua", "R U' R U R U R U' R' U' R2").ok).toBe(true);
    expect(validateAlg("PLL-H", "(M2 U M2) U2 (M2 U M2)").ok).toBe(true);
    expect(validateAlg("OLL27", "L' U2 L U L' U L").ok).toBe(true); // left-handed sune
  });

  it("rejects algs for other cases and broken algs with a clear message", () => {
    const wrong = validateAlg("PLL-T", PLL.find((c) => c.id === "PLL-Ua")!.algs[0]);
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/different case/);
    const broken = validateAlg("PLL-T", "R U R'");
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/breaks the first two layers/);
    const bad = validateAlg("PLL-T", "R U Q");
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Unrecognised/);
    expect(validateAlg("OLL21", "R U R' U R U2 R'").ok).toBe(false);
  });

  it("PLL arrows: T has two swaps, Ua a 3-cycle, H two edge swaps", () => {
    const alg = (n: string) => PLL.find((c) => c.id === "PLL-" + n)!.algs[0];
    const t = pllArrows(alg("T"));
    expect(t.length).toBe(2);
    expect(t.every((a) => a.both)).toBe(true);
    const ua = pllArrows(alg("Ua"));
    expect(ua.length).toBe(3);
    expect(ua.every((a) => !a.both)).toBe(true);
    expect(pllArrows(alg("H")).length).toBe(2);
  });

  it("case views are consistent with the simulator", () => {
    const v = caseView(PLL[0].algs[0]);
    expect(v.U.every((x) => x === 0)).toBe(true);
    const o = caseView(OLL[44].algs[0]); // OLL45 T shape
    expect(o.U.filter((x) => x === 0).length).toBe(5);
  });

  it("z2 relabelling keeps a white cross solved for F2L scrambles", () => {
    // a scramble that keeps the D (yellow) cross solved, relabelled, keeps the U (white) cross solved
    const scr = "R U R' U' F' U F L U2 L'";
    const c = new Cube().apply(relabel(scr, Z2)).facelets();
    expect([1, 3, 5, 7].every((i) => c.U[i] === 0)).toBe(true);
    expect(relabel("R U' D2 F", Z2)).toBe("L D' U2 F");
    expect(invertAlg("R U")).toBe("U' R'");
  });
});

describe("spaced repetition", () => {
  const now = 1_700_000_000_000;
  it("SM-2 intervals grow 1, 4, ×EF and lapses reset", () => {
    let c = review(undefined, 5, now);
    expect(c.interval).toBe(1);
    expect(c.due).toBe(now + DAY);
    c = review(c, 5, c.due);
    expect(c.interval).toBe(4);
    const ef = c.ef;
    c = review(c, 4, c.due);
    expect(c.interval).toBe(Math.round(4 * c.ef));
    expect(c.ef).toBeCloseTo(ef, 5); // q = 4 leaves EF unchanged
    const lapse = review(c, 1, c.due);
    expect(lapse.reps).toBe(0);
    expect(lapse.lapses).toBe(1);
    expect(lapse.due - c.due).toBe(10 * 60_000);
    expect(lapse.ef).toBeLessThan(c.ef);
  });
  it("early successful reviews do not inflate the schedule", () => {
    const c = review(review(undefined, 5, now), 5, now + DAY);
    const early = review(c, 5, now + DAY + 1000);
    expect(early.due).toBe(c.due);
    expect(early.reps).toBe(c.reps);
  });
  it("EF floor 1.3 and grading", () => {
    let c = newCard(now);
    for (let i = 0; i < 20; i++) c = review(c, 0, now);
    expect(c.ef).toBe(1.3);
    expect(gradeExecution(2000, false, 2500)).toBe(5);
    expect(gradeExecution(3500, false, 2500)).toBe(4);
    expect(gradeExecution(9000, false, 2500)).toBe(3);
    expect(gradeExecution(1000, true, 2500)).toBe(1);
  });
});

describe("selection and stats", () => {
  const now = 1_700_000_000_000;
  it("weights unseen, due, slow and failed cases above solid ones; avoids repeats", () => {
    const st = emptyTrainState();
    const ids = ["PLL-T", "PLL-Ua", "PLL-Ub", "PLL-H"];
    // T: solid & not due
    st.drill["PLL-T"] = Array.from({ length: 10 }, (_, i) => ({ ms: 1500, at: now - i * 1000 }));
    st.srs["PLL-T"] = { ef: 2.5, reps: 3, interval: 10, due: now + 5 * DAY, lapses: 0, last: now };
    // Ua: slow and due
    st.drill["PLL-Ua"] = Array.from({ length: 10 }, (_, i) => ({ ms: 5000, at: now - i * 1000 }));
    st.srs["PLL-Ua"] = { ef: 2.5, reps: 2, interval: 4, due: now - DAY, lapses: 0, last: now - 5 * DAY };
    // H: failed
    st.drill["PLL-H"] = [{ ms: 3000, at: now, failed: true }, { ms: 2000, at: now }];
    st.srs["PLL-H"] = { ef: 2.3, reps: 0, interval: 0, due: now + 600_000, lapses: 1, last: now };
    const w = Object.fromEntries(drillWeights(st, ids, now).map((x) => [x.id, x]));
    expect(w["PLL-Ua"].weight).toBeGreaterThan(w["PLL-T"].weight);
    expect(w["PLL-Ub"].weight).toBeGreaterThan(w["PLL-T"].weight);
    expect(w["PLL-H"].weight).toBeGreaterThan(w["PLL-T"].weight);
    expect(w["PLL-Ua"].reasons.join(" ")).toMatch(/overdue|due/);
    expect(w["PLL-Ua"].reasons.join(" ")).toMatch(/slow/);
    const noRepeat = drillWeights(st, ids, now, "PLL-Ua").find((x) => x.id === "PLL-Ua")!;
    expect(noRepeat.weight).toBeLessThan(w["PLL-Ua"].weight * 0.2);
    // distribution follows weights
    const rand = seeded(3);
    const counts: Record<string, number> = {};
    const items = drillWeights(st, ids, now);
    for (let i = 0; i < 4000; i++) {
      const p = pickWeighted(items, rand)!;
      counts[p.id] = (counts[p.id] ?? 0) + 1;
    }
    expect(counts["PLL-Ua"]).toBeGreaterThan(counts["PLL-T"] * 2);
  });

  it("recognition weights favour misrecognised cases", () => {
    const st = emptyTrainState();
    st.recog["PLL-T"] = Array.from({ length: 10 }, () => ({ ms: 800, at: now, ok: true }));
    st.recog["PLL-V"] = Array.from({ length: 10 }, (_, i) => ({ ms: 1200, at: now, ok: i % 2 === 0 }));
    const w = Object.fromEntries(recogWeights(st, ["PLL-T", "PLL-V"]).map((x) => [x.id, x.weight]));
    expect(w["PLL-V"]).toBeGreaterThan(w["PLL-T"] * 2);
  });

  it("case stats: mean of last 12 successes, best, trend, mastery", () => {
    const recs = Array.from({ length: 20 }, (_, i) => ({ ms: 4000 - i * 100, at: now + i }));
    const s = caseStat("PLL-T", [...recs, { ms: 9999, at: now + 99, failed: true }], [], undefined, 2500);
    expect(s.count).toBe(21);
    expect(s.best).toBe(2100);
    expect(s.mean).toBeCloseTo(recs.slice(-12).reduce((a, r) => a + r.ms, 0) / 12, 6);
    expect(s.trend).toBeCloseTo(-100, 6);
    expect(s.failRate).toBeCloseTo(0.1, 6);
    expect(s.mastery).toBeGreaterThan(0);
    expect(s.mastery).toBeLessThan(1);
    expect(caseStat("PLL-T", [], [], undefined, 2500).mastery).toBeNull();
    const fast = caseStat("PLL-T", Array.from({ length: 10 }, () => ({ ms: 1500, at: now })), [], { ef: 2.6, reps: 5, interval: 30, due: now, lapses: 0, last: now }, 2500);
    expect(fast.mastery!).toBeGreaterThan(0.95);
  });
});

describe("phases, sets and plan", () => {
  const now = 1_700_000_000_000;
  it("phase breakdown averages durations", () => {
    expect(phaseDurations([1000, 5000, 7000, 9000])).toEqual([1000, 4000, 2000, 2000]);
    const b = phaseBreakdown([
      { at: 1, splits: [1000, 5000, 7000, 9000], scramble: "" },
      { at: 2, splits: [2000, 8000, 9000, 11000], scramble: "" },
      { at: 3, splits: [1, 2], scramble: "" },
    ]);
    expect(b.n).toBe(2);
    expect(b.means).toEqual([1500, 5000, 1500, 2000]);
    expect(b.total).toBe(10000);
    expect(b.share[1]).toBeCloseTo(0.5);
  });

  it("sets resolve collections, learning and due", () => {
    const st = emptyTrainState();
    st.collections.push({ id: "c1", name: "Mine", caseIds: ["PLL-T", "nope"], createdAt: 0 });
    st.cases["OLL21"] = { status: "learning" };
    st.srs["PLL-H"] = { ef: 2.5, reps: 1, interval: 1, due: now - 1, lapses: 0, last: 0 };
    expect(resolveSet(st, "col:c1", now)).toEqual(["PLL-T"]);
    expect(resolveSet(st, "learning", now)).toEqual(["OLL21"]);
    expect(resolveSet(st, "due", now)).toEqual(["PLL-H"]);
    expect(resolveSet(st, "PLL", now).length).toBe(21);
  });

  it("plan is deterministic and explains itself", () => {
    const st = emptyTrainState();
    st.srs["PLL-H"] = { ef: 2.5, reps: 1, interval: 1, due: now - 2 * DAY, lapses: 0, last: 0 };
    st.drill["PLL-V"] = Array.from({ length: 6 }, () => ({ ms: 6000, at: now - 1000 }));
    const a = computePlan(st, now);
    const b = computePlan(st, now);
    expect(a).toEqual(b);
    expect(a.due.map((d) => d.id)).toEqual(["PLL-H"]);
    expect(a.weakExec[0].id).toBe("PLL-V");
    expect(a.mix.length).toBeGreaterThan(2);
    for (const m of a.mix) expect(m.why.length).toBeGreaterThan(10);
    expect(a.nextToLearn[0]).toBe("PLL-Ua");
    expect(a.targets.find((t) => t.label === "Drill executions")!.current).toBe(6);
  });

  it("sanitizes garbage state", () => {
    const s = sanitizeTrainState({ cases: 5, collections: [{ bad: 1 }], prefs: { tab: "drill" } });
    expect(s.cases).toEqual({});
    expect(s.collections).toEqual([]);
    expect(s.prefs.tab).toBe("drill");
    expect(s.prefs.targetPLL).toBe(2500);
  });
});
