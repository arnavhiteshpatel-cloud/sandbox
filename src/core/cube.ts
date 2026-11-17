/**
 * Facelet-level NxN cube simulator used for scramble images, algorithm diagrams and
 * self-verification of algorithm libraries.
 *
 * Axes: x → R, y → U, z → F. Each sticker has an integer position on the surface
 * (one coordinate = ±N) and an outward normal. Turning a layer rotates the stickers
 * whose cubie coordinate lies in the selected slab.
 */

export type Face = "U" | "R" | "F" | "D" | "L" | "B";
export const FACES: Face[] = ["U", "R", "F", "D", "L", "B"];

interface Sticker {
  p: [number, number, number];
  n: [number, number, number];
  c: number; // colour index (face index of origin)
}

const FACE_NORMAL: Record<Face, [number, number, number]> = {
  U: [0, 1, 0],
  D: [0, -1, 0],
  R: [1, 0, 0],
  L: [-1, 0, 0],
  F: [0, 0, 1],
  B: [0, 0, -1],
};

export interface Move {
  /** axis 0=x 1=y 2=z */
  axis: number;
  /** quarter turns about +axis (positive = counter-clockwise looking from +axis) */
  q: number;
  /** inclusive cubie coordinate range in "layer index" units 0..N-1 counted from the negative side */
  from: number;
  to: number;
}

function rot(v: [number, number, number], axis: number, q: number): [number, number, number] {
  let [x, y, z] = v;
  q = ((q % 4) + 4) % 4;
  for (let i = 0; i < q; i++) {
    // +90° about axis
    if (axis === 0) [y, z] = [-z, y];
    else if (axis === 1) [z, x] = [-x, z];
    else [x, y] = [-y, x];
  }
  return [x, y, z];
}

export class Cube {
  n: number;
  stickers: Sticker[] = [];
  constructor(n = 3) {
    this.n = n;
    const N = n;
    FACES.forEach((f, fi) => {
      const nrm = FACE_NORMAL[f];
      for (let a = 0; a < N; a++)
        for (let b = 0; b < N; b++) {
          const u = -(N - 1) + 2 * a;
          const v = -(N - 1) + 2 * b;
          const p: [number, number, number] = [0, 0, 0];
          const ax = nrm.findIndex((c) => c !== 0);
          p[ax] = nrm[ax] * N;
          const others = [0, 1, 2].filter((i) => i !== ax);
          p[others[0]] = u;
          p[others[1]] = v;
          this.stickers.push({ p, n: [...nrm] as [number, number, number], c: fi });
        }
    });
  }

  clone(): Cube {
    const c = new Cube(0);
    c.n = this.n;
    c.stickers = this.stickers.map((s) => ({ p: [...s.p] as any, n: [...s.n] as any, c: s.c }));
    return c;
  }

  applyMove(m: Move) {
    const N = this.n;
    for (const s of this.stickers) {
      const cc = Math.max(-(N - 1), Math.min(N - 1, s.p[m.axis]));
      const layer = (cc + (N - 1)) / 2;
      if (layer >= m.from && layer <= m.to) {
        s.p = rot(s.p, m.axis, m.q);
        s.n = rot(s.n, m.axis, m.q);
      }
    }
  }

  apply(alg: string | Move[]): this {
    const moves = typeof alg === "string" ? parseMoves(alg, this.n) : alg;
    for (const m of moves) this.applyMove(m);
    return this;
  }

  /** Returns face → row-major colour indices as drawn in the standard net. */
  facelets(): Record<Face, number[]> {
    const N = this.n;
    const out = {} as Record<Face, number[]>;
    for (const f of FACES) out[f] = new Array(N * N).fill(-1);
    const idx = (v: number) => (v + (N - 1)) / 2; // 0..N-1 from negative side
    for (const s of this.stickers) {
      const [x, y, z] = s.p;
      const [nx, ny, nz] = s.n;
      let f: Face, r: number, c: number;
      if (ny === 1) {
        f = "U";
        r = idx(z);
        c = idx(x);
      } else if (ny === -1) {
        f = "D";
        r = N - 1 - idx(z);
        c = idx(x);
      } else if (nz === 1) {
        f = "F";
        r = N - 1 - idx(y);
        c = idx(x);
      } else if (nz === -1) {
        f = "B";
        r = N - 1 - idx(y);
        c = N - 1 - idx(x);
      } else if (nx === 1) {
        f = "R";
        r = N - 1 - idx(y);
        c = N - 1 - idx(z);
      } else {
        f = "L";
        r = N - 1 - idx(y);
        c = idx(z);
      }
      out[f][r * N + c] = s.c;
    }
    return out;
  }

  /** Rotate the whole cube so centres are in their home positions (odd cubes only). */
  normalize(): this {
    if (this.n % 2 === 0) return this;
    for (const a of ROT_A)
      for (const b of ROT_B) {
        const c = this.clone().apply(a + " " + b);
        const fl = c.facelets();
        const mid = (this.n * this.n - 1) / 2;
        if (FACES.every((f, i) => fl[f][mid] === i)) {
          this.stickers = c.stickers;
          return this;
        }
      }
    return this;
  }

  isSolved(): boolean {
    const fl = this.facelets();
    return FACES.every((f) => fl[f].every((c) => c === fl[f][0]));
  }

  /** Signature string of all facelets (for equality checks). */
  key(): string {
    const fl = this.facelets();
    return FACES.map((f) => fl[f].join("")).join("|");
  }
}

const ROT_A = ["", "x", "x2", "x'", "z", "z'"];
const ROT_B = ["", "y", "y2", "y'"];

const AXIS: Record<string, [number, number]> = {
  // face → [axis, sign of face normal]
  R: [0, 1],
  L: [0, -1],
  U: [1, 1],
  D: [1, -1],
  F: [2, 1],
  B: [2, -1],
};

const MOVE_RE = /^(\d+)?(-)?(\d+)?([RLUDFBrludfbMESxyz])(w)?(\d+)?('|’)?(\d+)?$/;

/**
 * Parse WCA / SiGN notation for an NxN cube.
 * Supports R U' F2, Rw, 3Rw, r (wide), 2R (inner slice), M E S, x y z, and comments in // or (...)
 */
export function parseMoves(alg: string, n = 3): Move[] {
  const out: Move[] = [];
  const cleaned = alg
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*.*?\*\//g, " ")
    .replace(/[()[\],]/g, " ")
    .replace(/’/g, "'");
  for (const tokRaw of cleaned.split(/\s+/)) {
    const tok = tokRaw.trim();
    if (!tok || tok === "." ) continue;
    // repeated groups like (R U)2 are flattened by the caller; we ignore bare numbers
    if (/^\d+$/.test(tok)) continue;
    const m = MOVE_RE.exec(tok);
    if (!m) throw new Error(`Unrecognised move "${tok}"`);
    const pre = m[1] ? +m[1] : undefined;
    let letter = m[4];
    const wide = !!m[5];
    let amt = m[6] ? +m[6] : m[8] ? +m[8] : 1;
    if (m[7]) amt = -amt;
    // normalise amounts: R2' == R2
    const N = n;
    if ("xyz".includes(letter)) {
      const axis = "xyz".indexOf(letter);
      // x follows R, y follows U, z follows F (clockwise = -90°)
      out.push({ axis, q: -amt, from: 0, to: N - 1 });
      continue;
    }
    if ("MES".includes(letter)) {
      // M follows L, E follows D, S follows F; inner layers only
      const axis = "MES".indexOf(letter) === 0 ? 0 : "MES".indexOf(letter) === 1 ? 1 : 2;
      const sign = letter === "S" ? 1 : -1;
      out.push({ axis, q: -amt * sign, from: 1, to: N - 2 });
      continue;
    }
    let depth = 1;
    let sliceOnly = false;
    if (letter === letter.toLowerCase()) {
      letter = letter.toUpperCase();
      depth = pre ?? 2;
      if (N === 3 || !pre) depth = pre ?? 2;
    } else if (wide) {
      depth = pre ?? 2;
    } else if (pre) {
      // "2R" = second layer only
      depth = pre;
      sliceOnly = true;
    }
    const [axis, sign] = AXIS[letter];
    const q = -amt * sign;
    const inner = sliceOnly ? depth : 1;
    // convert "layers from the face" to layer indices counted from negative side
    let from: number, to: number;
    if (sign > 0) {
      from = N - depth;
      to = N - inner;
    } else {
      from = inner - 1;
      to = depth - 1;
    }
    out.push({ axis, q, from, to });
  }
  return out;
}

/** Expand simple repetition groups like "(R U R' U')3" into flat strings. */
export function expandRepeats(alg: string): string {
  let prev = "";
  let s = alg;
  while (prev !== s) {
    prev = s;
    s = s.replace(/\(([^()]*)\)(\d+)('?)/g, (_, body: string, k: string, inv: string) => {
      const b = inv ? invertAlg(body) : body;
      return Array(+k).fill(b).join(" ");
    });
  }
  return s;
}

export function invertAlg(alg: string): string {
  return expandRepeats(alg)
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .reverse()
    .map((t) => {
      if (/2'?$/.test(t)) return t.replace(/'$/, "");
      return t.endsWith("'") ? t.slice(0, -1) : t + "'";
    })
    .join(" ");
}

/** Standard colour scheme (white top, green front). Index = face order U R F D L B. */
export const DEFAULT_COLORS = ["#ffffff", "#ff2a2a", "#22c55e", "#ffe600", "#ff9500", "#1f6bff"];
