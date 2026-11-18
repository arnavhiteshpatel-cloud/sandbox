import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../data/store";
import { THEMES, TIMER_FONTS, DEFAULT_SETTINGS, type Settings, type ThemeId, type TimerFont } from "../data/settings";
import { Seg, Toggle, confirmDialog } from "../ui/Overlay";
import { ImportFlow } from "../ui/ImportFlow";
import { exportCsTimer, exportFacelet } from "../core/exporter";
import { parseAvgLabel } from "../core/stats";
import { fmtDate } from "../core/time";
import type { BackupInfo } from "../core/types";
import type { AppPaths, IntegrityReport } from "../data/backend";
import { IconExport, IconImport, IconShield } from "../ui/icons";

function Row({ t, d, children }: { t: ReactNode; d?: ReactNode; children: ReactNode }) {
  return (
    <div className="row-set">
      <div>
        <div className="t">{t}</div>
        {d && <div className="d">{d}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{children}</div>
    </div>
  );
}

const SECTIONS = ["Appearance", "Timer", "Statistics", "Data", "Shortcuts", "About"] as const;
type Section = (typeof SECTIONS)[number];

export default function SettingsView() {
  const [sec, setSec] = useState<Section>("Appearance");
  return (
    <div className="page settings-page">
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, marginBottom: 18 }}>
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub" style={{ margin: 0 }}>Everything is stored locally on this Mac. No account, no cloud.</p>
        </div>
        <Seg value={sec} options={SECTIONS.map((s) => ({ v: s, label: s }))} onChange={setSec} />
      </div>
      <div className="glass-edge card" style={{ maxWidth: 980 }}>
        {sec === "Appearance" && <Appearance />}
        {sec === "Timer" && <TimerSettings />}
        {sec === "Statistics" && <StatsSettings />}
        {sec === "Data" && <DataSettings />}
        {sec === "Shortcuts" && <Shortcuts />}
        {sec === "About" && <About />}
      </div>
    </div>
  );
}

function useSet() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  return { s: settings, set: (p: Partial<Settings>) => update(p) };
}

function Appearance() {
  const { s, set } = useSet();
  return (
    <>
      <div className="section-title" style={{ marginTop: 4 }}>Theme</div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        {(Object.keys(THEMES) as ThemeId[]).map((id) => {
          const t = THEMES[id];
          return (
            <button key={id} className={"theme-card" + (s.theme === id ? " on" : "")} onClick={() => set({ theme: id })} data-testid={"theme-" + id}>
              <div className="sw" style={{ background: `radial-gradient(120px 80px at 50% 40%, ${t.vars["--bg-glow"]}, ${t.vars["--bg"]})` }}>
                <span style={{ color: t.vars["--fg"], textShadow: `0 0 18px ${t.vars["--glow"]}` }}>12.93</span>
                <i style={{ background: t.vars["--accent"] }} />
              </div>
              <div className="nm">{t.label}</div>
              <div className="ds">{t.desc}</div>
            </button>
          );
        })}
      </div>
      <div className="section-title">Timer typography</div>
      <Row t="Typeface">
        <select className="input" value={s.timerFont} onChange={(e) => set({ timerFont: e.target.value as TimerFont })}>
          {(Object.keys(TIMER_FONTS) as TimerFont[]).map((f) => (
            <option key={f} value={f}>{TIMER_FONTS[f].label}</option>
          ))}
        </select>
      </Row>
      <Row t="Weight" d="Thin to bold">
        <input type="range" min={200} max={700} step={50} value={s.timerWeight} onChange={(e) => set({ timerWeight: +e.target.value })} />
        <span className="num dim" style={{ width: 34 }}>{s.timerWeight}</span>
      </Row>
      <Row t="Timer size">
        <input type="range" min={0.6} max={1.4} step={0.05} value={s.timerScale} onChange={(e) => set({ timerScale: +e.target.value })} />
        <span className="num dim" style={{ width: 34 }}>{Math.round(s.timerScale * 100)}%</span>
      </Row>
      <Row t="Smaller decimals"><Toggle on={s.smallDecimals} onChange={(v) => set({ smallDecimals: v })} /></Row>
      <Row t="Scramble size">
        <input type="range" min={0.7} max={1.4} step={0.05} value={s.scrambleScale} onChange={(e) => set({ scrambleScale: +e.target.value })} />
        <span className="num dim" style={{ width: 34 }}>{Math.round(s.scrambleScale * 100)}%</span>
      </Row>
      <Row t="Scramble font"><Seg value={s.scrambleFont} options={[{ v: "mono", label: "Mono" }, { v: "sans", label: "Sans" }]} onChange={(v) => set({ scrambleFont: v })} /></Row>
      <div className="section-title">Timer screen</div>
      <Row t="Live 3D cube" d="Rotatable model of the scrambled puzzle, with scramble guide"><Toggle on={s.showCube3d} onChange={(v) => set({ showCube3d: v })} /></Row>
      <Row t="Flat scramble net"><Toggle on={s.showScrambleImage} onChange={(v) => set({ showScrambleImage: v })} /></Row>
      <Row t="Animations"><Toggle on={s.animations} onChange={(v) => set({ animations: v })} /></Row>
      <Row t="Sticker colours" d="U R F D L B">
        {s.cubeColors.map((c, i) => (
          <input key={i} type="color" value={c} onChange={(e) => { const n = [...s.cubeColors]; n[i] = e.target.value; set({ cubeColors: n }); }} className="swatch" />
        ))}
        <button className="btn sm ghost" onClick={() => set({ cubeColors: DEFAULT_SETTINGS.cubeColors })}>Reset</button>
      </Row>
    </>
  );
}

function TimerSettings() {
  const { s, set } = useSet();
  return (
    <>
      <div className="section-title" style={{ marginTop: 4 }}>Starting & stopping</div>
      <Row t="Input" d="Use the keyboard timer, or type times in manually"><Seg value={s.inputMode} options={[{ v: "timer", label: "Timer" }, { v: "typing", label: "Typing" }]} onChange={(v) => set({ inputMode: v })} /></Row>
      <Row t="Hold time before start" d="How long the start key must be held (csTimer default 0.3 s)">
        <Seg value={s.holdMs} options={[0, 300, 550, 1000].map((v) => ({ v, label: v ? v / 1000 + " s" : "none" }))} onChange={(v) => set({ holdMs: v })} />
      </Row>
      <Row t="Start key"><Seg value={s.startKey} options={[{ v: "space", label: "Space" }, { v: "any", label: "Any key" }]} onChange={(v) => set({ startKey: v })} /></Row>
      <Row t="While solving show" d="Hidden shows only the word “solving”">
        <Seg value={s.runningDisplay} options={[{ v: "hidden", label: "Hidden" }, { v: "full", label: "0.01" }, { v: "tenths", label: "0.1" }, { v: "seconds", label: "1 s" }]} onChange={(v) => set({ runningDisplay: v })} />
      </Row>
      <Row t="Hide interface while timing"><Toggle on={s.hideUiWhileTiming} onChange={(v) => set({ hideUiWhileTiming: v })} /></Row>
      <Row t="Precision" d="Display and statistics resolution (csTimer uses 0.01 unless “use milliseconds”)"><Seg value={s.decimals} options={[{ v: 2 as const, label: "0.01" }, { v: 3 as const, label: "0.001" }]} onChange={(v) => set({ decimals: v })} /></Row>
      <div className="section-title">Accidental stops</div>
      <Row t="Ignore impossibly fast solves" d="A stop faster than this share of your best single (minimum 1 s) is not saved; a notice lets you keep it anyway, and the scramble stays">
        <Seg value={s.shortFilter} options={[{ v: "auto", label: "On" }, { v: "off", label: "Off" }]} onChange={(v) => set({ shortFilter: v })} />
        <Seg value={s.shortRatio} options={[0.3, 0.4, 0.5, 0.6].map((v) => ({ v, label: Math.round(v * 100) + "%" }))} onChange={(v) => set({ shortRatio: v })} />
      </Row>
      <div className="section-title">Personal bests</div>
      <Row t="Celebration" d="When you set a new best single, mo3, ao5, ao12, ao50, ao100 or ao1000">
        <Seg value={s.celebrate} options={[{ v: "big", label: "Big" }, { v: "subtle", label: "Subtle" }, { v: "off", label: "Off" }]} onChange={(v) => set({ celebrate: v })} />
      </Row>
      <Row t="Celebration sound"><Toggle on={s.celebrateSound} onChange={(v) => set({ celebrateSound: v })} /></Row>
      <Row t="Preview">
        <button className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent("facelet:pb", { detail: [{ label: "ao5", value: "12.21", gain: "−0.27" }, { label: "single", value: "8.43", gain: "−0.07" }] }))}>Test celebration</button>
      </Row>
      <div className="section-title">WCA inspection</div>
      <Row t="Inspection" d="Tap space to start inspection; +2 after 15 s, DNF after 17 s (⌘I)"><Toggle on={s.inspection} onChange={(v) => set({ inspection: v })} testId="toggle-inspection" /></Row>
      <Row t="Inspection length">
        <Seg value={s.inspectionSeconds} options={[8, 12, 15].map((v) => ({ v, label: v + " s" }))} onChange={(v) => set({ inspectionSeconds: v })} />
      </Row>
      <Row t="Voice alerts at 8 s and 12 s"><Toggle on={s.inspectionVoice} onChange={(v) => set({ inspectionVoice: v })} /></Row>
      <Row t="Beep alerts"><Toggle on={s.inspectionBeep} onChange={(v) => set({ inspectionBeep: v })} /></Row>
    </>
  );
}

function StatsSettings() {
  const { s, set } = useSet();
  const [rows, setRows] = useState(s.statsRows.join(" "));
  const valid = rows.split(/[\s,]+/).filter(Boolean).every((l) => parseAvgLabel(l));
  return (
    <>
      <div className="section-title" style={{ marginTop: 4 }}>Averages</div>
      <Row t="Averages shown" d="Any of moN / aoN, e.g. mo3 ao5 ao12 ao25 ao50 ao100 ao1000">
        <input className="input" style={{ width: 420, borderColor: valid ? undefined : "var(--bad)" }} value={rows} onChange={(e) => setRows(e.target.value)} onBlur={() => valid && set({ statsRows: rows.split(/[\s,]+/).filter(Boolean).map((x) => x.toLowerCase()) })} />
      </Row>
      <Row t="Trim" d="Percentage trimmed from each end of aoN (csTimer and WCA ao5 use 5%: ao5/ao12 drop 1 each side)">
        <Seg value={s.trimPct} options={[5, 10].map((v) => ({ v, label: v + "%" }))} onChange={(v) => set({ trimPct: v })} />
      </Row>
      <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
        Averages follow csTimer exactly: each single is truncated to the displayed precision, an average is DNF when DNFs exceed the trimmed count, means of N trim nothing, and
        averages are rounded to the displayed precision.
      </p>
    </>
  );
}

function DataSettings() {
  const backend = useStore((s) => s.backend)!;
  const imports = useStore((s) => s.imports);
  const settings = useStore((s) => s.settings);
  const sessions = useStore((s) => s.sessions);
  const solves = useStore((s) => s.solves);
  const toast = useStore((s) => s.toast);
  const [importing, setImporting] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [integ, setInteg] = useState<IntegrityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    backend.backupList().then(setBackups).catch(() => {});
    backend.paths().then(setPaths).catch(() => {});
  };
  useEffect(refresh, [backend, settings.backupDir]);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const live = solves.filter((s) => !s.deletedAt).length;
  return (
    <>
      <div className="section-title" style={{ marginTop: 4 }}>Import & export</div>
      <Row t="Import solves" d="csTimer backup (.txt), csTimer CSV, Twisty Timer, Facelet backup — with preview, duplicate detection and verification">
        <button className="btn primary" onClick={() => setImporting(true)} data-testid="open-import"><IconImport size={15} /> Import…</button>
      </Row>
      <Row t="Export for csTimer" d="A csTimer-format backup you can import back into csTimer">
        <button className="btn" onClick={async () => { const p = await backend.saveTextFile(`facelet_cstimer_${stamp}.txt`, exportCsTimer(sessions, solves), [{ name: "csTimer backup", extensions: ["txt"] }]); if (p) toast("Exported " + live.toLocaleString() + " solves", "success"); }} data-testid="export-cstimer"><IconExport size={15} /> Export…</button>
      </Row>
      <Row t="Full Facelet backup" d="Every field, including deleted solves, settings and import history (JSON)">
        <button className="btn" onClick={async () => { const p = await backend.saveTextFile(`facelet_backup_${stamp}.json`, exportFacelet(sessions, solves, settings as any, imports), [{ name: "Facelet backup", extensions: ["json"] }]); if (p) toast("Backup exported", "success"); }} data-testid="export-facelet"><IconExport size={15} /> Export…</button>
      </Row>
      <div className="section-title">Automatic backups</div>
      <Row t="Backups" d={`A snapshot is taken daily at launch and before every import, rollback and restore (newest 30 automatic kept). ${paths ? "Folder: " + paths.backupDir : ""}`}>
        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await backend.backupCreate("manual"); toast("Backup created", "success"); refresh(); } catch (e) { toast(String(e), "error"); } setBusy(false); }} data-testid="backup-now">Back up now</button>
        {backend.kind === "tauri" && (
          <button className="btn ghost" onClick={async () => { const d = await backend.pickDirectory(); if (d) { useStore.getState().updateSettings({ backupDir: d }); toast("Backup folder changed"); } }}>Change folder…</button>
        )}
      </Row>
      <div style={{ maxHeight: 240, overflow: "auto", marginBottom: 6 }}>
        <table className="tbl">
          <thead><tr><th>Snapshot</th><th>Reason</th><th className="r">Size</th><th /></tr></thead>
          <tbody>
            {backups.slice(0, 60).map((b) => (
              <tr key={b.path}>
                <td className="num">{fmtDate(b.createdAt)}</td>
                <td className="dim">{b.reason}</td>
                <td className="r num dim">{(b.size / 1024).toFixed(0)} KB</td>
                <td className="r">
                  <button className="btn sm ghost" data-testid="backup-restore" onClick={async () => {
                    if (!confirmDialog(`Restore the snapshot from ${fmtDate(b.createdAt)}?\n\nYour current data is backed up first, so this can be undone by restoring that backup.`)) return;
                    try { const n = await backend.backupRestore(b.path); await useStore.getState().reload(); toast(`Restored ${n.toLocaleString()} solves`, "success"); refresh(); } catch (e) { toast(String(e), "error"); }
                  }}>Restore</button>
                  {backend.kind === "tauri" && <button className="btn sm ghost" onClick={() => backend.reveal(b.path)}>Show</button>}
                </td>
              </tr>
            ))}
            {!backups.length && <tr><td colSpan={4} className="dim">No backups yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="section-title">Import history</div>
      <table className="tbl">
        <thead><tr><th>Date</th><th>File</th><th className="r">Added</th><th className="r">Dup</th><th>Status</th><th /></tr></thead>
        <tbody>
          {[...imports].sort((a, b) => b.createdAt - a.createdAt).map((im) => (
            <tr key={im.id}>
              <td className="num">{fmtDate(im.createdAt)}</td>
              <td>{im.fileName}<div className="dim mono" style={{ fontSize: 10.5 }}>sha256 {im.fileHash.slice(0, 16)}…</div></td>
              <td className="r num">{im.solvesAdded.toLocaleString()}</td>
              <td className="r num dim">{im.duplicatesSkipped.toLocaleString()}</td>
              <td>{im.rolledBackAt ? <span className="tag">rolled back</span> : <span className="tag ok">active</span>}</td>
              <td className="r">
                {!im.rolledBackAt && (
                  <button className="btn sm danger" onClick={async () => {
                    if (!confirmDialog(`Undo this import? ${im.solvesAdded.toLocaleString()} imported solves will be removed (a backup is taken first). Solves you timed yourself are never touched.`)) return;
                    try { const n = await backend.importRollback(im.id); await useStore.getState().reload(); toast(`Removed ${n.toLocaleString()} imported solves`, "success"); } catch (e) { toast(String(e), "error"); }
                  }} data-testid="rollback-import">Undo import</button>
                )}
                <button className="btn sm ghost" onClick={async () => { const t = await backend.importSource(im.id); if (t) backend.saveTextFile(im.fileName, t, [{ name: "Original file", extensions: ["txt", "json", "csv"] }]); }}>Original</button>
              </td>
            </tr>
          ))}
          {!imports.length && <tr><td colSpan={6} className="dim">No imports yet.</td></tr>}
        </tbody>
      </table>
      <div className="section-title">Integrity</div>
      <Row t="Database check" d={integ ? `${integ.ok ? "OK" : "PROBLEM: " + integ.message} · ${integ.liveSolves.toLocaleString()} live solves (${integ.solves.toLocaleString()} incl. deleted) · ${integ.sessions} sessions · schema v${integ.schemaVersion}` : "Runs SQLite's integrity check and verifies every solve belongs to a session"}>
        <button className="btn" onClick={async () => setInteg(await backend.integrity())} data-testid="integrity"><IconShield size={15} /> Check</button>
      </Row>
      {paths && <div className="dim mono" style={{ fontSize: 11.5, marginTop: 8 }}>Database: {paths.dbPath}</div>}
      {importing && <ImportFlow onClose={() => setImporting(false)} />}
    </>
  );
}

function Shortcuts() {
  const rows: [string, string][] = [
    ["Space", "Tap: start inspection · hold until green, release: start · any key: stop"],
    ["Esc", "Cancel inspection · close panels · back to timer"],
    ["⌥Z  or  ⌘⌫", "Delete last solve"],
    ["⌘Z / ⇧⌘Z", "Undo / redo"],
    ["⌘1 / ⌘2 / ⌘3", "Last solve: OK / +2 / DNF"],
    ["⌘E", "Open last solve (comment, details)"],
    ["← / →", "Previous / next scramble"],
    ["⌥↑ / ⌥↓", "Previous / next session"],
    ["⌘N", "New session"],
    ["⌘I", "Toggle inspection"],
    ["F  or  ⌃⌘F", "Fullscreen"],
    ["⌥1 … ⌥5, ⌥,", "Timer, History, Analytics, Training, Sessions, Settings"],
    ["?", "Shortcut overlay"],
  ];
  return (
    <table className="tbl">
      <tbody>
        {rows.map(([k, d]) => (
          <tr key={k}><td style={{ width: 170 }}><span className="kbd">{k}</span></td><td className="muted">{d}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function About() {
  return (
    <div style={{ lineHeight: 1.7 }} className="muted">
      <p style={{ marginTop: 4 }}><b style={{ color: "var(--fg)" }}>Facelet</b> — a local-first speedcubing timer. Works fully offline; no account, subscription, cloud service or AI is used.</p>
      <p>Data lives in a SQLite database on this Mac (WAL journal, synchronous writes) with automatic backups. Every solve is written before it is shown.</p>
      <p className="dim" style={{ fontSize: 12.5 }}>
        Open-source components: cubing.js (MPL-2.0) for scrambles and 3D puzzles · Tauri (MIT/Apache-2.0) · React (MIT) · zustand (MIT) · uPlot (MIT) · SQLite (public domain) via rusqlite (MIT) · Inter and JetBrains Mono fonts (SIL OFL 1.1). Statistics conventions follow csTimer (GPL-3.0); no csTimer code is included.
      </p>
    </div>
  );
}
