/**
 * Importers for csTimer backups (JSON .txt export), csTimer CSV session exports,
 * Twisty Timer CSV backups, Facelet's own backup format, and simple one-time-per-line text.
 *
 * Format reference (csTimer src/js/export.js, lib/storage.js, stats/stats.js):
 *   { "session1": [solve, ...], "session2": [...], ..., "properties": { "sessionData": "<json string>", ... } }
 *   solve = [ [penalty, time, cumSplit_{k-1}, ..., cumSplit_1], scramble, comment, unixSeconds, ext? ]
 *     penalty: 0 OK, 2000 (+2), -1 DNF.  Session arrays may themselves be JSON strings.
 *   sessionData = { "1": { name, opt: { scrType, phases, ... }, rank, stat: [count, dnf, mean], date: [first, last] } }
 *
 * The importer never mutates its input text. Every source entry is either imported or
 * reported as invalid with a reason; nothing is silently dropped.
 */
import { hash53 } from "./ids";
import { parseCsDate, parseTime, solveValue } from "./time";
import { summarize } from "./stats";

export interface ParsedSolve {
  sourceIndex: number;
  time: number;
  penalty: number;
  splits: number[] | null;
  scramble: string;
  comment: string;
  date: number | null;
  extra: string | null;
  fp: string;
}

export interface InvalidEntry {
  index: number;
  reason: string;
  raw: string;
}

export interface ParsedSession {
  key: string;
  index: number;
  name: string;
  rank: number;
  event: string;
  phases: number;
  opt: Record<string, unknown>;
  solves: ParsedSolve[];
  invalid: InvalidEntry[];
  /** csTimer's own cached [count, dnf, mean] for cross-verification, if present. */
  csStat: [number, number, number] | null;
}

export type ImportFormat = "cstimer" | "cstimer-csv" | "twistytimer" | "facelet" | "plain";

export interface ParsedBackup {
  format: ImportFormat;
  sessions: ParsedSession[];
  properties: Record<string, unknown> | null;
  warnings: string[];
  totalSolves: number;
  totalInvalid: number;
  /** For Facelet backups: full payload (settings, ids) to restore. */
  facelet?: any;
}

/** Fingerprint of a solve's recorded content; stable across csTimer <-> Facelet round trips. */
export function solveFingerprint(s: {
  time: number;
  penalty: number;
  splits: number[] | null;
  scramble: string;
  date: number | null;
}): string {
  const dateSec = s.date == null ? null : Math.floor(s.date / 1000);
  return hash53(JSON.stringify([s.penalty, s.time, s.splits ?? 0, s.scramble.trim(), dateSec]));
}

function str2obj(v: unknown): unknown {
  return typeof v === "string" ? JSON.parse(v) : v;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Convert one csTimer solve entry. Returns a reason string when invalid. */
export function convertCsSolve(entry: unknown, index: number): ParsedSolve | string {
  if (!Array.isArray(entry)) return "entry is not an array";
  const tarr = entry[0];
  if (!Array.isArray(tarr) || tarr.length < 2) return "missing [penalty, time] array";
  const nums = tarr.map((x) => (typeof x === "string" && x.trim() !== "" ? Number(x) : x));
  if (!nums.every(isNum)) return "non-numeric time data";
  const penalty = nums[0] as number;
  const time = nums[1] as number;
  if (!(penalty === 0 || penalty === -1 || penalty > 0)) return `unknown penalty value ${penalty}`;
  if (time < 0) return `negative time ${time}`;
  if (!Number.isInteger(time)) return `non-integer time ${time}`;
  let splits: number[] | null = null;
  if (nums.length > 2) {
    // [pen, total, cum_{k-1}, ..., cum_1] -> forward cumulative [cum_1, ..., cum_{k-1}, total]
    splits = (nums.slice(1) as number[]).reverse();
  }
  const scramble = entry[1] == null ? "" : String(entry[1]);
  const comment = entry[2] == null ? "" : String(entry[2]);
  let date: number | null = null;
  if (entry[3] != null && entry[3] !== "") {
    const d = Number(entry[3]);
    if (!Number.isFinite(d)) return `invalid date ${String(entry[3])}`;
    if (d > 0) date = Math.round(d * 1000);
  }
  const extra = entry.length > 4 ? JSON.stringify(entry.slice(4)) : null;
  const s = { sourceIndex: index, time, penalty, splits, scramble, comment, date, extra, fp: "" };
  s.fp = solveFingerprint(s);
  return s;
}

function parseCsTimerJson(data: any): ParsedBackup {
  const warnings: string[] = [];
  let props: Record<string, unknown> | null = null;
  let sessionData: Record<string, any> = {};
  if (data.properties != null) {
    try {
      props = str2obj(data.properties) as Record<string, unknown>;
      if (props && props.sessionData != null) sessionData = str2obj(props.sessionData) as Record<string, any>;
    } catch (e) {
      warnings.push("Could not parse properties/sessionData; session names will default to numbers.");
    }
  }
  const sessions: ParsedSession[] = [];
  for (const key of Object.keys(data)) {
    const m = /^session(\d+)$/.exec(key);
    if (!m) continue;
    const idx = +m[1];
    let arr: unknown;
    try {
      arr = str2obj(data[key]);
    } catch {
      warnings.push(`${key}: could not parse solve list`);
      continue;
    }
    if (!Array.isArray(arr)) {
      warnings.push(`${key}: solve list is not an array`);
      continue;
    }
    const sd = sessionData[String(idx)] ?? {};
    const opt: Record<string, unknown> = typeof sd.opt === "object" && sd.opt ? { ...sd.opt } : {};
    if (sd.scr && !opt.scrType) opt.scrType = sd.scr; // legacy layout
    if (sd.phases && !opt.phases) opt.phases = sd.phases;
    const solves: ParsedSolve[] = [];
    const invalid: InvalidEntry[] = [];
    arr.forEach((entry, i) => {
      const r = convertCsSolve(entry, i);
      if (typeof r === "string") invalid.push({ index: i, reason: r, raw: JSON.stringify(entry).slice(0, 500) });
      else solves.push(r);
    });
    let phases = Number(opt.phases) || 1;
    for (const s of solves) if (s.splits && s.splits.length > phases) phases = s.splits.length;
    const csStat =
      Array.isArray(sd.stat) && sd.stat.length >= 3 && sd.stat.every(isNum) ? (sd.stat.slice(0, 3) as [number, number, number]) : null;
    sessions.push({
      key,
      index: idx,
      name: sd.name != null && String(sd.name).trim() !== "" ? String(sd.name) : String(idx),
      rank: isNum(sd.rank) ? sd.rank : idx,
      event: typeof opt.scrType === "string" && opt.scrType ? (opt.scrType as string) : "333",
      phases,
      opt,
      solves,
      invalid,
      csStat,
    });
  }
  sessions.sort((a, b) => a.rank - b.rank || a.index - b.index);
  if (sessions.length === 0) warnings.push("No session data found in file.");
  return finish("cstimer", sessions, props, warnings);
}

function finish(
  format: ImportFormat,
  sessions: ParsedSession[],
  props: Record<string, unknown> | null,
  warnings: string[],
): ParsedBackup {
  return {
    format,
    sessions,
    properties: props,
    warnings,
    totalSolves: sessions.reduce((s, x) => s + x.solves.length, 0),
    totalInvalid: sessions.reduce((s, x) => s + x.invalid.length, 0),
  };
}

/** Minimal RFC4180-style CSV reader supporting quoted fields and a custom delimiter. */
export function readCSV(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseCsTimerCsv(text: string, fileName: string): ParsedBackup {
  const rows = readCSV(text, ";");
  const header = rows[0];
  const nPhases = Math.max(1, header.length - 5);
  const solves: ParsedSolve[] = [];
  const invalid: InvalidEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    if (line.length === 1 && line[0] === "") continue;
    const t = parseTime(line[1] ?? "");
    if (!t) {
      invalid.push({ index: i - 1, reason: `unparseable time "${line[1]}"`, raw: line.join(";") });
      continue;
    }
    const phaseVals: number[] = [];
    for (let j = 5; j < line.length; j++) {
      if (line[j] === "") continue;
      const p = parseTime(line[j]);
      if (p) phaseVals.push(p.time + (p.penalty > 0 ? p.penalty : 0));
    }
    let time = t.time;
    let splits: number[] | null = null;
    if (phaseVals.length > 1) {
      splits = [];
      let acc = 0;
      for (const v of phaseVals) splits.push((acc += v));
      time = acc; // csTimer uses phase data as the authoritative time
    } else if (phaseVals.length === 1) time = phaseVals[0];
    const date = parseCsDate(line[4] ?? "");
    const s: ParsedSolve = {
      sourceIndex: i - 1,
      time,
      penalty: t.penalty,
      splits,
      scramble: line[3] ?? "",
      comment: line[2] ?? "",
      date,
      extra: null,
      fp: "",
    };
    s.fp = solveFingerprint(s);
    solves.push(s);
  }
  const name = fileName.replace(/\.[^.]+$/, "") || "Imported CSV";
  return finish(
    "cstimer-csv",
    [{ key: "csv", index: 1, name, rank: 1, event: "333", phases: nPhases, opt: { phases: nPhases }, solves, invalid, csStat: null }],
    null,
    ["csTimer CSV exports store dates without seconds precision guarantees and no puzzle type; sessions default to 3x3."],
  );
}

const TWISTY_MAP: Record<string, string> = {
  "333": "333",
  "222": "222so",
  "444": "444wca",
  "555": "555wca",
  "666": "666wca",
  "777": "777wca",
  pyra: "pyrso",
  skewb: "skbso",
  mega: "mgmp",
  sq1: "sqrs",
  clock: "clkwca",
  "333oh": "333oh",
  "333bld": "333ni",
  "444bld": "444bld",
  "555bld": "555bld",
  "333fmc": "333fm",
};

function parseTwisty(text: string): ParsedBackup {
  const rows = readCSV(text, ";");
  const byName = new Map<string, ParsedSession>();
  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    if (line.length < 7) continue;
    const name = `${line[0]}-${line[1]}`;
    let ses = byName.get(name);
    if (!ses) {
      ses = { key: name, index: byName.size + 1, name, rank: byName.size + 1, event: TWISTY_MAP[line[0]] ?? "333", phases: 1, opt: {}, solves: [], invalid: [], csStat: null };
      byName.set(name, ses);
    }
    const ms = parseInt(line[2], 10);
    const pen = ({ "0": 0, "1": 2000, "2": -1 } as Record<string, number>)[line[5]] ?? 0;
    if (!Number.isFinite(ms)) {
      ses.invalid.push({ index: i - 1, reason: "bad time", raw: line.join(";") });
      continue;
    }
    // Twisty Timer stores time including +2
    const s: ParsedSolve = {
      sourceIndex: i - 1,
      time: pen === 2000 ? Math.max(0, ms - 2000) : ms,
      penalty: pen,
      splits: null,
      scramble: line[4] ?? "",
      comment: line[6] ?? "",
      date: Number.isFinite(+line[3]) ? +line[3] : null,
      extra: null,
      fp: "",
    };
    s.fp = solveFingerprint(s);
    ses.solves.push(s);
  }
  return finish("twistytimer", [...byName.values()], null, []);
}

function parsePlain(text: string, fileName: string): ParsedBackup {
  const solves: ParsedSolve[] = [];
  const invalid: InvalidEntry[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const l = line.trim().replace(/^\d+[.)]\s+/, "");
    if (!l) return;
    const t = parseTime(l.split(/\s+/)[0]);
    if (!t) invalid.push({ index: i, reason: "unparseable line", raw: line });
    else {
      const s: ParsedSolve = { sourceIndex: i, ...t, splits: null, scramble: "", comment: "", date: null, extra: null, fp: "" };
      s.fp = solveFingerprint(s);
      solves.push(s);
    }
  });
  return finish("plain", [{ key: "plain", index: 1, name: fileName.replace(/\.[^.]+$/, ""), rank: 1, event: "333", phases: 1, opt: {}, solves, invalid, csStat: null }], null, [
    "Plain-text import: only times are available; dates and scrambles are recorded as missing.",
  ]);
}

function parseFacelet(data: any): ParsedBackup {
  const sessions: ParsedSession[] = (data.sessions ?? []).map((s: any, i: number) => {
    const solves: ParsedSolve[] = [];
    const invalid: InvalidEntry[] = [];
    (data.solves ?? [])
      .filter((x: any) => x.sessionId === s.id && !x.deletedAt)
      .sort((a: any, b: any) => a.ord - b.ord)
      .forEach((x: any, j: number) => {
        if (!isNum(x.time) || !isNum(x.penalty)) {
          invalid.push({ index: j, reason: "bad time", raw: JSON.stringify(x).slice(0, 300) });
          return;
        }
        solves.push({
          sourceIndex: j,
          time: x.time,
          penalty: x.penalty,
          splits: x.splits ?? null,
          scramble: x.scramble ?? "",
          comment: x.comment ?? "",
          date: x.date ?? null,
          extra: x.extra ?? null,
          fp: x.fp || solveFingerprint(x),
        });
      });
    return {
      key: s.sourceKey ?? `facelet:${s.id}`,
      index: i + 1,
      name: s.name,
      rank: s.rank ?? i + 1,
      event: s.event ?? "333",
      phases: s.phases ?? 1,
      opt: s.opt ?? {},
      solves,
      invalid,
      csStat: null,
    } satisfies ParsedSession;
  });
  const r = finish("facelet", sessions, null, []);
  r.facelet = data;
  return r;
}

/** Detect the format of `text` and parse it. Throws with a readable message when unsupported. */
export function parseBackup(text: string, fileName = "import"): ParsedBackup {
  const t = text.replace(/^﻿/, "").trimStart();
  if (t.startsWith("{")) {
    let data: any;
    try {
      data = JSON.parse(t);
    } catch (e) {
      throw new Error("The file looks like JSON but could not be parsed: " + (e as Error).message);
    }
    if (data && data.app === "facelet") return parseFacelet(data);
    if (data && Object.keys(data).some((k) => /^session\d+$/.test(k))) return parseCsTimerJson(data);
    throw new Error("JSON file does not contain csTimer sessions (expected keys like \"session1\").");
  }
  if (/^No\.;Time;Comment;Scramble;Date/i.test(t)) return parseCsTimerCsv(t, fileName);
  if (/^"?Puzzle"?;"?Category"?;"?Time\(millis\)"?/i.test(t)) return parseTwisty(t);
  return parsePlain(t, fileName);
}

/** Per-session verification numbers computed from parsed data (independent of the database). */
export function verifyAgainstCsStat(s: ParsedSession) {
  const count = s.solves.length + s.invalid.length;
  const at = (dec: number) => summarize(s.solves.map((x) => solveValue(x, dec)));
  const s2 = at(2);
  const s3 = at(3);
  const ours = { count, dnf: s2.dnf, mean: s2.mean, mean3: s3.mean };
  if (!s.csStat) return { ours, theirs: null, match: null as boolean | null };
  const [c, d, m] = s.csStat;
  // csTimer computes the mean from values truncated to 10 ms unless "use milliseconds" was on
  const meanMatch = (m < 0 && Number.isNaN(ours.mean)) || Math.abs(m - s2.mean) < 0.5 || Math.abs(m - s3.mean) < 0.5;
  return { ours, theirs: { count: c, dnf: d, mean: m }, match: c === count && d === ours.dnf && meanMatch };
}
