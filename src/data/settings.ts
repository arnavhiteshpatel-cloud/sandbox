export type ThemeId = "oled" | "graphite" | "midnight" | "paper";
export type TimerFont = "inter" | "system" | "helvetica" | "mono" | "rounded" | "serif";

export interface Settings {
  layout: "rail" | "stage";
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
  layout: "rail",
  theme: "oled",
  accent: "#30d158",
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
  showRolling: ["ao5", "ao12"],
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

export const THEMES: Record<ThemeId, { label: string; vars: Record<string, string> }> = {
  oled: {
    label: "OLED Black",
    vars: { "--bg": "#000000", "--bg-elev": "#0b0b0c", "--bg-elev2": "#141416", "--fg": "#ffffff", "--fg2": "#a1a1a6", "--fg3": "#636366", "--fg4": "#3a3a3c", "--line": "#1c1c1e", "--line2": "#2c2c2e", "--tile-bg": "#ffffff", "--tile-fg": "#000000" },
  },
  graphite: {
    label: "Graphite",
    vars: { "--bg": "#111113", "--bg-elev": "#1a1a1d", "--bg-elev2": "#232327", "--fg": "#f5f5f7", "--fg2": "#a1a1a6", "--fg3": "#6e6e73", "--fg4": "#424245", "--line": "#252528", "--line2": "#343438", "--tile-bg": "#f5f5f7", "--tile-fg": "#111113" },
  },
  midnight: {
    label: "Midnight",
    vars: { "--bg": "#05070d", "--bg-elev": "#0b0f1a", "--bg-elev2": "#121828", "--fg": "#eef2ff", "--fg2": "#9aa3b8", "--fg3": "#5d6579", "--fg4": "#323a4d", "--line": "#141a2a", "--line2": "#1f2738", "--tile-bg": "#eef2ff", "--tile-fg": "#05070d" },
  },
  paper: {
    label: "Paper",
    vars: { "--bg": "#f6f5f2", "--bg-elev": "#ffffff", "--bg-elev2": "#eeece8", "--fg": "#0a0a0a", "--fg2": "#55555a", "--fg3": "#8e8e93", "--fg4": "#c7c7cc", "--line": "#e5e3df", "--line2": "#d6d4cf", "--tile-bg": "#0a0a0a", "--tile-fg": "#f6f5f2" },
  },
};
