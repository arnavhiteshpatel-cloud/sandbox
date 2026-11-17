import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTrain } from "../../data/trainStore";
import { useStore } from "../../data/store";
import { generateScramble } from "../../scramble/scrambler";
import { phaseBreakdown, phaseDurations, PHASE_NAMES } from "../../core/train/phases";
import { IconTrash } from "../../ui/icons";
import { Toggle } from "../../ui/Overlay";
import { useTrainTimer, TimerFace, KeyHint } from "./timer";
import { Stat, sec, tidyScramble } from "./common";

const PH_CLASS = ["p0", "p1", "p2", "p3"];

export function Phases() {
  const s = useTrain((t) => t.s);
  const setPref = useTrain((t) => t.setPref);
  const [scramble, setScramble] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<number[] | null>(null);
  const gen = useRef(0);
  const load = useCallback(() => {
    const token = ++gen.current;
    setScramble(null);
    generateScramble("333")
      .then((scr) => token === gen.current && setScramble(tidyScramble(scr)))
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);
  useEffect(load, [load]);
  const scrRef = useRef(scramble);
  scrRef.current = scramble;

  const timer = useTrainTimer({
    phases: 4,
    inspection: s.prefs.phaseInspection,
    enabled: !!scramble,
    onSolve: (r) => {
      if (r.penalty < 0 || !r.splits || r.splits.length !== 4) {
        useStore.getState().toast("Inspection exceeded 17 s (DNF) — not recorded.", "error");
        load();
        return;
      }
      const splits = r.splits;
      useTrain.getState().recordPhase({ at: Date.now(), splits, scramble: scrRef.current ?? "" });
      setLast(splits);
      load();
    },
  });
  // live split count while running
  const splitCount = useSyncExternalStore(
    (f) => timer.engine.subscribe(f),
    () => timer.engine.splits.length,
  );

  const bd = useMemo(() => phaseBreakdown(s.phases), [s.phases]);
  const running = timer.phase === "run";
  const recent = s.phases.slice(-12).reverse();
  const maxTotal = Math.max(1, ...recent.map((r) => r.splits[3]));

  return (
    <div className="tr-grid" data-testid="phases">
      <div className="tr-main">
        <div className="tr-toolbar fade-when-timing">
          <label className="tr-inline">
            <Toggle on={s.prefs.phaseInspection} onChange={(v) => setPref("phaseInspection", v)} />
            <span>Inspection</span>
          </label>
          <div className="grow" />
          <span className="cap dim">Press any key at the end of each phase: cross → F2L → OLL → PLL (stops)</span>
        </div>
        <div className={"tr-stage glass-edge phase-stage" + (timer.phase !== "idle" && timer.phase !== "done" ? " running" : "")}>
          <div className="drill-scr fade-when-timing" data-testid="phase-scramble">
            {scramble ? <span className="mono">{scramble}</span> : error ? <span className="bad">{error}</span> : <span className="dim">generating scramble…</span>}
          </div>
          <TimerFace timer={timer} value={last ? last[3] : null} testId="phase-timer" />
          <div className="phase-track" data-testid="phase-track">
            {PHASE_NAMES.map((n, i) => {
              const done = running ? i < splitCount : !!last;
              const now = running && i === splitCount;
              const dur = !running && last ? phaseDurations(last)[i] : null;
              return (
                <div key={n} className={"pt " + PH_CLASS[i] + (done ? " done" : "") + (now ? " now" : "")}>
                  <i />
                  <span className="cap">{n}</span>
                  <span className="num">{dur != null ? sec(dur) : running && i < splitCount ? sec(phaseDurations(timer.engine.splits)[i]) : "–"}</span>
                </div>
              );
            })}
          </div>
          <KeyHint phase={timer.phase} idle={scramble ? (s.prefs.phaseInspection ? "space to inspect, hold space to start" : "hold space to start") : "waiting for scramble"} />
        </div>
      </div>
      <aside className="tr-side fade-when-timing">
        <div className="glass-edge tr-panel" data-testid="phase-breakdown">
          <div className="row-between">
            <span className="cap">Average breakdown</span>
            <span className="cap">last {bd.n}</span>
          </div>
          {bd.n ? (
            <>
              <div className="stack-bar big">
                {bd.means.map((m, i) => (
                  <i key={i} className={PH_CLASS[i]} style={{ flexGrow: m }} title={`${PHASE_NAMES[i]} ${sec(m)}`} />
                ))}
              </div>
              <div className="phase-legend">
                {bd.means.map((m, i) => (
                  <div key={i}>
                    <span className={"sw " + PH_CLASS[i]} />
                    <span className="cap">{PHASE_NAMES[i]}</span>
                    <b className="num">{sec(m)}</b>
                    <span className="dim num">{Math.round(bd.share[i] * 100)}%</span>
                  </div>
                ))}
              </div>
              <div className="tr-stats3" style={{ marginTop: 6 }}>
                <Stat label="Mean total" value={sec(bd.total)} />
                <Stat label="Recorded" value={s.phases.length} />
                <Stat label="Last" value={last ? sec(last[3]) : "–"} />
              </div>
            </>
          ) : (
            <div className="dim tr-small">No solves with phase splits yet.</div>
          )}
          <p className="tr-note-sm">Only from solves recorded here with phase splits — your regular timer solves have no splits and are not included.</p>
        </div>
        <div className="glass-edge tr-panel">
          <div className="cap">Recent</div>
          {recent.length ? (
            <div className="phase-recent">
              {recent.map((r) => {
                const d = phaseDurations(r.splits);
                return (
                  <div key={r.at} className="pr-row" title={d.map((x, i) => `${PHASE_NAMES[i]} ${sec(x)}`).join(" · ")}>
                    <span className="num pr-t">{sec(r.splits[3])}</span>
                    <div className="stack-bar" style={{ width: (r.splits[3] / maxTotal) * 100 + "%" }}>
                      {d.map((x, i) => (
                        <i key={i} className={PH_CLASS[i]} style={{ flexGrow: x }} />
                      ))}
                    </div>
                    <button className="ib sm" title="Delete" onClick={() => useTrain.getState().removePhase(r.at)}>
                      <IconTrash size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="dim tr-small">Each recorded solve shows its four phases here.</div>
          )}
        </div>
      </aside>
    </div>
  );
}
