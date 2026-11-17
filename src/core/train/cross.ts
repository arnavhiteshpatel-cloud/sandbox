/**
 * Optimal cross solver (face-turn metric).
 *
 * The four cross edges are tracked by where their cross-coloured sticker is: one of the 24
 * edge-sticker locations, which encodes both position and orientation. A full breadth-first
 * distance table over the 24·22·20·18 = 190 080 reachable states is built once (~50 ms),
 * after which an optimal solution is read off by always taking a distance-decreasing move.
 * Move tables are derived from the facelet simulator, so notation semantics are shared with
 * the rest of the app.
 */
import { Cube, FACES, type Face } from "../cube";

const FACE_IDX: Record<Face, number> = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
const loc = (f: Face, i: number) => FACE_IDX[f] * 9 + i;
const MOVES: string[] = FACES.flatMap((f) => [f, f + "2", f + "'"]);

/** Rotation (applied after the scramble) that brings colour `c`'s centre to D, for WCA orientation. */
export const CROSS_ROTATION = ["z2", "z", "x'", "", "z'", "x"];
export const COLOUR_NAMES = ["White", "Red", "Green", "Yellow", "Orange", "Blue"];

interface Tables {
  edgeLocs: number[]; // 24 facelet locations
  edgeIdx: Map<number, number>; // facelet location → 0..23
  partner: number[]; // edge-sticker index → the other sticker of the same cubie
  moveEdge: Int8Array[]; // [move][edge sticker] → new edge sticker
  dist: Uint8Array;
  solvedKey: number;
}

let tables: Tables | null = null;

function uniqueCube() {
  const c = new Cube();
  c.stickers.forEach((s, i) => (s.c = i));
  return c;
}

function flatFacelets(c: Cube): number[] {
  const fl = c.facelets();
  return FACES.flatMap((f) => fl[f]);
}

function build(): Tables {
  const solved = uniqueCube();
  const flat0 = flatFacelets(solved);
  const homeOf = new Map<number, number>(); // sticker id → facelet location
  flat0.forEach((id, l) => homeOf.set(id, l));
  // cubie membership from geometric position
  const cubieOf = new Map<number, string>();
  for (let i = 0; i < solved.stickers.length; i++) {
    const p = solved.stickers[i].p.map((v) => Math.max(-2, Math.min(2, v)));
    cubieOf.set(homeOf.get(i)!, p.join(","));
  }
  const edgeLocs: number[] = [];
  for (const f of FACES) for (const i of [1, 3, 5, 7]) edgeLocs.push(loc(f, i));
  const edgeIdx = new Map(edgeLocs.map((l, i) => [l, i]));
  const partner = edgeLocs.map((l) => edgeIdx.get(edgeLocs.find((m) => m !== l && cubieOf.get(m) === cubieOf.get(l))!)!);
  const moveEdge = MOVES.map((m) => {
    const flat = flatFacelets(uniqueCube().apply(m));
    const t = new Int8Array(24);
    flat.forEach((id, l) => {
      const from = homeOf.get(id)!;
      const ei = edgeIdx.get(from);
      if (ei != null) t[ei] = edgeIdx.get(l)!;
    });
    return t;
  });
  const solvedEdges = [loc("D", 1), loc("D", 5), loc("D", 7), loc("D", 3)].map((l) => edgeIdx.get(l)!);
  const key = (a: number, b: number, c: number, d: number) => ((a * 24 + b) * 24 + c) * 24 + d;
  const solvedKey = key(solvedEdges[0], solvedEdges[1], solvedEdges[2], solvedEdges[3]);
  const dist = new Uint8Array(24 ** 4).fill(255);
  dist[solvedKey] = 0;
  let frontier = [solvedKey];
  let depth = 0;
  while (frontier.length) {
    const next: number[] = [];
    for (const k of frontier) {
      const a = Math.floor(k / 13824),
        b = Math.floor(k / 576) % 24,
        c = Math.floor(k / 24) % 24,
        d = k % 24;
      for (const t of moveEdge) {
        const nk = key(t[a], t[b], t[c], t[d]);
        if (dist[nk] === 255) {
          dist[nk] = depth + 1;
          next.push(nk);
        }
      }
    }
    frontier = next;
    depth++;
  }
  return { edgeLocs, edgeIdx, partner, moveEdge, dist, solvedKey };
}

function T() {
  return (tables ??= build());
}

/** Encode the cross state (cross on D) of a coloured cube in its current orientation. */
function encode(cube: Cube): number[] {
  const t = T();
  const fl = cube.facelets();
  const flat = FACES.flatMap((f) => fl[f]);
  const cc = fl.D[4];
  const sides = [fl.F[4], fl.R[4], fl.B[4], fl.L[4]];
  return sides.map((sc) => {
    for (let e = 0; e < 24; e++) {
      const l = t.edgeLocs[e];
      if (flat[l] === cc && flat[t.edgeLocs[t.partner[e]]] === sc) return e;
    }
    throw new Error("cross edge not found");
  });
}

const keyOf = (s: number[]) => ((s[0] * 24 + s[1]) * 24 + s[2]) * 24 + s[3];

export interface CrossSolution {
  colour: number;
  rotation: string;
  length: number;
  /** optimal solutions in the rotated frame (cross on D), first is canonical */
  solutions: string[];
}

const axisOf = (m: number) => [0, 1, 2, 0, 1, 2][Math.floor(m / 3)];

/** All optimal solutions (up to `limit`) for the cross of colour `colour` after `scramble`. */
export function solveCross(scramble: string, colour: number, limit = 4): CrossSolution {
  const t = T();
  const rotation = CROSS_ROTATION[colour];
  const cube = new Cube().apply(`${scramble} ${rotation}`);
  const start = encode(cube);
  const len = t.dist[keyOf(start)];
  const sols: string[] = [];
  const path: number[] = [];
  const dfs = (s: number[], depthLeft: number) => {
    if (sols.length >= limit) return;
    if (depthLeft === 0) {
      sols.push(path.map((m) => MOVES[m]).join(" "));
      return;
    }
    for (let m = 0; m < 18; m++) {
      const prev = path[path.length - 1];
      if (prev != null) {
        const pf = Math.floor(prev / 3),
          f = Math.floor(m / 3);
        if (pf === f) continue;
        // commuting opposite faces: only allow one order
        if (axisOf(prev) === axisOf(m) && f < pf) continue;
      }
      const tb = t.moveEdge[m];
      const ns = [tb[s[0]], tb[s[1]], tb[s[2]], tb[s[3]]];
      if (t.dist[keyOf(ns)] !== depthLeft - 1) continue;
      path.push(m);
      dfs(ns, depthLeft - 1);
      path.pop();
    }
  };
  dfs(start, len);
  return { colour, rotation, length: len, solutions: sols };
}

export function solveAllColours(scramble: string, limit = 3): CrossSolution[] {
  return [0, 1, 2, 3, 4, 5].map((c) => solveCross(scramble, c, limit));
}

/** True when the cross of the colour now on D is solved (for tests / verification). */
export function crossSolvedOnD(cube: Cube): boolean {
  const t = T();
  return keyOf(encode(cube)) === t.solvedKey;
}

/** Number of states at each distance (sanity: max depth 8). */
export function crossDistanceHistogram(): number[] {
  const h: number[] = [];
  for (const d of T().dist) if (d !== 255) h[d] = (h[d] ?? 0) + 1;
  return h;
}
