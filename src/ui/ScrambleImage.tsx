import type { JSX } from "react";
import { memo, useEffect, useMemo, useRef } from "react";
import { Cube, FACES, type Face } from "../core/cube";
import { getEvent } from "../core/events";

/** Flat cube net (U on top, L F R B, D below) drawn from the facelet simulator. */
export const CubeNet = memo(function CubeNet({ n, scramble, colors, unit = 13 }: { n: number; scramble: string; colors: string[]; unit?: number }) {
  const fl = useMemo(() => {
    try {
      return new Cube(n).apply(scramble).facelets();
    } catch {
      return null;
    }
  }, [n, scramble]);
  if (!fl) return null;
  const gap = Math.max(1, unit * 0.09);
  const faceGap = unit * 0.32;
  const fs = n * unit + faceGap;
  const pos: Record<Face, [number, number]> = { U: [1, 0], L: [0, 1], F: [1, 1], R: [2, 1], B: [3, 1], D: [1, 2] };
  const W = 4 * fs;
  const H = 3 * fs;
  const rects: JSX.Element[] = [];
  for (const f of FACES) {
    const [fx, fy] = pos[f];
    fl[f].forEach((c, i) => {
      const r = Math.floor(i / n),
        col = i % n;
      rects.push(
        <rect
          key={f + i}
          x={fx * fs + col * unit + gap / 2}
          y={fy * fs + r * unit + gap / 2}
          width={unit - gap}
          height={unit - gap}
          rx={unit * 0.06}
          fill={colors[c] ?? "#888"}
        />,
      );
    });
  }
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} data-testid="cube-net">
      {rects}
    </svg>
  );
});

const TWISTY_PUZZLE: Record<string, string> = {
  minx: "megaminx",
  pyram: "pyraminx",
  skewb: "skewb",
  sq1: "square1",
  clock: "clock",
  fto: "fto",
};

/** Non-cube puzzles: cubing.js 2D renderer. */
function TwistyImage({ puzzle, scramble, width }: { puzzle: string; scramble: string; width: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let el: HTMLElement | null = null;
    import("cubing/twisty").then(({ TwistyPlayer }) => {
      if (cancelled || !host.current) return;
      const p = new TwistyPlayer({
        puzzle: puzzle as any,
        experimentalSetupAlg: scramble,
        alg: "",
        visualization: "2D",
        controlPanel: "none",
        background: "none",
        hintFacelets: "none",
      });
      p.style.width = width + "px";
      p.style.height = Math.round(width * 0.62) + "px";
      host.current.innerHTML = "";
      host.current.appendChild(p);
      el = p;
    });
    return () => {
      cancelled = true;
      el?.remove();
    };
  }, [puzzle, scramble, width]);
  return <div ref={host} />;
}

export function ScrambleImage({ eventId, scramble, colors, width = 230 }: { eventId: string; scramble: string; colors: string[]; width?: number }) {
  const ev = getEvent(eventId);
  if (!scramble) return null;
  if (ev.puzzle === "cube" || ev.puzzle === "none") {
    const n = ev.size ?? (/^222/.test(eventId) ? 2 : /^444/.test(eventId) ? 4 : /^555/.test(eventId) ? 5 : 3);
    return <CubeNet n={n} scramble={scramble} colors={colors} unit={width / (4 * n + 1.3)} />;
  }
  const tp = TWISTY_PUZZLE[ev.puzzle];
  if (!tp) return null;
  return <TwistyImage puzzle={tp} scramble={scramble} width={width} />;
}
