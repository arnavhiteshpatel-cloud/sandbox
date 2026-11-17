import { describe, expect, it } from "vitest";
import {
  aggregate,
  buildDataset,
  compareGroups,
  computeRolling,
  currentDayStreak,
  dayKeyOf,
  detectPlateaus,
  downsample,
  fastestWindows,
  filterByDate,
  headline,
  histogram,
  histRange,
  improvementReport,
  longestDayStreak,
  mergeChronological,
  milestones,
  pbProgression,
  periodStart,
  runningBest,
  type Bucket,
} from "./analytics";
import type { Solve } from "./types";

const DAY = 86400000;
let seq = 0;
function mk(time: number, date: number | null, extra: Partial<Solve> = {}): Solve {
  seq++;
  return {
    id: "s" + seq,
    sessionId: "a",
    ord: seq,
    time,
    penalty: 0,
    splits: null,
    scramble: "R U",
    comment: "",
    date,
    event: "333",
    importId: null,
    fp: "",
    extra: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...extra,
  };
}
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe("dataset", () => {
  it("computes values, dates and day keys; undated counted", () => {
    const ds = buildDataset([mk(10004, at(2024, 3, 1)), mk(12000, null, { penalty: 2000 }), mk(9000, at(2024, 3, 2), { penalty: -1 })]);
    expect(Array.from(ds.values)).toEqual([10000, 14000, Infinity]);
    expect(ds.undated).toBe(1);
    expect(Array.from(ds.dayKeys)).toEqual([20240301, 0, 20240302]);
    expect(Number.isNaN(ds.dates[1])).toBe(true);
  });

  it("merges sessions chronologically keeping undated solves next to their neighbours", () => {
    const a = [mk(1, 100), mk(2, null), mk(3, 300)];
    const b = [mk(4, 150), mk(5, 250)];
    const m = mergeChronological([a, b]).map((s) => s.time);
    expect(m).toEqual([1, 2, 4, 5, 3]);
    expect(mergeChronological([a, []])).toBe(a);
  });

  it("filters by date range and drops undated solves only when bounded", () => {
    const list = [mk(1, 100), mk(2, null), mk(3, 300)];
    expect(filterByDate(list, null, null)).toBe(list);
    expect(filterByDate(list, 100, 300).map((s) => s.time)).toEqual([1]);
    expect(filterByDate(list, 150, null).map((s) => s.time)).toEqual([3]);
  });
});

describe("headline & streaks", () => {
  it("counts practice days and streaks", () => {
    const keys = [20240301, 20240302, 20240303, 20240310, 20240311];
    expect(longestDayStreak(keys)).toBe(3);
    const now = at(2024, 3, 12);
    expect(currentDayStreak(new Set(keys), now)).toBe(2); // today missing -> counts from yesterday
    expect(currentDayStreak(new Set(keys), at(2024, 3, 14))).toBe(0);
  });

  it("summarises solves and finds bests with dates", () => {
    const solves = [10, 11, 9, 12, 8, 13, 10].map((s, i) => mk(s * 1000, at(2024, 1, 1 + i)));
    solves[3].penalty = -1;
    const ds = buildDataset(solves);
    const h = headline(ds, computeRolling(ds.values), at(2024, 1, 8));
    expect(h.count).toBe(7);
    expect(h.dnf).toBe(1);
    expect(h.dnfRate).toBeCloseTo(1 / 7);
    expect(h.bests[0]).toMatchObject({ label: "single", value: 8000, idx: 4 });
    expect(h.bests[0].date).toBe(at(2024, 1, 5));
    expect(h.practiceDays).toBe(7);
    expect(h.currentStreak).toBe(7);
    expect(h.bests[1].label).toBe("ao5");
    expect(Number.isFinite(h.bests[1].value)).toBe(true);
  });
});

describe("PB progression", () => {
  it("lists strict improvements with deltas", () => {
    const vals = [10, 12, 9, Infinity, 9, 7, NaN, 8, 6];
    const dates = vals.map((_, i) => i * DAY);
    const pb = pbProgression(vals, dates);
    expect(pb.map((p) => p.value)).toEqual([10, 9, 7, 6]);
    expect(pb.map((p) => p.idx)).toEqual([0, 2, 5, 8]);
    expect(Number.isNaN(pb[0].prev)).toBe(true);
    expect(pb[1]).toMatchObject({ prev: 10, days: 2, solves: 2 });
  });

  it("running best is NaN until first finite value", () => {
    const r = runningBest([Infinity, 5, 7, 3]);
    expect(Number.isNaN(r[0])).toBe(true);
    expect(Array.from(r.slice(1))).toEqual([5, 5, 3]);
  });
});

describe("aggregates", () => {
  it("period starts: ISO week begins Monday", () => {
    // 2024-03-07 is a Thursday -> Monday 2024-03-04
    expect(periodStart(at(2024, 3, 7), "week")).toBe(new Date(2024, 2, 4).getTime());
    expect(periodStart(at(2024, 3, 3), "week")).toBe(new Date(2024, 1, 26).getTime()); // Sunday
    expect(periodStart(at(2024, 3, 7), "month")).toBe(new Date(2024, 2, 1).getTime());
    expect(periodStart(at(2024, 3, 7), "year")).toBe(new Date(2024, 0, 1).getTime());
  });

  it("groups by day/month with mean, median, percentiles, DNFs; skips undated", () => {
    const solves = [
      mk(10000, at(2024, 1, 1, 9)),
      mk(20000, at(2024, 1, 1, 20)),
      mk(30000, at(2024, 1, 1, 21), { penalty: -1 }),
      mk(5000, null),
      mk(12000, at(2024, 2, 3)),
    ];
    const ds = buildDataset(solves);
    const days = aggregate(ds, "day");
    expect(days.length).toBe(2);
    expect(days[0]).toMatchObject({ label: "2024-01-01", count: 3, dnf: 1, n: 2, mean: 15000, median: 15000, best: 10000 });
    expect(days[0].idx).toEqual([0, 1, 2]);
    expect(days[0].p10).toBeCloseTo(11000);
    expect(days[0].p90).toBeCloseTo(19000);
    const months = aggregate(ds, "month");
    expect(months.map((m) => m.label)).toEqual(["Jan 2024", "Feb 2024"]);
    expect(months[1].idx).toEqual([4]);
    const years = aggregate(ds, "year");
    expect(years[0].count).toBe(4);
  });

  it("aggregates a custom metric series", () => {
    const ds = buildDataset([mk(1000, at(2024, 1, 1)), mk(2000, at(2024, 1, 1))]);
    const b = aggregate(ds, "day", [NaN, 7000]);
    expect(b[0]).toMatchObject({ count: 2, n: 1, mean: 7000 });
  });
});

describe("milestones", () => {
  it("finds first crossings, elapsed between them, drops trivial rows, reports next goal", () => {
    // series improving 31 -> 14 s over 18 steps, one per day
    const avg = [NaN, ...Array.from({ length: 18 }, (_, i) => (31 - i) * 1000)];
    const dates = avg.map((_, i) => i * DAY);
    const r = milestones([{ label: "ao5", avg }], dates, [40, 35, 30, 25, 20, 15, 10]);
    expect(r.rows.map((x) => x.threshold / 1000)).toEqual([30, 25, 20, 15]);
    const c30 = r.rows[0].cells.ao5!;
    expect(c30.idx).toBe(3); // 29 s at index 3
    expect(c30.dSolves).toBe(2); // since sub-35 (trivial, at start: index 1)
    const c25 = r.rows[1].cells.ao5!;
    expect(c25).toMatchObject({ idx: 8, dSolves: 5, dDays: 5 });
    expect(r.next?.threshold).toBe(10000);
    expect(r.next?.best.ao5).toBe(14000);
  });

  it("keeps rows reached by some metrics with nulls for others", () => {
    const a = [20000, 19000, 14000];
    const b = [NaN, 20000, 19000];
    const r = milestones(
      [
        { label: "ao5", avg: a },
        { label: "ao100", avg: b },
      ],
      [0, DAY, 2 * DAY],
      [25, 20, 15],
    );
    expect(r.rows.map((x) => x.threshold / 1000)).toEqual([20, 15]);
    expect(r.rows[0].cells.ao100!.idx).toBe(2);
    expect(r.rows[1].cells.ao100).toBeNull();
    expect(r.rows[1].cells.ao5!.idx).toBe(2);
  });
});

describe("distribution", () => {
  it("bins values and folds outliers into edge bins", () => {
    const h = histogram([1000, 1500, 2500, 9000, Infinity, NaN, -5], 1000, 1000, 3000);
    expect(h.counts).toEqual([3, 2]); // -5 folded into first, 9000 into last
    expect(h.under).toBe(1);
    expect(h.over).toBe(1);
    expect(h.dnf).toBe(1);
    expect(h.total).toBe(5);
  });

  it("robust range snaps to bin width", () => {
    const sorted = Array.from({ length: 1000 }, (_, i) => 10000 + i * 10);
    const [lo, hi] = histRange(sorted, 500);
    expect(lo % 500).toBe(0);
    expect(hi % 500).toBe(0);
    expect(lo).toBeLessThanOrEqual(10050);
    expect(hi).toBeGreaterThanOrEqual(19900);
  });
});

describe("comparison", () => {
  it("detects a significant difference with verdict", () => {
    const a = Array.from({ length: 200 }, (_, i) => 20000 + ((i * 37) % 1000));
    const b = Array.from({ length: 200 }, (_, i) => 16790 + ((i * 53) % 1000));
    const c = compareGroups(a, b, ["First 200", "Last 200"]);
    expect(c.diff).toBeGreaterThan(3000);
    expect(c.significant).toBe(true);
    expect(c.p).toBeLessThan(0.001);
    expect(c.effect).toBe("large");
    expect(c.verdict).toMatch(/^Last 200 is 3\.\d\d s faster; difference is statistically significant/);
  });

  it("reports non-significance for overlapping groups", () => {
    const a = [10000, 12000, 11000, 13000, 9000];
    const b = [10500, 11500, 12500, 9500, 11400];
    const c = compareGroups(a, b);
    expect(c.significant).toBe(false);
    expect(c.verdict).toMatch(/not statistically significant/);
  });

  it("excludes DNFs from the test but counts their rate; handles tiny groups", () => {
    const c = compareGroups([10000, Infinity, 11000], [9000]);
    expect(c.a.dnfRate).toBeCloseTo(1 / 3);
    expect(Number.isNaN(c.p)).toBe(true);
    expect(c.verdict).toMatch(/Not enough/);
  });
});

describe("plateaus & improvement", () => {
  const month = (y: number, m: number, mean: number, n = 50): Bucket => {
    const start = new Date(y, m - 1, 1).getTime();
    const end = new Date(y, m, 1).getTime();
    return { start, end, label: "", count: n, dnf: 0, n, mean, median: mean, sd: 0, p10: mean, p90: mean, best: mean, idx: [m] };
  };

  it("finds runs of >= 60 days with < 2% change", () => {
    const months = [month(2024, 1, 20000), month(2024, 2, 18000), month(2024, 3, 17000), month(2024, 4, 17100), month(2024, 5, 17200), month(2024, 6, 15000), month(2024, 7, 15400)];
    const p = detectPlateaus(months);
    expect(p.length).toBe(1);
    expect(p[0].months).toBe(3);
    expect(p[0].start).toBe(new Date(2024, 2, 1).getTime());
    expect(p[0].days).toBe(92);
    expect(p[0].change).toBeCloseTo(200 / 17000);
    // Jun-Jul (61 days, 2.7% apart) qualifies with a looser tolerance
    expect(detectPlateaus(months, { tol: 0.03 }).length).toBe(2);
  });

  it("ignores thin months and breaks on long gaps", () => {
    const months = [month(2024, 1, 17000), month(2024, 2, 30000, 3), month(2024, 3, 17100), month(2024, 9, 17050), month(2024, 10, 17000)];
    const p = detectPlateaus(months);
    expect(p.length).toBe(2);
    expect(p[0].months).toBe(2); // Jan + Mar (Feb ignored, gap of one month allowed)
    expect(p[1].start).toBe(new Date(2024, 8, 1).getTime());
  });

  it("regresses monthly means and finds fastest windows", () => {
    const solves: Solve[] = [];
    // 6 months, 30 solves per month, mean drops by 1 s / month
    for (let m = 0; m < 6; m++) for (let k = 0; k < 30; k++) solves.push(mk(25000 - m * 1000 + (k % 3) * 10, new Date(2024, m, 1 + k % 28, 12).getTime()));
    const ds = buildDataset(solves);
    const r = improvementReport(ds, ds.values);
    expect(r.used.length).toBe(6);
    expect(r.slope).toBeCloseTo(-1000, 0);
    expect(r.r2).toBeCloseTo(1, 3);
    expect(r.bestMonth?.label).toBe("Jun 2024");
    expect(r.worstMonth?.label).toBe("Jan 2024");
    expect(r.biggestGain?.delta).toBeCloseTo(1000, 0);
    expect(r.windows.length).toBeGreaterThan(0);
    for (const w of r.windows) {
      expect(w.delta).toBeGreaterThan(0);
      expect(w.end - w.start).toBeGreaterThanOrEqual(30 * DAY - 2 * 3600000);
    }
    // windows never overlap
    const ws = [...r.windows].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ws.length; i++) expect(ws[i].start).toBeGreaterThanOrEqual(ws[i - 1].end);
  });

  it("fastest windows ignore comparisons across very long breaks", () => {
    const solves = [mk(30000, at(2024, 1, 1)), mk(10000, at(2024, 6, 1))];
    const ds = buildDataset(solves);
    expect(fastestWindows(ds, ds.values, 30)).toEqual([]);
  });
});

describe("helpers", () => {
  it("downsample keeps the span and averages buckets", () => {
    const ys = Array.from({ length: 1000 }, (_, i) => i);
    const d = downsample(ys, 100);
    expect(d.length).toBe(100);
    expect(d[0].y).toBeCloseTo(4.5);
    expect(d[99].x).toBeCloseTo(994.5);
    expect(downsample([NaN, NaN], 10)).toEqual([]);
  });

  it("dayKeyOf is local-time based", () => {
    expect(dayKeyOf(at(2023, 12, 31, 23))).toBe(20231231);
  });

  it("handles 20k solves quickly", () => {
    const solves: Solve[] = [];
    let t = at(2020, 1, 1);
    for (let i = 0; i < 20000; i++) {
      t += 45000 + ((i * 7919) % 60000) + (i % 300 === 0 ? 2 * DAY : 0);
      solves.push(mk(9000 + ((i * 104729) % 12000), t, { penalty: i % 97 === 0 ? -1 : 0 }));
    }
    const t0 = performance.now();
    const ds = buildDataset(solves);
    const rolling = computeRolling(ds.values);
    headline(ds, rolling);
    aggregate(ds, "day");
    aggregate(ds, "week");
    improvementReport(ds, rolling.ao100.avg);
    milestones(
      [
        { label: "ao5", avg: rolling.ao5.avg },
        { label: "ao12", avg: rolling.ao12.avg },
        { label: "ao100", avg: rolling.ao100.avg },
      ],
      ds.dates,
    );
    pbProgression(ds.values, ds.dates);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
  });
});
