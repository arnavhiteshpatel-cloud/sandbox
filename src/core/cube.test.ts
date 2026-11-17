import { describe, expect, it } from "vitest";
import { Cube, expandRepeats, invertAlg, parseMoves, type Face } from "./cube";
import { OLL, PLL } from "./algs";
import { llState } from "./llstate";

const SIDES: Face[] = ["F", "R", "B", "L"];

function f2lIntact(c: Cube) {
  const fl = c.facelets();
  if (!fl.D.every((x) => x === fl.D[4])) return false;
  for (const f of SIDES) for (let i = 3; i < 9; i++) if (fl[f][i] !== fl[f][4]) return false;
  return true;
}

describe("cube simulator", () => {
  it("basic identities", () => {
    expect(new Cube().apply("R U R' U'".repeat(1).concat(" R U R' U'").repeat(1)).isSolved()).toBe(false);
    const c = new Cube();
    for (let i = 0; i < 6; i++) c.apply("R U R' U'");
    expect(c.isSolved()).toBe(true);
    expect(new Cube().apply("R2 R2").isSolved()).toBe(true);
    expect(new Cube().apply("M2 E2 S2 M2 E2 S2").isSolved()).toBe(true);
    expect(new Cube().apply("x y z z' y' x'").isSolved()).toBe(true);
    expect(new Cube().apply("r R'").normalize().key()).toBe(new Cube().apply("M'").normalize().key());
    const t = "R U R' U' R' F R2 U' R' U' R U R' F'";
    expect(new Cube().apply(t + " " + t).isSolved()).toBe(true);
    expect(new Cube().apply(t + " " + invertAlg(t)).isSolved()).toBe(true);
    expect(expandRepeats("(R U R' U')3")).toBe("R U R' U' R U R' U' R U R' U'");
  });

  it("R moves F stickers to U (orientation sanity)", () => {
    const fl = new Cube().apply("R").facelets();
    expect(fl.U[2]).toBe(2); // F colour now on U right column
    expect(fl.F[2]).toBe(3); // D colour on F
    const fu = new Cube().apply("U").facelets();
    expect(fu.F[0]).toBe(1); // R colour moved to F top row
  });

  it("big cube wide and slice moves", () => {
    expect(new Cube(4).apply("Rw Rw'").isSolved()).toBe(true);
    expect(new Cube(5).apply("3Rw2 3Rw2").isSolved()).toBe(true);
    expect(new Cube(4).apply("Rw R'").key()).toBe(new Cube(4).apply("2R").key());
    expect(() => parseMoves("Q")).toThrow();
  });

  it("matches cubing.js notation semantics (scramble + cubing.js solution = solved)", async () => {
    const { randomScrambleForEvent } = await import("cubing/scramble");
    const { experimentalSolve3x3x3IgnoringCenters } = await import("cubing/search");
    const { cube3x3x3 } = await import("cubing/puzzles");
    const kp = await cube3x3x3.kpuzzle();
    for (let i = 0; i < 3; i++) {
      const scr = (await randomScrambleForEvent("333")).toString();
      const sol = (await experimentalSolve3x3x3IgnoringCenters(kp.defaultPattern().applyAlg(scr))).toString();
      expect(new Cube().apply(scr + " " + sol).isSolved()).toBe(true);
    }
  }, 60000);
});

describe("algorithm libraries are verified", () => {
  it("every PLL preserves F2L + orientation and the 21 cases are distinct", () => {
    expect(PLL.length).toBe(21);
    const seen = new Map<string, string>();
    for (const c of PLL) {
      for (const a of c.algs) {
        const cube = new Cube().apply(invertAlg(a)).normalize();
        expect(f2lIntact(cube), c.id).toBe(true);
        const fl = cube.facelets();
        expect(fl.U.every((x) => x === 0), c.id + " oriented").toBe(true);
        expect(cube.isSolved(), c.id).toBe(false);
      }
      const st = llState(c.algs[0]);
      for (const k of st.classKeys) {
        expect(seen.has(k), `${c.id} collides with ${seen.get(k)}`).toBe(false);
      }
      for (const k of st.classKeys) seen.set(k, c.id);
    }
  });

  it("every OLL preserves F2L, orients the LL, and 57 cases are distinct", () => {
    expect(OLL.length).toBe(57);
    const seen = new Map<string, string>();
    for (const c of OLL) {
      for (const a of c.algs) {
        const cube = new Cube().apply(invertAlg(a)).normalize();
        expect(f2lIntact(cube), c.id + " F2L").toBe(true);
        // applying the alg to the case orients the last layer
        const solved = cube.clone().apply(a).normalize().facelets();
        expect(solved.U.every((x) => x === 0), c.id + " orients").toBe(true);
      }
      const st = llState(c.algs[0]);
      expect(st.oriented, c.id).toBe(false);
      expect(seen.has(st.orientKey), `${c.id} same shape as ${seen.get(st.orientKey)}`).toBe(false);
      seen.set(st.orientKey, c.id);
    }
  });
});
