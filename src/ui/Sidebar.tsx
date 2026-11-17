import { useMemo } from "react";
import { liveSessions, useStore } from "../data/store";
import { getEvent } from "../core/events";
import { IconChevronDown } from "./icons";
import { Menu, useMenu } from "./Overlay";
import { AvgDetail } from "./AvgDetail";
import { NavIcons, Sparkline, SolveList, StatsBand, StatsTable, SummaryLine, useDetailState, useSessionData } from "./blocks";

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

/** Layout "rail": slim icon strip on the left, typographic stats rail on the right. */
export function NavStrip() {
  return (
    <div className="nav-strip fade-when-timing">
      <NavIcons vertical />
    </div>
  );
}

export function Rail() {
  const { settings, solves, stats, d } = useSessionData();
  const [detail, setDetail] = useDetailState();
  return (
    <aside className={"rail fade-when-timing" + (settings.showSidebar ? "" : " hidden")} data-testid="sidebar">
      <div className="rail-head">
        <SessionPicker />
      </div>
      <SummaryLine stats={stats} d={d} />
      <Sparkline solves={solves} stats={stats} />
      <StatsTable solves={solves} stats={stats} d={d} onDetail={setDetail} />
      <SolveList solves={solves} stats={stats} d={d} columns={settings.listColumns} />
      {detail && <AvgDetail solves={solves} label={detail.label} end={detail.end} onClose={() => setDetail(null)} />}
    </aside>
  );
}

/** Layout "stage": no side panels; a full-width instrument band at the bottom. */
export function StageFooter() {
  const { solves, stats, d } = useSessionData();
  const [detail, setDetail] = useDetailState();
  return (
    <div className="stage-footer fade-when-timing">
      <div className="stage-footer-top">
        <SummaryLine stats={stats} d={d} />
        <div style={{ flex: 1, maxWidth: 520 }}>
          <Sparkline solves={solves} stats={stats} height={40} />
        </div>
      </div>
      <StatsBand solves={solves} stats={stats} d={d} onDetail={setDetail} />
      {detail && <AvgDetail solves={solves} label={detail.label} end={detail.end} onClose={() => setDetail(null)} />}
    </div>
  );
}
