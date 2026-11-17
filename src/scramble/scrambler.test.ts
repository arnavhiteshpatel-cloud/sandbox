import { describe, expect, it } from "vitest";
import { generateScramble, scrambleForCase } from "./scrambler";
import { Cube } from "../core/cube";
import { PLL } from "../core/algs";
import { llState } from "../core/llstate";

const f2l = (c: Cube) => {
  const fl = c.facelets();
  return fl.D.every((x) => x === 3) && (["F", "R", "B", "L"] as const).every((f) => fl[f].slice(3).every((x) => x === fl[f][4]));
};

describe("training scramblers produce the requested states", () => {
  it("PLL: F2L solved, LL oriented", async () => {
    for (let i = 0; i < 5; i++) {
      const c = new Cube().apply(await generateScramble("pll"));
      expect(f2l(c)).toBe(true);
      expect(c.facelets().U.every((x) => x === 0)).toBe(true);
    }
  }, 60000);
  it("OLL / LL: F2L solved", async () => {
    for (const ev of ["oll", "ll", "zbll", "ell", "cll"]) {
      const c = new Cube().apply(await generateScramble(ev));
      expect(f2l(c), ev).toBe(true);
    }
  }, 60000);
  it("cross solved", async () => {
    const fl = new Cube().apply(await generateScramble("f2l")).facelets();
    expect([1, 3, 5, 7].every((i) => fl.D[i] === 3)).toBe(true);
  }, 60000);
  it("case scramble reproduces the case", async () => {
    const t = PLL.find((p) => p.id === "PLL-T")!;
    const s = await scrambleForCase(t.algs[0]);
    const c = new Cube().apply(s);
    expect(f2l(c)).toBe(true);
    // solving with the T alg after some AUF must solve the cube
    const keys = new Set(llState(t.algs[0]).classKeys);
    const fl = c.facelets();
    const view = [fl.U, fl.F.slice(0, 3), fl.R.slice(0, 3), fl.B.slice(0, 3), fl.L.slice(0, 3)].map((a) => a.join("")).join("|");
    expect(keys.has(view)).toBe(true);
  }, 60000);
  it("WCA events", async () => {
    for (const ev of ["333", "222so", "pyrso", "skbso", "clkwca"]) expect((await generateScramble(ev)).length).toBeGreaterThan(5);
  }, 120000);
});
