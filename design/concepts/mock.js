// Shared sample content for design concept mockups (served by the Vite dev server).
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import { Cube, FACES } from "/src/core/cube.ts";

export const SCRAMBLE = "R2 D' B2 U F2 U' L2 D2 R2 U' B' R F' U' L D' F2 R' U2 L'";
export const STATS = [
  ["single", "12.93", "8.50"], ["mo3", "12.94", "11.48"], ["ao5", "12.92", "11.62"], ["ao12", "13.43", "12.25"],
  ["ao25", "13.83", "12.81"], ["ao50", "14.01", "13.20"], ["ao100", "14.34", "13.30"], ["ao200", "13.99", "13.60"],
  ["ao500", "13.98", "13.90"], ["ao1000", "14.00", "13.97"], ["ao2000", "14.03", "14.01"], ["ao5000", "14.12", "14.12"], ["ao10000", "14.51", "14.51"],
];
export const RECENT = ["12.93", "11.48", "14.42", "12.34", "13.49", "15.59", "15.29", "13.06", "13.41", "11.33"];
const COLORS = ["#ffffff", "#ff3b30", "#2fd158", "#ffd60a", "#ff9f0a", "#0a84ff"];

export function netSVG(unit = 14, colors = COLORS, stroke = "rgba(0,0,0,.25)") {
  const n = 3, fl = new Cube(3).apply(SCRAMBLE).facelets();
  const gap = unit * 0.1, fg = unit * 0.32, fs = n * unit + fg;
  const pos = { U: [1, 0], L: [0, 1], F: [1, 1], R: [2, 1], B: [3, 1], D: [1, 2] };
  let r = "";
  for (const f of FACES) fl[f].forEach((c, i) => {
    const [fx, fy] = pos[f];
    r += `<rect x="${fx * fs + (i % 3) * unit + gap / 2}" y="${fy * fs + Math.floor(i / 3) * unit + gap / 2}" width="${unit - gap}" height="${unit - gap}" rx="${unit * 0.12}" fill="${colors[c]}" stroke="${stroke}" stroke-width=".6"/>`;
  });
  return `<svg width="${4 * fs}" height="${3 * fs}" viewBox="0 0 ${4 * fs} ${3 * fs}">${r}</svg>`;
}

// deterministic fake history for charts
export function series(n = 300, seed = 3) {
  let s = seed; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = []; let lvl = 15.4;
  for (let i = 0; i < n; i++) { lvl -= 0.004; out.push(+(lvl * (0.84 + r() * 0.34)).toFixed(2)); }
  return out;
}
export function rolling(a, k = 12) { return a.map((_, i) => i < k - 1 ? null : a.slice(i - k + 1, i + 1).sort((x, y) => x - y).slice(1, -1).reduce((p, q) => p + q, 0) / (k - 2)); }

export function chartSVG(w, h, { n = 200, dot = "rgba(255,255,255,.28)", line = "#fff", lineW = 1.6, pad = 6, k = 12 } = {}) {
  const a = series(n), ro = rolling(a, k);
  const lo = Math.min(...a), hi = [...a].sort((x, y) => x - y)[Math.floor(a.length * .97)];
  const X = (i) => pad + i / (n - 1) * (w - 2 * pad), Y = (v) => pad + (1 - (Math.min(v, hi) - lo) / (hi - lo)) * (h - 2 * pad);
  const dots = a.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="1.7" fill="${dot}"/>`).join("");
  const path = ro.map((v, i) => v == null ? "" : `${ro[i - 1] == null ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  return `<svg width="${w}" height="${h}">${dots}<path d="${path}" fill="none" stroke="${line}" stroke-width="${lineW}" stroke-linejoin="round"/></svg>`;
}
