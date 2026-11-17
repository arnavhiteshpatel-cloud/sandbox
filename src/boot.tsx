import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Development-only helper used by automated screenshots/tests: loads a synthetic csTimer backup.
if (import.meta.env.DEV) {
  (window as any).__faceletDemo = async (opts?: any) => {
    const [{ makeCsTimerBackup }, { parseBackup }, { planImport, importRecordFor }, { useStore }] = await Promise.all([
      import("./core/testdata"),
      import("./core/importer"),
      import("./core/importPlan"),
      import("./data/store"),
    ]);
    const text = JSON.stringify(makeCsTimerBackup(opts));
    const parsed = parseBackup(text, "demo.txt");
    const st = useStore.getState();
    const plan = planImport(parsed, st.sessions, st.solves);
    const ph = st.sessions.filter((s) => (s.opt as any)?.autoCreated && !st.solves.some((x) => x.sessionId === s.id));
    if (ph.length) await st.backend!.apply([{ t: "hardDeleteSessions", ids: ph.map((s) => s.id) }]);
    await st.backend!.importCommit(importRecordFor(plan, "demo.txt", parsed.format, "demo", text.length, parsed.warnings), plan.sessions, plan.solves, text);
    await st.reload();
    st.setCurrentSession(plan.sessions[0].id);
    return plan.totals;
  };
}
if (import.meta.env.DEV) {
  import("./data/store").then(({ useStore }) => ((window as any).__faceletStore = useStore));
}

// Native self-test (only when FACELET_SELFTEST is set in the environment).
if ("__TAURI_INTERNALS__" in window) {
  import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke<string | null>("selftest_mode").then((phase) => {
      if (phase) import("./selftest").then((m) => m.runSelfTest(phase));
    }),
  );
}
