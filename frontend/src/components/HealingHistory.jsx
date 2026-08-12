import React, { useEffect, useState } from "react";
import { workflowsApi } from "../api/client";
import "../styles/HealingHistory.css";

/* =====================================================================
   HealingHistory — what this scraper fixed by itself.

   Self-healing has been recording every repair it makes since it shipped
   (run_repairs: which step, what broke, what it proposed, whether the fix
   verified against the page snapshot, whether it was auto-adopted). None of
   it was readable. A scraper that quietly repaired itself four times looked
   exactly like one that never broke — so the platform's most persuasive
   behaviour was also its most invisible.

   It reads as reassurance first ("N repairs, you didn't have to do
   anything") and as diagnosis second: the per-step rollup names which parts
   of the scraper are actually fragile, which is where a human should spend
   their attention.

   Rendered inline inside the run-history dialog rather than as another
   modal — it answers the same question the user came there to ask.

   Props: workflowId, days
   ===================================================================== */

export default function HealingHistory({ workflowId, days = 90 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!workflowId) return;
    let alive = true;
    setLoading(true); setErr(null);
    workflowsApi.healing(workflowId, days)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setErr(e?.response?.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [workflowId, days]);

  if (loading) return <div className="hh hh-quiet">Checking self-healing history…</div>;
  if (err) return <div className="hh hh-quiet hh-error">{err}</div>;

  const totals = data?.totals;
  // Nothing repaired is the normal, happy case — say so in one line rather
  // than showing an empty dashboard.
  if (!totals || totals.repairs === 0) {
    return (
      <div className="hh hh-quiet">
        Nothing has needed repairing in the last {totals?.sinceDays ?? days} days.
      </div>
    );
  }

  const { repairs, verified, autoAdopted, runsAffected, sinceDays } = totals;

  return (
    <div className="hh">
      <div className="hh-head">
        <span className="hh-icon" aria-hidden="true">🛠️</span>
        <div className="hh-headline">
          <strong>
            This scraper repaired itself {repairs} time{repairs === 1 ? "" : "s"} in the
            last {sinceDays} days
          </strong>
          <span className="hh-sub">
            across {runsAffected} run{runsAffected === 1 ? "" : "s"} ·{" "}
            {verified} verified against the live page ·{" "}
            {autoAdopted} adopted into the saved workflow automatically
          </span>
        </div>
        <button className="hh-toggle" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>
          {expanded ? "Hide detail" : "What broke?"}
        </button>
      </div>

      {expanded && (
        <>
          {data.bySteps.length > 0 && (
            <div className="hh-steps">
              <div className="hh-section-title">Steps that needed fixing</div>
              {data.bySteps.map(s => (
                <div className="hh-step" key={s.stepId}>
                  <span className="hh-step-name" title={s.label}>{s.label}</span>
                  <span className="hh-step-count">
                    {s.total}×
                    {s.verified > 0 && <span className="hh-ok"> · {s.verified} verified</span>}
                    {s.autoAdopted > 0 && <span className="hh-ok"> · {s.autoAdopted} adopted</span>}
                  </span>
                </div>
              ))}
              {data.bySteps.length > 1 && (
                <p className="hh-hint">
                  A step near the top of this list keeps breaking — that's usually worth
                  re-pointing by hand rather than leaving to repeated repairs.
                </p>
              )}
            </div>
          )}

          <div className="hh-list">
            <div className="hh-section-title">Recent repairs</div>
            {data.repairs.slice(0, 12).map(r => (
              <div className="hh-item" key={r.id}>
                <span className={`hh-dot ${r.verified ? "ok" : r.applied ? "warn" : "err"}`} />
                <div className="hh-item-body">
                  <span className="hh-item-title">
                    {r.label}
                    <span className="hh-item-when">{formatWhen(r.created_at)}</span>
                  </span>
                  {r.explanation && <span className="hh-item-why">{r.explanation}</span>}
                  <span className="hh-item-tags">
                    {r.verified ? "verified" : r.applied ? "applied, not verified" : "proposed only"}
                    {r.auto_adopted ? " · adopted automatically" : ""}
                    {r.run_id ? ` · run #${r.run_id}` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function formatWhen(s) {
  if (!s) return "";
  const d = new Date(/T/.test(s) ? s : String(s).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}
