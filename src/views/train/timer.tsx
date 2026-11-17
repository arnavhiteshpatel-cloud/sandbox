/**
 * Training timer: a private TimerEngine instance with its own key handling. Listeners run in
 * the capture phase and stop propagation for every key the engine consumes, so the app's
 * global shortcuts (Esc → timer view, F → fullscreen, …) never fire mid-solve.
 */
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { TimerEngine, type Phase, type SolveResult } from "../../timer/engine";
import { useStore } from "../../data/store";
import { layersOpen } from "../../ui/Overlay";
import { fmtSingle } from "../../core/time";

function isEditable(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export interface TrainTimer {
  engine: TimerEngine;
  phase: Phase;
}

export function useTrainTimer({ onSolve, phases = 1, inspection = false, enabled = true }: { onSolve: (r: SolveResult) => void; phases?: number; inspection?: boolean; enabled?: boolean }): TrainTimer {
  const holdMs = useStore((s) => s.settings.holdMs);
  const inspectionSeconds = useStore((s) => s.settings.inspectionSeconds);
  const hideUi = useStore((s) => s.settings.hideUiWhileTiming);
  const setTiming = useStore((s) => s.setTiming);
  const ref = useRef<TimerEngine | null>(null);
  if (!ref.current) ref.current = new TimerEngine({ holdMs, inspection, inspectionMs: inspectionSeconds * 1000, phases, startKey: "space" });
  const engine = ref.current;
  engine.opts = { holdMs, inspection, inspectionMs: inspectionSeconds * 1000, phases, startKey: "space" };
  const cb = useRef(onSolve);
  cb.current = onSolve;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    engine.onSolve = (r) => cb.current(r);
    const down = (e: KeyboardEvent) => {
      const active = engine.phase !== "idle";
      if (!active) {
        if (!enabledRef.current || layersOpen() || isEditable(e.target)) return;
        if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return;
      }
      if (engine.keyDown({ code: e.code, key: e.key, timeStamp: e.timeStamp, repeat: e.repeat })) {
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (engine.phase === "idle") return;
      if (engine.keyUp({ code: e.code, key: e.key, timeStamp: e.timeStamp })) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const blur = () => engine.blur();
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      engine.onSolve = null;
      engine.cancel();
    };
  }, [engine]);

  const phase = useSyncExternalStore(
    (f) => engine.subscribe(f),
    () => engine.phase,
  );
  useEffect(() => {
    setTiming(hideUi && phase !== "idle" && phase !== "done");
  }, [phase, hideUi, setTiming]);
  useEffect(() => () => setTiming(false), [setTiming]);
  return { engine, phase };
}

/** Big time readout; updates via rAF while running (no React render per frame). */
export function TimerFace({ timer, value, size = "lg", testId, label }: { timer: TrainTimer; value: number | null; size?: "lg" | "md"; testId?: string; label?: string }) {
  const { engine, phase } = timer;
  const d = useStore((s) => s.settings.decimals);
  const inspectionSeconds = useStore((s) => s.settings.inspectionSeconds);
  const el = useRef<HTMLSpanElement>(null);
  const inInspect = phase === "inspect" || phase === "preinspect" || engine.inspectingHold();
  useLayoutEffect(() => {
    let raf = 0;
    const tick = () => {
      const node = el.current;
      if (node) {
        if (engine.phase === "run") node.textContent = fmtSingle(engine.elapsed(), Math.min(d, 2));
        else if (engine.phase === "inspect" || engine.inspectingHold()) {
          const left = inspectionSeconds - Math.floor(engine.elapsed() / 1000);
          node.textContent = left > 0 ? String(left) : left > -2 ? "+2" : "DNF";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    if (phase === "run" || inInspect) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, inInspect, engine, d, inspectionSeconds]);
  const running = phase === "run" || inInspect;
  const txt = running ? (phase === "run" ? fmtSingle(0, Math.min(d, 2)) : String(inspectionSeconds)) : value != null ? fmtSingle(value, d) : d === 3 ? "0.000" : "0.00";
  const cls = ["tr-time num", size, phase === "hold" ? "hold" : "", phase === "ready" ? "ready" : "", phase === "run" ? "run" : "", inInspect ? "inspect" : ""].join(" ");
  return (
    <div className={cls} data-testid={testId} data-phase={phase}>
      <span ref={el}>{txt}</span>
      {label && !running && <span className="tr-time-label cap">{label}</span>}
    </div>
  );
}

export function KeyHint({ phase, idle }: { phase: Phase; idle: string }) {
  const txt =
    phase === "idle" || phase === "done" ? idle : phase === "hold" ? "keep holding…" : phase === "ready" ? "release to start" : phase === "run" ? "any key to stop" : phase === "inspect" || phase === "preinspect" ? "inspecting · hold space to start" : "";
  return <div className="tr-keyhint cap">{txt}</div>;
}
