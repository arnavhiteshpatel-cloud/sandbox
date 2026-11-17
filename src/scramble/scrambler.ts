/**
 * Scramble generation.
 *  - WCA events: cubing.js random-state scramblers (MPL-2.0), the same family used by
 *    the WCA's TNoodle-compatible tooling.
 *  - Training scramblers (PLL, OLL, LL, F2L, ...): a random *state* restricted to the
 *    relevant pieces is constructed, solved with cubing.js's 3x3 solver, and the solution
 *    inverted. This yields uniformly random cases with natural probabilities.
 */
import { getEvent } from "../core/events";
import { invertAlg } from "../core/cube";

type KPuzzle = any;

let kp3: Promise<KPuzzle> | null = null;
async function kpuzzle3() {
  if (!kp3) kp3 = import("cubing/puzzles").then((m) => m.cube3x3x3.kpuzzle());
  return kp3;
}

function randInt(n: number) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parity(perm: number[]) {
  let p = 0;
  const seen = new Array(perm.length).fill(false);
  for (let i = 0; i < perm.length; i++) {
    if (seen[i]) continue;
    let len = 0;
    for (let j = i; !seen[j]; j = perm[j]) {
      seen[j] = true;
      len++;
    }
    p ^= (len - 1) & 1;
  }
  return p;
}

interface Spec {
  /** edge positions whose pieces are permuted among themselves (randomly) */
  ep: number[];
  /** edge positions whose orientation is randomised */
  eo: number[];
  cp: number[];
  co: number[];
}

const U_E = [0, 1, 2, 3];
const U_C = [0, 1, 2, 3];
const ALL_E = [...Array(12).keys()];
const ALL_C = [...Array(8).keys()];
const NON_D_E = [0, 1, 2, 3, 8, 9, 10, 11];

const SPECS: Record<string, Spec> = {
  pll: { ep: U_E, eo: [], cp: U_C, co: [] },
  oll: { ep: U_E, eo: U_E, cp: U_C, co: U_C },
  ll: { ep: U_E, eo: U_E, cp: U_C, co: U_C },
  zbll: { ep: U_E, eo: [], cp: U_C, co: U_C },
  coll: { ep: U_E, eo: [], cp: U_C, co: U_C },
  ell: { ep: U_E, eo: U_E, cp: [], co: [] },
  cll: { ep: [], eo: [], cp: U_C, co: U_C },
  lsll: { ep: [...U_E, 8], eo: [...U_E, 8], cp: [...U_C, 4], co: [...U_C, 4] },
  f2l: { ep: NON_D_E, eo: NON_D_E, cp: ALL_C, co: ALL_C },
  edges: { ep: ALL_E, eo: ALL_E, cp: [], co: [] },
  corners: { ep: [], eo: [], cp: ALL_C, co: ALL_C },
  lse: { ep: [0, 1, 2, 3, 4, 6], eo: [0, 1, 2, 3, 4, 6], cp: [], co: [] },
};

function randomState(spec: Spec) {
  const ep = [...Array(12).keys()];
  const cp = [...Array(8).keys()];
  const eo = new Array(12).fill(0);
  const co = new Array(8).fill(0);
  for (;;) {
    const e = shuffle([...spec.ep]);
    const c = shuffle([...spec.cp]);
    spec.ep.forEach((pos, i) => (ep[pos] = e[i]));
    spec.cp.forEach((pos, i) => (cp[pos] = c[i]));
    if (parity(ep) === parity(cp)) break;
    // if one set cannot change parity, try again (pure-corner/edge subsets always succeed eventually)
    if (spec.ep.length < 2 && spec.cp.length >= 2) continue;
    if (spec.cp.length < 2 && spec.ep.length >= 2) continue;
  }
  let s = 0;
  for (const p of spec.eo) s += eo[p] = randInt(2);
  if (spec.eo.length && s % 2) eo[spec.eo[0]] ^= 1;
  s = 0;
  for (const p of spec.co) s += co[p] = randInt(3);
  if (spec.co.length && s % 3) co[spec.co[0]] = (co[spec.co[0]] + (3 - (s % 3))) % 3;
  return { ep, eo, cp, co };
}

function isSolvedState(st: ReturnType<typeof randomState>) {
  return st.ep.every((x, i) => x === i) && st.cp.every((x, i) => x === i) && st.eo.every((x) => !x) && st.co.every((x) => !x);
}

async function solveToScramble(alg: string | null, st?: ReturnType<typeof randomState>): Promise<string> {
  const kp = await kpuzzle3();
  const { KPattern } = await import("cubing/kpuzzle");
  const { experimentalSolve3x3x3IgnoringCenters } = await import("cubing/search");
  let pattern: any;
  if (st) {
    pattern = new KPattern(kp, {
      EDGES: { pieces: st.ep, orientation: st.eo },
      CORNERS: { pieces: st.cp, orientation: st.co },
      CENTERS: { pieces: [0, 1, 2, 3, 4, 5], orientation: [0, 0, 0, 0, 0, 0], orientationMod: [1, 1, 1, 1, 1, 1] },
    } as any);
  } else {
    pattern = kp.defaultPattern().applyAlg(alg!);
  }
  const sol = await experimentalSolve3x3x3IgnoringCenters(pattern);
  return tidy(sol.invert().toString());
}

const AUFS = ["", "U", "U2", "U'"];

/** Scramble that sets up a specific algorithm's case (inverse alg, random AUFs, re-solved). */
export async function scrambleForCase(alg: string): Promise<string> {
  const setup = `${AUFS[randInt(4)]} ${invertAlg(alg)} ${AUFS[randInt(4)]}`;
  return solveToScramble(setup);
}

function randomMoves(faces: string[], len: number, size = 3) {
  const out: string[] = [];
  const axisOf = (f: string) => "RL UD FB".split(" ").findIndex((a) => a.includes(f[f.length - 1].toUpperCase()));
  let last = "",
    prevAxisCount = 0;
  while (out.length < len) {
    const f = faces[randInt(faces.length)];
    if (f === last) continue;
    if (last && axisOf(f) === axisOf(last)) {
      if (prevAxisCount >= 1) continue;
      prevAxisCount++;
    } else prevAxisCount = 0;
    last = f;
    out.push(f + ["", "'", "2"][randInt(3)]);
  }
  void size;
  return out.join(" ");
}

/** cubing.js writes half turns as "R2'"; speedcubers write "R2". */
export function tidy(s: string) {
  return s.replace(/(\b[A-Za-z]+w?2)'/g, "$1");
}

async function cubingScramble(eventId: string): Promise<string> {
  const { randomScrambleForEvent } = await import("cubing/scramble");
  const alg = await randomScrambleForEvent(eventId);
  return tidy(alg.toString());
}

/** Generate one scramble for a csTimer-style event id. */
export async function generateScramble(eventId: string): Promise<string> {
  const ev = getEvent(eventId);
  if (ev.cubing) return cubingScramble(ev.cubing);
  if (ev.gen && SPECS[ev.gen]) {
    let st;
    do st = randomState(SPECS[ev.gen]);
    while (isSolvedState(st));
    return solveToScramble(null, st);
  }
  if (ev.gen === "rm") {
    const n = ev.size ?? 3;
    const faces = n > 3 ? ["R", "L", "U", "D", "F", "B", "Rw", "Uw", "Fw"] : ["R", "L", "U", "D", "F", "B"];
    return randomMoves(faces, ev.len ?? 25, n);
  }
  if (ev.gen === "2gen") return randomMoves(["R", "U"], ev.len ?? 25);
  if (ev.gen === "222cll") {
    const { experimentalSolve2x2x2 } = await import("cubing/search");
    const { cube2x2x2 } = await import("cubing/puzzles");
    const kp = await cube2x2x2.kpuzzle();
    // random U-layer corners, bottom solved
    let st;
    do st = randomState({ ep: [], eo: [], cp: U_C, co: U_C });
    while (isSolvedState(st));
    const def = kp.defaultPattern();
    const { KPattern } = await import("cubing/kpuzzle");
    const data = JSON.parse(JSON.stringify(def.patternData));
    data.CORNERS.pieces = st.cp;
    data.CORNERS.orientation = st.co;
    try {
      const sol = await experimentalSolve2x2x2(new KPattern(kp, data));
      return tidy(sol.invert().toString());
    } catch {
      return cubingScramble("222");
    }
  }
  // Unknown csTimer scramble types: fall back by puzzle family, preserving the session's type.
  if (/^222/.test(eventId)) return cubingScramble("222");
  if (/^444/.test(eventId)) return cubingScramble("444");
  if (/^555/.test(eventId)) return cubingScramble("555");
  if (/^(sq|sqr)/.test(eventId)) return cubingScramble("sq1");
  if (/^pyr/.test(eventId)) return cubingScramble("pyram");
  if (/^skb/.test(eventId)) return cubingScramble("skewb");
  if (/^mgm|^minx/.test(eventId)) return cubingScramble("minx");
  if (/^clk/.test(eventId)) return cubingScramble("clock");
  if (eventId === "input") return "";
  return cubingScramble("333");
}

/** Small prefetching queue so the next scramble is ready the instant a solve ends. */
class ScrambleQueue {
  private q = new Map<string, Promise<string>[]>();
  next(eventId: string): Promise<string> {
    const list = this.q.get(eventId) ?? [];
    const p = list.shift() ?? generateScramble(eventId);
    this.q.set(eventId, list);
    this.prefetch(eventId);
    return p;
  }
  prefetch(eventId: string, depth = 2) {
    const list = this.q.get(eventId) ?? [];
    while (list.length < depth) {
      const p = generateScramble(eventId);
      p.catch(() => {
        const l = this.q.get(eventId);
        if (l) this.q.set(eventId, l.filter((x) => x !== p));
      });
      list.push(p);
    }
    this.q.set(eventId, list);
  }
}

export const scrambleQueue = new ScrambleQueue();
