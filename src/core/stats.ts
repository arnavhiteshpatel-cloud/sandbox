/**
 * Statistics engine.
 *
 * Semantics match csTimer (src/js/stats/timestat.js):
 *  - aoN trims ceil(N * trimPct / 100) solves from each end (default 5%),
 *    and if that would trim everything, one less from each side.
 *    => ao5: 1/1, ao12: 1/1, ao25: 2/2, ao50: 3/3, ao100: 5/5, ao1000: 50/50.
 *  - moN trims nothing.
 *  - An average is DNF when the number of DNFs exceeds the upper trim count.
 *  - Values are the per-solve truncated values (see solveValue), DNF = Infinity.
 *
 * Rolling averages over n solves use a Fenwick tree over value ranks so that every
 * window is O(log n): computing ao10000 across 20k+ solves takes milliseconds.
 */

export interface AvgSpec {
  /** Window size. */
  n: number;
  /** true => mean (no trimming), e.g. mo3. */
  mean?: boolean;
}

export function avgLabel(a: AvgSpec) {
  return `${a.mean ? "mo" : "ao"}${a.n}`;
}

export function parseAvgLabel(s: string): AvgSpec | null {
  const m = /^(ao|mo)(\d+)$/i.exec(s.trim());
  if (!m) return null;
  const n = +m[2];
  if (n < 1 || n > 100000) return null;
  return { n, mean: m[1].toLowerCase() === "mo" };
}

export function trimCounts(n: number, mean = false, trimPct = 5): [number, number] {
  if (mean) return [0, 0];
  const t = Math.ceil((n / 100) * trimPct);
  if (t + t >= n) return [Math.max(t - 1, 0), Math.max(t - 1, 0)];
  return [t, t];
}

class Fenwick {
  cnt: Int32Array;
  sum: Float64Array;
  sq: Float64Array;
  n: number;
  logn: number;
  constructor(n: number) {
    this.n = n;
    this.cnt = new Int32Array(n + 1);
    this.sum = new Float64Array(n + 1);
    this.sq = new Float64Array(n + 1);
    this.logn = 1;
    while (1 << this.logn <= n) this.logn++;
  }
  add(i: number, c: number, v: number) {
    const vv = v * v * c;
    const vs = v * c;
    for (i++; i <= this.n; i += i & -i) {
      this.cnt[i] += c;
      this.sum[i] += vs;
      this.sq[i] += vv;
    }
  }
  /** Sum (and sum of squares) of the k smallest elements. vals[rank] gives value of rank. */
  smallest(k: number, vals: Float64Array): [number, number] {
    if (k <= 0) return [0, 0];
    let pos = 0,
      rem = k,
      s = 0,
      q = 0;
    for (let b = 1 << this.logn; b > 0; b >>= 1) {
      const np = pos + b;
      if (np <= this.n && this.cnt[np] < rem) {
        pos = np;
        rem -= this.cnt[np];
        s += this.sum[np];
        q += this.sq[np];
      }
    }
    // element at rank index `pos` (0-based) supplies the remaining `rem` copies
    const v = vals[pos];
    return [s + v * rem, q + v * v * rem];
  }
}

export interface RollingResult {
  /** avg[i] = average of window ending at i (NaN if i < n-1, Infinity if DNF). */
  avg: Float64Array;
  /** Standard deviation of counted (non-trimmed) solves, NaN where undefined. */
  sd: Float64Array;
}

/**
 * Rolling trimmed average for every window ending at i.
 */
export function rollingAverage(values: ArrayLike<number>, spec: AvgSpec, trimPct = 5): RollingResult {
  const len = values.length;
  const n = spec.n;
  const avg = new Float64Array(len).fill(NaN);
  const sd = new Float64Array(len).fill(NaN);
  if (n <= 0 || len < n) return { avg, sd };
  const [tl, tr] = trimCounts(n, spec.mean, trimPct);
  // coordinate compression of finite values
  const finite: number[] = [];
  for (let i = 0; i < len; i++) if (Number.isFinite(values[i])) finite.push(values[i]);
  finite.sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const v of finite) if (uniq.length === 0 || uniq[uniq.length - 1] !== v) uniq.push(v);
  const vals = Float64Array.from(uniq);
  const rankOf = (v: number) => {
    let lo = 0,
      hi = vals.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (vals[m] < v) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const ranks = new Int32Array(len);
  for (let i = 0; i < len; i++) ranks[i] = Number.isFinite(values[i]) ? rankOf(values[i]) : -1;
  const fw = new Fenwick(Math.max(vals.length, 1));
  let dnf = 0;
  const counted = n - tl - tr;
  for (let i = 0; i < len; i++) {
    if (ranks[i] < 0) dnf++;
    else fw.add(ranks[i], 1, values[i]);
    if (i >= n) {
      const j = i - n;
      if (ranks[j] < 0) dnf--;
      else fw.add(ranks[j], -1, values[j]);
    }
    if (i >= n - 1) {
      if (dnf > tr) {
        avg[i] = Infinity;
      } else {
        const [s1, q1] = fw.smallest(n - tr, vals);
        const [s0, q0] = fw.smallest(tl, vals);
        const s = s1 - s0;
        const q = q1 - q0;
        avg[i] = s / counted;
        sd[i] = counted > 1 ? Math.sqrt(Math.max(0, (q - (s * s) / counted) / (counted - 1))) : 0;
      }
    }
  }
  return { avg, sd };
}

/** Average of an explicit list (e.g. a single window), same semantics. */
export function averageOf(values: number[], spec?: AvgSpec, trimPct = 5): number {
  const n = values.length;
  if (n === 0) return NaN;
  const s = spec ?? { n };
  const [tl, tr] = trimCounts(n, s.mean, trimPct);
  const sorted = [...values].sort((a, b) => a - b);
  const dnf = sorted.filter((v) => !Number.isFinite(v)).length;
  if (dnf > tr) return Infinity;
  let sum = 0;
  for (let i = tl; i < n - tr; i++) sum += sorted[i];
  return sum / (n - tl - tr);
}

/** Indices (within the window) of trimmed solves, for parenthesising in reports. */
export function trimmedIndices(values: number[], spec: AvgSpec, trimPct = 5): Set<number> {
  const n = values.length;
  const [tl, tr] = trimCounts(n, spec.mean, trimPct);
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = new Set<number>();
  for (let i = 0; i < tl; i++) out.add(order[i][1]);
  for (let i = n - tr; i < n; i++) out.add(order[i][1]);
  return out;
}

export interface BestAvg {
  value: number;
  /** index of last solve in best window, -1 if none */
  end: number;
}

export function bestOf(arr: ArrayLike<number>): BestAvg {
  let best = Infinity,
    end = -1;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isNaN(v) && (v < best || (end < 0 && v === Infinity))) {
      best = v;
      end = i;
    }
  }
  return { value: end < 0 ? NaN : best, end };
}

export interface SummaryStats {
  count: number;
  solved: number;
  dnf: number;
  plus2: number;
  mean: number;
  median: number;
  sd: number;
  best: number;
  bestIdx: number;
  worst: number;
  worstIdx: number;
  /** Mean of all solves counting DNF as excluded (csTimer "mean"). */
  sum: number;
}

export function summarize(values: ArrayLike<number>, penalties?: ArrayLike<number>): SummaryStats {
  const fin: number[] = [];
  let best = Infinity,
    bestIdx = -1,
    worst = -Infinity,
    worstIdx = -1,
    sum = 0,
    plus2 = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (penalties && penalties[i] > 0) plus2++;
    if (!Number.isFinite(v)) continue;
    fin.push(v);
    sum += v;
    if (v < best) {
      best = v;
      bestIdx = i;
    }
    if (v > worst) {
      worst = v;
      worstIdx = i;
    }
  }
  fin.sort((a, b) => a - b);
  const k = fin.length;
  const mean = k ? sum / k : NaN;
  let sq = 0;
  for (const v of fin) sq += (v - mean) * (v - mean);
  const median = k ? (k % 2 ? fin[(k - 1) >> 1] : (fin[k / 2 - 1] + fin[k / 2]) / 2) : NaN;
  return {
    count: values.length,
    solved: k,
    dnf: values.length - k,
    plus2,
    mean,
    median,
    sd: k > 1 ? Math.sqrt(sq / (k - 1)) : NaN,
    best: k ? best : NaN,
    bestIdx,
    worst: k ? worst : NaN,
    worstIdx,
    sum,
  };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Ordinary least squares: returns slope/intercept of y over x. */
export function linreg(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
    syy += ys[i] * ys[i];
  }
  const d = n * sxx - sx * sx;
  if (d === 0) return { slope: NaN, intercept: NaN, r2: NaN };
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  const r = (n * sxy - sx * sy) / Math.sqrt(d * (n * syy - sy * sy));
  return { slope, intercept, r2: r * r };
}

/** Welch's t-test; returns t, df and a two-sided p-value approximation. */
export function welch(a: number[], b: number[]) {
  const m = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const v = (x: number[], mu: number) => x.reduce((s, y) => s + (y - mu) ** 2, 0) / (x.length - 1);
  const ma = m(a),
    mb = m(b);
  const va = v(a, ma),
    vb = v(b, mb);
  const se = Math.sqrt(va / a.length + vb / b.length);
  const t = (ma - mb) / se;
  const df = (va / a.length + vb / b.length) ** 2 / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1));
  const p = 2 * (1 - studentTCdf(Math.abs(t), df));
  // Cohen's d with pooled SD
  const sp = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2));
  return { t, df, p, d: (ma - mb) / sp, meanA: ma, meanB: mb };
}

// Student t CDF via regularized incomplete beta.
function studentTCdf(t: number, df: number) {
  const x = df / (df + t * t);
  return 1 - 0.5 * incBeta(x, df / 2, 0.5);
}
function lgamma(z: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z,
    y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function incBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}
function betacf(x: number, a: number, b: number) {
  const MAXIT = 200,
    EPS = 3e-12,
    FPMIN = 1e-300;
  let qab = a + b,
    qap = a + 1,
    qam = a - 1,
    c = 1,
    d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Default averages shown in the stats panel, matching the user's csTimer setup. */
export const DEFAULT_AVGS: AvgSpec[] = [
  { n: 3, mean: true },
  { n: 5 },
  { n: 12 },
  { n: 25 },
  { n: 50 },
  { n: 100 },
  { n: 200 },
  { n: 500 },
  { n: 1000 },
  { n: 2000 },
  { n: 5000 },
  { n: 10000 },
];
