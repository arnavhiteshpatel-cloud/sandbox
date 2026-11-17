import { useMemo, useState } from "react";
import { useTrain } from "../../data/trainStore";
import { casesOfSet, groupsOf, shortName } from "../../core/train/cases";
import { allStats } from "../../core/train/caseStats";
import type { LearnStatus } from "../../core/train/types";
import type { AlgCase } from "../../core/algs";
import { Menu, Modal, Seg, useMenu, confirmDialog } from "../../ui/Overlay";
import { IconPlus, IconSearch } from "../../ui/icons";
import { RefDiagram, heat } from "./diagram";
import { useTrainNav } from "./common";

const STATUS_LABEL: Record<LearnStatus, string> = { none: "Not started", learning: "Learning", learned: "Learned" };

export function preferredAlg(c: AlgCase, cu?: { preferred?: string; custom?: string[] }) {
  const all = [...c.algs, ...(cu?.custom ?? [])];
  return cu?.preferred && all.includes(cu.preferred) ? cu.preferred : c.algs[0];
}

export function Library() {
  const s = useTrain((t) => t.s);
  const setPref = useTrain((t) => t.setPref);
  const setOpenCase = useTrainNav((n) => n.setOpenCase);
  const setAdhoc = useTrainNav((n) => n.setAdhoc);
  const set = s.prefs.libSet;
  const [status, setStatus] = useState<"all" | LearnStatus>("all");
  const [col, setCol] = useState<string>("");
  const [q, setQ] = useState("");
  const [newCol, setNewCol] = useState<null | { id?: string; name: string }>(null);
  const cases = useMemo(() => casesOfSet(set), [set]);
  const stats = useMemo(() => allStats(s, cases.map((c) => c.id)), [s, cases]);
  const collection = s.collections.find((c) => c.id === col);
  const filtered = cases.filter((c) => {
    const st = s.cases[c.id]?.status ?? "none";
    if (status !== "all" && st !== status) return false;
    if (collection && !collection.caseIds.includes(c.id)) return false;
    if (q) {
      const needle = q.toLowerCase().replace(/\s+/g, "");
      const hay = (c.name + " " + c.group + " " + shortName(c) + " " + (s.cases[c.id]?.notes ?? "")).toLowerCase().replace(/\s+/g, "");
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  const counts = { learned: 0, learning: 0 };
  for (const c of cases) {
    const st = s.cases[c.id]?.status;
    if (st === "learned") counts.learned++;
    else if (st === "learning") counts.learning++;
  }
  const colMenu = useMenu();
  const train = (key: string) => {
    const st = useTrain.getState();
    st.setPref("drillSet", key);
    st.setPref("tab", "drill");
  };

  return (
    <div className="lib" data-testid="library">
      <div className="tr-toolbar">
        <Seg value={set} options={[{ v: "PLL", label: "PLL · 21" }, { v: "OLL", label: "OLL · 57" }]} onChange={(v) => setPref("libSet", v)} />
        <Seg
          value={status}
          options={[
            { v: "all", label: "All" },
            { v: "none", label: "Not started" },
            { v: "learning", label: "Learning" },
            { v: "learned", label: "Learned" },
          ]}
          onChange={setStatus}
        />
        <label className="tr-search">
          <IconSearch size={14} />
          <input className="input" placeholder="Search name, group, notes" value={q} onChange={(e) => setQ(e.target.value)} data-testid="lib-search" />
        </label>
        <div className="grow" />
        <div className="lib-progress" title={`${counts.learned} learned, ${counts.learning} learning of ${cases.length}`}>
          <span className="cap">
            <b className="num">{counts.learned}</b>/{cases.length} learned · <b className="num">{counts.learning}</b> learning
          </span>
          <div className="bar">
            <i style={{ width: (counts.learned / cases.length) * 100 + "%" }} />
            <i className="lrn" style={{ width: (counts.learning / cases.length) * 100 + "%" }} />
          </div>
        </div>
      </div>

      <div className="lib-cols">
        <span className="cap">Collections</span>
        <button className={"chip" + (!col ? " on" : "")} onClick={() => setCol("")}>
          All cases
        </button>
        {s.collections.map((c) => (
          <span key={c.id} className="col-chip">
            <button className={"chip" + (col === c.id ? " on" : "")} onClick={() => setCol(col === c.id ? "" : c.id)} onContextMenu={(e) => (e.preventDefault(), setCol(c.id), colMenu.open(e))} data-testid="collection-chip">
              {c.name} <span className="num dim">{c.caseIds.length}</span>
            </button>
          </span>
        ))}
        <button className="chip ghost-chip" onClick={() => setNewCol({ name: "" })} data-testid="new-collection">
          <IconPlus size={13} /> New collection
        </button>
        {collection && (
          <span className="col-actions">
            <button className="btn sm" onClick={() => train("col:" + collection.id)} disabled={!collection.caseIds.length}>
              Drill
            </button>
            <button
              className="btn sm"
              onClick={() => {
                useTrain.getState().setPref("recogSet", "col:" + collection.id);
                useTrain.getState().setPref("tab", "recognition");
              }}
              disabled={!collection.caseIds.length}
            >
              Recognise
            </button>
            <button className="btn sm ghost" onClick={(e) => colMenu.open(e)}>
              ···
            </button>
          </span>
        )}
      </div>
      {colMenu.anchor && collection && (
        <Menu
          anchor={colMenu.anchor}
          onClose={colMenu.close}
          items={[
            { label: "Rename…", onSelect: () => setNewCol({ id: collection.id, name: collection.name }) },
            {
              label: `Add all ${cases.length} ${set} cases`,
              onSelect: () => {
                const st = useTrain.getState();
                for (const c of cases) if (!collection.caseIds.includes(c.id)) st.toggleInCollection(collection.id, c.id);
              },
            },
            { sep: true },
            {
              label: "Delete collection",
              danger: true,
              onSelect: () => {
                if (confirmDialog(`Delete the collection "${collection.name}"? Cases and their statistics are kept.`)) {
                  useTrain.getState().deleteCollection(collection.id);
                  setCol("");
                }
              },
            },
          ]}
        />
      )}
      {collection && !collection.caseIds.length && <div className="tr-note">This collection is empty — open a case and tick “{collection.name}” under Collections to add it.</div>}

      <div className="lib-groups">
      {groupsOf(filtered).map((g) => (
        <section key={g.group} className="lib-sec">
          <h2 className="section-title">
            {g.group} <span className="num">{g.cases.length}</span>
          </h2>
          <div className="lib-grid">
            {g.cases.map((c) => {
              const cu = s.cases[c.id];
              const st = cu?.status ?? "none";
              const m = stats.get(c.id)!.mastery;
              return (
                <button key={c.id} className={"lib-card glass-lite st-" + st} onClick={() => setOpenCase(c.id)} data-testid={"case-" + c.id}>
                  <div className="lc-top">
                    <span className="lc-name">{c.set === "PLL" ? shortName(c) : "OLL " + shortName(c)}</span>
                    <span className={"lc-status " + st} title={STATUS_LABEL[st]} />
                  </div>
                  <div className="lc-dia">
                    <RefDiagram c={c} size={92} />
                  </div>
                  <div className="lc-alg mono">{preferredAlg(c, cu)}</div>
                  <div className="lc-mastery" title={m == null ? "No practice data yet" : `Mastery ${Math.round(m * 100)}%`}>
                    <i style={{ width: m == null ? 0 : Math.max(6, m * 100) + "%", background: heat(m) }} />
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      </div>
      {!filtered.length && <div className="tr-empty">No cases match these filters.</div>}
      <div className="tr-foot-actions">
        <button
          className="btn sm"
          onClick={() => {
            setAdhoc({ label: `Shown ${set} cases`, ids: filtered.map((c) => c.id) });
            train("adhoc");
          }}
          disabled={!filtered.length}
        >
          Drill the {filtered.length} shown cases
        </button>
      </div>

      {newCol && (
        <Modal
          title={newCol.id ? "Rename collection" : "New collection"}
          onClose={() => setNewCol(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setNewCol(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={!newCol.name.trim()}
                data-testid="collection-save"
                onClick={() => {
                  const name = newCol.name.trim();
                  if (!name) return;
                  if (newCol.id) useTrain.getState().renameCollection(newCol.id, name);
                  else setCol(useTrain.getState().createCollection(name));
                  setNewCol(null);
                }}
              >
                {newCol.id ? "Rename" : "Create"}
              </button>
            </>
          }
        >
          <div className="field">
            <label>Name</label>
            <input
              className="input"
              autoFocus
              value={newCol.name}
              placeholder="e.g. 2-look OLL, weak PLLs"
              onChange={(e) => setNewCol({ ...newCol, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newCol.name.trim()) {
                  if (newCol.id) useTrain.getState().renameCollection(newCol.id, newCol.name.trim());
                  else setCol(useTrain.getState().createCollection(newCol.name.trim()));
                  setNewCol(null);
                }
              }}
              data-testid="collection-name"
            />
          </div>
          {!newCol.id && <p className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>Add cases from each case’s detail view, or add a whole set from the collection’s ··· menu.</p>}
        </Modal>
      )}
    </div>
  );
}

export { STATUS_LABEL };
