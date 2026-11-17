/**
 * Case registry and algorithm verification for the training module.
 * Everything here is derived from the verified OLL/PLL libraries via the facelet simulator.
 */
import { OLL, PLL, type AlgCase } from "../algs";
import { Cube, FACES, expandRepeats, invertAlg, parseMoves, type Face } from "../cube";
import { llView, type LLView } from "../llstate";

export const ALL_CASES: AlgCase[] = [...OLL, ...PLL];
const BY_ID = new Map(ALL_CASES.map((c) => [c.id, c]));
export const getCase = (id: string) => BY_ID.get(id);
export const casesOfSet = (set: string) => ALL_CASES.filter((c) => c.set === set);

export const AUFS = ["", "U", "U2", "U'"];

/** Short display label: "Ua", "T", "21". */
export const shortName = (c: AlgCase) => (c.set === "PLL" ? c.id.slice(4) : c.id.slice(3));

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

function normalizedState(alg: string) {
  return new Cube().apply(expandRepeats(alg)).normalize();
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
