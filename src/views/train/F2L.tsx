import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTrain } from "../../data/trainStore";
import { useStore } from "../../data/store";
import { generateScramble } from "../../scramble/scrambler";
import { relabel, Z2 } from "../../core/train/cases";
import { averageOf, summarize } from "../../core/stats";
import { ScrambleImage } from "../../ui/ScrambleImage";
import { IconTrash } from "../../ui/icons";
import { Seg } from "../../ui/Overlay";
import { useTrainTimer, TimerFace, KeyHint } from "./timer";
import { Spark, Stat, sec, tidyScramble } from "./common";

const ao = (vals: number[], n: number) => (vals.length >= n ? averageOf(vals.slice(-n), { n }) : NaN);

export function F2L() {
  const s = useTrain((t) => t.s);
  const setPref = useTrain((t) => t.setPref);
  const colours = useStore((x) => x.settings.cubeColors);
  const mode = s.prefs.f2lMode;
  const crossColour = s.prefs.f2lCross;
  const [scramble, setScramble] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const gen = useRef(0);

  const load = useCallback(() => {
    const token = ++gen.current;
    setScramble(null);
    setError(null);
    generateScramble(mode === "ls" ? "lsll2" : "f2l")
      .then((scr) => {
        if (token !== gen.current) return;
        // generated with the solved cross on D (yellow); z2-relabel for a white cross
        setScramble(tidyScramble(crossColour === "white" ? relabel(scr, Z2) : scr));
      })
      .catch((e) => token === gen.current && setError(String(e?.message ?? e)));
  }, [mode, crossColour]);
  useEffect(load, [load]);

  const scrRef = useRef(scramble);
  scrRef.current = scramble;
  const timer = useTrainTimer({
    enabled: !!scramble,
    onSolve: (r) => {
      useTrain.getState().recordTimed({ at: Date.now(), ms: r.time, mode, scramble: scrRef.current ?? "" });
      setLastMs(r.time);
      load();
    },
  });

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (timer.engine.phase !== "idle" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "KeyN" || e.code === "ArrowRight") {
        e.preventDefault();
        load();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [timer.engine, load]);

  const recs = useMemo(() => s.timed.filter((r) => r.mode === mode), [s.timed, mode]);
  const vals = recs.map((r) => r.ms);
  const sum = summarize(vals);
  const running = timer.phase !== "idle" && timer.phase !== "done";

  return (
    <div className="tr-grid" data-testid="f2l">
      <div className="tr-main">
        <div className="tr-toolbar fade-when-timing">
          <Seg
            value={mode}
            options={[
              { v: "f2l", label: "Full F2L" },
              { v: "ls", label: "Last slot + LL" },
            ]}
            onChange={(v) => setPref("f2lMode", v)}
          />
          <Seg
            value={crossColour}
            options={[
              { v: "white", label: "White cross" },
              { v: "yellow", label: "Yellow cross" },
            ]}
            onChange={(v) => setPref("f2lCross", v)}
          />
          <div className="grow" />
          <button className="btn sm ghost" onClick={load} title="New scramble  N">
            New scramble <span className="kbd">N</span>
          </button>
        </div>
        <div className={"tr-stage glass-edge f2l-stage" + (running ? " running" : "")}>
          <div className="drill-scr fade-when-timing" data-testid="f2l-scramble">
            {scramble ? <span className="mono">{scramble}</span> : error ? <span className="bad">{error}</span> : <span className="dim">generating scramble…</span>}
          </div>
          <div className="dim tr-small fade-when-timing" style={{ textAlign: "center" }}>
            Scramble in the standard orientation (white top, green front). The {crossColour} cross stays solved{mode === "ls" ? " with three pairs inserted" : ""}; time {mode === "ls" ? "the last slot and last layer" : "F2L only (stop when the four pairs are in)"}.
          </div>
          <TimerFace timer={timer} value={lastMs} testId="f2l-timer" />
          <KeyHint phase={timer.phase} idle={scramble ? "hold space to start · any key stops" : "waiting for scramble"} />
          <div className="f2l-net fade-when-timing">{scramble && <ScrambleImage eventId="333" scramble={scramble} colors={colours} width={190} />}</div>
        </div>
      </div>
      <aside className="tr-side fade-when-timing">
        <div className="glass-edge tr-panel">
          <div className="cap">{mode === "ls" ? "Last slot + LL" : "F2L"} · all time</div>
          <div className="tr-stats3">
            <Stat label="Count" value={sum.count} />
            <Stat label="Mean" value={sec(sum.mean)} />
            <Stat label="Best" value={sec(sum.best)} accent />
            <Stat label="ao5" value={sec(ao(vals, 5))} />
            <Stat label="ao12" value={sec(ao(vals, 12))} />
            <Stat label="ao50" value={sec(ao(vals, 50))} />
          </div>
          {vals.length > 1 && <Spark values={vals.slice(-50).map((ms) => ({ ms }))} width={270} height={40} />}
        </div>
        <div className="glass-edge tr-panel">
          <div className="cap">Recent</div>
          {recs.length ? (
            <div className="f2l-list">
              {recs
                .slice(-12)
                .reverse()
                .map((r) => (
                  <div key={r.at} className="fl-row" title={r.scramble}>
                    <span className="num">{sec(r.ms)}</span>
                    <span className="dim mono fl-scr">{r.scramble}</span>
                    <button className="ib sm" title="Delete" onClick={() => useTrain.getState().removeTimed(r.at)}>
                      <IconTrash size={12} />
                    </button>
                  </div>
                ))}
            </div>
          ) : (
            <div className="dim tr-small">Times are kept separately from your main sessions.</div>
          )}
        </div>
      </aside>
    </div>
  );
}
