import { useEffect, useMemo, useRef, useState } from "react";
import { liveSessions, useStore } from "../data/store";
import { fmtAvg, fmtDate, fmtSolve, parseTime, solveValue } from "../core/time";
import { rollingAverage, summarize } from "../core/stats";
import { getEvent } from "../core/events";
import type { Solve } from "../core/types";
import { Seg, Menu, useMenu, confirmDialog } from "../ui/Overlay";
import { IconSearch } from "../ui/icons";

const ROW = 34;

export default function HistoryView() {
  const allSolves = useStore((s) => s.solves);
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.currentSessionId);
  const settings = useStore((s) => s.settings);
  const openSolve = useStore((s) => s.openSolve);
  const updateSolves = useStore((s) => s.updateSolves);
  const deleteSolves = useStore((s) => s.deleteSolves);
  const restoreSolves = useStore((s) => s.restoreSolves);
  const moveSolves = useStore((s) => s.moveSolves);
  const d = settings.decimals;
  const [scope, setScope] = useState<string>(current);
  const [q, setQ] = useState("");
  const [pen, setPen] = useState<"all" | "ok" | "p2" | "dnf" | "comment">("all");
  const [minT, setMinT] = useState("");
  const [maxT, setMaxT] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<"new" | "old" | "fast" | "slow">("new");
  const [trash, setTrash] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const moveMenu = useMenu();
  const sesMap = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  // per-session index and ao5 for display (computed once per solves array)
  const meta = useMemo(() => {
    const m = new Map<string, { idx: number; ao5: number }>();
    const by = new Map<string, Solve[]>();
    for (const s of allSolves) if (!s.deletedAt) (by.get(s.sessionId) ?? by.set(s.sessionId, []).get(s.sessionId)!).push(s);
    for (const list of by.values()) {
      list.sort((a, b) => a.ord - b.ord);
      const ao5 = rollingAverage(list.map((s) => solveValue(s, d)), { n: 5 }, settings.trimPct).avg;
      list.forEach((s, i) => m.set(s.id, { idx: i + 1, ao5: ao5[i] }));
    }
    return m;
  }, [allSolves, d, settings.trimPct]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const lo = minT ? parseTime(minT)?.time ?? null : null;
    const hi = maxT ? parseTime(maxT)?.time ?? null : null;
    const f = from ? new Date(from + "T00:00").getTime() : null;
    const t = to ? new Date(to + "T23:59:59").getTime() : null;
    const out = allSolves.filter((s) => {
      if (trash ? !s.deletedAt : !!s.deletedAt) return false;
      if (scope !== "*" && s.sessionId !== scope) return false;
      if (pen === "ok" && s.penalty !== 0) return false;
      if (pen === "p2" && !(s.penalty > 0)) return false;
      if (pen === "dnf" && s.penalty >= 0) return false;
      if (pen === "comment" && !s.comment) return false;
      const v = s.penalty < 0 ? Infinity : s.time + s.penalty;
      if (lo != null && v < lo) return false;
      if (hi != null && v > hi) return false;
      if (f != null && (s.date == null || s.date < f)) return false;
      if (t != null && (s.date == null || s.date > t)) return false;
      if (ql && !(s.comment.toLowerCase().includes(ql) || s.scramble.toLowerCase().includes(ql) || (sesMap.get(s.sessionId)?.name.toLowerCase().includes(ql) ?? false))) return false;
      return true;
    });
    const key = (s: Solve) => (s.date ?? 0) * 1 + s.ord * 1e-6;
    if (sort === "new") out.sort((a, b) => key(b) - key(a) || b.ord - a.ord);
    else if (sort === "old") out.sort((a, b) => key(a) - key(b) || a.ord - b.ord);
    else {
      const v = (s: Solve) => solveValue(s, 3);
      out.sort((a, b) => (sort === "fast" ? v(a) - v(b) : v(b) - v(a)));
    }
    return out;
  }, [allSolves, scope, q, pen, minT, maxT, from, to, sort, trash, sesMap]);

  const summary = useMemo(() => summarize(filtered.map((s) => solveValue(s, d))), [filtered, d]);
  useEffect(() => setSel(new Set()), [scope, q, pen, minT, maxT, from, to, sort, trash]);

  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(600);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const last = Math.min(filtered.length, first + Math.ceil(h / ROW) + 10);

  const click = (i: number, e: React.MouseEvent) => {
    const id = filtered[i].id;
    if (e.shiftKey && anchor != null) {
      const n = new Set(sel);
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) n.add(filtered[k].id);
      setSel(n);
    } else if (e.metaKey || e.ctrlKey) {
      const n = new Set(sel);
      n.has(id) ? n.delete(id) : n.add(id);
      setSel(n);
      setAnchor(i);
    } else {
      openSolve(id);
      setAnchor(i);
    }
  };
  const selIds = [...sel];

  return (
    <div className="page history-page" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="row-between" style={{ alignItems: "flex-end", marginBottom: 14 }}>
        <div>
          <h1 className="page-title">History</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            <span className="num">{filtered.length.toLocaleString()}</span> solves · mean <span className="num">{fmtAvg(summary.mean, d)}</span> · median{" "}
            <span className="num">{fmtAvg(summary.median, d)}</span> · best <span className="num">{fmtAvg(summary.best, d)}</span> · σ{" "}
            <span className="num">{Number.isFinite(summary.sd) ? (summary.sd / 1000).toFixed(2) : "–"}</span>
          </p>
        </div>
        <Seg value={trash ? "trash" : "live"} options={[{ v: "live", label: "Solves" }, { v: "trash", label: "Recently deleted" }]} onChange={(v) => setTrash(v === "trash")} />
      </div>
      <div className="glass-edge filters">
        <div className="search">
          <IconSearch size={15} />
          <input placeholder="Search comments, scrambles, sessions…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="history-search" />
        </div>
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value)} data-testid="history-scope">
          <option value="*">All sessions</option>
          {liveSessions(sessions).map((s) => (
            <option key={s.id} value={s.id}>{s.name} · {getEvent(s.event).short}</option>
          ))}
        </select>
        <Seg value={pen} options={[{ v: "all", label: "All" }, { v: "ok", label: "OK" }, { v: "p2", label: "+2" }, { v: "dnf", label: "DNF" }, { v: "comment", label: "Notes" }]} onChange={setPen} />
        <input className="input" style={{ width: 74 }} placeholder="min s" value={minT} onChange={(e) => setMinT(e.target.value)} />
        <input className="input" style={{ width: 74 }} placeholder="max s" value={maxT} onChange={(e) => setMaxT(e.target.value)} />
        <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value as any)}>
          <option value="new">Newest</option>
          <option value="old">Oldest</option>
          <option value="fast">Fastest</option>
          <option value="slow">Slowest</option>
        </select>
      </div>
      {sel.size > 0 && (
        <div className="bulk">
          <span className="num">{sel.size.toLocaleString()} selected</span>
          {trash ? (
            <button className="btn sm" onClick={() => { restoreSolves(selIds); setSel(new Set()); }}>Restore</button>
          ) : (
            <>
              <button className="btn sm" onClick={() => updateSolves(selIds, () => ({ penalty: 0 }), "Set OK")}>OK</button>
              <button className="btn sm" onClick={() => updateSolves(selIds, () => ({ penalty: 2000 }), "Set +2")}>+2</button>
              <button className="btn sm" onClick={() => updateSolves(selIds, () => ({ penalty: -1 }), "Set DNF")}>DNF</button>
              <button className="btn sm" onClick={moveMenu.open}>Move to…</button>
              <button className="btn sm danger" onClick={() => { if (selIds.length < 20 || confirmDialog(`Delete ${selIds.length} solves? (You can undo with ⌘Z or restore from Recently deleted.)`)) { deleteSolves(selIds); setSel(new Set()); } }}>Delete</button>
            </>
          )}
          <button className="btn sm ghost" onClick={() => setSel(new Set(filtered.map((s) => s.id)))}>Select all {filtered.length.toLocaleString()}</button>
          <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button>
          {moveMenu.anchor && (
            <Menu anchor={moveMenu.anchor} onClose={moveMenu.close} items={liveSessions(sessions).map((s) => ({ label: s.name, meta: getEvent(s.event).short, onSelect: () => { moveSolves(selIds, s.id); setSel(new Set()); } }))} />
          )}
        </div>
      )}
      <div className="glass-edge hist-table">
        <div className="hrow head">
          <span>#</span>
          <span>Time</span>
          <span>ao5</span>
          <span>Session</span>
          <span>Date</span>
          <span>Scramble</span>
          <span>Comment</span>
        </div>
        <div className="hscroll" ref={scroller} onScroll={(e) => setTop(e.currentTarget.scrollTop)} data-testid="history-list">
          <div style={{ height: filtered.length * ROW, position: "relative" }}>
            {filtered.slice(first, last).map((s, k) => {
              const i = first + k;
              const m = meta.get(s.id);
              return (
                <div key={s.id} className={"hrow" + (sel.has(s.id) ? " sel" : "")} style={{ top: i * ROW }} onClick={(e) => click(i, e)} data-testid="history-row">
                  <span className="dim num">{m?.idx ?? "–"}</span>
                  <span className="num t">{fmtSolve(s, d)}</span>
                  <span className="num dim">{m && Number.isFinite(m.ao5) ? fmtAvg(m.ao5, d) : m && m.ao5 === Infinity ? "DNF" : "–"}</span>
                  <span className="dim ell">{sesMap.get(s.sessionId)?.name}</span>
                  <span className="dim num">{fmtDate(s.date)}</span>
                  <span className="mono dim ell scr">{s.scramble}</span>
                  <span className="ell">{s.comment}</span>
                </div>
              );
            })}
          </div>
          {!filtered.length && <div className="empty">No solves match these filters.</div>}
        </div>
      </div>
      <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>Click to open · ⌘-click to select · ⇧-click to select a range</div>
    </div>
  );
}
