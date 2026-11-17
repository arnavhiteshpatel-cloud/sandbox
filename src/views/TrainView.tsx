/** Training: algorithm library, recognition, timed drills with spaced repetition, cross/F2L practice, phase splits and a computed plan. */
import { useEffect, useMemo } from "react";
import "../styles/train.css";
import { useTrain } from "../data/trainStore";
import { layersOpen } from "../ui/Overlay";
import { computePlan } from "../core/train/plan";
import { useTrainNav, type Tab } from "./train/common";
import { Library } from "./train/Library";
import { CaseModal } from "./train/CaseModal";
import { Recognition } from "./train/Recognition";
import { Drill } from "./train/Drill";
import { Cross } from "./train/Cross";
import { F2L } from "./train/F2L";
import { Phases } from "./train/Phases";
import { PlanView } from "./train/Plan";

const TABS: { v: Tab; label: string; sub: string }[] = [
  { v: "library", label: "Library", sub: "OLL & PLL algorithms, status, notes and collections" },
  { v: "recognition", label: "Recognition", sub: "Name the case as fast as you can" },
  { v: "drill", label: "Drill", sub: "Timed execution with spaced repetition" },
  { v: "cross", label: "Cross", sub: "Plan the cross in inspection, then check against the optimum" },
  { v: "f2l", label: "F2L", sub: "Timed F2L and last-slot practice from cross-solved states" },
  { v: "phases", label: "Phases", sub: "Full solves with cross / F2L / OLL / PLL splits" },
  { v: "plan", label: "Plan", sub: "What to practise today, and why" },
];

export default function TrainView() {
  const tab = useTrain((t) => t.s.prefs.tab) as Tab;
  const setPref = useTrain((t) => t.setPref);
  const s = useTrain((t) => t.s);
  const openCase = useTrainNav((n) => n.openCase);
  const setOpenCase = useTrainNav((n) => n.setOpenCase);
  const cur = TABS.find((t) => t.v === tab) ?? TABS[0];
  const dueCount = useMemo(() => computePlan(s, Date.now()).due.length, [s]);

  // [ and ] cycle through the sub-views
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (layersOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.key === "[" || e.key === "]") {
        const i = TABS.findIndex((x) => x.v === cur.v);
        const n = TABS[(i + (e.key === "]" ? 1 : TABS.length - 1)) % TABS.length];
        setPref("tab", n.v);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [cur.v, setPref]);

  return (
    <div className="page tr-page" data-testid="train-view">
      <header className="tr-head fade-when-timing">
        <div>
          <h1 className="page-title">Training</h1>
          <p className="page-sub">{cur.sub}</p>
        </div>
        <nav className="tr-tabs" role="tablist" data-testid="train-tabs">
          {TABS.map((t) => (
            <button key={t.v} role="tab" aria-selected={t.v === cur.v} className={t.v === cur.v ? "on" : ""} onClick={() => setPref("tab", t.v)} data-testid={"tab-" + t.v} title={t.sub}>
              {t.label}
              {t.v === "plan" && dueCount > 0 && <span className="tr-badge num">{dueCount}</span>}
            </button>
          ))}
        </nav>
      </header>
      <div className="tr-body" key={cur.v}>
        {cur.v === "library" && <Library />}
        {cur.v === "recognition" && <Recognition />}
        {cur.v === "drill" && <Drill />}
        {cur.v === "cross" && <Cross />}
        {cur.v === "f2l" && <F2L />}
        {cur.v === "phases" && <Phases />}
        {cur.v === "plan" && <PlanView />}
      </div>
      {openCase && <CaseModal id={openCase} onClose={() => setOpenCase(null)} />}
    </div>
  );
}
