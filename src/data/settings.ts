export type ThemeId = "hud" | "vision" | "telemetry" | "black";
export type TimerFont = "inter" | "system" | "helvetica" | "mono" | "rounded" | "serif";

export interface Settings {
  showCube3d: boolean;
  showRuler: boolean;
  theme: ThemeId;
  accent: string;
  timerFont: TimerFont;
  timerWeight: number;
  /** relative timer size (1 = default) */
  timerScale: number;
  smallDecimals: boolean;
  scrambleScale: number;
  scrambleFont: "mono" | "sans";
  decimals: 2 | 3;
  /** ms the start key must be held before release starts the timer */
  holdMs: number;
  startKey: "space" | "any";
  inspection: boolean;
  inspectionSeconds: number;
  inspectionVoice: boolean;
  inspectionBeep: boolean;
  /** display during solve: full precision, 0.1s, whole seconds, or hidden */
  runningDisplay: "full" | "tenths" | "seconds" | "hidden";
  hideUiWhileTiming: boolean;
  showScrambleImage: boolean;
  showSidebar: boolean;
  showRolling: string[];
  statsRows: string[];
  trimPct: number;
  confirmDelete: boolean;
  sounds: boolean;
  animations: boolean;
  inputMode: "timer" | "typing";
  cubeColors: string[];
  wordmark: boolean;
  backupDir: string;
  /** solves per session table: show ao columns */
  listColumns: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  showCube3d: true,
  showRuler: true,
  theme: "hud",
  accent: "",
  timerFont: "inter",
  timerWeight: 450,
  timerScale: 1,
  smallDecimals: false,
  scrambleScale: 1,
  scrambleFont: "mono",
  decimals: 2,
  holdMs: 300,
  startKey: "space",
  inspection: true,
  inspectionSeconds: 15,
  inspectionVoice: true,
  inspectionBeep: true,
  runningDisplay: "hidden",
  hideUiWhileTiming: true,
  showScrambleImage: true,
  showSidebar: true,
  showRolling: [],
  statsRows: ["mo3", "ao5", "ao12", "ao25", "ao50", "ao100", "ao200", "ao500", "ao1000", "ao2000", "ao5000", "ao10000"],
  trimPct: 5,
  confirmDelete: false,
  sounds: false,
  animations: true,
  inputMode: "timer",
  cubeColors: ["#ffffff", "#ff3b30", "#2fd158", "#ffd60a", "#ff9f0a", "#0a84ff"],
  wordmark: false,
  backupDir: "",
  listColumns: ["ao5", "ao12"],
};

export const TIMER_FONTS: Record<TimerFont, { label: string; stack: string }> = {
  inter: { label: "Inter", stack: "'Inter Variable', 'Inter', -apple-system, sans-serif" },
  system: { label: "San Francisco", stack: "-apple-system, 'SF Pro Display', 'Inter Variable', sans-serif" },
  helvetica: { label: "Helvetica", stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  mono: { label: "JetBrains Mono", stack: "'JetBrains Mono Variable', ui-monospace, monospace" },
  rounded: { label: "SF Rounded", stack: "ui-rounded, 'SF Pro Rounded', 'Inter Variable', sans-serif" },
  serif: { label: "New York", stack: "ui-serif, 'New York', Georgia, serif" },
};

export const THEMES: Record<ThemeId, { label: string; desc: string; vars: Record<string, string> }> = {
  hud: {
    label: "HUD",
    desc: "Deep space-black, ice-blue light, lit glass edges",
    vars: { "--bg": "#03050a", "--bg-glow": "#0c1220", "--panel-a": "rgba(22,27,38,.72)", "--panel-b": "rgba(9,12,18,.74)", "--edge-a": "rgba(170,200,255,.30)", "--edge-b": "rgba(170,200,255,.05)", "--edge-c": "rgba(170,200,255,.16)", "--grid": "rgba(140,170,255,.045)", "--fg": "#eef3ff", "--fg2": "rgba(214,224,245,.72)", "--fg3": "rgba(190,205,235,.48)", "--fg4": "rgba(170,190,230,.22)", "--line": "rgba(160,185,235,.08)", "--line2": "rgba(160,185,235,.16)", "--accent": "#7fdcff", "--accent-soft": "rgba(127,220,255,.12)", "--glow": "rgba(127,220,255,.18)", "--bg-elev": "#0b0f17", "--bg-elev2": "#121826" },
  },
  vision: {
    label: "Vision",
    desc: "Frosted glass with soft colored light",
    vars: { "--bg": "#06070b", "--bg-glow": "#141a2c", "--panel-a": "rgba(255,255,255,.075)", "--panel-b": "rgba(255,255,255,.035)", "--edge-a": "rgba(255,255,255,.34)", "--edge-b": "rgba(255,255,255,.05)", "--edge-c": "rgba(255,255,255,.14)", "--grid": "transparent", "--fg": "#ffffff", "--fg2": "rgba(255,255,255,.72)", "--fg3": "rgba(255,255,255,.46)", "--fg4": "rgba(255,255,255,.2)", "--line": "rgba(255,255,255,.07)", "--line2": "rgba(255,255,255,.15)", "--accent": "#ffffff", "--accent-soft": "rgba(255,255,255,.14)", "--glow": "rgba(255,255,255,.12)", "--bg-elev": "#12141b", "--bg-elev2": "#1b1e27" },
  },
  telemetry: {
    label: "Telemetry",
    desc: "Amber instrument panel",
    vars: { "--bg": "#050403", "--bg-glow": "#16120c", "--panel-a": "rgba(22,19,14,.8)", "--panel-b": "rgba(10,9,7,.8)", "--edge-a": "rgba(255,190,100,.34)", "--edge-b": "rgba(255,190,100,.05)", "--edge-c": "rgba(255,190,100,.18)", "--grid": "rgba(255,190,100,.045)", "--fg": "#fff7ec", "--fg2": "rgba(255,236,210,.72)", "--fg3": "rgba(255,205,140,.5)", "--fg4": "rgba(255,205,140,.22)", "--line": "rgba(255,190,100,.08)", "--line2": "rgba(255,190,100,.16)", "--accent": "#ffb547", "--accent-soft": "rgba(255,181,71,.13)", "--glow": "rgba(255,181,71,.2)", "--bg-elev": "#110e0a", "--bg-elev2": "#1a1610" },
  },
  black: {
    label: "Pure Black",
    desc: "Flat OLED black, no glow or grid",
    vars: { "--bg": "#000000", "--bg-glow": "#000000", "--panel-a": "#0a0a0b", "--panel-b": "#0a0a0b", "--edge-a": "#1f1f22", "--edge-b": "#1f1f22", "--edge-c": "#1f1f22", "--grid": "transparent", "--fg": "#ffffff", "--fg2": "#a1a1a6", "--fg3": "#6e6e73", "--fg4": "#3a3a3c", "--line": "#1a1a1c", "--line2": "#2c2c2e", "--accent": "#30d158", "--accent-soft": "rgba(48,209,88,.12)", "--glow": "transparent", "--bg-elev": "#0b0b0c", "--bg-elev2": "#141416" },
  },
};
