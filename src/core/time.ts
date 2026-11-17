import type { Solve } from "./types";

/** Effective value for statistics: ms with penalty, Infinity for DNF. */
export function solveValue(s: Pick<Solve, "time" | "penalty">, decimals = 2): number {
  if (s.penalty < 0) return Infinity;
  const v = s.time + s.penalty;
  // csTimer truncates each single to the displayed resolution before computing stats.
  return decimals >= 3 ? v : Math.floor(v / 10) * 10;
}

function pad(n: number, w: number) {
  return String(n).padStart(w, "0");
}

/** Format integer milliseconds. Singles are truncated (csTimer behaviour); averages rounded. */
export function fmtMs(ms: number, decimals = 2, mode: "trunc" | "round" = "trunc"): string {
  if (ms === Infinity || ms < 0) return "DNF";
  if (!Number.isFinite(ms)) return "–";
  const unit = decimals >= 3 ? 1 : 10;
  const q = mode === "round" ? Math.round(ms / unit) : Math.floor(ms / unit);
  const frac = decimals >= 3 ? q % 1000 : q % 100;
  const totalSec = Math.floor(decimals >= 3 ? q / 1000 : q / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const fracStr = pad(frac, decimals >= 3 ? 3 : 2);
  if (h > 0) return `${h}:${pad(m, 2)}:${pad(s, 2)}.${fracStr}`;
  if (m > 0) return `${m}:${pad(s, 2)}.${fracStr}`;
  return `${s}.${fracStr}`;
}

export const fmtSingle = (ms: number, decimals = 2) => fmtMs(ms, decimals, "trunc");
export const fmtAvg = (ms: number, decimals = 2) => (Number.isNaN(ms) ? "–" : fmtMs(ms, decimals, "round"));

/** Display string for a solve including penalty markers, e.g. "12.34+" or "DNF(12.34)". */
export function fmtSolve(s: Pick<Solve, "time" | "penalty">, decimals = 2, showDnfTime = false): string {
  if (s.penalty < 0) return showDnfTime ? `DNF(${fmtSingle(s.time, decimals)})` : "DNF";
  if (s.penalty > 0) return fmtSingle(s.time + s.penalty, decimals) + "+";
  return fmtSingle(s.time, decimals);
}

const TIME_RE = /^\s*(DNF)?\s*\(?\s*(?:(\d+):)?(?:(\d+):)?(\d*\.?\d*)\s*(\+)?\s*\)?\s*$/i;

/**
 * Parse a typed/CSV time such as "12.34", "1:02.345", "DNF(12.3)", "14.20+".
 * Returns { time, penalty } where time excludes the +2.
 */
export function parseTime(str: string): { time: number; penalty: number } | null {
  const m = TIME_RE.exec(str);
  if (!m || (!m[4] && !m[2])) return null;
  let h = 0,
    min = 0;
  if (m[2] !== undefined && m[3] !== undefined) {
    h = +m[2];
    min = +m[3];
  } else if (m[2] !== undefined) {
    min = +m[2];
  }
  const sec = m[4] ? parseFloat(m[4]) : 0;
  if (!Number.isFinite(sec)) return null;
  let ms = Math.round(h * 3600000 + min * 60000 + sec * 1000);
  let penalty = 0;
  if (m[1]) penalty = -1;
  else if (m[5]) {
    penalty = 2000;
    ms = Math.max(0, ms - 2000);
  }
  return { time: ms, penalty };
}

/** Parse "typing mode" input like csTimer: "1234" -> 12.34, "12.34" -> 12.34. */
export function parseTypedEntry(str: string): { time: number; penalty: number } | null {
  const t = str.trim();
  if (/^\d+$/.test(t)) {
    // csTimer convention: digits only => last two are centiseconds, then seconds, minutes
    const d = t.padStart(3, "0");
    const cs = +d.slice(-2);
    const rest = d.slice(0, -2);
    const sec = +rest.slice(-2);
    const min = rest.length > 2 ? +rest.slice(0, -2) : 0;
    return { time: min * 60000 + sec * 1000 + cs * 10, penalty: 0 };
  }
  return parseTime(t);
}

export function fmtDate(ms: number | null, withTime = true): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
  return withTime ? `${date} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}` : date;
}

/** csTimer-compatible "YYYY-MM-DD hh:mm:ss" in local time. */
export function fmtCsDate(ms: number | null): string {
  if (ms == null) return "N/A";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(
    d.getMinutes(),
    2,
  )}:${pad(d.getSeconds(), 2)}`;
}

export function parseCsDate(str: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(str.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return d.getTime();
}
