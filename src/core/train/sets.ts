/** Named case sets used by the drill / recognition trainers. */
import { ALL_CASES, casesOfSet, getCase } from "./cases";
import { isDue } from "./srs";
import type { TrainState } from "./types";

export interface SetOption {
  key: string;
  label: string;
  ids: string[];
}

export function resolveSet(state: TrainState, key: string, now: number): string[] {
  if (key === "PLL" || key === "OLL") return casesOfSet(key).map((c) => c.id);
  if (key === "learning") return ALL_CASES.filter((c) => state.cases[c.id]?.status === "learning").map((c) => c.id);
  if (key === "learned") return ALL_CASES.filter((c) => state.cases[c.id]?.status === "learned").map((c) => c.id);
  if (key === "due") return ALL_CASES.filter((c) => isDue(state.srs[c.id], now)).map((c) => c.id);
  if (key.startsWith("col:")) {
    const col = state.collections.find((c) => c.id === key.slice(4));
    return (col?.caseIds ?? []).filter((id) => !!getCase(id));
  }
  return [];
}

export function setOptions(state: TrainState, now: number): SetOption[] {
  const base: SetOption[] = [
    { key: "PLL", label: "All PLL", ids: [] },
    { key: "OLL", label: "All OLL", ids: [] },
    { key: "learning", label: "Learning", ids: [] },
    { key: "learned", label: "Learned", ids: [] },
    { key: "due", label: "Due reviews", ids: [] },
    ...state.collections.map((c) => ({ key: "col:" + c.id, label: c.name, ids: [] })),
  ];
  return base.map((o) => ({ ...o, ids: resolveSet(state, o.key, now) }));
}

export function setLabel(state: TrainState, key: string) {
  if (key.startsWith("col:")) return state.collections.find((c) => c.id === key.slice(4))?.name ?? "Collection";
  return { PLL: "All PLL", OLL: "All OLL", learning: "Learning", learned: "Learned", due: "Due reviews" }[key] ?? key;
}
