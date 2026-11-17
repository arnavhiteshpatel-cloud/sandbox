import { describe, expect, it } from "vitest";
import { pbThreshold, percentileRank, practiceStreak } from "./insights";
import { averageOf } from "./stats";

describe("PB thresholds", () => {
  it("ao5: finds the exact cutoff", () => {
    const prev = [10000, 11000, 12000, 13000]; // next solve t; ao5 = mean of middle three
    const best = 11500;
    const r = pbThreshold(prev, { n: 5 }, best);
    expect(r.kind).toBe("below");
    if (r.kind === "below") {
      expect(averageOf([...prev, r.ms - 10], { n: 5 })).toBeLessThan(best);
      expect(averageOf([...prev, r.ms], { n: 5 })).toBeGreaterThanOrEqual(best);
    }
  });
  it("impossible and guaranteed cases", () => {
    expect(pbThreshold([20000, 20000, 20000, 20000], { n: 5 }, 10000).kind).toBe("none");
    expect(pbThreshold([5000, 5000, 5000, 5000], { n: 5 }, 10000).kind).toBe("any");
    expect(pbThreshold([5000, 5000], { n: 3, mean: true }, NaN).kind).toBe("any");
  });
  it("percentile and streak", () => {
    expect(percentileRank([1, 2, 3, 4, NaN], 2.5)).toBe(0.5);
    const day = 86400000;
    const now = new Date(2026, 10, 17, 15).getTime();
    expect(practiceStreak([now, now - day, now - 2 * day, now - 4 * day], now)).toBe(3);
    expect(practiceStreak([now - day, now - 2 * day], now)).toBe(2);
    expect(practiceStreak([now - 3 * day], now)).toBe(0);
  });
});
