import { useMemo } from "react";
import { useTrain } from "../../data/trainStore";
import { computePlan, type PlanAction } from "../../core/train/plan";
import { getCase, shortName } from "../../core/train/cases";
import { RefDiagram } from "./diagram";
import { ADHOC, sec, useTrainNav } from "./common";

export function PlanView() {
  const s = useTrain((t) => t.s);
  const setOpenCase = useTrainNav((n) => n.setOpenCase);
  const plan = useMemo(() => computePlan(s, Date.now()), [s]);
  const totalMin = plan.mix.reduce((a, m) => a + m.minutes, 0);

  const go = (a: PlanAction, label: string, ids?: string[]) => {
    const t = useTrain.getState();
    if (a.tab === "library") {
      t.setPref("tab", "library");
      if (ids?.length) {
        t.setPref("libSet", getCase(ids[0])!.set as "OLL" | "PLL");
        setOpenCase(ids[0]);
      }
      return;
    }
    if (a.ids && a.ids.length) {
      useTrainNav.getState().setAdhoc({ label, ids: a.ids });
      if (a.tab === "drill") t.setPref("drillSet", ADHOC);
      if (a.tab === "recognition") t.setPref("recogSet", ADHOC);
    } else if (a.set) {
      if (a.tab === "drill") t.setPref("drillSet", a.set);
      if (a.tab === "recognition") t.setPref("recogSet", a.set);
    }
    t.setPref("tab", a.tab);
  };

  return (
    <div className="plan" data-testid="plan">
      <div className="plan-cols">
        <section className="plan-main">
          <div className="row-between plan-h">
            <h2 className="section-title" style={{ margin: 0 }}>
              Today’s session
            </h2>
            <span className="cap">≈ {Math.round(totalMin)} min</span>
          </div>
          <ol className="plan-mix">
            {plan.mix.map((m, i) => (
              <li key={i} className="glass-edge plan-item" data-testid="plan-item">
                <span className="pi-n num">{String(i + 1).padStart(2, "0")}</span>
                <div className="pi-body">
                  <div className="pi-title">{m.title}</div>
                  <div className="pi-detail num">{m.detail}</div>
                  <div className="pi-why">
                    <span className="cap">Why</span> {m.why}
                  </div>
                </div>
                <div className="pi-side">
                  <span className="cap">{Math.round(m.minutes)} min</span>
                  <button className="btn sm" onClick={() => go(m.action, m.title.split(" · ")[0], m.ids)} data-testid="plan-go">
                    Start
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <aside className="plan-side">
          <div className="glass-edge tr-panel">
            <div className="row-between">
              <span className="cap">Due for review</span>
              <span className="cap num">{plan.due.length}</span>
            </div>
            {plan.due.length ? (
              <div className="plan-due">
                {plan.due.slice(0, 18).map((d) => (
                  <button key={d.id} className="pd" onClick={() => setOpenCase(d.id)} title={d.overdue >= 1 ? `overdue by ${Math.floor(d.overdue)} days` : "due today"}>
                    <RefDiagram c={getCase(d.id)!} size={42} arrows={false} />
                    <span>{shortName(getCase(d.id)!)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="dim tr-small">Nothing due. Cases enter the review schedule the first time you drill them.</div>
            )}
          </div>
          <div className="glass-edge tr-panel">
            <span className="cap">Weakest execution</span>
            {plan.weakExec.length ? (
              <table className="tbl tr-tbl">
                <tbody>
                  {plan.weakExec.map((w) => (
                    <tr key={w.id} className="click" onClick={() => setOpenCase(w.id)}>
                      <td>{getCase(w.id)!.name}</td>
                      <td className="r num">{sec(w.mean)}</td>
                      <td className="r num dim">×{(w.mean / w.target).toFixed(2)}</td>
                      <td className="r num">{w.failRate ? <span className="bad">{Math.round(w.failRate * 100)}%</span> : <span className="dim">–</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="dim tr-small">Needs at least 3 drills per case; cases faster than target are not listed.</div>
            )}
          </div>
          <div className="glass-edge tr-panel">
            <span className="cap">Weakest recognition</span>
            {plan.weakRecog.length ? (
              <table className="tbl tr-tbl">
                <tbody>
                  {plan.weakRecog.map((w) => (
                    <tr key={w.id} className="click" onClick={() => setOpenCase(w.id)}>
                      <td>{getCase(w.id)!.name}</td>
                      <td className={"r num " + (w.acc < 0.8 ? "bad" : "")}>{Math.round(w.acc * 100)}%</td>
                      <td className="r num dim">{sec(w.ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="dim tr-small">Nothing below 90% accuracy (needs ≥ 3 answers per case).</div>
            )}
          </div>
          <div className="glass-edge tr-panel" data-testid="plan-targets">
            <span className="cap">This week · rolling 7 days</span>
            <div className="targets">
              {plan.targets.map((t) => (
                <div key={t.label} className="tg" title={t.why}>
                  <div className="row-between">
                    <span>{t.label}</span>
                    <span className="num">
                      <b className={t.pct >= 1 ? "good" : ""}>
                        {t.current}
                        {t.unit}
                      </b>
                      <span className="dim">
                        {" "}
                        / {t.goal}
                        {t.unit}
                      </span>
                    </span>
                  </div>
                  <div className="tg-bar">
                    <i style={{ width: t.pct * 100 + "%" }} className={t.pct >= 1 ? "done" : ""} />
                  </div>
                  <div className="tg-why">{t.why}</div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
