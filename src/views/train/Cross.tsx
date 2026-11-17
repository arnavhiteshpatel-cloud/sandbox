import { useCallback, useEffect, useMemo, useState } from "react";
import { useTrain } from "../../data/trainStore";
import { useStore } from "../../data/store";
import { generateScramble } from "../../scramble/scrambler";
import { solveAllColours, COLOUR_NAMES, type CrossSolution } from "../../core/train/cross";
import { ScrambleImage } from "../../ui/ScrambleImage";
import { layersOpen } from "../../ui/Overlay";
import { AlgPlayer } from "./AlgPlayer";
import { Stat, tidyScramble } from "./common";

type Stage = "loading" | "ready" | "plan" | "reveal";

export function Cross() {
  const s = useTrain((t) => t.s);
  const setPref = useTrain((t) => t.setPref);
  const colours = useStore((x) => x.settings.cubeColors);
  const colour = s.prefs.crossColour;
  const planSec = s.prefs.crossPlanSec;
  const [scramble, setScramble] = useState("");
  const [stage, setStage] = useState<Stage>("loading");
  const [planStart, setPlanStart] = useState(0);
  const [planMs, setPlanMs] = useState(0);
  const [now, setNow] = useState(0);
  const [shownSol, setShownSol] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setStage("loading");
    setError(null);
    generateScramble("333")
      .then((scr) => {
        setScramble(tidyScramble(scr));
        setStage("ready");
        setShownSol(0);
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);
  useEffect(load, [load]);

  const all: CrossSolution[] = useMemo(() => (scramble ? solveAllColours(scramble, 4) : []), [scramble]);
  const best = all.length ? Math.min(...all.map((x) => x.length)) : 0;
  const target = colour < 0 ? all.find((x) => x.length === best) : all[colour];

  const reveal = useCallback(() => {
    setPlanMs(Math.round(performance.now() - planStart));
    setStage("reveal");
  }, [planStart]);

  // countdown
  useEffect(() => {
    if (stage !== "plan") return;
    let raf = 0;
    const tick = () => {
      const t = performance.now();
      setNow(t);
      if (planSec > 0 && t - planStart >= planSec * 1000) {
        reveal();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage, planStart, planSec, reveal]);

  const record = useCallback(
    (ok: boolean) => {
      if (!target) return;
      useTrain.getState().recordCross({ at: Date.now(), colour: target.colour, optimal: target.length, ok, planMs });
      load();
    },
    [target, planMs, load],
  );

  const start = () => {
    setPlanStart(performance.now());
    setNow(performance.now());
    setStage("plan");
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (layersOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (stage === "ready") start();
        else if (stage === "plan") reveal();
        else if (stage === "reveal") load();
      } else if (stage === "reveal" && (e.code === "KeyY" || e.code === "Digit1")) {
        e.preventDefault();
        record(true);
      } else if (stage === "reveal" && (e.code === "KeyN" || e.code === "Digit2")) {
        e.preventDefault();
        record(false);
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  });

  const hist = s.cross;
  const last20 = hist.slice(-20);
  const rate = last20.length ? last20.filter((r) => r.ok).length / last20.length : NaN;
  const avgOpt = hist.length ? hist.reduce((a, r) => a + r.optimal, 0) / hist.length : NaN;
  const left = planSec > 0 ? Math.max(0, planSec - (now - planStart) / 1000) : (now - planStart) / 1000;
  const frac = planSec > 0 ? Math.min(1, (now - planStart) / (planSec * 1000)) : 0;
  const R = 54,
    C = 2 * Math.PI * R;

  return (
    <div className="tr-grid" data-testid="cross">
      <div className="tr-main">
        <div className="tr-toolbar">
          <div className="seg cross-colours" role="radiogroup" aria-label="Cross colour">
            {[0, 3, 2, 5, 1, 4].map((c) => (
              <button key={c} className={colour === c ? "on" : ""} onClick={() => setPref("crossColour", c)} title={COLOUR_NAMES[c] + " cross"} data-testid={"cross-colour-" + c}>
                <i className="sw" style={{ background: colours[c] }} />
                {COLOUR_NAMES[c]}
              </button>
            ))}
            <button className={colour === -1 ? "on" : ""} onClick={() => setPref("crossColour", -1)} title="Colour neutral: the colour with the shortest cross" data-testid="cross-colour-any">
              Any
            </button>
          </div>
          <div className="grow" />
          <span className="cap dim">Plan</span>
          <div className="seg">
            {[8, 15, 30, 0].map((v) => (
              <button key={v} className={planSec === v ? "on" : ""} onClick={() => setPref("crossPlanSec", v)}>
                {v ? v + "s" : "∞"}
              </button>
            ))}
          </div>
        </div>

        <div className="tr-stage glass-edge cross-stage">
          <div className="cross-scr mono" data-testid="cross-scramble">
            {error ? <span className="bad">{error}</span> : scramble && stage !== "loading" ? scramble : <span className="dim">generating scramble…</span>}
          </div>
          <div className="cross-mid">
            <div className="cross-net">{scramble && <ScrambleImage eventId="333" scramble={scramble} colors={colours} width={210} />}</div>
            <div className="cross-centre">
              {stage === "ready" && (
                <div className="cross-ready">
                  <div className="cap">Scramble your cube, then</div>
                  <button className="btn primary" onClick={start} data-testid="cross-start">
                    Start planning <span className="kbd dark">Space</span>
                  </button>
                  <div className="dim tr-small">
                    {colour < 0 ? "Colour neutral — find the shortest cross of any colour." : `${COLOUR_NAMES[colour]} cross on the bottom.`} {planSec ? `${planSec} s to plan.` : "No time limit."}
                  </div>
                </div>
              )}
              {stage === "plan" && (
                <div className="cross-ring" data-testid="cross-countdown">
                  <svg width={136} height={136} viewBox="0 0 136 136">
                    <circle cx={68} cy={68} r={R} className="ring-bg" />
                    {planSec > 0 && <circle cx={68} cy={68} r={R} className={"ring-fg" + (left < 3 ? " warn" : "")} strokeDasharray={C} strokeDashoffset={C * frac} transform="rotate(-90 68 68)" />}
                  </svg>
                  <div className="ring-num num">{planSec > 0 ? Math.ceil(left) : left.toFixed(1)}</div>
                  <div className="ring-cap cap">Space to reveal</div>
                </div>
              )}
              {stage === "reveal" && target && (
                <div className="cross-reveal" data-testid="cross-reveal">
                  <div className="cap">
                    Optimal {COLOUR_NAMES[target.colour].toLowerCase()} cross · {target.length} move{target.length === 1 ? "" : "s"}
                    {colour < 0 && " · shortest colour"}
                  </div>
                  <div className="cross-sols">
                    {target.solutions.map((sol, i) => (
                      <button key={i} className={"cross-sol mono" + (i === shownSol ? " on" : "")} onClick={() => setShownSol(i)} data-testid="cross-solution">
                        {target.rotation && <span className="rot">{target.rotation}</span>} {sol || "already solved"}
                      </button>
                    ))}
                  </div>
                  <div className="cross-mark">
                    <span className="dim">Did your plan work?</span>
                    <button className="chip good-chip" onClick={() => record(true)} data-testid="cross-yes">
                      Yes, planned it <span className="kbd">Y</span>
                    </button>
                    <button className="chip bad-chip" onClick={() => record(false)} data-testid="cross-no">
                      No <span className="kbd">N</span>
                    </button>
                    <button className="btn sm ghost" onClick={load}>
                      Skip <span className="kbd">Space</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="cross-3d">
              {stage === "reveal" && target && <AlgPlayer alg={target.solutions[shownSol] ?? ""} setup={`${scramble} ${target.rotation}`} anchor="start" size={200} autoplay />}
            </div>
          </div>
          {stage === "reveal" && (
            <div className="cross-allc" data-testid="cross-all-colours">
              {all.map((x) => (
                <div key={x.colour} className={"cac" + (x.length === best ? " best" : "") + (target?.colour === x.colour ? " cur" : "")}>
                  <i className="sw" style={{ background: colours[x.colour] }} />
                  <span>{COLOUR_NAMES[x.colour]}</span>
                  <b className="num">{x.length}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <aside className="tr-side">
        <div className="glass-edge tr-panel">
          <div className="cap">Cross planning</div>
          <div className="tr-stats3">
            <Stat label="Success" value={Number.isFinite(rate) ? Math.round(rate * 100) + "%" : "–"} sub={`last ${last20.length}`} accent={rate >= 0.8} />
            <Stat label="Planned" value={hist.length} sub="all time" />
            <Stat label="Avg optimal" value={Number.isFinite(avgOpt) ? avgOpt.toFixed(1) : "–"} sub="moves" />
          </div>
        </div>
        <div className="glass-edge tr-panel">
          <div className="cap">Recent</div>
          {hist.length ? (
            <div className="cross-hist">
              {hist
                .slice(-10)
                .reverse()
                .map((r) => (
                  <div key={r.at} className="ch-row">
                    <i className="sw" style={{ background: colours[r.colour] }} />
                    <span className="num">{r.optimal} moves</span>
                    <span className="dim num">{(r.planMs / 1000).toFixed(1)}s</span>
                    <span className={r.ok ? "good" : "bad"}>{r.ok ? "✓" : "✗"}</span>
                  </div>
                ))}
            </div>
          ) : (
            <div className="dim tr-small">Plan the cross during inspection, then compare with the optimal solution. Mark honestly whether your plan worked.</div>
          )}
        </div>
        <div className="glass-edge tr-panel">
          <div className="cap">How it works</div>
          <p className="dim tr-small">
            Optimal solutions come from a breadth-first search over all 190 080 states of the four cross edges (at most 8 moves). They are written for holding the cross on the bottom: do the rotation, then the moves.
          </p>
        </div>
      </aside>
    </div>
  );
}
