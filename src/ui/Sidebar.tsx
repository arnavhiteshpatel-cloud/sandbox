import { useMemo } from "react";
import { liveSessions, useStore } from "../data/store";
import { getEvent } from "../core/events";
import { IconChevronDown } from "./icons";
import { Menu, useMenu } from "./Overlay";

export function SessionPicker({ showEvent = true }: { showEvent?: boolean }) {
  const sessions = useStore((s) => s.sessions);
  const solves = useStore((s) => s.solves);
  const current = useStore((s) => s.currentSessionId);
  const setCurrent = useStore((s) => s.setCurrentSession);
  const createSession = useStore((s) => s.createSession);
  const setView = useStore((s) => s.setView);
  const menu = useMenu();
  const live = liveSessions(sessions);
  const cur = live.find((s) => s.id === current);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of solves) if (!s.deletedAt) m.set(s.sessionId, (m.get(s.sessionId) ?? 0) + 1);
    return m;
  }, [solves]);
  return (
    <>
      <button className="session-btn" onClick={menu.open} data-testid="session-picker" title="Switch session  ⌥↑ ⌥↓">
        <span className="name">{cur?.name ?? "—"}</span>
        {showEvent && <span className="event-chip">{getEvent(cur?.event ?? "333").short}</span>}
        <IconChevronDown size={12} />
      </button>
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          minWidth={260}
          items={[
            ...live.map((s) => ({
              label: s.name,
              meta: `${getEvent(s.event).short} · ${(counts.get(s.id) ?? 0).toLocaleString()}`,
              selected: s.id === current,
              onSelect: () => setCurrent(s.id),
            })),
            { sep: true },
            {
              label: "New session…",
              testId: "new-session",
              onSelect: () => {
                const name = window.prompt("Session name", `Session ${live.length + 1}`);
                if (name) createSession({ name: name.trim(), event: cur?.event ?? "333" });
              },
            },
            { label: "Manage sessions…", onSelect: () => setView("sessions") },
          ]}
        />
      )}
    </>
  );
}

