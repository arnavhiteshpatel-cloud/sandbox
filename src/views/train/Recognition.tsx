import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTrain } from "../../data/trainStore";
import { AUFS, caseView, getCase, groupsOf, shortName } from "../../core/train/cases";
import { pickWeighted, recogWeights } from "../../core/train/select";
import { allStats } from "../../core/train/caseStats";
import { Seg } from "../../ui/Overlay";
import { IsoLL, LLDiagram, RefDiagram } from "./diagram";
import { ADHOC, Empty, HeatGrid, HeatLegend, SetPicker, Stat, sec, useSetIds, useTrainNav } from "./common";
import { preferredAlg } from "./Library";

interface Q {
  id: string;
  pre: string;
  post: string;
  shownAt: number;
}

const rnd = (n: number) => Math.floor(Math.random() * n);

/** Match typed text against a case in the set: "ua", "Ua perm", "21", "oll 21". */
function matchAnswer(text: string, ids: string[]): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "").replace(/perm$/, "").replace(/^oll/, "").replace(/^pll-?/, "");
  if (!t) return null;
  for (const id of ids) {
    const c = getCase(id)!;
    if (shortName(c).toLowerCase() === t) return id;
  }
  return null;
}

export function Recognition() {
  const s = useTrain((t) => t.s);
  const setPref = useTrain((t) => t.setPref);
  const setOpenCase = useTrainNav((n) => n.setOpenCase);
  const key = s.prefs.recogSet;
  const mode = s.prefs.recogMode;
  const ids = useSetIds(key);
  const [q, setQ] = useState<Q | null>(null);
  const [answer, setAnswer] = useState<{ given: string | null; ok: boolean; ms: number } | null>(null);
  const [text, setText] = useState("");
  const [session, setSession] = useState<{ n: number; ok: number; ms: number[] }>({ n: 0, ok: 0, ms: [] });
  const input = useRef<HTMLInputElement>(null);
  const lastId = useRef<string | null>(null);
  const qRef = useRef<Q | null>(null);
  qRef.current = q;

  const next = useCallback(() => {
    if (!ids.length) {
      setQ(null);
      return;
    }
    const w = recogWeights(useTrain.getState().s, ids, lastId.current);
    const p = pickWeighted(w)!;
    lastId.current = p.id;
    setQ({ id: p.id, pre: AUFS[rnd(4)], post: AUFS[rnd(4)], shownAt: performance.now() });
    setAnswer(null);
    setText("");
    setTimeout(() => input.current?.focus(), 0);
  }, [ids]);

  useEffect(() => {
    next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ids.length]);

  const submit = (id: string | null) => {
    if (!q || answer) return;
    const ms = Math.round(performance.now() - q.shownAt);
    const ok = id === q.id;
    useTrain.getState().recordRecog(q.id, ms, ok, id ? shortName(getCase(id)!) : undefined);
    setAnswer({ given: id, ok, ms });
    setSession((x) => ({ n: x.n + 1, ok: x.ok + (ok ? 1 : 0), ms: ok ? [...x.ms, ms] : x.ms }));
    if (ok)
      setTimeout(() => {
        if (qRef.current === q) next();
      }, 650);
  };

  // keyboard: Enter submits typed text / continues after a wrong answer, Esc clears
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // the Enter that submitted the answer reaches window after React already re-rendered
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (answer && !answer.ok && (e.key === "Enter" || e.code === "Space")) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [answer, next]);

  const set = q ? getCase(q.id)!.set : key === "OLL" ? "OLL" : "PLL";
  const view = useMemo(() => (q ? caseView(getCase(q.id)!.algs[0], q.pre, q.post) : null), [q]);
  const stats = useMemo(() => allStats(s, ids), [s, ids]);
  const worst = [...ids]
    .map((id) => stats.get(id)!)
    .filter((x) => x.recogCount > 0 && (x.recogAcc < 0.95 || x.recogMs > 1500))
    .sort((a, b) => a.recogAcc - b.recogAcc || b.recogMs - a.recogMs)
    .slice(0, 8);
  const mixed = new Set(ids.map((id) => getCase(id)!.set)).size > 1;
  const choices = groupsOf(ids.map((id) => getCase(id)!));

  return (
    <div className="tr-grid" data-testid="recognition">
      <div className="tr-main">
        <div className="tr-toolbar">
          <SetPicker value={key} onChange={(k) => setPref("recogSet", k)} testId="recog-set" />
          <Seg
            value={mode}
            options={[
              { v: "full", label: "Top-down" },
              { v: "2side", label: "2-side" },
            ]}
            onChange={(v) => setPref("recogMode", v)}
          />
          <div className="grow" />
          <span className="cap dim">{mode === "2side" ? "Corner view: only the front and right sides are visible" : "Random U angle every time"}</span>
        </div>
        <div className="tr-stage glass-edge recog-stage">
          {!ids.length ? (
            <Empty>{key === ADHOC ? "This list is empty." : "This set has no cases yet — pick another set or add cases to it in the Library."}</Empty>
          ) : (
            q &&
            view && (
              <>
                <div className={"recog-dia" + (answer ? (answer.ok ? " ok" : " wrong") : "")} data-testid="recog-diagram">
                  {mode === "2side" ? <IsoLL view={view} size={250} mode={set === "OLL" ? "oll" : "pll"} /> : <LLDiagram view={view} size={236} mode={set === "OLL" ? "oll" : "pll"} />}
                </div>
                <div className="recog-feedback" data-testid="recog-feedback">
                  {!answer && <span className="cap">Which case is this?</span>}
                  {answer?.ok && (
                    <span className="good">
                      ✓ {getCase(q.id)!.name} <span className="num dim">· {sec(answer.ms)}</span>
                    </span>
                  )}
                  {answer && !answer.ok && (
                    <span className="bad">
                      ✗ {answer.given ? `Not ${getCase(answer.given)!.name} — ` : ""}it’s <b>{getCase(q.id)!.name}</b>
                    </span>
                  )}
                </div>
                {answer && !answer.ok && (
                  <div className="recog-reveal">
                    <RefDiagram c={getCase(q.id)!} size={84} />
                    <div>
                      <div className="mono">{preferredAlg(getCase(q.id)!, s.cases[q.id])}</div>
                      <div className="cap" style={{ marginTop: 8 }}>
                        <span className="kbd">Enter</span> next
                      </div>
                    </div>
                    {answer.given && (
                      <div className="recog-vs">
                        <span className="cap">You said</span>
                        <RefDiagram c={getCase(answer.given)!} size={64} />
                      </div>
                    )}
                  </div>
                )}
                <div className="recog-input">
                  <input
                    ref={input}
                    className="input"
                    placeholder={set === "OLL" && !mixed ? "Type the OLL number, Enter" : "Type the name (Ua, T, Gc…), Enter"}
                    value={text}
                    disabled={!!answer}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const m = matchAnswer(text, ids);
                        if (m || text.trim()) submit(m);
                      } else if (e.key === "Escape") setText("");
                    }}
                    data-testid="recog-input"
                  />
                </div>
                <div className={"recog-choices" + (set === "OLL" ? " oll" : "")}>
                  {choices.map((g) => (
                    <div key={g.group} className="rc-group">
                      {g.cases.map((c) => (
                        <button key={c.id} className="chip" disabled={!!answer} onClick={() => submit(c.id)} title={c.name} data-testid={"ans-" + c.id}>
                          {shortName(c)}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            )
          )}
        </div>
      </div>
      <aside className="tr-side">
        <div className="glass-edge tr-panel">
          <div className="cap">This session</div>
          <div className="tr-stats3">
            <Stat label="Answered" value={session.n} testId="recog-n" />
            <Stat label="Accuracy" value={session.n ? Math.round((session.ok / session.n) * 100) + "%" : "–"} accent={session.n > 0 && session.ok === session.n} />
            <Stat label="Mean" value={session.ms.length ? sec(session.ms.reduce((a, b) => a + b, 0) / session.ms.length) : "–"} sub="correct only" />
          </div>
        </div>
        <div className="glass-edge tr-panel">
          <div className="row-between">
            <span className="cap">Needs work · last 20 each</span>
          </div>
          {worst.length ? (
            <table className="tbl tr-tbl">
              <thead>
                <tr>
                  <th>Case</th>
                  <th className="r">Acc</th>
                  <th className="r">Time</th>
                  <th className="r">n</th>
                </tr>
              </thead>
              <tbody>
                {worst.map((w) => (
                  <tr key={w.id} className="click" onClick={() => setOpenCase(w.id)}>
                    <td>{getCase(w.id)!.name}</td>
                    <td className={"r " + (w.recogAcc < 0.8 ? "bad" : w.recogAcc < 1 ? "" : "good")}>{Math.round(w.recogAcc * 100)}%</td>
                    <td className="r">{sec(w.recogMs)}</td>
                    <td className="r dim">{w.recogCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dim tr-small">{stats.size && [...stats.values()].some((x) => x.recogCount) ? "Every case you have answered is above 95% and faster than 1.5 s." : "Answer a few cases to see accuracy and response time per case."}</div>
          )}
        </div>
        <div className="glass-edge tr-panel">
          <div className="cap">Mastery · {ids.length} cases</div>
          <HeatGrid ids={ids} onPick={setOpenCase} compact={ids.length > 30} />
          <HeatLegend />
        </div>
      </aside>
    </div>
  );
}
