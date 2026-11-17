import { useMemo, useState } from "react";
import { Modal } from "../../ui/Overlay";
import { IconCheck, IconPlus, IconTrash, IconCopy } from "../../ui/icons";
import { useTrain } from "../../data/trainStore";
import { useStore } from "../../data/store";
import { getCase, moveCount, playbackFor, shortName, validateAlg } from "../../core/train/cases";
import { caseStat, targetFor } from "../../core/train/caseStats";
import type { LearnStatus } from "../../core/train/types";
import { RefDiagram } from "./diagram";
import { AlgPlayer } from "./AlgPlayer";
import { preferredAlg, STATUS_LABEL } from "./Library";
import { sec, Spark, TrendBadge } from "./common";

export function CaseModal({ id, onClose }: { id: string; onClose: () => void }) {
  const c = getCase(id)!;
  const s = useTrain((t) => t.s);
  const t = useTrain.getState();
  const cu = s.cases[id] ?? {};
  const status = cu.status ?? "none";
  const pref = preferredAlg(c, cu);
  const [shown, setShown] = useState(pref);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState(cu.notes ?? "");
  const [newCol, setNewCol] = useState<string | null>(null);
  const st = useMemo(() => caseStat(id, s.drill[id], s.recog[id], s.srs[id], targetFor(s, id)), [s, id]);
  const all = [...c.algs.map((a) => ({ alg: a, custom: false })), ...(cu.custom ?? []).map((a) => ({ alg: a, custom: true }))];
  const toast = useStore((x) => x.toast);
  const pb = useMemo(() => playbackFor(c, shown), [c, shown]);

  const add = () => {
    const r = validateAlg(id, draft);
    if (!r.ok) {
      setErr(r.error ?? "Invalid algorithm.");
      return;
    }
    if (all.some((x) => x.alg === r.alg)) {
      setErr("This algorithm is already in the list.");
      return;
    }
    t.addCustomAlg(id, r.alg);
    setDraft("");
    setErr(null);
    setShown(r.alg);
    toast(`Added a verified algorithm for ${c.name}`, "success");
  };
  const saveNotes = () => {
    if ((cu.notes ?? "") !== notes) t.patchCase(id, { notes });
  };

  return (
    <Modal
      wide
      testId="case-modal"
      title={
        <span className="cm-title">
          {c.name} <span className="tag">{c.group}</span>
        </span>
      }
      onClose={() => {
        saveNotes();
        onClose();
      }}
    >
      <div className="cm">
        <div className="cm-left">
          <div className="cm-dia">
            <RefDiagram c={c} size={196} />
          </div>
          <AlgPlayer alg={pb.alg} setup={"z2 " + pb.setup} anchor="start" size={232} testId="case-player" />
          {pb.alg !== shown && <div className="cm-playing mono">with AUF: {pb.alg}</div>}
        </div>
        <div className="cm-right">
          <div className="cm-row">
            <span className="cap">Status</span>
            <div className="seg" data-testid="status-seg">
              {(["none", "learning", "learned"] as LearnStatus[]).map((v) => (
                <button key={v} className={status === v ? "on" : ""} onClick={() => t.setStatus(id, v)} data-testid={"status-" + v}>
                  <span className={"lc-status " + v} /> {STATUS_LABEL[v]}
                </button>
              ))}
            </div>
          </div>

          <div className="cap cm-h">Algorithms</div>
          <div className="cm-algs" data-testid="alg-list">
            {all.map(({ alg, custom }) => (
              <div key={alg} className={"cm-alg" + (alg === shown ? " shown" : "") + (alg === pref ? " pref" : "")} onClick={() => setShown(alg)}>
                <button
                  className={"star" + (alg === pref ? " on" : "")}
                  title={alg === pref ? "Preferred algorithm" : "Use as preferred"}
                  onClick={(e) => {
                    e.stopPropagation();
                    t.patchCase(id, { preferred: alg });
                  }}
                  data-testid="alg-prefer"
                >
                  {alg === pref ? <IconCheck size={13} /> : <span className="dotc" />}
                </button>
                <span className="mono a">{alg}</span>
                <span className="dim num mc">{moveCount(alg)}</span>
                {custom && <span className="tag">yours</span>}
                <button
                  className="ib sm"
                  title="Copy"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard?.writeText(alg).then(() => toast("Copied"), () => {});
                  }}
                >
                  <IconCopy size={13} />
                </button>
                {custom && (
                  <button
                    className="ib sm danger"
                    title="Remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      t.removeCustomAlg(id, alg);
                      if (shown === alg) setShown(c.algs[0]);
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="cm-add">
            <input
              className={"input mono" + (err ? " invalid" : "")}
              placeholder="Add your algorithm, e.g. (R U R' U') R' F R2 U' R' U' R U R' F'"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setErr(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && add()}
              data-testid="alg-input"
            />
            <button className="btn" onClick={add} disabled={!draft.trim()} data-testid="alg-add">
              <IconPlus size={14} /> Verify & add
            </button>
          </div>
          <div className={"cm-msg" + (err ? " bad" : "")} data-testid="alg-msg">
            {err ?? "Checked with the cube simulator: it must solve this case (OLL: orient the last layer) from any U angle, keeping F2L."}
          </div>

          <div className="cm-split">
            <div>
              <div className="cap cm-h">Notes</div>
              <textarea className="input cm-notes" rows={4} value={notes} placeholder="Fingertricks, recognition cues, regrips…" onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} data-testid="case-notes" />
            </div>
            <div>
              <div className="cap cm-h">Collections</div>
              <div className="cm-cols">
                {s.collections.map((col) => {
                  const on = col.caseIds.includes(id);
                  return (
                    <button key={col.id} className={"chip" + (on ? " on" : "")} onClick={() => t.toggleInCollection(col.id, id)} data-testid="case-collection">
                      {on && <IconCheck size={12} />} {col.name}
                    </button>
                  );
                })}
                {newCol == null ? (
                  <button className="chip" onClick={() => setNewCol("")} data-testid="case-new-collection">
                    <IconPlus size={12} /> New
                  </button>
                ) : (
                  <input
                    className="input cm-newcol"
                    autoFocus
                    placeholder="Name, Enter"
                    value={newCol}
                    onChange={(e) => setNewCol(e.target.value)}
                    onBlur={() => setNewCol(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newCol.trim()) {
                        t.createCollection(newCol.trim(), [id]);
                        setNewCol(null);
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setNewCol(null);
                      }
                    }}
                  />
                )}
              </div>
            </div>
          </div>

          <div className="cap cm-h">Your practice · {shortName(c)}</div>
          <div className="cm-stats">
            <div>
              <span className="cap">Drills</span>
              <b className="num">{st.count}</b>
            </div>
            <div>
              <span className="cap">Mean</span>
              <b className="num">{sec(st.mean)}</b>
            </div>
            <div>
              <span className="cap">Best</span>
              <b className="num">{sec(st.best)}</b>
            </div>
            <div>
              <span className="cap">Trend</span>
              <b className="num sm">
                <TrendBadge slope={st.trend} />
              </b>
            </div>
            <div>
              <span className="cap">Recognition</span>
              <b className="num">{st.recogCount ? Math.round(st.recogAcc * 100) + "%" : "–"}</b>
            </div>
            <div>
              <span className="cap">Next review</span>
              <b className="num sm">{st.card ? dueText(st.card.due) : "–"}</b>
            </div>
          </div>
          {(s.drill[id]?.length ?? 0) > 1 && (
            <div className="cm-spark">
              <Spark values={(s.drill[id] ?? []).slice(-30).map((r) => ({ ms: r.ms, bad: r.failed }))} width={520} height={34} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function dueText(due: number, now = Date.now()) {
  const d = due - now;
  if (d <= 0) return "due now";
  if (d < 3600_000) return `in ${Math.ceil(d / 60_000)} min`;
  if (d < 86_400_000) return `in ${Math.round(d / 3600_000)} h`;
  return `in ${Math.round(d / 86_400_000)} d`;
}
