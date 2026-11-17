/** Crisp last-layer diagrams (top-down and 2-side isometric) drawn from the facelet simulator. */
import { memo, useMemo, type JSX } from "react";
import { useStore } from "../../data/store";
import type { LLView } from "../../core/llstate";
import { canonicalPre, caseView, pllArrows, type AlgCase, type Arrow } from "../../core/train/cases";

/**
 * Yellow-top colour scheme (the cube held with yellow on top and green in front, i.e. the
 * WCA orientation turned with z2): U→yellow, D→white, F→green, B→blue, R→orange, L→red.
 * Indices follow the simulator's face order U R F D L B into the user's colour setting.
 */
const YELLOW_TOP = [3, 4, 2, 0, 1, 5];

export function useLLColours(): string[] {
  const cc = useStore((s) => s.settings.cubeColors);
  return useMemo(() => YELLOW_TOP.map((i) => cc[i]), [cc]);
}

const GREY = "color-mix(in srgb, var(--fg) 13%, var(--bg-elev))";

export type DiagramMode = "oll" | "pll";

export const LLDiagram = memo(function LLDiagram({
  view,
  size = 100,
  mode = "pll",
  arrows,
  hideSides,
  className,
}: {
  view: LLView;
  size?: number;
  mode?: DiagramMode;
  arrows?: Arrow[];
  hideSides?: ("F" | "R" | "B" | "L")[];
  className?: string;
}) {
  const colours = useLLColours();
  const fill = (c: number) => (mode === "oll" ? (c === 0 ? colours[0] : GREY) : colours[c]);
  // geometry in a 100-unit box: 3 cells of 26 with gap 2, side strips 7 thick at 2.4 offset
  const cell = 24.2,
    gap = 2.2,
    strip = 6.6,
    off = 2.6;
  const inner = 3 * cell + 2 * gap;
  const o = strip + off; // origin of the U face
  const total = inner + 2 * o;
  const r = 2.6;
  const rects: JSX.Element[] = [];
  const pos = (i: number) => [o + (i % 3) * (cell + gap), o + Math.floor(i / 3) * (cell + gap)];
  view.U.forEach((c, i) => {
    const [x, y] = pos(i);
    rects.push(<rect key={"u" + i} x={x} y={y} width={cell} height={cell} rx={r} style={{ fill: fill(c) }} />);
  });
  const hidden = new Set(hideSides ?? []);
  const sideCell = (k: string, x: number, y: number, w: number, h: number, c: number, hide: boolean) => (
    <rect key={k} x={x} y={y} width={w} height={h} rx={1.6} style={{ fill: hide ? "color-mix(in srgb, var(--fg) 6%, transparent)" : fill(c) }} />
  );
  for (let j = 0; j < 3; j++) {
    const along = o + j * (cell + gap);
    // B along the top, drawn right→left
    rects.push(sideCell("b" + j, along, 0, cell, strip, view.B[2 - j], hidden.has("B")));
    // F along the bottom, left→right
    rects.push(sideCell("f" + j, along, total - strip, cell, strip, view.F[j], hidden.has("F")));
    // L down the left side
    rects.push(sideCell("l" + j, 0, along, strip, cell, view.L[j], hidden.has("L")));
    // R down the right side, back (top) to front (bottom)
    rects.push(sideCell("r" + j, total - strip, along, strip, cell, view.R[2 - j], hidden.has("R")));
  }
  const centre = (i: number) => {
    const [x, y] = pos(i);
    return [x + cell / 2, y + cell / 2];
  };
  const arrowEls = (arrows ?? []).map((a, k) => {
    const [x1, y1] = centre(a.from);
    const [x2, y2] = centre(a.to);
    const dx = x2 - x1,
      dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const trim = 7;
    const ux = dx / len,
      uy = dy / len;
    const sx = x1 + ux * (a.both ? trim : trim * 0.6),
      sy = y1 + uy * (a.both ? trim : trim * 0.6);
    const ex = x2 - ux * trim,
      ey = y2 - uy * trim;
    return <line key={k} x1={sx} y1={sy} x2={ex} y2={ey} className="ll-arrow" markerEnd="url(#llh)" markerStart={a.both ? "url(#llt)" : undefined} />;
  });
  return (
    <svg className={"ll-diagram " + (className ?? "")} width={size} height={size} viewBox={`0 0 ${total} ${total}`} aria-hidden>
      {arrows && arrows.length > 0 && (
        <defs>
          <marker id="llh" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.2" markerHeight="4.2" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" className="ll-head" />
          </marker>
          <marker id="llt" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="4.2" markerHeight="4.2" orient="auto">
            <path d="M10,0 L0,5 L10,10 z" className="ll-head" />
          </marker>
        </defs>
      )}
      {rects}
      {arrowEls}
    </svg>
  );
});

/** Diagram for a case (by algorithm) with optional pre/post AUF. */
export function CaseDiagram({ alg, set, size = 100, pre = "", post = "", arrows = true, hideSides }: { alg: string; set: string; size?: number; pre?: string; post?: string; arrows?: boolean; hideSides?: ("F" | "R" | "B" | "L")[] }) {
  const view = useMemo(() => caseView(alg, pre, post), [alg, pre, post]);
  const arr = useMemo(() => (set === "PLL" && arrows && !post && size >= 80 ? pllArrows(alg, pre) : undefined), [alg, set, pre, arrows, post, size]);
  return <LLDiagram view={view} size={size} mode={set === "OLL" ? "oll" : "pll"} arrows={arr} hideSides={hideSides} />;
}

/** Reference diagram of a case (PLL drawn at the angle with the fewest moved pieces). */
export function RefDiagram({ c, size = 100, arrows = true }: { c: AlgCase; size?: number; arrows?: boolean }) {
  return <CaseDiagram alg={c.algs[0]} set={c.set} size={size} pre={canonicalPre(c)} arrows={arrows} />;
}

/**
 * 2-side recognition view: the cube seen from the front-right corner, showing the U face,
 * and the F and R faces (top row from the case, lower two rows solved).
 */
export const IsoLL = memo(function IsoLL({ view, size = 220, mode = "pll" }: { view: LLView; size?: number; mode?: DiagramMode }) {
  const colours = useLLColours();
  const fill = (c: number) => (mode === "oll" ? (c === 0 ? colours[0] : GREY) : colours[c]);
  const s = 1;
  const c30 = Math.cos(Math.PI / 6),
    s30 = 0.5;
  const P = (x: number, y: number, z: number) => [(x - z) * c30 * s, (x + z) * s30 * s - y * s];
  const poly = (pts: number[][], k: string, colour: string, inset = 0.085) => {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const d = pts.map((p) => [cx + (p[0] - cx) * (1 - inset * 2), cy + (p[1] - cy) * (1 - inset * 2)]);
    return <polygon key={k} points={d.map((p) => p.map((v) => v.toFixed(3)).join(",")).join(" ")} style={{ fill: colour }} strokeLinejoin="round" />;
  };
  const els: JSX.Element[] = [];
  // body silhouette
  const sil = [P(0, 3, 0), P(3, 3, 0), P(3, 0, 0), P(3, 0, 3), P(0, 0, 3), P(0, 3, 3)];
  els.push(<polygon key="body" points={sil.map((p) => p.join(",")).join(" ")} className="iso-body" />);
  for (let i = 0; i < 9; i++) {
    const r = Math.floor(i / 3),
      c = i % 3;
    els.push(poly([P(c, 3, r), P(c + 1, 3, r), P(c + 1, 3, r + 1), P(c, 3, r + 1)], "u" + i, fill(view.U[i])));
  }
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      const fc = r === 0 ? view.F[c] : 2;
      els.push(poly([P(c, 3 - r, 3), P(c + 1, 3 - r, 3), P(c + 1, 2 - r, 3), P(c, 2 - r, 3)], `f${r}${c}`, r === 0 ? fill(fc) : fill(2) + ""));
      const rc = r === 0 ? view.R[c] : 1;
      // R column c: c=0 at the front (z=3)
      els.push(poly([P(3, 3 - r, 3 - c), P(3, 3 - r, 2 - c), P(3, 2 - r, 2 - c), P(3, 2 - r, 3 - c)], `r${r}${c}`, fill(rc)));
    }
  const minX = -3 * c30,
    maxX = 3 * c30,
    minY = -3,
    maxY = 3;
  const pad = 0.12;
  return (
    <svg className="iso-ll" width={size} height={size * ((maxY - minY + 2 * pad) / (maxX - minX + 2 * pad))} viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`} aria-hidden>
      {els}
    </svg>
  );
});

/** Heat colour (bad → warn → good) for a 0..1 mastery value, theme-aware via CSS variables. */
export function heat(m: number | null): string {
  if (m == null) return "color-mix(in srgb, var(--fg) 5%, transparent)";
  if (m < 0.5) return `color-mix(in oklab, var(--warn) ${Math.round((m / 0.5) * 100)}%, var(--bad))`;
  return `color-mix(in oklab, var(--good) ${Math.round(((m - 0.5) / 0.5) * 100)}%, var(--warn))`;
}
