import { describe, expect, it, vi } from "vitest";
import { TimerEngine, type SolveResult } from "./engine";

const k = (code: string, timeStamp: number, repeat = false) => ({ code, timeStamp, repeat });

function make(over: Partial<ConstructorParameters<typeof TimerEngine>[0]> = {}) {
  const e = new TimerEngine({ holdMs: 300, inspection: false, inspectionMs: 15000, phases: 1, startKey: "space", ...over });
  const solves: SolveResult[] = [];
  e.onSolve = (r) => solves.push(r);
  return { e, solves };
}

describe("timer engine", () => {
  it("hold to arm, release to start, any key stops; time from event timestamps", () => {
    vi.useFakeTimers();
    const { e, solves } = make();
    e.keyDown(k("Space", 1000));
    expect(e.phase).toBe("hold");
    e.keyDown(k("Space", 1100, true)); // auto-repeat ignored
    vi.advanceTimersByTime(300);
    expect(e.phase).toBe("ready");
    e.keyUp(k("Space", 1400));
    expect(e.phase).toBe("run");
    e.keyDown(k("KeyJ", 13_743.6));
    expect(e.phase).toBe("done");
    expect(solves[0]).toEqual({ time: 12344, penalty: 0, splits: null, inspectionMs: null });
    e.keyUp(k("KeyJ", 13_800));
    expect(e.phase).toBe("idle");
    vi.useRealTimers();
  });

  it("releasing too early does not start", () => {
    vi.useFakeTimers();
    const { e } = make();
    e.keyDown(k("Space", 0));
    vi.advanceTimersByTime(100);
    e.keyUp(k("Space", 100));
    expect(e.phase).toBe("idle");
    vi.useRealTimers();
  });

  it("stopping with space does not immediately re-arm", () => {
    vi.useFakeTimers();
    const { e, solves } = make({ holdMs: 0 });
    e.keyDown(k("Space", 0));
    e.keyUp(k("Space", 10));
    e.keyDown(k("Space", 5010));
    expect(solves).toHaveLength(1);
    e.keyDown(k("Space", 5020, true));
    e.keyUp(k("Space", 5100));
    expect(e.phase).toBe("idle");
    vi.useRealTimers();
  });

  it("inspection: +2 between 15 and 17 s, DNF after 17 s", () => {
    vi.useFakeTimers();
    for (const [startAt, pen] of [
      [14000, 0],
      [16000, 2000],
      [17500, -1],
    ] as const) {
      const { e, solves } = make({ inspection: true, holdMs: 0 });
      e.keyDown(k("Space", 0));
      e.keyUp(k("Space", 50));
      expect(e.phase).toBe("inspect");
      e.keyDown(k("Space", 50 + startAt - 10));
      e.keyUp(k("Space", 50 + startAt));
      e.keyDown(k("Space", 50 + startAt + 9000));
      expect(solves[0].penalty).toBe(pen);
      expect(solves[0].time).toBe(9000);
    }
    vi.useRealTimers();
  });

  it("inspection voice warnings fire at 8 and 12 seconds", () => {
    vi.useFakeTimers();
    const { e } = make({ inspection: true });
    const w: number[] = [];
    e.onInspectionWarning = (s) => w.push(s);
    e.keyDown(k("Space", 0));
    e.keyUp(k("Space", 0));
    vi.advanceTimersByTime(12500);
    expect(w).toEqual([8, 12]);
    vi.useRealTimers();
  });

  it("multi-phase splits", () => {
    const { e, solves } = make({ holdMs: 0, phases: 3 });
    e.keyDown(k("Space", 0));
    e.keyUp(k("Space", 0));
    e.keyDown(k("KeyA", 2000));
    e.keyUp(k("KeyA", 2050));
    e.keyDown(k("KeyA", 7000));
    e.keyUp(k("KeyA", 7050));
    e.keyDown(k("KeyA", 11000));
    expect(solves[0].splits).toEqual([2000, 7000, 11000]);
    expect(solves[0].time).toBe(11000);
  });

  it("blur during hold cancels the arm; escape cancels inspection", () => {
    const { e } = make();
    e.keyDown(k("Space", 0));
    e.blur();
    expect(e.phase).toBe("idle");
    const i = make({ inspection: true }).e;
    i.keyDown(k("Space", 0));
    i.keyUp(k("Space", 0));
    i.keyDown(k("Escape", 10));
    expect(i.phase).toBe("idle");
  });

  it("modifier keys do not stop the timer", () => {
    const { e, solves } = make({ holdMs: 0 });
    e.keyDown(k("Space", 0));
    e.keyUp(k("Space", 0));
    e.keyDown(k("MetaLeft", 100));
    expect(e.phase).toBe("run");
    e.keyDown(k("Space", 5000));
    expect(solves).toHaveLength(1);
  });
});
