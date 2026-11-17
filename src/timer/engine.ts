/**
 * Timer state machine. Independent of React so that key events are handled with the
 * least possible latency and the logic can be unit-tested.
 *
 * Times are measured from the *event timestamps* (DOMHighResTimeStamp) of the start
 * key release and the stopping key press, not from when handlers happen to run.
 *
 *   idle ──down──▶ hold ──(holdMs)──▶ ready ──up──▶ run ──any down──▶ done ──up──▶ idle
 *     │ with inspection: idle ──down/up──▶ inspect ──down──▶ hold … (inspection penalty applied at start)
 */

export type Phase = "idle" | "preinspect" | "inspect" | "hold" | "ready" | "run" | "done";

export interface EngineOptions {
  holdMs: number;
  inspection: boolean;
  inspectionMs: number;
  phases: number;
  startKey: "space" | "any";
}

export interface SolveResult {
  time: number;
  penalty: number;
  splits: number[] | null;
  inspectionMs: number | null;
}

type Listener = () => void;

export interface KeyLike {
  code: string;
  key?: string;
  timeStamp: number;
  repeat?: boolean;
}

const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "Fn"]);

export class TimerEngine {
  phase: Phase = "idle";
  opts: EngineOptions;
  t0 = 0;
  inspectStart = 0;
  holdStart = 0;
  splits: number[] = [];
  last: SolveResult | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private returnPhase: Phase = "idle";
  /** keys currently held (prevents a stop key press from re-arming on keyup) */
  private down = new Set<string>();
  onSolve: ((r: SolveResult) => void) | null = null;
  onInspectionWarning: ((sec: 8 | 12) => void) | null = null;
  private warned = new Set<number>();
  private warnTimers: ReturnType<typeof setTimeout>[] = [];
  now: () => number = () => performance.now();

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
  private setPhase(p: Phase) {
    this.phase = p;
    this.emit();
  }

  private isStartKey(e: KeyLike) {
    if (this.opts.startKey === "space") return e.code === "Space";
    return !MODIFIER_CODES.has(e.code) && e.code !== "Escape";
  }

  get active() {
    return this.phase !== "idle" && this.phase !== "done";
  }

  /** Elapsed ms of the running solve or inspection, for display. */
  elapsed(at = this.now()) {
    if (this.phase === "run") return at - this.t0;
    if (this.phase === "inspect" || this.inspectingHold()) return at - this.inspectStart;
    return 0;
  }

  inspectingHold() {
    return (this.phase === "hold" || this.phase === "ready") && this.returnPhase === "inspect";
  }

  keyDown(e: KeyLike): boolean {
    if (e.repeat) return this.phase !== "idle" || e.code === "Space";
    const wasDown = this.down.has(e.code);
    this.down.add(e.code);
    if (wasDown) return true;
    switch (this.phase) {
      case "run": {
        if (MODIFIER_CODES.has(e.code)) return false;
        const t = e.timeStamp - this.t0;
        if (this.splits.length + 1 < this.opts.phases && e.code !== "Escape") {
          this.splits.push(Math.round(t));
          this.emit();
          return true;
        }
        this.finish(t);
        return true;
      }
      case "idle":
        if (!this.isStartKey(e)) return false;
        if (this.opts.inspection) {
          this.setPhase("preinspect");
        } else {
          this.beginHold(e.timeStamp, "idle");
        }
        return true;
      case "inspect":
        if (e.code === "Escape") {
          this.cancel();
          return true;
        }
        if (!this.isStartKey(e)) return false;
        this.beginHold(e.timeStamp, "inspect");
        return true;
      case "hold":
      case "ready":
      case "preinspect":
        if (e.code === "Escape") {
          this.cancel();
          return true;
        }
        return true;
      case "done":
        return true;
    }
    return false;
  }

  keyUp(e: KeyLike): boolean {
    this.down.delete(e.code);
    switch (this.phase) {
      case "preinspect":
        if (!this.isStartKey(e)) return false;
        this.startInspection(e.timeStamp);
        return true;
      case "hold":
        if (!this.isStartKey(e)) return true;
        this.clearHold();
        this.setPhase(this.returnPhase);
        return true;
      case "ready":
        if (!this.isStartKey(e)) return true;
        this.clearHold();
        this.start(e.timeStamp);
        return true;
      case "done":
        if (this.down.size === 0) this.setPhase("idle");
        return true;
    }
    return false;
  }

  /** Window lost focus: abandon a pending hold (we would never see the key-up). */
  blur() {
    this.down.clear();
    if (this.phase === "hold" || this.phase === "ready") {
      this.clearHold();
      this.setPhase(this.returnPhase);
    } else if (this.phase === "preinspect") this.setPhase("idle");
    else if (this.phase === "done") this.setPhase("idle");
  }

  cancel() {
    this.clearHold();
    this.clearWarn();
    this.splits = [];
    this.down.clear();
    this.setPhase("idle");
  }

  private beginHold(ts: number, ret: Phase) {
    this.returnPhase = ret;
    this.holdStart = ts;
    if (this.opts.holdMs <= 0) {
      this.setPhase("ready");
      return;
    }
    this.setPhase("hold");
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.phase === "hold") this.setPhase("ready");
    }, this.opts.holdMs);
  }

  private clearHold() {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private startInspection(ts: number) {
    this.inspectStart = ts;
    this.warned.clear();
    this.clearWarn();
    const fire = (sec: 8 | 12) => {
      if ((this.phase === "inspect" || this.inspectingHold()) && !this.warned.has(sec)) {
        this.warned.add(sec);
        this.onInspectionWarning?.(sec);
      }
    };
    this.warnTimers.push(setTimeout(() => fire(8), 8000), setTimeout(() => fire(12), 12000));
    this.setPhase("inspect");
  }

  private clearWarn() {
    this.warnTimers.forEach(clearTimeout);
    this.warnTimers = [];
  }

  private start(ts: number) {
    this.t0 = ts;
    this.splits = [];
    this.clearWarn();
    this.setPhase("run");
  }

  /** WCA Regulation A3a / 10e: >15s inspection = +2, >17s = DNF. */
  inspectionPenalty(): { penalty: number; ms: number | null } {
    if (this.returnPhase !== "inspect" || !this.opts.inspection) return { penalty: 0, ms: null };
    const ms = this.t0 - this.inspectStart;
    const lim = this.opts.inspectionMs;
    if (ms > lim + 2000) return { penalty: -1, ms };
    if (ms > lim) return { penalty: 2000, ms };
    return { penalty: 0, ms };
  }

  private finish(t: number) {
    const time = Math.max(0, Math.round(t));
    const ip = this.inspectionPenalty();
    const splits = this.opts.phases > 1 ? [...this.splits, time] : null;
    this.last = { time, penalty: ip.penalty, splits, inspectionMs: ip.ms };
    this.returnPhase = "idle";
    this.setPhase("done");
    this.onSolve?.(this.last);
  }
}
