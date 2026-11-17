import { useMemo, useState } from "react";
import { liveSessions, sessionSolves, useStore } from "../data/store";
import { EVENTS, getEvent } from "../core/events";
import { fmtAvg, fmtDate, fmtSingle, solveValue } from "../core/time";
import { bestOf, rollingAverage, summarize } from "../core/stats";
import { exportSessionCsv } from "../core/exporter";
import { Menu, Modal, Seg, useMenu, confirmDialog } from "../ui/Overlay";
import { IconPlus } from "../ui/icons";
import type { Session } from "../core/types";

export default function SessionsView() {
  const sessions = useStore((s) => s.sessions);
  const solves = useStore((s) => s.solves);
  const current = useStore((s) => s.currentSessionId);
  const st = useStore.getState;
  const d = useStore((s) => s.settings.decimals);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"rank" | "name" | "count" | "recent">("rank");
  const [merge, setMerge] = useState(false);
  const [split, setSplit] = useState<Session | null>(null);
  const live = liveSessions(sessions);

  const info = useMemo(() => {
    const m = new Map<string, { n: number; mean: number; best: number; ao100: number; first: number | null; last: number | null }>();
    for (const s of live) {
      const list = sessionSolves(solves, s.id);
      const vals = list.map((x) => solveValue(x, d));
      const sum = summarize(vals);
      const ao = list.length >= 100 ? bestOf(rollingAverage(vals, { n: 100 }).avg).value : NaN;
      const dates = list.map((x) => x.date).filter((x): x is number => x != null);
      m.set(s.id, { n: list.length, mean: sum.mean, best: sum.best, ao100: ao, first: dates.length ? Math.min(...dates) : null, last: dates.length ? Math.max(...dates) : null });
    }
    return m;
  }, [sessions, solves, d]); // eslint-disable-line react-hooks/exhaustive-deps

  const ordered = [...live].sort((a, b) => {
    if (sortBy === "name") return a.name.localeCompare(b.name, undefined, { numeric: true });
    if (sortBy === "count") return (info.get(b.id)?.n ?? 0) - (info.get(a.id)?.n ?? 0);
    if (sortBy === "recent") return (info.get(b.id)?.last ?? 0) - (info.get(a.id)?.last ?? 0);
    return a.rank - b.rank;
  });
  const move = (id: string, dir: -1 | 1) => {
    const ids = live.map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    st().reorderSessions(ids);
  };

  return (
    <div className="page">
      <div className="row-between" style={{ alignItems: "flex-end", marginBottom: 16 }}>
        <div>
          <h1 className="page-title">Sessions</h1>
          <p className="page-sub" style={{ margin: 0 }}>{live.length} sessions · {[...info.values()].reduce((a, b) => a + b.n, 0).toLocaleString()} solves</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Seg value={sortBy} options={[{ v: "rank", label: "Custom" }, { v: "name", label: "Name" }, { v: "count", label: "Size" }, { v: "recent", label: "Recent" }]} onChange={setSortBy} />
          {sel.size >= 2 && <button className="btn" onClick={() => setMerge(true)} data-testid="merge-open">Merge {sel.size}…</button>}
          <button className="btn primary" onClick={() => { const n = window.prompt("Session name", `Session ${live.length + 1}`); if (n) st().createSession({ name: n.trim() }); }} data-testid="create-session"><IconPlus size={14} /> New session</button>
        </div>
      </div>
      <div className="ses-grid">
        {ordered.map((s) => {
          const i = info.get(s.id)!;
          return (
            <SessionCard key={s.id} s={s} i={i} d={d} current={s.id === current} selected={sel.has(s.id)}
              onSelect={(v) => { const n = new Set(sel); v ? n.add(s.id) : n.delete(s.id); setSel(n); }}
              onMove={sortBy === "rank" ? move : undefined} onSplit={() => setSplit(s)} />
          );
        })}
      </div>
      {merge && <MergeDialog ids={[...sel]} onClose={() => { setMerge(false); setSel(new Set()); }} />}
      {split && <SplitDialog s={split} onClose={() => setSplit(null)} />}
    </div>
  );
}

function SessionCard({ s, i, d, current, selected, onSelect, onMove, onSplit }: {
  s: Session; i: { n: number; mean: number; best: number; ao100: number; first: number | null; last: number | null }; d: number; current: boolean; selected: boolean;
  onSelect: (v: boolean) => void; onMove?: (id: string, dir: -1 | 1) => void; onSplit: () => void;
}) {
  const st = useStore.getState;
  const menu = useMenu();
  const evMenu = useMenu();
  return (
    <div className={"glass-edge ses-card" + (current ? " current" : "") + (selected ? " selected" : "")} data-testid="session-card">
      <div className="row-between">
        <label style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
          <span className="ses-name" title={s.name}>{s.name}</span>
        </label>
        <div style={{ display: "flex", gap: 2 }}>
          {onMove && <button className="btn sm ghost" onClick={() => onMove(s.id, -1)} title="Move up">↑</button>}
          {onMove && <button className="btn sm ghost" onClick={() => onMove(s.id, 1)} title="Move down">↓</button>}
          <button className="btn sm ghost" onClick={menu.open} data-testid="session-menu">•••</button>
        </div>
      </div>
      <button className="cap ev" onClick={evMenu.open}>{getEvent(s.event).name}{s.phases > 1 ? ` · ${s.phases} phases` : ""}</button>
      <div className="ses-stats num">
        <div><span className="cap">solves</span><b>{i.n.toLocaleString()}</b></div>
        <div><span className="cap">mean</span><b>{fmtAvg(i.mean, d)}</b></div>
        <div><span className="cap">best</span><b>{Number.isFinite(i.best) ? fmtSingle(i.best, d) : "–"}</b></div>
        <div><span className="cap">best ao100</span><b>{Number.isFinite(i.ao100) ? fmtAvg(i.ao100, d) : "–"}</b></div>
      </div>
      <div className="dim" style={{ fontSize: 11.5 }}>{i.first ? `${fmtDate(i.first, false)} → ${fmtDate(i.last, false)}` : "no dated solves"}{s.importId ? " · imported" : ""}</div>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button className="btn sm" onClick={() => { st().setCurrentSession(s.id); st().setView("timer"); }}>{current ? "Current" : "Open"}</button>
      </div>
      {menu.anchor && (
        <Menu anchor={menu.anchor} onClose={menu.close} items={[
          { label: "Rename…", onSelect: () => { const n = window.prompt("Rename session", s.name); if (n && n.trim()) st().updateSession(s.id, { name: n.trim() }, "Rename session"); } },
          { label: "Phases (multi-phase timing)…", onSelect: () => { const n = window.prompt("Number of phases per solve (1 = normal)", String(s.phases)); if (n && +n >= 1 && +n <= 10) st().updateSession(s.id, { phases: Math.round(+n) }, "Set phases"); } },
          { label: "Split…", onSelect: onSplit },
          { label: "Export CSV…", onSelect: () => st().backend!.saveTextFile(`${s.name}.csv`, exportSessionCsv(s, st().solves, d), [{ name: "CSV", extensions: ["csv"] }]) },
          { sep: true },
          { label: "Delete session", danger: true, onSelect: () => { if (confirmDialog(`Delete "${s.name}" and its ${i.n.toLocaleString()} solves? You can undo with ⌘Z.`)) st().deleteSession(s.id); } },
        ]} />
      )}
      {evMenu.anchor && (
        <Menu anchor={evMenu.anchor} onClose={evMenu.close} items={EVENTS.map((e) => ({ label: e.name, meta: e.group, selected: e.id === s.event, onSelect: () => st().updateSession(s.id, { event: e.id }, "Change scramble type") }))} />
      )}
    </div>
  );
}

function MergeDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const [target, setTarget] = useState(ids[0]);
  const [mode, setMode] = useState<"chronological" | "append">("chronological");
  const names = ids.map((id) => sessions.find((s) => s.id === id)!);
  return (
    <Modal title="Merge sessions" onClose={onClose} testId="merge-dialog" footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => { useStore.getState().mergeSessions(ids, target, mode); onClose(); }} data-testid="merge-confirm">Merge</button></>}>
      <div className="field" style={{ marginBottom: 14 }}>
        <label>Keep this session (others are merged into it and removed)</label>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          {names.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Order</label>
        <Seg value={mode} options={[{ v: "chronological", label: "By date" }, { v: "append", label: "Append in order" }]} onChange={setMode} />
      </div>
      <p className="dim" style={{ fontSize: 12.5 }}>No solves are lost; undo with ⌘Z.</p>
    </Modal>
  );
}

function SplitDialog({ s, onClose }: { s: Session; onClose: () => void }) {
  const solves = useStore((x) => x.solves);
  const list = sessionSolves(solves, s.id);
  const [at, setAt] = useState(Math.max(1, Math.floor(list.length / 2)));
  const [name, setName] = useState(`${s.name} (2)`);
  return (
    <Modal title={`Split "${s.name}"`} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={at < 1 || at >= list.length} onClick={() => { useStore.getState().splitSession(s.id, at, name); onClose(); }}>Split</button></>}>
      <div className="field" style={{ marginBottom: 12 }}>
        <label>Solves from #{at + 1} onward ({(list.length - at).toLocaleString()} solves) move to a new session</label>
        <input type="range" min={1} max={Math.max(1, list.length - 1)} value={at} onChange={(e) => setAt(+e.target.value)} style={{ width: "100%" }} />
        <div className="dim num" style={{ fontSize: 12 }}>Split before solve #{at + 1} · {fmtDate(list[at]?.date ?? null)}</div>
      </div>
      <div className="field">
        <label>New session name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
    </Modal>
  );
}
