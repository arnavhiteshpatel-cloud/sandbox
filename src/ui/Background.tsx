/**
 * App background layer. Static options are pure CSS; animated ones draw on a canvas at a
 * capped frame rate, pause when the window is hidden and (optionally) while a solve runs,
 * so they cost almost nothing when you're not looking.
 */
import { useEffect, useRef } from "react";
import { useStore } from "../data/store";

type Draw = (g: CanvasRenderingContext2D, w: number, h: number, t: number) => void;

function accentRgb() {
  const c = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7fdcff";
  const n = parseInt(c.replace("#", "").padEnd(6, "f").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function makeStarfield(w: number, h: number): Draw {
  const stars = Array.from({ length: Math.round((w * h) / 5200) }, () => ({ x: Math.random() * w, y: Math.random() * h, z: 0.2 + Math.random() * 0.8, tw: Math.random() * Math.PI * 2 }));
  const [r, gg, b] = accentRgb();
  return (g, W, H, t) => {
    g.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.x -= 0.06 * s.z;
      s.y += 0.015 * s.z;
      if (s.x < 0) s.x += W;
      if (s.y > H) s.y -= H;
      const a = 0.25 + 0.55 * s.z * (0.75 + 0.25 * Math.sin(t * 1.3 + s.tw));
      g.fillStyle = s.z > 0.92 ? `rgba(${r},${gg},${b},${a})` : `rgba(235,240,255,${a})`;
      g.fillRect(s.x, s.y, s.z * 1.6, s.z * 1.6);
    }
  };
}

function makeConstellation(w: number, h: number): Draw {
  const pts = Array.from({ length: Math.round((w * h) / 26000) }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12 }));
  const [r, gg, b] = accentRgb();
  return (g, W, H) => {
    g.clearRect(0, 0, W, H);
    for (const p of pts) {
      p.x = (p.x + p.vx + W) % W;
      p.y = (p.y + p.vy + H) % H;
    }
    const maxD = 150;
    g.lineWidth = 1;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x,
          dy = pts[i].y - pts[j].y;
        const d = Math.hypot(dx, dy);
        if (d < maxD) {
          g.strokeStyle = `rgba(${r},${gg},${b},${0.12 * (1 - d / maxD)})`;
          g.beginPath();
          g.moveTo(pts[i].x, pts[i].y);
          g.lineTo(pts[j].x, pts[j].y);
          g.stroke();
        }
      }
    g.fillStyle = `rgba(${r},${gg},${b},0.5)`;
    for (const p of pts) g.fillRect(p.x - 1, p.y - 1, 2, 2);
  };
}

function CanvasBg({ kind, paused }: { kind: "starfield" | "constellation"; paused: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext("2d")!;
    let draw: Draw;
    let raf = 0;
    let last = 0;
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = innerWidth * dpr;
      c.height = innerHeight * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw = kind === "starfield" ? makeStarfield(innerWidth, innerHeight) : makeConstellation(innerWidth, innerHeight);
      draw(g, innerWidth, innerHeight, 0);
    };
    size();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || pausedRef.current || now - last < 33) return; // ≤30 fps
      last = now;
      draw(g, innerWidth, innerHeight, now / 1000);
    };
    raf = requestAnimationFrame(loop);
    addEventListener("resize", size);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", size);
    };
  }, [kind, theme]);
  return <canvas ref={ref} className="bg-canvas" />;
}

export function Background() {
  const s = useStore((x) => x.settings);
  const timing = useStore((x) => x.timing);
  const paused = s.bgPauseWhileSolving && timing;
  const bg = s.background;
  return (
    <div className={"bg-root bg-" + bg + (paused ? " bg-paused" : "")} aria-hidden>
      {(bg === "theme" || bg === "glow" || bg === "grid" || bg === "starfield" || bg === "aurora" || bg === "constellation") && <div className="bg-layer" />}
      {(bg === "theme" || bg === "grid") && <div className="grid-layer" />}
      {bg === "aurora" && (
        <div className="aurora">
          <i className="a1" />
          <i className="a2" />
          <i className="a3" />
        </div>
      )}
      {(bg === "starfield" || bg === "constellation") && <CanvasBg kind={bg} paused={paused} />}
      {bg === "image" && s.bgImage && <div className="bg-image" style={{ backgroundImage: `url(${s.bgImage})` }} />}
      <div className="bg-dim" style={{ opacity: s.bgDim / 100 }} />
    </div>
  );
}

/** Read an image file, downscale to ≤2560 px and return a compact JPEG data URL. */
export function pickBackgroundImage(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 2560 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => resolve(null);
      img.src = url;
    };
    input.click();
  });
}
