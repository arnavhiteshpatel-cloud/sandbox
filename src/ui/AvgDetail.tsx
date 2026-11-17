import { useMemo } from "react";
import { Modal } from "./Overlay";
import { useStore } from "../data/store";
import { averageOf, parseAvgLabel, trimmedIndices } from "../core/stats";
import { fmtAvg, fmtDate, fmtSolve, solveValue } from "../core/time";
import type { Solve } from "../core/types";
import { IconCopy } from "./icons";

/** csTimer-style average detail: every solve in the window, trimmed ones in parentheses. */
export function AvgDetail({ solves, label, end, onClose }: { solves: Solve[]; label: string; end: number; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const openSolve = useStore((s) => s.openSolve);
  const spec = parseAvgLabel(label)!;
  const win = solves.slice(Math.max(0, end - spec.n + 1), end + 1);
  const vals = win.map((s) => solveValue(s, settings.decimals));
  const trimmed = useMemo(() => trimmedIndices(vals, spec, settings.trimPct), [vals, spec, settings.trimPct]);
  const avg = averageOf(vals, spec, settings.trimPct);
  const counted = vals.filter((_, i) => !trimmed.has(i) && Number.isFinite(vals[i]));
  const mean = counted.reduce((a, b) => a + b, 0) / (counted.length || 1);
  const sd = Math.sqrt(counted.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, counted.length - 1));
  const text = [
    `${label}: ${fmtAvg(avg, settings.decimals)} (σ = ${(sd / 1000).toFixed(2)})`,
    `${fmtDate(win[0]?.date ?? null)} – ${fmtDate(win.at(-1)?.date ?? null)}`,
    ...win.map((s, i) => `${i + 1}. ${trimmed.has(i) ? "(" : ""}${fmtSolve(s, settings.decimals)}${trimmed.has(i) ? ")" : ""}   ${s.scramble}${s.comment ? "   [" + s.comment + "]" : ""}`),
  ].join("\n");
  return (
    <Modal
      title={
        <span>
          {label} <span className="num" style={{ marginLeft: 8 }}>{fmtAvg(avg, settings.decimals)}</span>
          <span className="dim num" style={{ marginLeft: 10, fontWeight: 400, fontSize: 13 }}>σ {(sd / 1000).toFixed(2)}</span>
        </span>
      }
      onClose={onClose}
      wide={spec.n > 12}
      testId="avg-detail"
      footer={
        <button className="btn" onClick={() => navigator.clipboard?.writeText(text)}>
          <IconCopy size={14} /> Copy as text
        </button>
      }
    >
      <div className="dim" style={{ marginBottom: 10, fontSize: 12.5 }}>
        Solves {Math.max(1, end - spec.n + 2)}–{end + 1} · {fmtDate(win[0]?.date ?? null)} → {fmtDate(win.at(-1)?.date ?? null)} · trimmed {trimmed.size}
      </div>
      <div style={{ maxHeight: "58vh", overflow: "auto" }}>
        <table className="tbl">
          <tbody>
            {win.map((s, i) => (
              <tr key={s.id} className="click" onClick={() => openSolve(s.id)}>
                <td className="dim num" style={{ width: 50 }}>{end - win.length + i + 2}</td>
                <td className="num" style={{ width: 110, color: trimmed.has(i) ? "var(--fg3)" : undefined }}>
                  {trimmed.has(i) ? `(${fmtSolve(s, settings.decimals)})` : fmtSolve(s, settings.decimals)}
                </td>
                <td className="mono dim" style={{ fontSize: 12 }}>{s.scramble}</td>
                <td className="dim">{s.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
