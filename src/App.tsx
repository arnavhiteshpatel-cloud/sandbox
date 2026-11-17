import { lazy, Suspense, useEffect, useState } from "react";
import { liveSessions, sessionSolves, useStore, type View } from "./data/store";
import { NavStrip, Rail } from "./ui/Sidebar";
import { TimerView, engine } from "./views/TimerView";
import { SolveSheet } from "./ui/SolveSheet";
import { THEMES, TIMER_FONTS } from "./data/settings";
import { layersOpen, Modal } from "./ui/Overlay";
import { useScramble } from "./scramble/useScramble";
import { NavIcons } from "./ui/blocks";

const HistoryView = lazy(() => import("./views/HistoryView"));
const AnalyticsView = lazy(() => import("./views/AnalyticsView"));
const TrainView = lazy(() => import("./views/TrainView"));
const SessionsView = lazy(() => import("./views/SessionsView"));
const SettingsView = lazy(() => import("./views/SettingsView"));

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + (t.kind ?? "")} data-testid="toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Space", "Hold to arm, release to start (any key stops)"],
  ["Esc", "Cancel inspection / close panels / back to timer"],
  ["⌘Z / ⇧⌘Z", "Undo / redo"],
  ["⌘1 / ⌘2 / ⌘3", "Last solve: OK / +2 / DNF"],
  ["⌘⌫", "Delete last solve"],
  ["⌘E", "Comment on last solve"],
  ["← / →", "Previous / next scramble"],
  ["⌥↑ / ⌥↓", "Previous / next session"],
  ["⌘N", "New session"],
  ["⌘I", "Toggle inspection"],
  ["⌘\\", "Toggle side panel"],
  ["F  or  ⌃⌘F", "Fullscreen"],
  ["⌥1 … ⌥5, ⌥,", "Timer, History, Analytics, Training, Sessions, Settings"],
  ["?", "This list"],
];

export default function App() {
  const ready = useStore((s) => s.ready);
  const fatal = useStore((s) => s.fatal);
  const view = useStore((s) => s.view);
  const timing = useStore((s) => s.timing);
  const settings = useStore((s) => s.settings);
  const openSolveId = useStore((s) => s.openSolveId);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    useStore.getState().init();
  }, []);

  // theme / typography
  useEffect(() => {
    const root = document.documentElement;
    const t = THEMES[settings.theme] ?? THEMES.oled;
    for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
    root.style.setProperty("--accent", settings.accent);
    root.style.setProperty("--font-timer", TIMER_FONTS[settings.timerFont]?.stack ?? TIMER_FONTS.inter.stack);
    root.style.setProperty("--timer-weight", String(settings.timerWeight));
    root.style.colorScheme = settings.theme === "paper" ? "light" : "dark";
    document.body.classList.toggle("no-anim", !settings.animations);
  }, [settings.theme, settings.accent, settings.timerFont, settings.timerWeight, settings.animations]);

  // global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (engine.active) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const st = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const lastSolve = () => sessionSolves(st.solves, st.currentSessionId).at(-1);
      const go = (v: View) => {
        e.preventDefault();
        st.setView(v);
      };
      if (e.altKey && !mod) {
        const map: Record<string, View> = { Digit1: "timer", Digit2: "history", Digit3: "analytics", Digit4: "train", Digit5: "sessions", Comma: "settings" };
        if (map[e.code]) return go(map[e.code]);
        if (e.code === "ArrowUp" || e.code === "ArrowDown") {
          const list = liveSessions(st.sessions);
          const i = list.findIndex((s) => s.id === st.currentSessionId);
          const n = list[i + (e.code === "ArrowUp" ? -1 : 1)];
          if (n) st.setCurrentSession(n.id);
          e.preventDefault();
          return;
        }
      }
      if (layersOpen()) return;
      if (mod && e.code === "KeyZ") {
        e.preventDefault();
        return e.shiftKey ? st.redo() : st.undo();
      }
      if (mod && e.code === "KeyY") {
        e.preventDefault();
        return st.redo();
      }
      if (mod && ["Digit1", "Digit2", "Digit3"].includes(e.code)) {
        const l = lastSolve();
        e.preventDefault();
        if (l) st.updateSolves([l.id], () => ({ penalty: e.code === "Digit1" ? 0 : e.code === "Digit2" ? 2000 : -1 }), "Change penalty");
        return;
      }
      if (mod && e.code === "Backspace") {
        const l = lastSolve();
        e.preventDefault();
        if (l) st.deleteSolves([l.id]);
        return;
      }
      if (mod && e.code === "KeyE") {
        const l = lastSolve();
        e.preventDefault();
        if (l) st.openSolve(l.id);
        return;
      }
      if (mod && e.code === "KeyN") {
        e.preventDefault();
        const name = window.prompt("New session name", `Session ${liveSessions(st.sessions).length + 1}`);
        if (name) st.createSession({ name, event: st.sessions.find((s) => s.id === st.currentSessionId)?.event });
        return;
      }
      if (mod && e.code === "KeyI") {
        e.preventDefault();
        st.updateSettings({ inspection: !st.settings.inspection });
        st.toast(`Inspection ${!st.settings.inspection ? "on" : "off"}`);
        return;
      }
      if (mod && e.code === "Backslash") {
        e.preventDefault();
        st.updateSettings({ showSidebar: !st.settings.showSidebar });
        return;
      }
      if ((e.code === "KeyF" && !mod && !e.altKey) || (e.code === "KeyF" && e.metaKey && e.ctrlKey)) {
        e.preventDefault();
        st.backend?.isFullscreen().then((fs) => st.backend?.setFullscreen(!fs));
        return;
      }
      if (e.key === "?") {
        setHelp((h) => !h);
        return;
      }
      if (e.code === "Escape" && st.view !== "timer") return go("timer");
      if (st.view === "timer" && !mod && !e.altKey) {
        if (e.code === "ArrowLeft") {
          e.preventDefault();
          useScramble.getState().prev();
        } else if (e.code === "ArrowRight") {
          e.preventDefault();
          useScramble.getState().next();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (fatal)
    return (
      <div className="splash" style={{ flexDirection: "column", gap: 10 }}>
        <div style={{ color: "var(--bad)" }}>Could not open the database</div>
        <div className="mono" style={{ fontSize: 12 }}>{fatal}</div>
      </div>
    );
  if (!ready) return <div className="splash">facelet</div>;

  return (
    <div className={"app" + (timing ? " timing" : "")} data-testid="app">
      <div className="drag-strip" data-tauri-drag-region />
      {settings.layout === "rail" && <NavStrip />}
      {view === "timer" ? (
        <TimerView layout={settings.layout} />
      ) : (
        <Suspense fallback={<div className="main" />}>
          <div className="main" key={view}>
            {settings.layout === "stage" && (
              <div className="topbar-left" style={{ top: 22, position: "absolute" }}>
                <NavIcons />
              </div>
            )}
            {view === "history" && <HistoryView />}
            {view === "analytics" && <AnalyticsView />}
            {view === "train" && <TrainView />}
            {view === "sessions" && <SessionsView />}
            {view === "settings" && <SettingsView />}
          </div>
        </Suspense>
      )}
      {settings.layout === "rail" && view === "timer" && <Rail />}
      {openSolveId && <SolveSheet />}
      {help && (
        <Modal title="Keyboard shortcuts" onClose={() => setHelp(false)}>
          <table className="tbl">
            <tbody>
              {SHORTCUTS.map(([k, d]) => (
                <tr key={k}>
                  <td style={{ width: 150 }}>
                    <span className="kbd">{k}</span>
                  </td>
                  <td className="muted">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      <Toasts />
    </div>
  );
}
