import { useEffect, useState } from "react";
import { Modal, Seg } from "./Overlay";
import { liveSessions, sessionSolves, useStore } from "../data/store";
import { fmtDate, fmtSingle, fmtSolve } from "../core/time";
import { getEvent } from "../core/events";
import { ScrambleImage } from "./ScrambleImage";
import { IconCopy, IconTrash } from "./icons";

export function SolveSheet() {
  const id = useStore((s) => s.openSolveId);
  const close = useStore((s) => s.openSolve);
  const solve = useStore((s) => s.solves.find((x) => x.id === id));
  const all = useStore((s) => s.solves);
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const updateSolves = useStore((s) => s.updateSolves);
  const deleteSolves = useStore((s) => s.deleteSolves);
  const restoreSolves = useStore((s) => s.restoreSolves);
  const moveSolves = useStore((s) => s.moveSolves);
  const [comment, setComment] = useState(solve?.comment ?? "");
  useEffect(() => setComment(solve?.comment ?? ""), [solve?.id]); // eslint-disable-line
  if (!solve) return null;
  const d = settings.decimals;
  const list = sessionSolves(all, solve.sessionId);
  const idx = list.findIndex((s) => s.id === solve.id);
  const ses = sessions.find((s) => s.id === solve.sessionId);
  const saveComment = () => comment !== solve.comment && updateSolves([solve.id], () => ({ comment }), "Edit comment");
  const onClose = () => {
    saveComment();
    close(null);
  };
  const nav = (dir: number) => {
    saveComment();
    const n = list[idx + dir];
    if (n) close(n.id);
  };
  return (
    <Modal
      title={
        <span className="num">
          Solve {idx >= 0 ? `#${idx + 1}` : ""} <span className="dim" style={{ fontWeight: 400, marginLeft: 6 }}>{ses?.name}</span>
        </span>
      }
      onClose={onClose}
      testId="solve-sheet"
      footer={
        <>
          {solve.deletedAt ? (
            <button className="btn" onClick={() => restoreSolves([solve.id])}>Restore</button>
          ) : (
            <button className="btn danger" onClick={() => { deleteSolves([solve.id]); close(null); }} data-testid="delete-solve">
              <IconTrash size={14} /> Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn ghost" disabled={idx <= 0} onClick={() => nav(-1)}>‹ Prev</button>
          <button className="btn ghost" disabled={idx < 0 || idx >= list.length - 1} onClick={() => nav(1)}>Next ›</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </>
      }
    >
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div className="num" style={{ fontSize: 56, fontWeight: 450, letterSpacing: "-0.03em", lineHeight: 1 }} data-testid="sheet-time">
            {fmtSolve(solve, d, true)}
          </div>
          <div className="dim" style={{ marginTop: 6 }}>
            {fmtDate(solve.date)} · {getEvent(solve.event).name}
            {solve.importId ? " · imported" : ""}
          </div>
        </div>
        <Seg
          value={solve.penalty < 0 ? "dnf" : solve.penalty > 0 ? "p2" : "ok"}
          options={[
            { v: "ok", label: "OK" },
            { v: "p2", label: "+2" },
            { v: "dnf", label: "DNF" },
          ]}
          onChange={(v) => updateSolves([solve.id], () => ({ penalty: v === "dnf" ? -1 : v === "p2" ? 2000 : 0 }), "Change penalty")}
        />
      </div>
      {solve.splits && solve.splits.length > 1 && (
        <>
          <div className="section-title">Phases</div>
          <div style={{ display: "flex", gap: 18 }} className="num">
            {solve.splits.map((c, i) => (
              <div key={i}>
                <div className="dim" style={{ fontSize: 11.5 }}>P{i + 1}</div>
                <div style={{ fontSize: 17 }}>{fmtSingle(c - (i ? solve.splits![i - 1] : 0), d)}</div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="section-title" style={{ display: "flex", justifyContent: "space-between" }}>
        Scramble
        <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(solve.scramble)}>
          <IconCopy size={13} /> Copy
        </button>
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <div className="mono" style={{ flex: 1, fontSize: 15, lineHeight: 1.5, userSelect: "text" }}>{solve.scramble || <span className="dim">No scramble recorded</span>}</div>
        {solve.scramble && <ScrambleImage eventId={solve.event} scramble={solve.scramble} colors={settings.cubeColors} width={170} />}
      </div>
      <div className="section-title">Comment</div>
      <textarea className="input" rows={2} style={{ width: "100%" }} value={comment} onChange={(e) => setComment(e.target.value)} onBlur={saveComment} placeholder="Add a note…" data-testid="comment" />
      <div className="section-title">Date</div>
      <input
        className="input"
        type="datetime-local"
        style={{ width: "100%", colorScheme: "dark" }}
        value={solve.date ? new Date(solve.date - new Date(solve.date).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""}
        onChange={(e) => {
          const v = e.target.value ? new Date(e.target.value).getTime() : null;
          if (v === null || Number.isFinite(v)) updateSolves([solve.id], () => ({ date: v }), "Edit date");
        }}
      />
      <div className="section-title">Session</div>
      <select className="input" value={solve.sessionId} onChange={(e) => { moveSolves([solve.id], e.target.value); }} style={{ width: "100%" }}>
        {liveSessions(sessions).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      {solve.extra && (
        <div className="dim" style={{ fontSize: 12, marginTop: 12 }}>
          Extra data preserved from source: <span className="mono">{solve.extra.slice(0, 160)}</span>
        </div>
      )}
    </Modal>
  );
}
