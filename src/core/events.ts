/**
 * Event / scramble-type registry. Ids use csTimer's scramble-type codes so imported
 * sessions keep their original type and exports re-import into csTimer cleanly.
 */

export type PuzzleKind = "cube" | "minx" | "pyram" | "skewb" | "sq1" | "clock" | "fto" | "none";

export interface EventDef {
  id: string;
  name: string;
  short: string;
  group: "WCA" | "3x3 training" | "2x2 training" | "Other" | "Input";
  /** cubing.js event id for random-state scrambles */
  cubing?: string;
  /** custom generator id handled in scramble/generators.ts */
  gen?: string;
  puzzle: PuzzleKind;
  /** cube size for "cube" puzzles */
  size?: number;
  /** move count for random-move scramblers */
  len?: number;
  inspection?: boolean;
}

export const EVENTS: EventDef[] = [
  { id: "333", name: "3x3x3", short: "3x3", group: "WCA", cubing: "333", puzzle: "cube", size: 3 },
  { id: "222so", name: "2x2x2", short: "2x2", group: "WCA", cubing: "222", puzzle: "cube", size: 2 },
  { id: "444wca", name: "4x4x4", short: "4x4", group: "WCA", cubing: "444", puzzle: "cube", size: 4 },
  { id: "555wca", name: "5x5x5", short: "5x5", group: "WCA", cubing: "555", puzzle: "cube", size: 5 },
  { id: "666wca", name: "6x6x6", short: "6x6", group: "WCA", cubing: "666", puzzle: "cube", size: 6 },
  { id: "777wca", name: "7x7x7", short: "7x7", group: "WCA", cubing: "777", puzzle: "cube", size: 7 },
  { id: "333ni", name: "3x3x3 Blindfolded", short: "3BLD", group: "WCA", cubing: "333bf", puzzle: "cube", size: 3, inspection: false },
  { id: "333fm", name: "3x3x3 Fewest Moves", short: "FMC", group: "WCA", cubing: "333fm", puzzle: "cube", size: 3, inspection: false },
  { id: "333oh", name: "3x3x3 One-Handed", short: "OH", group: "WCA", cubing: "333oh", puzzle: "cube", size: 3 },
  { id: "clkwca", name: "Clock", short: "Clock", group: "WCA", cubing: "clock", puzzle: "clock" },
  { id: "mgmp", name: "Megaminx", short: "Mega", group: "WCA", cubing: "minx", puzzle: "minx" },
  { id: "pyrso", name: "Pyraminx", short: "Pyra", group: "WCA", cubing: "pyram", puzzle: "pyram" },
  { id: "skbso", name: "Skewb", short: "Skewb", group: "WCA", cubing: "skewb", puzzle: "skewb" },
  { id: "sqrs", name: "Square-1", short: "SQ1", group: "WCA", cubing: "sq1", puzzle: "sq1" },
  { id: "444bld", name: "4x4x4 Blindfolded", short: "4BLD", group: "WCA", cubing: "444bf", puzzle: "cube", size: 4, inspection: false },
  { id: "555bld", name: "5x5x5 Blindfolded", short: "5BLD", group: "WCA", cubing: "555bf", puzzle: "cube", size: 5, inspection: false },
  { id: "r3ni", name: "3x3x3 Multi-Blind", short: "MBLD", group: "WCA", cubing: "333bf", puzzle: "cube", size: 3, inspection: false },
  { id: "333ft", name: "3x3x3 With Feet", short: "Feet", group: "Other", cubing: "333", puzzle: "cube", size: 3 },

  { id: "pll", name: "PLL", short: "PLL", group: "3x3 training", gen: "pll", puzzle: "cube", size: 3 },
  { id: "oll", name: "OLL", short: "OLL", group: "3x3 training", gen: "oll", puzzle: "cube", size: 3 },
  { id: "ll", name: "Last layer", short: "LL", group: "3x3 training", gen: "ll", puzzle: "cube", size: 3 },
  { id: "coll", name: "COLL (edges oriented)", short: "COLL", group: "3x3 training", gen: "coll", puzzle: "cube", size: 3 },
  { id: "zbll", name: "ZBLL (edges oriented)", short: "ZBLL", group: "3x3 training", gen: "zbll", puzzle: "cube", size: 3 },
  { id: "ell", name: "ELL (corners solved)", short: "ELL", group: "3x3 training", gen: "ell", puzzle: "cube", size: 3 },
  { id: "cll", name: "CLL (edges solved)", short: "CLL", group: "3x3 training", gen: "cll", puzzle: "cube", size: 3 },
  { id: "lsll2", name: "Last slot + last layer", short: "LSLL", group: "3x3 training", gen: "lsll", puzzle: "cube", size: 3 },
  { id: "f2l", name: "Cross solved (F2L practice)", short: "F2L", group: "3x3 training", gen: "f2l", puzzle: "cube", size: 3 },
  { id: "edges", name: "Edges only", short: "Edges", group: "3x3 training", gen: "edges", puzzle: "cube", size: 3 },
  { id: "corners", name: "Corners only", short: "Corners", group: "3x3 training", gen: "corners", puzzle: "cube", size: 3 },
  { id: "lse", name: "Roux LSE", short: "LSE", group: "3x3 training", gen: "lse", puzzle: "cube", size: 3 },
  { id: "333o", name: "3x3x3 random move", short: "3x3 RM", group: "3x3 training", gen: "rm", puzzle: "cube", size: 3, len: 25 },
  { id: "2gen", name: "2-gen <R,U>", short: "RU", group: "3x3 training", gen: "2gen", puzzle: "cube", size: 3, len: 25 },
  { id: "222eg0", name: "2x2 CLL", short: "2CLL", group: "2x2 training", gen: "222cll", puzzle: "cube", size: 2 },
  { id: "444m", name: "4x4x4 random move", short: "4x4 RM", group: "Other", gen: "rm", puzzle: "cube", size: 4, len: 40 },
  { id: "input", name: "Typed entry (no scramble)", short: "Input", group: "Input", puzzle: "none" },
  { id: "ftoso", name: "FTO", short: "FTO", group: "Other", cubing: "fto", puzzle: "fto" },
];

const BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

/** Lookup with graceful fallback for unknown csTimer scramble types (kept verbatim). */
export function getEvent(id: string): EventDef {
  const e = BY_ID.get(id);
  if (e) return e;
  return { id, name: id, short: id, group: "Other", puzzle: "none" };
}

export function isKnownEvent(id: string) {
  return BY_ID.has(id);
}

export const EVENT_GROUPS = ["WCA", "3x3 training", "2x2 training", "Other", "Input"] as const;
