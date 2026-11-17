import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTrain } from "../../data/trainStore";
import { getCase, shortName } from "../../core/train/cases";
import { drillWeights, pickWeighted, type Weighted } from "../../core/train/select";
import { caseStat, targetFor } from "../../core/train/caseStats";
import { scrambleForCase } from "../../scramble/scrambler";
import { Toggle } from "../../ui/Overlay";
import { RefDiagram } from "./diagram";
import { useTrainTimer, TimerFace, KeyHint } from "./timer";
import { tidyScramble, ADHOC, Empty, HeatGrid, HeatLegend, SetPicker, Spark, Stat, TrendBadge, sec, useSetIds, useTrainNav } from "./common";
import { preferredAlg } from "./Library";
import { dueText } from "./CaseModal";

interface Pending {
  id: string;
  reasons: string[];
  scramble: string | null;
  error?: string;
}

interface Result {
  id: string;
  ms: number;
  failed: boolean;
  scramble: string;
  reasons: string[];
}

export function Drill() {
  const s = useTrain((t) => t.s);
  const setPref = useTrain((t) => t.setPref);
  const setOpenCase = useTrainNav((n) => n.setOpenCase);
  const key = s.prefs.drillSet;
  const ids = useSetIds(key);
  const [cur, setCur] = useState<Pending | null>(null);
  const [last, setLast] = useState<Result | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [session, setSession] = useState<Result[]>([]);
  const lastId = useRef<string | null>(null);
  const gen = useRef(0);

  const draw = useCallback(() => {
    if (!ids.length) {
      setCur(null);
      return;
    }
    const w: Weighted[] = drillWeights(useTrain.getState().s, ids, Date.now(), lastId.current);
    const p = pickWeighted(w)!;
    lastId.current = p.id;
    const token = ++gen.current;
    setCur({ id: p.id, reasons: p.reasons, scramble: null });
    scrambleForCase(getCase(p.id)!.algs[0])
      .then((scr) => token === gen.current && setCur((c) => (c && c.id === p.id ? { ...c, scramble: tidyScramble(scr) } : c)))
      .catch((e) => token === gen.current && setCur((c) => (c ? { ...c, error: String(e?.message ?? e) } : c)));
  }, [ids]);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ids.join(",")]);

  const curRef = useRef(cur);
  curRef.current = cur;
  const timer = useTrainTimer({
    enabled: !!cur?.scramble,
    onSolve: (r) => {
      const c = curRef.current;
      if (!c) return;
      useTrain.getState().recordDrill(c.id, r.time, false);
      const res = { id: c.id, ms: r.time, failed: false, scramble: c.scramble ?? "", reasons: c.reasons };
      setLast(res);
      setSession((x) => [...x, res]);
      setFocus(c.id);
      draw();
    },
  });

  const lastRef = useRef(last);
  lastRef.current = last;
  const toggleFailed = useCallback(() => {
    const l = lastRef.current;
    if (!l) return;
    const failed = !l.failed;
    useTrain.getState().setLastFailed(failed);
    setLast({ ...l, failed });
    setSession((x) => x.map((r, i) => (i === x.length - 1 ? { ...r, failed } : r)));
  }, []);

  // shortcuts while idle: X = failed / needed help, N or → = skip this case
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (timer.engine.phase !== "idle" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "KeyX" && last) {
        e.preventDefault();
        toggleFailed();
      } else if (e.code === "KeyN" || e.code === "ArrowRight") {
        e.preventDefault();
        draw();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [timer.engine, last, toggleFailed, draw]);

  const running = timer.phase !== "idle" && timer.phase !== "done";
  const sesOk = session.filter((r) => !r.failed);
  const sesMean = sesOk.length ? sesOk.reduce((a, r) => a + r.ms, 0) / sesOk.length : NaN;
  const focusId = focus ?? ids[0];
  const fst = useMemo(() => (focusId && getCase(focusId) ? caseStat(focusId, s.drill[focusId], s.recog[focusId], s.srs[focusId], targetFor(s, focusId)) : null), [s, focusId]);
  const curCase = cur ? getCase(cur.id)! : null;
  const lastCase = last ? getCase(last.id)! : null;
  const set = curCase?.set ?? (key === "OLL" ? "OLL" : "PLL");
  const target = set === "OLL" ? s.prefs.targetOLL : s.prefs.targetPLL;

  return (
    <div className="tr-grid" data-testid="drill">
      <div className="tr-main">
        <div className="tr-toolbar fade-when-timing">
          <SetPicker value={key} onChange={(k) => setPref("drillSet", k)} testId="drill-set" />
          <label className="tr-inline">
            <Toggle on={s.prefs.drillShowCase} onChange={(v) => setPref("drillShowCase", v)} testId="drill-showcase" />
            <span>Show case first</span>
          </label>
          <label className="tr-inline" title="Executions at or under the target count as easy (grade 5) for spaced repetition; up to 1.5× as good (4)">
            <span className="dim">Target {set}</span>
            <input
              className="input num tr-num"
              type="number"
              step={0.1}
              min={0.5}
              max={20}
              value={(target / 1000).toFixed(1)}
              onChange={(e) => {
                const v = Math.round(parseFloat(e.target.value) * 1000);
                if (Number.isFinite(v) && v >= 500) setPref(set === "OLL" ? "targetOLL" : "targetPLL", v);
              }}
            />
            <span className="dim">s</span>
          </label>
          <div className="grow" />
          <button className="btn sm ghost" onClick={draw} disabled={!ids.length} title="Skip this case  N">
            Skip <span className="kbd">N</span>
          </button>
        </div>

        <div className={"tr-stage glass-edge drill-stage" + (running ? " running" : "")}>
          {!ids.length ? (
            <Empty>
              {key === "due" ? "Nothing is due — every drilled case is scheduled for later. Pick another set to keep practising." : key === "learning" ? "No cases are marked as learning. Mark some in the Library." : key === ADHOC ? "This list is empty." : "This set has no cases."}
            </Empty>
          ) : (
            <>
              <div className="drill-scr fade-when-timing" data-testid="drill-scramble">
                {cur?.scramble ? <span className="mono">{cur.scramble}</span> : cur?.error ? <span className="bad">{cur.error}</span> : <span className="dim">generating scramble…</span>}
              </div>
              {s.prefs.drillShowCase && curCase && (
                <div className="drill-preview fade-when-timing">
                  <RefDiagram c={curCase} size={88} />
                  <span className="cap">{curCase.name}</span>
                </div>
              )}
              <TimerFace timer={timer} value={last?.ms ?? null} testId="drill-timer" />
              <KeyHint phase={timer.phase} idle={cur?.scramble ? "hold space · solve the case · any key stops" : "waiting for scramble"} />
              {last && lastCase && !running && (
                <div className={"drill-result" + (last.failed ? " failed" : "")} data-testid="drill-result">
                  <RefDiagram c={lastCase} size={84} />
                  <div className="dr-info">
                    <div className="dr-name">
                      {lastCase.name}
                      <span className="num">{sec(last.ms)}</span>
                      {last.failed && <span className="tag err">failed</span>}
                    </div>
                    <div className="mono dr-alg">{preferredAlg(lastCase, s.cases[last.id])}</div>
                    {last.reasons.length > 0 && <div className="dr-why">Picked because: {last.reasons.join(" · ")}</div>}
                  </div>
                  <div className="dr-actions">
                    <button className={"chip" + (last.failed ? " on bad-on" : "")} onClick={toggleFailed} data-testid="drill-failed">
                      Failed / needed help <span className="kbd">X</span>
                    </button>
                    <button className="chip" onClick={() => setOpenCase(last.id)}>
                      Details
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="drill-session glass-edge fade-when-timing">
          <span className="cap">Session</span>
          <div className="ds-items">
            {session
              .slice(-16)
              .reverse()
              .map((r, i) => (
                <button key={session.length - i} className={"ds-item" + (r.failed ? " failed" : "")} onClick={() => setFocus(r.id)} title={getCase(r.id)!.name}>
                  <span className="n">{shortName(getCase(r.id)!)}</span>
                  <span className="num">{sec(r.ms)}</span>
                </button>
              ))}
            {!session.length && <span className="dim">Your executions in this session appear here.</span>}
          </div>
          <span className="num dim ds-sum">
            {session.length} · μ {sec(sesMean)}
          </span>
        </div>
      </div>

      <aside className="tr-side fade-when-timing">
        {fst && (
          <div className="glass-edge tr-panel" data-testid="drill-case-stats">
            <div className="row-between">
              <span className="cap">Case · {getCase(fst.id)!.name}</span>
              <button className="btn sm ghost" onClick={() => setOpenCase(fst.id)}>
                Open
              </button>
            </div>
            <div className="tr-stats3">
              <Stat label="Count" value={fst.count} />
              <Stat label="Mean" value={sec(fst.mean)} sub="last 12 ok" />
              <Stat label="Best" value={sec(fst.best)} accent />
            </div>
            <div className="dc-row">
              <span className="cap">Last 5</span>
              <span className="num dc-last">
                {fst.last5.length
                  ? fst.last5.map((v, i) => (
                      <span key={i} className={v < 0 ? "bad" : ""}>
                        {sec(Math.abs(v))}
                      </span>
                    ))
                  : "–"}
              </span>
            </div>
            <div className="dc-row">
              <span className="cap">Trend</span>
              <TrendBadge slope={fst.trend} />
            </div>
            <div className="dc-row">
              <span className="cap">Review</span>
              <span className="num">{fst.card ? `${dueText(fst.card.due)} · EF ${fst.card.ef.toFixed(2)}` : "not scheduled"}</span>
            </div>
            {(s.drill[fst.id]?.length ?? 0) > 1 && <Spark values={(s.drill[fst.id] ?? []).slice(-30).map((r) => ({ ms: r.ms, bad: r.failed }))} width={270} height={34} />}
          </div>
        )}
        <div className="glass-edge tr-panel">
          <div className="row-between">
            <span className="cap">Mastery · {ids.length} cases</span>
          </div>
          <HeatGrid ids={ids} onPick={setFocus} current={focusId} compact={ids.length > 30} />
          <HeatLegend />
        </div>
        <div className="glass-edge tr-panel">
          <div className="tr-stats3">
            <Stat label="Session" value={session.length} />
            <Stat label="Mean" value={sec(sesMean)} />
            <Stat label="Failed" value={session.filter((r) => r.failed).length} />
          </div>
        </div>
      </aside>
    </div>
  );
}
