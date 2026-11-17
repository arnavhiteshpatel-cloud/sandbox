import { describe, expect, it } from "vitest";
import { averageOf, rollingAverage, summarize, trimCounts, bestOf, trimmedIndices } from "./stats";
import { fmtAvg, fmtSingle, parseTime, parseTypedEntry, solveValue, fmtSolve } from "./time";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe("trim counts match csTimer", () => {
  it.each([
    [3, true, 0],
    [5, false, 1],
    [12, false, 1],
    [25, false, 2],
    [50, false, 3],
    [100, false, 5],
    [200, false, 10],
    [500, false, 25],
    [1000, false, 50],
    [2, false, 0],
    [1, false, 0],
  ])("ao/mo%i", (n, mean, t) => {
    expect(trimCounts(n as number, mean as boolean)).toEqual([t, t]);
  });
});

describe("averages", () => {
  it("WCA ao5 example", () => {
    expect(averageOf([12000, 13000, 14000, 15000, 16000])).toBe(14000);
    expect(averageOf([12000, Infinity, 14000, 15000, 16000])).toBe(15000);
    expect(averageOf([Infinity, Infinity, 14000, 15000, 16000])).toBe(Infinity);
    expect(averageOf([10000, 11000, Infinity], { n: 3, mean: true })).toBe(Infinity);
  });

  it("rolling Fenwick average equals naive computation (randomised, with DNFs)", () => {
    const r = rng(42);
    const vals: number[] = [];
    for (let i = 0; i < 3000; i++) vals.push(r() < 0.04 ? Infinity : Math.floor((8000 + r() * 15000) / 10) * 10);
    for (const spec of [{ n: 3, mean: true }, { n: 5 }, { n: 12 }, { n: 25 }, { n: 50 }, { n: 100 }, { n: 1000 }]) {
      const { avg, sd } = rollingAverage(vals, spec);
      for (let i = 0; i < vals.length; i += spec.n > 100 ? 37 : 1) {
        if (i < spec.n - 1) {
          expect(Number.isNaN(avg[i])).toBe(true);
          continue;
        }
        const naive = averageOf(vals.slice(i - spec.n + 1, i + 1), spec);
        if (naive === Infinity) expect(avg[i]).toBe(Infinity);
        else {
          expect(avg[i]).toBeCloseTo(naive, 6);
          expect(Number.isFinite(sd[i])).toBe(true);
        }
      }
    }
  });

  it("handles duplicate values and all-equal windows", () => {
    const vals = [10000, 10000, 10000, 10000, 10000, 20000];
    const { avg } = rollingAverage(vals, { n: 5 });
    expect(avg[4]).toBe(10000);
    expect(avg[5]).toBe(10000);
  });

  it("20k solves x ao10000 is fast", () => {
    const r = rng(1);
    const vals = Array.from({ length: 20000 }, () => (r() < 0.02 ? Infinity : 9000 + r() * 10000));
    const t0 = performance.now();
    for (const n of [5, 12, 100, 1000, 10000]) rollingAverage(vals, { n });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("best and trimmed indices", () => {
    expect(bestOf([NaN, NaN, 5, 3, Infinity]).value).toBe(3);
    expect(bestOf([NaN, Infinity]).value).toBe(Infinity);
    expect([...trimmedIndices([5, 1, 9, 3, 4], { n: 5 })].sort()).toEqual([1, 2]);
  });

  it("summary", () => {
    const s = summarize([1000, 3000, Infinity, 2000]);
    expect(s.solved).toBe(3);
    expect(s.dnf).toBe(1);
    expect(s.mean).toBe(2000);
    expect(s.median).toBe(2000);
    expect(s.best).toBe(1000);
  });
});

describe("time formatting matches csTimer", () => {
  it("truncates singles, rounds averages", () => {
    expect(fmtSingle(14749)).toBe("14.74");
    expect(fmtAvg(14945)).toBe("14.95");
    expect(fmtAvg(14944.9)).toBe("14.94");
    expect(fmtSingle(65432)).toBe("1:05.43");
    expect(fmtSingle(3723456)).toBe("1:02:03.45");
    expect(fmtSingle(8505, 3)).toBe("8.505");
    expect(fmtSingle(Infinity)).toBe("DNF");
  });
  it("solve values truncate to centiseconds", () => {
    expect(solveValue({ time: 14749, penalty: 0 })).toBe(14740);
    expect(solveValue({ time: 14749, penalty: 2000 })).toBe(16740);
    expect(solveValue({ time: 14749, penalty: -1 })).toBe(Infinity);
    expect(solveValue({ time: 14749, penalty: 0 }, 3)).toBe(14749);
    expect(fmtSolve({ time: 14749, penalty: 2000 })).toBe("16.74+");
    expect(fmtSolve({ time: 14749, penalty: -1 }, 2, true)).toBe("DNF(14.74)");
  });
  it("parses times", () => {
    expect(parseTime("12.34")).toEqual({ time: 12340, penalty: 0 });
    expect(parseTime("1:02.345")).toEqual({ time: 62345, penalty: 0 });
    expect(parseTime("DNF(12.30)")).toEqual({ time: 12300, penalty: -1 });
    expect(parseTime("14.20+")).toEqual({ time: 12200, penalty: 2000 });
    expect(parseTime("abc")).toBeNull();
    expect(parseTypedEntry("1234")).toEqual({ time: 12340, penalty: 0 });
    expect(parseTypedEntry("10512")).toEqual({ time: 65120, penalty: 0 });
  });
});
