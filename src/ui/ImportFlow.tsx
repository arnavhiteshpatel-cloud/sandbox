/**
 * Import wizard: pick file → parse & preview (nothing written) → commit in one transaction
 * (a safety backup is taken first) → verification report computed from the database.
 */
import { useMemo, useState } from "react";
import { Modal, Toggle } from "./Overlay";
import { useStore, sessionSolves } from "../data/store";
import { parseBackup, type ParsedBackup } from "../core/importer";
import { importRecordFor, planImport, type ImportPlan } from "../core/importPlan";
import { sha256Hex } from "../core/ids";
import { fmtAvg, fmtDate, solveValue } from "../core/time";
import { getEvent } from "../core/events";
import { summarize } from "../core/stats";

type Stage = "pick" | "preview" | "working" | "report" | "error";

interface VerifyRow {
  name: string;
  expected: number;
  stored: number;
  sourceMean: number;
  storedMean: number;
  ok: boolean;
}

export function ImportFlow({ onClose }: { onClose: () => void }) {
  const backend = useStore((s) => s.backend)!;
  const [stage, setStage] = useState<Stage>("pick");
  const [file, setFile] = useState<{ name: string; text: string; size: number; hash: string } | null>(null);
  const [parsed, setParsed] = useState<ParsedBackup | null>(null);
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [merge, setMerge] = useState(true);
  const [skipDup, setSkipDup] = useState(true);
  const [error, setError] = useState("");
  const [report, setReport] = useState<{ plan: ImportPlan; rows: VerifyRow[]; ok: boolean } | null>(null);

  const st = useStore.getState();
  const plan = useMemo(() => {
    if (!parsed) return null;
    return planImport(parsed, st.sessions, st.solves, { include, mergeMatching: merge, skipDuplicates: skipDup });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, include, merge, skipDup]);

  async function pick() {
    try {
      const f = await backend.pickOpenFile([{ name: "Timer backups", extensions: ["txt", "json", "csv"] }]);
      if (!f) return;
      const hash = await sha256Hex(f.text);
      const p = parseBackup(f.text, f.name);
      setFile({ ...f, hash });
      setParsed(p);
      setInclude(new Set(p.sessions.filter((s) => s.solves.length > 0).map((s) => s.key)));
      setStage("preview");
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setStage("error");
    }
  }

  async function commit() {
    if (!plan || !parsed || !file) return;
    setStage("working");
    try {
      const rec = importRecordFor(plan, file.name, parsed.format, file.hash, file.size, parsed.warnings);
      await backend.importCommit(rec, plan.sessions, plan.solves, file.text);
      // Remove the placeholder session created on first launch if it is still empty.
      {
        const s0 = useStore.getState();
        const placeholders = s0.sessions.filter((s) => (s.opt as any)?.autoCreated && !s.deletedAt && !s0.solves.some((x) => x.sessionId === s.id));
        if (placeholders.length) await backend.apply([{ t: "hardDeleteSessions", ids: placeholders.map((s) => s.id) }]);
      }
      await useStore.getState().reload();
      // Verify against what is actually stored in the database now.
      const data = await backend.load();
      const rows: VerifyRow[] = [];
      for (const p of plan.perSession) {
        const planned = plan.solves.filter((s) => s.sessionId === p.targetSessionId);
        const stored = data.solves.filter((s) => s.importId === plan.importId && s.sessionId === p.targetSessionId && !s.deletedAt);
        const sm = summarize(planned.map((x) => solveValue(x, 2))).mean;
        const dm = summarize(stored.map((x) => solveValue(x, 2))).mean;
        // compare full content fingerprints (time, penalty, splits, scramble, date) as multisets
        const count = new Map<string, number>();
        planned.forEach((s) => count.set(s.fp, (count.get(s.fp) ?? 0) + 1));
        stored.forEach((s) => count.set(s.fp, (count.get(s.fp) ?? 0) - 1));
        const fpOk = [...count.values()].every((v) => v === 0);
        rows.push({
          name: p.name,
          expected: planned.length,
          stored: stored.length,
          sourceMean: sm,
          storedMean: dm,
          ok: fpOk && stored.length === planned.length && planned.length === p.sourceSolves - p.duplicates,
        });
      }
      const ok = rows.every((r) => r.ok);
      setReport({ plan, rows, ok });
      setStage("report");
      const live = useStore.getState().sessions.find((s) => s.id === plan.perSession[0]?.targetSessionId);
      if (live) useStore.getState().setCurrentSession(live.id);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setStage("error");
    }
  }

  const reportText = () => {
    if (!report || !file || !parsed) return "";
    const lines = [
      `Facelet import report — ${new Date().toISOString()}`,
      `File: ${file.name} (${file.size.toLocaleString()} bytes, sha256 ${file.hash})`,
      `Format: ${parsed.format}`,
      `Source solves: ${report.plan.totals.source}; added: ${report.plan.totals.toAdd}; duplicates skipped: ${report.plan.totals.duplicates}; invalid: ${report.plan.totals.invalid}`,
      `Verification: ${report.ok ? "PASSED" : "FAILED"}`,
      "",
      ...report.plan.perSession.map((p, i) => {
        const r = report.rows[i];
        return `${p.name} [${p.event}] → ${p.target === "new" ? "new session" : "merged into " + p.targetName}: source ${p.sourceSolves}, added ${p.toAdd}, dup ${p.duplicates}, invalid ${p.invalid}, stored ${r.stored}, mean ${fmtAvg(r.sourceMean)} / ${fmtAvg(r.storedMean)}${p.verify.theirs ? `, csTimer cached count ${p.verify.theirs.count} mean ${fmtAvg(p.verify.theirs.mean)} → ${p.verify.match ? "match" : "MISMATCH"}` : ""}`;
      }),
      ...(parsed.warnings.length ? ["", "Warnings:", ...parsed.warnings] : []),
      ...parsed.sessions.flatMap((s) => s.invalid.map((x) => `INVALID ${s.name} #${x.index + 1}: ${x.reason} — ${x.raw}`)),
    ];
    return lines.join("\n");
  };

  return (
    <Modal title="Import solves" onClose={stage === "working" ? () => {} : onClose} wide testId="import-flow"
      footer={
        stage === "preview" ? (
          <>
            <span className="dim" style={{ marginRight: "auto", fontSize: 12.5 }}>Nothing has been written yet. A safety backup is created before importing.</span>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!plan || plan.totals.toAdd === 0} onClick={commit} data-testid="import-commit">
              Import {plan?.totals.toAdd.toLocaleString()} solves
            </button>
          </>
        ) : stage === "report" ? (
          <>
            <button className="btn" onClick={() => backend.saveTextFile(`facelet-import-report-${Date.now()}.txt`, reportText(), [{ name: "Text", extensions: ["txt"] }])}>Save report</button>
            <button className="btn primary" onClick={onClose} data-testid="import-done">Done</button>
          </>
        ) : undefined
      }
    >
      {stage === "pick" && (
        <div style={{ padding: "18px 0 8px" }}>
          <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
            Choose a <b>csTimer backup</b> (Export → “Export to file”, a <span className="mono">.txt</span> file containing JSON), a csTimer session CSV, a Twisty Timer
            backup, a Facelet backup, or a plain list of times. The original file is only read — never modified.
          </p>
          <button className="btn primary" onClick={pick} data-testid="import-pick">Choose file…</button>
        </div>
      )}
      {stage === "error" && (
        <div style={{ padding: "12px 0" }}>
          <div className="bad" style={{ marginBottom: 12 }}>{error}</div>
          <button className="btn" onClick={() => setStage("pick")}>Try another file</button>
        </div>
      )}
      {stage === "working" && <div className="empty">Importing and verifying…</div>}
      {stage === "preview" && parsed && plan && file && (
        <div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 14 }}>
            <div className="tile"><span className="cap">File</span><b style={{ fontSize: 14, wordBreak: "break-all" }}>{file.name}</b><span className="sub">{(file.size / 1024).toFixed(0)} KB · {parsed.format}</span></div>
            <div className="tile"><span className="cap">Solves in file</span><b className="num" data-testid="preview-total">{parsed.totalSolves.toLocaleString()}</b><span className="sub">{parsed.sessions.length} sessions</span></div>
            <div className="tile"><span className="cap">Will add</span><b className="num acc">{plan.totals.toAdd.toLocaleString()}</b><span className="sub">{plan.totals.duplicates.toLocaleString()} duplicates skipped</span></div>
            <div className="tile"><span className="cap">Invalid</span><b className="num">{parsed.totalInvalid}</b><span className="sub">reported, not imported</span></div>
          </div>
          <div style={{ maxHeight: "42vh", overflow: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th />
                  <th>Session</th>
                  <th>Type</th>
                  <th className="r">Solves</th>
                  <th>Dates</th>
                  <th className="r">Add</th>
                  <th className="r">Dup</th>
                  <th>Target</th>
                  <th>csTimer check</th>
                </tr>
              </thead>
              <tbody>
                {parsed.sessions.map((s) => {
                  const p = plan.perSession.find((x) => x.key === s.key);
                  const on = include.has(s.key);
                  return (
                    <tr key={s.key} style={{ opacity: on ? 1 : 0.45 }}>
                      <td>
                        <input type="checkbox" checked={on} onChange={(e) => { const n = new Set(include); e.target.checked ? n.add(s.key) : n.delete(s.key); setInclude(n); }} />
                      </td>
                      <td>{s.name}</td>
                      <td className="dim">{getEvent(s.event).short}{s.phases > 1 ? ` · ${s.phases} phases` : ""}</td>
                      <td className="r num">{s.solves.length.toLocaleString()}{s.invalid.length ? <span className="bad"> +{s.invalid.length}✗</span> : null}</td>
                      <td className="dim" style={{ fontSize: 12 }}>{p?.firstDate ? `${fmtDate(p.firstDate, false)} → ${fmtDate(p.lastDate, false)}` : "—"}</td>
                      <td className="r num">{p ? p.toAdd.toLocaleString() : "–"}</td>
                      <td className="r num dim">{p ? p.duplicates.toLocaleString() : "–"}</td>
                      <td className="dim" style={{ fontSize: 12 }}>{p ? (p.target === "new" ? "new session" : "→ " + p.targetName) : "skipped"}</td>
                      <td style={{ fontSize: 12 }}>
                        {p?.verify.match == null ? <span className="dim">no cached stats</span> : p.verify.match ? <span className="tag ok">✓ count & mean match</span> : <span className="tag err">differs</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 28, marginTop: 14 }}>
            <label style={{ display: "flex", gap: 10, alignItems: "center" }}><Toggle on={merge} onChange={setMerge} /> Add to matching sessions from earlier imports</label>
            <label style={{ display: "flex", gap: 10, alignItems: "center" }}><Toggle on={skipDup} onChange={setSkipDup} /> Skip solves already in Facelet</label>
          </div>
          {parsed.warnings.length > 0 && <div className="dim" style={{ marginTop: 12, fontSize: 12.5 }}>{parsed.warnings.join(" ")}</div>}
          {parsed.totalInvalid > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="bad" style={{ cursor: "pointer" }}>{parsed.totalInvalid} entries could not be read (will be listed in the report)</summary>
              <div className="mono dim" style={{ fontSize: 11.5, maxHeight: 160, overflow: "auto" }}>
                {parsed.sessions.flatMap((s) => s.invalid.map((x) => <div key={s.key + x.index}>{s.name} #{x.index + 1}: {x.reason} — {x.raw}</div>))}
              </div>
            </details>
          )}
        </div>
      )}
      {stage === "report" && report && (
        <div data-testid="import-report">
          <div className={"tile"} style={{ marginBottom: 14 }}>
            <span className="cap">Verification</span>
            <b className={report.ok ? "good" : "bad"} data-testid="verify-result">{report.ok ? "Passed — every source solve is accounted for" : "Problems found — see below"}</b>
            <span className="sub num">
              {report.plan.totals.toAdd.toLocaleString()} added · {report.plan.totals.duplicates.toLocaleString()} duplicates skipped · {report.plan.totals.invalid} invalid · source {report.plan.totals.source.toLocaleString()}
            </span>
          </div>
          <table className="tbl">
            <thead>
              <tr><th>Session</th><th className="r">Expected</th><th className="r">Stored</th><th className="r">Mean (source)</th><th className="r">Mean (stored)</th><th /></tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="r num">{r.expected.toLocaleString()}</td>
                  <td className="r num">{r.stored.toLocaleString()}</td>
                  <td className="r num">{fmtAvg(r.sourceMean)}</td>
                  <td className="r num">{fmtAvg(r.storedMean)}</td>
                  <td>{r.ok ? <span className="tag ok">✓</span> : <span className="tag err">✗</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim" style={{ fontSize: 12.5, marginTop: 12 }}>You can undo this import at any time from Settings → Data → Import history.</p>
        </div>
      )}
    </Modal>
  );
}

export function sessionCount(sessionId: string) {
  return sessionSolves(useStore.getState().solves, sessionId).length;
}
