import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/jetbrains-mono/index.css";
export * from "./mock.js";
import { SCRAMBLE } from "./mock.js";
export async function cube3d(el, size) {
  const { TwistyPlayer } = await import("cubing/twisty");
  const p = new TwistyPlayer({ puzzle: "3x3x3", experimentalSetupAlg: SCRAMBLE, alg: "", background: "none", controlPanel: "none", hintFacelets: "none", cameraLatitude: 28, cameraLongitude: 32 });
  p.style.width = size + "px"; p.style.height = size + "px";
  el.appendChild(p);
}
/** Precision ruler: where the latest solve sits relative to PB and averages. */
export function ruler(w, marks, value, { lo = 8, hi = 18, color = "#7fdcff" } = {}) {
  const X = (v) => 20 + (v - lo) / (hi - lo) * (w - 40);
  let ticks = "";
  for (let t = lo; t <= hi + 1e-9; t += 0.25) {
    const major = Math.abs(t - Math.round(t)) < 1e-9;
    ticks += `<line x1="${X(t)}" x2="${X(t)}" y1="${major ? 30 : 36}" y2="46" stroke="rgba(190,205,235,${major ? .45 : .16})" stroke-width="1"/>`;
    if (major) ticks += `<text x="${X(t)}" y="62" fill="rgba(190,205,235,.38)" font-size="10" font-family="JetBrains Mono Variable" text-anchor="middle">${t}</text>`;
  }
  let lastX = -1e9, lvl = 0;
  const mk = marks.map(([l, v]) => { const x = X(v); lvl = x - lastX < 90 ? lvl + 1 : 0; lastX = x; const y = 16 - lvl * 12;
    return `<line x1="${x}" x2="${x}" y1="${y + 4}" y2="46" stroke="rgba(230,238,255,.35)" stroke-width="1"/><text x="${x + 4}" y="${y}" fill="rgba(230,238,255,.75)" font-size="10" font-family="JetBrains Mono Variable">${l} ${v.toFixed(2)}</text>`; }).join("");
  const cur = `<defs><filter id="gl"><feGaussianBlur stdDeviation="3"/></filter></defs><line x1="${X(value)}" x2="${X(value)}" y1="18" y2="50" stroke="${color}" stroke-width="5" filter="url(#gl)" opacity=".7"/><line x1="${X(value)}" x2="${X(value)}" y1="18" y2="50" stroke="${color}" stroke-width="2"/>`;
  return `<svg width="${w}" height="70" style="overflow:visible"><line x1="20" x2="${w - 20}" y1="46" y2="46" stroke="rgba(190,205,235,.25)"/>${ticks}${mk}${cur}</svg>`;
}
