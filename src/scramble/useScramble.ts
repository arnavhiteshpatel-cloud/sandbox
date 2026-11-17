import { create } from "zustand";
import { scrambleQueue } from "./scrambler";

interface ScrState {
  eventId: string;
  seen: string[];
  pos: number;
  loading: boolean;
  error: string | null;
  /** manually entered scramble overrides the generator for the next solve */
  current(): string;
  setEvent(eventId: string): void;
  next(): Promise<void>;
  prev(): void;
  setManual(s: string): void;
}

let gen = 0;

export const useScramble = create<ScrState>((set, get) => ({
  eventId: "",
  seen: [],
  pos: -1,
  loading: false,
  error: null,
  current() {
    const { seen, pos } = get();
    return seen[pos] ?? "";
  },
  setEvent(eventId) {
    if (eventId === get().eventId && get().seen.length) return;
    set({ eventId, seen: [], pos: -1 });
    get().next();
  },
  async next() {
    const { seen, pos, eventId } = get();
    if (pos < seen.length - 1) {
      set({ pos: pos + 1 });
      return;
    }
    const my = ++gen;
    set({ loading: true, error: null });
    try {
      const s = await scrambleQueue.next(eventId);
      if (my !== gen || get().eventId !== eventId) return;
      const list = [...get().seen, s].slice(-200);
      set({ seen: list, pos: list.length - 1, loading: false });
    } catch (e) {
      if (my === gen) set({ loading: false, error: String((e as Error)?.message ?? e) });
    }
  },
  prev() {
    const { pos } = get();
    if (pos > 0) set({ pos: pos - 1 });
  },
  setManual(s) {
    const list = [...get().seen.slice(0, get().pos + 1), s];
    set({ seen: list, pos: list.length - 1 });
  },
}));
