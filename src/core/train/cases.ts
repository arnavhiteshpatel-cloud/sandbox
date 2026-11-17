/**
 * Case registry and algorithm verification for the training module.
 * Everything here is derived from the verified OLL/PLL libraries via the facelet simulator.
 */
import { OLL, PLL, type AlgCase } from "../algs";
export type { AlgCase };
import { Cube, FACES, expandRepeats, invertAlg, parseMoves, type Face } from "../cube";
import { llView, type LLView } from "../llstate";

export const ALL_CASES: AlgCase[] = [...OLL, ...PLL];
const BY_ID = new Map(ALL_CASES.map((c) => [c.id, c]));
export const getCase = (id: string) => BY_ID.get(id);
export const casesOfSet = (set: string) => ALL_CASES.filter((c) => c.set === set);

export const AUFS = ["", "U", "U2", "U'"];

/** Short display label: "Ua", "T", "21". */
export const shortName = (c: AlgCase) => (c.set === "PLL" ? c.id.slice(4) : c.id.slice(3));
/** Readable label in lists: "Ua", "OLL 33". */
export const caseLabel = (c: AlgCase) => (c.set === "PLL" ? shortName(c) : "OLL " + shortName(c));

/** Group order for display (as in the library definition). */
export function groupsOf(cases: AlgCase[]): { group: string; cases: AlgCase[] }[] {
  const out: { group: string; cases: AlgCase[] }[] = [];
  for (const c of cases) {
    let g = out.find((x) => x.group === c.group);
    if (!g) out.push((g = { group: c.group, cases: [] }));
    g.cases.push(c);
  }
  return out;
}

/** Last-layer view of a case: inverse alg applied to solved, optionally viewed after pre/post AUF. */
export function caseView(alg: string, pre = "", post = ""): LLView {
  return llView(`${pre} ${invertAlg(expandRepeats(alg))} ${post}`);
}

function f2lIntact(fl: Record<Face, number[]>) {
  if (!fl.D.every((x) => x === 3)) return false;
  const home: Record<string, number> = { F: 2, R: 1, B: 5, L: 4 };
  for (const f of ["F", "R", "B", "L"]) for (let i = 3; i < 9; i++) if (fl[f as Face][i] !== home[f]) return false;
  return true;
}

export interface AlgCheck {
  ok: boolean;
  /** cleaned-up alg (whitespace normalised) */
  alg: string;
  error?: string;
}

/**
 * Validate a user algorithm for a case: it must solve the case (PLL: fully, OLL: orient the
 * last layer while keeping F2L) up to an adjustment of the U face before and after.
 */
export function validateAlg(caseId: string, input: string): AlgCheck {
  const c = getCase(caseId);
  const alg = input.replace(/[’`´]/g, "'").replace(/\s+/g, " ").trim();
  if (!c) return { ok: false, alg, error: "Unknown case." };
  if (!alg) return { ok: false, alg, error: "Enter an algorithm." };
  let flat: string;
  try {
    flat = expandRepeats(alg);
    if (!parseMoves(flat).length) return { ok: false, alg, error: "The algorithm has no moves." };
  } catch (e) {
    return { ok: false, alg, error: (e as Error).message + ". Use standard notation (R U R' U', r, M, x y z, (…)2)." };
  }
  const setup = invertAlg(c.algs[0]);
  for (const pre of AUFS) {
    const fl = new Cube().apply(`${setup} ${pre} ${flat}`).normalize().facelets();
    if (!f2lIntact(fl)) continue;
    if (c.set === "OLL") {
      if (fl.U.every((x) => x === 0)) return { ok: true, alg };
    } else {
      // any post-AUF that solves the cube
      for (const post of AUFS) {
        if (new Cube().apply(`${setup} ${pre} ${flat} ${post}`).normalize().isSolved()) return { ok: true, alg };
      }
    }
  }
  // Diagnose: does it at least keep F2L?
  let keeps = false;
  for (const pre of AUFS) if (f2lIntact(new Cube().apply(`${setup} ${pre} ${flat}`).normalize().facelets())) keeps = true;
  if (!keeps) return { ok: false, alg, error: `This algorithm breaks the first two layers when applied to ${c.name} (from any U angle).` };
  return {
    ok: false,
    alg,
    error: c.set === "OLL" ? `This algorithm keeps F2L but does not orient the last layer of ${c.name}. It probably solves a different OLL.` : `This algorithm keeps F2L but does not solve ${c.name}. It probably solves a different case.`,
  };
}

/** Number of moves (HTM-ish, counting each token) for display. */
export function moveCount(alg: string) {
  try {
    return parseMoves(expandRepeats(alg)).length;
  } catch {
    return 0;
  }
}

export interface Arrow {
  from: number; // U-face index 0..8
  to: number;
  both: boolean; // 2-cycle (draw double-headed once)
}

/**
 * PLL permutation arrows for a case drawn at the given pre-AUF: each U-layer piece points
 * to the position the algorithm takes it to.
 */
export function pllArrows(alg: string, pre = ""): Arrow[] {
  // encode sticker identity on top of colour so normalize() (which checks centre colours) still works
  const cube = new Cube();
  cube.stickers.forEach((s, i) => (s.c = s.c + 6 * (i + 1)));
  const home = new Map<number, [Face, number]>();
  const fl0 = cube.facelets();
  for (const f of FACES) fl0[f].forEach((v, i) => home.set(v, [f, i]));
  // restore plain centre colours
  const centreIds = new Set(FACES.map((f) => fl0[f][4]));
  for (const s of cube.stickers) if (centreIds.has(s.c)) s.c = s.c % 6;
  cube.apply(`${pre} ${invertAlg(expandRepeats(alg))}`).normalize();
  const fl = cube.facelets();
  const arrows: Arrow[] = [];
  const seen = new Set<string>();
  const map = new Map<number, number>();
  for (let i = 0; i < 9; i++) {
    if (i === 4) continue;
    const h = home.get(fl.U[i]);
    if (!h || h[0] !== "U") continue;
    if (h[1] !== i) map.set(i, h[1]);
  }
  for (const [from, to] of map) {
    const key = [from, to].sort().join("-");
    if (seen.has(key)) continue;
    const both = map.get(to) === from;
    seen.add(key);
    arrows.push({ from, to, both });
  }
  return arrows;
}

/** Map a face-turn sequence through a whole-cube relabelling (e.g. z2: U↔D, R↔L). */
export function relabel(alg: string, map: Partial<Record<string, string>>): string {
  return alg
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (map[t[0]] ? map[t[0]] + t.slice(1) : t))
    .join(" ");
}

export const Z2: Record<string, string> = { U: "D", D: "U", R: "L", L: "R", F: "F", B: "B" };

const canonCache = new Map<string, string>();
/**
 * Pre-AUF used for a case's reference diagram. For PLL the angle with the fewest moved
 * stickers is chosen (so e.g. a J perm shows two swaps, not a swap plus a U turn).
 */
export function canonicalPre(c: AlgCase): string {
  if (c.set !== "PLL") return "";
  let v = canonCache.get(c.id);
  if (v == null) {
    let best = Infinity;
    v = "";
    for (const pre of AUFS) {
      const moved = pllArrows(c.algs[0], pre).reduce((n, a) => n + (a.both ? 2 : 1), 0);
      if (moved < best) {
        best = moved;
        v = pre;
      }
    }
    canonCache.set(c.id, v);
  }
  return v;
}

/** Moves that set up the reference diagram's state from solved (yellow-top frame not included). */
export function canonicalSetup(c: AlgCase): string {
  return `${canonicalPre(c)} ${invertAlg(expandRepeats(c.algs[0]))}`.trim();
}

/**
 * Playback for any (valid) alg of a case, starting exactly from the reference diagram's state:
 * returns the alg wrapped in the AUFs needed before/after it.
 */
export function playbackFor(c: AlgCase, alg: string): { setup: string; alg: string } {
  const setup = canonicalSetup(c);
  let flat: string;
  try {
    flat = expandRepeats(alg);
    parseMoves(flat);
  } catch {
    return { setup, alg };
  }
  for (const x of AUFS)
    for (const y of c.set === "OLL" ? [""] : AUFS) {
      const cube = new Cube().apply(`${setup} ${x} ${flat} ${y}`).normalize();
      const ok = c.set === "OLL" ? f2lIntact(cube.facelets()) && cube.facelets().U.every((s) => s === 0) : cube.isSolved();
      if (ok) return { setup, alg: `${x} ${alg} ${y}`.replace(/\s+/g, " ").trim() };
    }
  return { setup, alg };
}
