import { Cube, invertAlg } from "./cube";

const AUF = ["", "U", "U2", "U'"];

export interface LLView {
  U: number[];
  F: number[];
  R: number[];
  B: number[];
  L: number[];
}

/** Last-layer stickers (U face + top row of each side) after applying `setup` to a solved cube. */
export function llView(setup: string): LLView {
  const fl = new Cube().apply(setup).normalize().facelets();
  return { U: fl.U, F: fl.F.slice(0, 3), R: fl.R.slice(0, 3), B: fl.B.slice(0, 3), L: fl.L.slice(0, 3) };
}

const viewKey = (v: LLView) => [v.U, v.F, v.R, v.B, v.L].map((a) => a.join("")).join("|");
const maskKey = (v: LLView) => [v.U, v.F, v.R, v.B, v.L].map((a) => a.map((x) => (x === 0 ? 1 : 0)).join("")).join("|");

/** Case state for an algorithm: inverse(alg) applied to solved. */
export function caseSetup(alg: string) {
  return invertAlg(alg);
}

export function llState(alg: string) {
  const setup = caseSetup(alg);
  const view = llView(setup);
  const orientKeys: string[] = [];
  const classKeys: string[] = [];
  for (const a of AUF) {
    orientKeys.push(maskKey(llView(setup + " " + a)));
    for (const b of AUF) classKeys.push(viewKey(llView(b + " " + setup + " " + a)));
  }
  return {
    view,
    oriented: view.U.every((x) => x === 0),
    orientKey: orientKeys.sort()[0],
    classKeys: [...new Set(classKeys)],
  };
}
