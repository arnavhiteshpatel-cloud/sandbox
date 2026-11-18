/**
 * Personal-best celebration: shockwave ring, particle burst, glowing banner and an optional chime.
 * Triggered with window.dispatchEvent(new CustomEvent("facelet:pb", { detail: PbHit[] })).
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store";

export interface PbHit {
  label: string; // "single" | "mo3" | "ao5" | ...
  value: string;
  gain: string | null; // e.g. "−0.21"
}

const RANK: Record<string, number> = { single: 4, ao5: 4, ao12: 5, mo3: 3, ao50: 3, ao100: 5, ao1000: 5 };

function chime(level: number) {
  try {
    const ctx = new AudioContext();
    const notes = level >= 4 ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 987.77];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.085;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.07, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.75);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {
    /* no audio */
  }
}

export function Celebration() {
  const mode = useStore((s) => s.settings.celebrate);
  const sound = useStore((s) => s.settings.celebrateSound);
  const [hits, setHits] = useState<PbHit[] | null>(null);
  const [key, setKey] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const h = (e: Event) => {
      if (mode === "off") return;
      const d = (e as CustomEvent).detail as PbHit[];
      setHits(d);
      setKey((k) => k + 1);
      const level = Math.max(...d.map((x) => RANK[x.label] ?? 3));
      if (sound) chime(level);
      document.documentElement.classList.add("pb-flash");
      setTimeout(() => document.documentElement.classList.remove("pb-flash"), 2600);
    };
    window.addEventListener("facelet:pb", h);
    return () => window.removeEventListener("facelet:pb", h);
  }, [mode, sound]);

  useEffect(() => {
    if (!hits) return;
    const t = setTimeout(() => setHits(null), mode === "big" ? 4200 : 2800);
    return () => clearTimeout(t);
  }, [hits, key, mode]);

  // particle burst
  useEffect(() => {
    if (!hits || mode !== "big") return;
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7fdcff";
    const colors = [accent, "#ffffff", "#ffd60a", accent, "#5ef2a8"];
    const level = Math.max(...hits.map((x) => RANK[x.label] ?? 3));
    const N = 90 + level * 45;
    const cx = innerWidth / 2,
      cy = innerHeight * 0.48;
    const ps = Array.from({ length: N }, () => {
      const a = Math.random() * Math.PI * 2;
      const sp = 4 + Math.random() * (7 + level * 1.6);
      return { x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, life: 1, s: 2 + Math.random() * 3.5, c: colors[(Math.random() * colors.length) | 0], r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3 };
    });
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      g.clearRect(0, 0, innerWidth, innerHeight);
      // shockwave rings
      for (const [delay, w] of [[0, 3], [0.18, 1.5]] as const) {
        const tt = t - delay;
        if (tt > 0 && tt < 1.1) {
          g.beginPath();
          g.arc(cx, cy, 40 + tt * Math.max(innerWidth, innerHeight) * 0.75, 0, Math.PI * 2);
          g.strokeStyle = accent;
          g.globalAlpha = Math.max(0, 0.55 * (1 - tt / 1.1));
          g.lineWidth = w;
          g.stroke();
        }
      }
      for (const p of ps) {
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.985;
        p.vy = p.vy * 0.985 + 0.12;
        p.r += p.vr;
        p.life -= 0.0065;
        if (p.life <= 0) continue;
        g.globalAlpha = Math.min(1, p.life * 1.4);
        g.fillStyle = p.c;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.r);
        g.fillRect(-p.s, -p.s * 0.45, p.s * 2, p.s * 0.9);
        g.restore();
      }
      g.globalAlpha = 1;
      if (t < 3.6) raf = requestAnimationFrame(tick);
      else g.clearRect(0, 0, innerWidth, innerHeight);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hits, key, mode]);

  if (!hits) return null;
  const top = [...hits].sort((a, b) => (RANK[b.label] ?? 3) - (RANK[a.label] ?? 3));
  return (
    <div className={"pb-layer " + mode} key={key} data-testid="pb-celebration">
      {mode === "big" && <canvas ref={canvas} className="pb-canvas" />}
      <div className="pb-banner">
        <div className="pb-kicker">New personal best</div>
        <div className="pb-items">
          {top.map((h) => (
            <div key={h.label} className="pb-item">
              <span className="pb-label">{h.label === "single" ? "Single" : h.label.toUpperCase()}</span>
              <span className="pb-value num">{h.value}</span>
              {h.gain && <span className="pb-gain num">{h.gain}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
