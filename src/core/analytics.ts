/**
 * Analytics engine: pure, allocation-conscious computations over a chronological list of
 * solves. Everything here is derived strictly from recorded solves (time, penalty, date);
 * nothing is estimated or invented. All functions are deterministic and side-effect free so
 * they can be memoised on input identity and unit-tested.
 *
 * Conventions
 *  - Values are ms with penalty, truncated like csTimer (see solveValue); DNF = Infinity.
 *  - Rolling averages are csTimer-exact (stats.rollingAverage); NaN = window not full yet.
 *  - Dates are local-time calendar based (days, ISO weeks starting Monday, months, years).
 *  - Solves without a date take part in index-based results and are skipped by date-based ones.
 */
import { percentile, rollingAverage, summarize, welch, type RollingResult } from "./stats";
import { solveValue } from "./time";
import type { Solve } from "./types";

const DAY = 86400000;

// ---------------------------------------------------------------- dataset

export interface Dataset {
  /** Chronological solves. */
  solves: Solve[];
  /** ms incl. penalty, DNF = Infinity. */
  values: Float64Array;
  /** Unix ms, NaN when the solve has no date. */
  dates: Float64Array;
  /** Local calendar day as yyyymmdd, 0 when undated. */
  dayKeys: Int32Array;
  /** Number of solves without a date. */
  undated: number;
}

export const dayKeyOf = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};
export const dayKeyToMs = (k: number) => new Date(Math.floor(k / 10000), (Math.floor(k / 100) % 100) - 1, k % 100).getTime();

export function buildDataset(solves: Solve[], decimals = 2): Dataset {
  const n = solves.length;
  const values = new Float64Array(n);
  const dates = new Float64Array(n);
  const dayKeys = new Int32Array(n);
  let undated = 0;
  // Day keys are computed once per distinct day; consecutive solves are usually same-day,
  // so a [dayStart, dayEnd) cache avoids constructing a Date per solve.
  let cs = Infinity,
    ce = -Infinity,
    ck = 0;
  for (let i = 0; i < n; i++) {
    const s = solves[i];
    values[i] = solveValue(s, decimals);
    const t = s.date;
    if (t == null || !Number.isFinite(t)) {
      dates[i] = NaN;
      undated++;
      continue;
    }
    dates[i] = t;
    if (t < cs || t >= ce) {
      const d = new Date(t);
      cs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      ce = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      ck = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    }
    dayKeys[i] = ck;
  }
  return { solves, values, dates, dayKeys, undated };
}

/**
 * Merge several chronological solve lists (one per session) into one chronological list.
 * Undated solves keep their position relative to their session neighbours by borrowing the
 * date of the previous dated solve in the same list. The sort is stable.
 */
export function mergeChronological(lists: Solve[][]): Solve[] {
  const nonEmpty = lists.filter((l) => l.length);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return nonEmpty[0];
  const items: { s: Solve; k: number; l: number; i: number }[] = [];
  nonEmpty.forEach((list, l) => {
    // first known date (for leading undated solves)
    let carry = -Infinity;
    for (const s of list)
      if (s.date != null) {
        carry = s.date;
        break;
      }
    list.forEach((s, i) => {
      if (s.date != null) carry = s.date;
      items.push({ s, k: carry, l, i });
    });
  });
  items.sort((a, b) => a.k - b.k || a.l - b.l || a.i - b.i);
  return items.map((x) => x.s);
}

/** Keep solves whose date lies in [from, to). Undated solves are dropped when any bound is set. */
export function filterByDate(solves: Solve[], from: number | null, to: number | null): Solve[] {
  if (from == null && to == null) return solves;
  const lo = from ?? -Infinity,
    hi = to ?? Infinity;
  return solves.filter((s) => s.date != null && s.date >= lo && s.date < hi);
}

// ---------------------------------------------------------------- small helpers

export function finiteSorted(values: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) out.push(values[i]);
  return out.sort((a, b) => a - b);
}

export const METRICS = ["single", "ao5", "ao12", "ao100", "ao1000"] as const;
export type Metric = (typeof METRICS)[number];
export const METRIC_N: Record<Metric, number> = { single: 1, ao5: 5, ao12: 12, ao100: 100, ao1000: 1000 };

export type RollingSet = Record<Exclude<Metric, "single">, RollingResult>;

export function computeRolling(values: Float64Array, trimPct = 5): RollingSet {
  return {
    ao5: rollingAverage(values, { n: 5 }, trimPct),
    ao12: rollingAverage(values, { n: 12 }, trimPct),
    ao100: rollingAverage(values, { n: 100 }, trimPct),
    ao1000: rollingAverage(values, { n: 1000 }, trimPct),
  };
}

export function metricSeries(m: Metric, values: Float64Array, rolling: RollingSet): Float64Array {
  return m === "single" ? values : rolling[m].avg;
}

/** Best-so-far (running minimum of finite values); NaN until the first finite value. */
export function runningBest(arr: ArrayLike<number>): Float64Array {
  const out = new Float64Array(arr.length);
  let best = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isFinite(v) && v < best) best = v;
    out[i] = Number.isFinite(best) ? best : NaN;
  }
  return out;
}

// ---------------------------------------------------------------- headline

export interface BestEntry {
  label: string;
  value: number;
  /** index of the last solve of the best window (-1 if none) */
  idx: number;
  date: number | null;
}

export interface Headline {
  count: number;
  solved: number;
  dnf: number;
  plus2: number;
  dnfRate: number;
  mean: number;
  median: number;
  sd: number;
  /** Total time spent solving (sum of recorded times incl. penalties, DNFs included at raw time). */
  totalTime: number;
  bests: BestEntry[];
  practiceDays: number;
  currentStreak: number;
  longestStreak: number;
  firstDate: number | null;
  lastDate: number | null;
}

/** Longest run of consecutive calendar days in a sorted unique list of day keys. */
export function longestDayStreak(sortedKeys: number[]): number {
  let best = 0,
    run = 0,
    prev = NaN;
  for (const k of sortedKeys) {
    const t = dayKeyToMs(k);
    run = Number.isFinite(prev) && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    prev = t;
    if (run > best) best = run;
  }
  return best;
}

/** Consecutive practice days ending today (or yesterday, if today has no solves yet). */
export function currentDayStreak(keys: Set<number>, now = Date.now()): number {
  const cur = new Date(now);
  cur.setHours(12, 0, 0, 0);
  if (!keys.has(dayKeyOf(cur.getTime()))) cur.setDate(cur.getDate() - 1);
  let streak = 0;
  while (keys.has(dayKeyOf(cur.getTime()))) {
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

export function headline(ds: Dataset, rolling: RollingSet, now = Date.now()): Headline {
  const { values, solves, dates, dayKeys } = ds;
  const pens = new Float64Array(solves.length);
  let totalTime = 0;
  for (let i = 0; i < solves.length; i++) {
    pens[i] = solves[i].penalty;
    totalTime += solves[i].time + Math.max(0, solves[i].penalty);
  }
  const sum = summarize(values, pens);
  const days = new Set<number>();
  let firstDate: number | null = null,
    lastDate: number | null = null;
  for (let i = 0; i < dayKeys.length; i++) {
    if (!dayKeys[i]) continue;
    days.add(dayKeys[i]);
    const t = dates[i];
    if (firstDate == null || t < firstDate) firstDate = t;
    if (lastDate == null || t > lastDate) lastDate = t;
  }
  const dateAt = (i: number) => (i >= 0 && Number.isFinite(dates[i]) ? dates[i] : null);
  const bestOfArr = (label: string, arr: ArrayLike<number>): BestEntry => {
    let v = Infinity,
      idx = -1;
    for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i]) && arr[i] < v) (v = arr[i]), (idx = i);
    return { label, value: idx >= 0 ? v : NaN, idx, date: dateAt(idx) };
  };
  return {
    count: sum.count,
    solved: sum.solved,
    dnf: sum.dnf,
    plus2: sum.plus2,
    dnfRate: sum.count ? sum.dnf / sum.count : NaN,
    mean: sum.mean,
    median: sum.median,
    sd: sum.sd,
    totalTime,
    bests: [bestOfArr("single", values), bestOfArr("ao5", rolling.ao5.avg), bestOfArr("ao12", rolling.ao12.avg), bestOfArr("ao100", rolling.ao100.avg)],
    practiceDays: days.size,
    currentStreak: currentDayStreak(days, now),
    longestStreak: longestDayStreak([...days].sort((a, b) => a - b)),
    firstDate,
    lastDate,
  };
}

// ---------------------------------------------------------------- PB progression

export interface PbEvent {
  /** index of the solve (or last solve of the window) that set the PB */
  idx: number;
  value: number;
  /** previous PB value (NaN for the first) */
  prev: number;
  date: number | null;
  /** days since the previous PB (null if either is undated or first) */
  days: number | null;
  /** solves since the previous PB (null for the first) */
  solves: number | null;
}

/** Every strict improvement of the running best of a series (finite values only). */
export function pbProgression(arr: ArrayLike<number>, dates?: ArrayLike<number>): PbEvent[] {
  const out: PbEvent[] = [];
  let best = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v) || v >= best) continue;
    const last = out[out.length - 1];
    const date = dates && Number.isFinite(dates[i]) ? dates[i] : null;
    out.push({
      idx: i,
      value: v,
      prev: last ? last.value : NaN,
      date,
      days: last && last.date != null && date != null ? (date - last.date) / DAY : null,
      solves: last ? i - last.idx : null,
    });
    best = v;
  }
  return out;
}

// ---------------------------------------------------------------- period aggregates

export type Period = "day" | "week" | "month" | "year";

export function periodStart(ms: number, period: Period): number {
  const d = new Date(ms);
  switch (period) {
    case "day":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case "week": {
      const dow = (d.getDay() + 6) % 7; // Monday = 0
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime();
    }
    case "month":
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case "year":
      return new Date(d.getFullYear(), 0, 1).getTime();
  }
}

export function nextPeriod(start: number, period: Period): number {
  const d = new Date(start);
  switch (period) {
    case "day":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    case "week":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
    case "month":
      return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    case "year":
      return new Date(d.getFullYear() + 1, 0, 1).getTime();
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function periodLabel(start: number, period: Period): string {
  const d = new Date(start);
  switch (period) {
    case "day":
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    case "week":
      return `Week of ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    case "month":
      return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    case "year":
      return String(d.getFullYear());
  }
}

export interface Bucket {
  start: number;
  end: number;
  label: string;
  /** solves in the period */
  count: number;
  dnf: number;
  /** statistics of the finite metric values in the period */
  n: number;
  mean: number;
  median: number;
  sd: number;
  p10: number;
  p90: number;
  best: number;
  /** solve indices (chronological) */
  idx: number[];
}

/**
 * Calendar aggregates. `metric` defaults to the single values; pass a rolling-average series
 * to aggregate e.g. the ao12s that ended in each period. DNFs are always counted from singles.
 */
export function aggregate(ds: Dataset, period: Period, metric?: ArrayLike<number>): Bucket[] {
  const m = metric ?? ds.values;
  const map = new Map<number, number[]>();
  // cache period start per day key: period boundaries never split a day
  const dayCache = new Map<number, number>();
  for (let i = 0; i < ds.dates.length; i++) {
    const k = ds.dayKeys[i];
    if (!k) continue;
    let st = dayCache.get(k);
    if (st === undefined) dayCache.set(k, (st = periodStart(ds.dates[i], period)));
    let arr = map.get(st);
    if (!arr) map.set(st, (arr = []));
    arr.push(i);
  }
  const out: Bucket[] = [];
  for (const [start, idx] of map) {
    let dnf = 0;
    const fin: number[] = [];
    let sum = 0;
    for (const i of idx) {
      if (!Number.isFinite(ds.values[i])) dnf++;
      const v = m[i];
      if (Number.isFinite(v)) {
        fin.push(v);
        sum += v;
      }
    }
    fin.sort((a, b) => a - b);
    const n = fin.length;
    const mean = n ? sum / n : NaN;
    let sq = 0;
    for (const v of fin) sq += (v - mean) * (v - mean);
    out.push({
      start,
      end: nextPeriod(start, period),
      label: periodLabel(start, period),
      count: idx.length,
      dnf,
      n,
      mean,
      median: n ? percentile(fin, 0.5) : NaN,
      sd: n > 1 ? Math.sqrt(sq / (n - 1)) : NaN,
      p10: n ? percentile(fin, 0.1) : NaN,
      p90: n ? percentile(fin, 0.9) : NaN,
      best: n ? fin[0] : NaN,
      idx,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- milestones

/** Thresholds in seconds; only the ones that are meaningful for the data are shown. */
export const MILESTONE_THRESHOLDS = [120, 90, 75, 60, 50, 45, 40, 35, 30, 25, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];

export interface MilestoneCell {
  idx: number;
  value: number;
  date: number | null;
  /** already under the threshold at the very first full window */
  atStart: boolean;
  /** elapsed since the previous shown milestone of the same metric */
  dDays: number | null;
  dSolves: number | null;
}

export interface MilestoneRow {
  /** threshold in ms */
  threshold: number;
  cells: Record<string, MilestoneCell | null>;
}

export interface MilestoneResult {
  labels: string[];
  rows: MilestoneRow[];
  /** next goal: highest threshold not yet reached by any metric */
  next: { threshold: number; best: Record<string, number> } | null;
}

/**
 * For each threshold, the first index where each series went strictly under it.
 * Rows where every metric was already under at its first window are dropped (trivial),
 * as are rows no metric has reached (the highest such is returned as `next`).
 */
export function milestones(series: { label: string; avg: ArrayLike<number> }[], dates: ArrayLike<number>, thresholdsSec = MILESTONE_THRESHOLDS): MilestoneResult {
  const labels = series.map((s) => s.label);
  const firstValid = series.map((s) => {
    for (let i = 0; i < s.avg.length; i++) if (!Number.isNaN(s.avg[i])) return i;
    return -1;
  });
  const bests = series.map((s) => {
    let b = Infinity;
    for (let i = 0; i < s.avg.length; i++) if (s.avg[i] < b) b = s.avg[i];
    return b;
  });
  const thr = [...thresholdsSec].sort((a, b) => b - a).map((t) => t * 1000);
  // first crossing per series per threshold, one pass per series (thresholds descending)
  const firstUnder: number[][] = series.map((s) => {
    const res = new Array<number>(thr.length).fill(-1);
    let k = 0;
    for (let i = 0; i < s.avg.length && k < thr.length; i++) {
      const v = s.avg[i];
      if (!Number.isFinite(v)) continue;
      while (k < thr.length && v < thr[k]) res[k++] = i;
    }
    return res;
  });
  const rows: MilestoneRow[] = [];
  let next: MilestoneResult["next"] = null;
  const prev: (MilestoneCell | null)[] = series.map(() => null);
  for (let k = 0; k < thr.length; k++) {
    const cells: Record<string, MilestoneCell | null> = {};
    let any = false,
      allStart = true;
    series.forEach((s, j) => {
      const i = firstUnder[j][k];
      if (i < 0) {
        cells[s.label] = null;
        return;
      }
      any = true;
      const atStart = i === firstValid[j];
      if (!atStart) allStart = false;
      const date = Number.isFinite(dates[i]) ? dates[i] : null;
      cells[s.label] = { idx: i, value: s.avg[i], date, atStart, dDays: null, dSolves: null };
    });
    if (!any) {
      if (!next) next = { threshold: thr[k], best: Object.fromEntries(series.map((s, j) => [s.label, bests[j]])) };
      continue;
    }
    if (allStart) {
      series.forEach((s, j) => (prev[j] = cells[s.label]));
      continue;
    }
    series.forEach((s, j) => {
      const c = cells[s.label];
      if (!c) return;
      const p = prev[j];
      if (p) {
        c.dSolves = c.idx - p.idx;
        c.dDays = c.date != null && p.date != null ? (c.date - p.date) / DAY : null;
      }
      prev[j] = c;
    });
    rows.push({ threshold: thr[k], cells });
  }
  return { labels, rows, next };
}

// ---------------------------------------------------------------- distribution

export interface Histogram {
  lo: number;
  hi: number;
  bin: number;
  counts: number[];
  /** finite values below lo / at or above hi (folded into the edge bins for display) */
  under: number;
  over: number;
  total: number;
  dnf: number;
}

/** Display range for a histogram: robust (p0.5–p99.5), snapped outward to the bin width. */
export function histRange(sorted: number[], bin: number): [number, number] {
  if (!sorted.length) return [0, bin];
  const lo = Math.floor(percentile(sorted, 0.005) / bin) * bin;
  let hi = Math.ceil((percentile(sorted, 0.995) + 1) / bin) * bin;
  if (hi <= lo) hi = lo + bin;
  // cap bin count to keep rendering cheap
  if ((hi - lo) / bin > 400) hi = lo + 400 * bin;
  return [lo, hi];
}

export function histogram(values: ArrayLike<number>, bin: number, lo: number, hi: number): Histogram {
  const nb = Math.max(1, Math.round((hi - lo) / bin));
  const counts = new Array<number>(nb).fill(0);
  let under = 0,
    over = 0,
    total = 0,
    dnf = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (!Number.isFinite(v)) {
      dnf++;
      continue;
    }
    total++;
    let b = Math.floor((v - lo) / bin);
    if (b < 0) {
      under++;
      b = 0;
    } else if (b >= nb) {
      over++;
      b = nb - 1;
    }
    counts[b]++;
  }
  return { lo, hi, bin, counts, under, over, total, dnf };
}

export const PERCENTILES = [0.1, 0.25, 0.5, 0.75, 0.9];

// ---------------------------------------------------------------- comparison

export interface GroupStats {
  count: number;
  solved: number;
  mean: number;
  median: number;
  sd: number;
  best: number;
  dnfRate: number;
}

export interface Comparison {
  a: GroupStats;
  b: GroupStats;
  /** mean(A) - mean(B) in ms: positive means B is faster */
  diff: number;
  t: number;
  df: number;
  p: number;
  /** Cohen's d of A vs B (positive = B faster) */
  d: number;
  significant: boolean;
  effect: "negligible" | "small" | "medium" | "large" | "n/a";
  verdict: string;
}

export function groupStats(values: ArrayLike<number>): GroupStats {
  const s = summarize(values);
  return { count: s.count, solved: s.solved, mean: s.mean, median: s.median, sd: s.sd, best: s.best, dnfRate: s.count ? s.dnf / s.count : NaN };
}

const secs = (ms: number) => (Math.abs(ms) / 1000).toFixed(2) + " s";

export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return "–";
  if (p < 0.001) return "p < 0.001";
  return "p = " + (p < 0.01 ? p.toFixed(3) : p.toFixed(2));
}

/** Welch t-test + Cohen's d on finite values, with a plain-English verdict. */
export function compareGroups(av: ArrayLike<number>, bv: ArrayLike<number>, names: [string, string] = ["A", "B"], alpha = 0.05): Comparison {
  const a = groupStats(av),
    b = groupStats(bv);
  const fa = finiteSorted(av),
    fb = finiteSorted(bv);
  const diff = a.mean - b.mean;
  let t = NaN,
    df = NaN,
    p = NaN,
    d = NaN;
  if (fa.length >= 2 && fb.length >= 2) {
    const w = welch(fa, fb);
    t = w.t;
    df = w.df;
    p = w.p;
    d = w.d;
    if (!Number.isFinite(p)) {
      // zero variance in both groups: identical means => p = 1, different => certain
      p = diff === 0 ? 1 : 0;
      d = diff === 0 ? 0 : Math.sign(diff) * Infinity;
    }
    p = Math.min(1, Math.max(0, p));
  }
  const ad = Math.abs(d);
  const effect: Comparison["effect"] = !Number.isFinite(d) && !(ad === Infinity) ? "n/a" : ad < 0.2 ? "negligible" : ad < 0.5 ? "small" : ad < 0.8 ? "medium" : "large";
  const significant = Number.isFinite(p) && p < alpha;
  let verdict: string;
  if (!(fa.length >= 2 && fb.length >= 2)) verdict = "Not enough solved times in both groups to compare (need at least 2 each).";
  else if (diff === 0) verdict = `${names[0]} and ${names[1]} have the same mean.`;
  else {
    const faster = diff > 0 ? names[1] : names[0];
    verdict =
      `${faster} is ${secs(diff)} faster; ` +
      (significant ? `difference is statistically significant (${fmtP(p)}, ${effect} effect).` : `difference is not statistically significant (${fmtP(p)}).`);
  }
  return { a, b, diff, t, df, p, d, significant, effect, verdict };
}

// ---------------------------------------------------------------- improvement & plateaus

export interface Plateau {
  start: number;
  end: number;
  days: number;
  months: number;
  /** mean of the monthly means in the plateau */
  mean: number;
  /** (max - min) / min of monthly means */
  change: number;
  firstIdx: number;
  lastIdx: number;
}

/**
 * Plateaus: maximal runs of consecutive months (empty months in between are allowed, up to
 * `maxGapMonths`) spanning at least `minDays` whose monthly means vary by less than `tol`
 * relative ((max - min) / min). Months with fewer than `minCount` solved times are ignored.
 */
export function detectPlateaus(months: Bucket[], { minDays = 60, tol = 0.02, minCount = 10, maxGapMonths = 1 } = {}): Plateau[] {
  const ms = months.filter((m) => m.n >= minCount && Number.isFinite(m.mean));
  const out: Plateau[] = [];
  const monthIndex = (t: number) => {
    const d = new Date(t);
    return d.getFullYear() * 12 + d.getMonth();
  };
  let i = 0;
  while (i < ms.length) {
    let lo = ms[i].mean,
      hi = ms[i].mean,
      j = i;
    while (j + 1 < ms.length) {
      const nx = ms[j + 1];
      if (monthIndex(nx.start) - monthIndex(ms[j].start) - 1 > maxGapMonths) break;
      const nlo = Math.min(lo, nx.mean),
        nhi = Math.max(hi, nx.mean);
      if ((nhi - nlo) / nlo >= tol) break;
      lo = nlo;
      hi = nhi;
      j++;
    }
    const days = (ms[j].end - ms[i].start) / DAY;
    if (j > i && days >= minDays) {
      let sum = 0;
      for (let k = i; k <= j; k++) sum += ms[k].mean;
      out.push({
        start: ms[i].start,
        end: ms[j].end,
        days: Math.round(days),
        months: j - i + 1,
        mean: sum / (j - i + 1),
        change: (hi - lo) / lo,
        firstIdx: ms[i].idx[0],
        lastIdx: ms[j].idx[ms[j].idx.length - 1],
      });
      i = j + 1;
    } else i++;
  }
  return out;
}

export interface ImprovementWindow {
  /** first/last day (ms, local midnight) of the window */
  start: number;
  end: number;
  from: number;
  to: number;
  /** from - to (ms, positive = faster) */
  delta: number;
  fromIdx: number;
  toIdx: number;
}

/**
 * Fastest-improvement windows: for every practice day D, compare the series value at the end
 * of D with its value at the end of the last practice day at least `windowDays` earlier
 * (and at most 2×windowDays earlier, so long breaks don't count). Returns the `top`
 * best non-overlapping windows.
 */
export function fastestWindows(ds: Dataset, series: ArrayLike<number>, windowDays = 30, top = 3): ImprovementWindow[] {
  // end-of-day value per practice day (chronological by day)
  const days: { t: number; v: number; i: number }[] = [];
  const seen = new Map<number, number>();
  for (let i = 0; i < ds.dayKeys.length; i++) {
    const k = ds.dayKeys[i];
    if (!k || !Number.isFinite(series[i])) continue;
    const at = seen.get(k);
    if (at === undefined) {
      seen.set(k, days.length);
      days.push({ t: dayKeyToMs(k), v: series[i], i });
    } else days[at] = { t: days[at].t, v: series[i], i };
  }
  days.sort((a, b) => a.t - b.t);
  const cands: ImprovementWindow[] = [];
  let p = 0;
  for (let q = 0; q < days.length; q++) {
    const limit = days[q].t - windowDays * DAY;
    while (p + 1 < days.length && days[p + 1].t <= limit) p++;
    if (days[p].t > limit) continue;
    if (days[q].t - days[p].t > 2 * windowDays * DAY) continue;
    const delta = days[p].v - days[q].v;
    if (delta > 0) cands.push({ start: days[p].t, end: days[q].t, from: days[p].v, to: days[q].v, delta, fromIdx: days[p].i, toIdx: days[q].i });
  }
  cands.sort((a, b) => b.delta - a.delta);
  const out: ImprovementWindow[] = [];
  for (const c of cands) {
    if (out.length >= top) break;
    if (out.some((o) => c.start < o.end && o.start < c.end)) continue;
    out.push(c);
  }
  return out;
}

export interface ImprovementReport {
  months: Bucket[];
  /** regression slope of monthly mean, ms per month (negative = getting faster) */
  slope: number;
  intercept: number;
  r2: number;
  /** months used by the regression */
  used: Bucket[];
  bestMonth: Bucket | null;
  worstMonth: Bucket | null;
  biggestGain: { month: Bucket; prev: Bucket; delta: number } | null;
  biggestSlump: { month: Bucket; prev: Bucket; delta: number } | null;
  windows: ImprovementWindow[];
  plateaus: Plateau[];
}

const monthNo = (t: number) => {
  const d = new Date(t);
  return d.getFullYear() * 12 + d.getMonth();
};

export function improvementReport(ds: Dataset, windowSeries: ArrayLike<number>, months?: Bucket[], minCount = 10): ImprovementReport {
  const all = months ?? aggregate(ds, "month");
  const used = all.filter((m) => m.n >= minCount && Number.isFinite(m.mean));
  let slope = NaN,
    intercept = NaN,
    r2 = NaN;
  if (used.length >= 2) {
    // OLS on (month number, mean)
    const x0 = monthNo(used[0].start);
    let sx = 0,
      sy = 0,
      sxx = 0,
      sxy = 0,
      syy = 0;
    const n = used.length;
    for (const m of used) {
      const x = monthNo(m.start) - x0,
        y = m.mean;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
    }
    const d = n * sxx - sx * sx;
    if (d !== 0) {
      slope = (n * sxy - sx * sy) / d;
      intercept = (sy - slope * sx) / n;
      const den = Math.sqrt(d * (n * syy - sy * sy));
      r2 = den ? ((n * sxy - sx * sy) / den) ** 2 : NaN;
    }
  }
  let bestMonth: Bucket | null = null,
    worstMonth: Bucket | null = null;
  for (const m of used) {
    if (!bestMonth || m.mean < bestMonth.mean) bestMonth = m;
    if (!worstMonth || m.mean > worstMonth.mean) worstMonth = m;
  }
  let biggestGain: ImprovementReport["biggestGain"] = null,
    biggestSlump: ImprovementReport["biggestSlump"] = null;
  for (let i = 1; i < used.length; i++) {
    const delta = used[i - 1].mean - used[i].mean;
    if (delta > 0 && (!biggestGain || delta > biggestGain.delta)) biggestGain = { month: used[i], prev: used[i - 1], delta };
    if (delta < 0 && (!biggestSlump || delta < biggestSlump.delta)) biggestSlump = { month: used[i], prev: used[i - 1], delta };
  }
  return {
    months: all,
    slope,
    intercept,
    r2,
    used,
    bestMonth,
    worstMonth,
    biggestGain,
    biggestSlump,
    windows: fastestWindows(ds, windowSeries, 30, 3),
    plateaus: detectPlateaus(all, { minCount }),
  };
}

// ---------------------------------------------------------------- consistency

export interface SeriesPoint {
  x: number;
  y: number;
}

/**
 * Downsample (index, value) pairs to at most `max` points by bucket averaging, skipping
 * non-finite values. Keeps the first and last finite points so the curve spans the range.
 */
export function downsample(ys: ArrayLike<number>, max: number): SeriesPoint[] {
  const n = ys.length;
  const out: SeriesPoint[] = [];
  if (!n) return out;
  const step = Math.max(1, n / max);
  for (let b = 0; b * step < n; b++) {
    const s = Math.floor(b * step),
      e = Math.min(n, Math.floor((b + 1) * step));
    let sum = 0,
      c = 0,
      sx = 0;
    for (let i = s; i < e; i++)
      if (Number.isFinite(ys[i])) {
        sum += ys[i];
        sx += i;
        c++;
      }
    if (c) out.push({ x: sx / c, y: sum / c });
  }
  return out;
}

/** Rolling consistency from a rolling result: σ (ms) or coefficient of variation (σ / mean). */
export function consistencySeries(r: RollingResult, mode: "sd" | "cv"): Float64Array {
  const out = new Float64Array(r.avg.length);
  for (let i = 0; i < out.length; i++) {
    const a = r.avg[i],
      s = r.sd[i];
    out[i] = Number.isFinite(a) && Number.isFinite(s) ? (mode === "sd" ? s : s / a) : NaN;
  }
  return out;
}
