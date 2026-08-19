import React, { useEffect, useState } from "react";
import { billingApi } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useConfirm } from "../components/ConfirmDialog";
import useDialog from "../components/useDialog";
import "../styles/BillingMenu.css";

/*
  Plan & usage panel.

  Two jobs: tell someone honestly where they stand this month, and make the
  upgrade one click when they're near a wall. The usage bars exist because
  "42 of 50 runs" prompts an upgrade decision at the right moment, while a
  402 error after the fact just reads as the product being broken.

  Everything shown here is advisory — the server is what enforces. The panel
  renders from /api/billing/plans and /api/billing/usage, both of which read
  the same catalogue the guards do, so the numbers on screen cannot drift
  from the numbers being applied.
*/

function fmt(n) {
  if (n === null || n === undefined) return "Unlimited";
  return n.toLocaleString();
}

function UsageBar({ label, used, limit, percent }) {
  const unlimited = limit === null || limit === undefined;
  // Warn before the wall, not at it.
  const level = unlimited ? "ok" : percent >= 100 ? "over" : percent >= 80 ? "warn" : "ok";
  return (
    <div className="bill-usage">
      <div className="bill-usage-head">
        <span>{label}</span>
        <span className="bill-usage-nums">
          {fmt(used)}{unlimited ? "" : ` / ${fmt(limit)}`}
        </span>
      </div>
      <div className="bill-usage-track">
        <div
          className={`bill-usage-fill is-${level}`}
          style={{ width: unlimited ? "0%" : `${Math.min(100, percent || 0)}%` }}
        />
      </div>
      {level === "over" && (
        <p className="bill-usage-note is-over">
          You've hit this month's limit. New runs are paused until it resets, or until you upgrade.
        </p>
      )}
      {level === "warn" && (
        <p className="bill-usage-note">{100 - percent}% left this month.</p>
      )}
    </div>
  );
}

export default function BillingMenu({ open, onClose, showToast }) {
  const { overlayProps, dialogProps } = useDialog({ open, onClose });
  const { refresh } = useAuth();
  const confirm = useConfirm();

  const [plans, setPlans] = useState([]);
  const [stubbed, setStubbed] = useState(false);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null); // slug currently being purchased
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [cat, use] = await Promise.all([billingApi.plans(), billingApi.usage()]);
      setPlans(cat.plans || []);
      setStubbed(!!cat.stubbed);
      setUsage(use);
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setLoading(false); }
  };

  useEffect(() => { if (open) load(); }, [open]);

  if (!open) return null;

  const upgrade = async (slug) => {
    setBusy(slug);
    setError(null);
    try {
      const out = await billingApi.checkout(slug);
      if (out.url && !out.applied) {
        // A real provider hands back a hosted checkout page.
        window.location.href = out.url;
        return;
      }
      await refresh();
      await load();
      showToast?.(`You're on the ${plans.find(p => p.slug === slug)?.name || slug} plan.`);
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(null); }
  };

  const cancel = async () => {
    if (!(await confirm({
      title: "Cancel your subscription?",
      message: "You'll keep everything you're paying for until the end of the current billing period, then drop to the Free plan.",
      confirmLabel: "Cancel subscription",
      danger: true,
    }))) return;
    try {
      const out = await billingApi.cancel();
      await refresh();
      await load();
      showToast?.(out.effectiveUntil
        ? `Cancelled. You keep access until ${new Date(out.effectiveUntil).toLocaleDateString()}.`
        : "Subscription cancelled.");
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    }
  };

  const resume = async () => {
    try {
      await billingApi.resume();
      await refresh();
      await load();
      showToast?.("Subscription resumed.");
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    }
  };

  const currentSlug = usage?.plan;
  const current = plans.find((p) => p.slug === currentSlug);
  const order = (slug) => plans.find((p) => p.slug === slug)?.order ?? 0;

  return (
    <div className="wf-overlay" {...overlayProps}>
      <div className="wf-modal bill-modal" {...dialogProps}>
        <div className="wf-header">
          <h2>Plan &amp; usage</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="wf-body">
          {loading && <p className="bill-muted">Loading…</p>}
          {error && <div className="wf-error">{error}</div>}

          {usage && (
            <>
              <section className="bill-current">
                <div className="bill-current-head">
                  <div>
                    <span className="bill-eyebrow">Current plan</span>
                    <h3>{usage.planName}</h3>
                  </div>
                  {usage.lapsed && (
                    <span className="bill-chip is-warn">Payment needed</span>
                  )}
                </div>

                {usage.lapsed && (
                  <p className="bill-lapsed">
                    Your payment didn't go through, so you're temporarily on Free limits.
                    Your workflows and data are untouched — update your billing to restore
                    the {usage.planName} plan.
                  </p>
                )}

                <p className="bill-period">Resets on the 1st · period {usage.period}</p>

                <UsageBar label="Runs" used={usage.runs.used} limit={usage.runs.limit} percent={usage.runs.percent} />
                <UsageBar label="Pages" used={usage.pages.used} limit={usage.pages.limit} percent={usage.pages.percent} />
              </section>

              {stubbed && (
                <div className="bill-stub-banner">
                  <strong>Development mode.</strong> No payment provider is connected,
                  so plan changes here apply instantly and nothing is charged.
                </div>
              )}

              <section className="bill-plans">
                {plans.map((p) => {
                  const isCurrent = p.slug === currentSlug;
                  const isDowngrade = order(p.slug) < order(currentSlug);
                  return (
                    <article
                      key={p.slug}
                      className={`bill-plan${p.featured ? " is-featured" : ""}${isCurrent ? " is-current" : ""}`}
                    >
                      <header>
                        <span className="bill-plan-name">{p.name}</span>
                        {isCurrent && <span className="bill-chip">Current</span>}
                      </header>
                      <div className="bill-plan-price">
                        {p.price.monthly === 0 ? "Free" : `€${p.price.monthly}`}
                        {p.price.monthly > 0 && <small>/month</small>}
                      </div>
                      <p className="bill-plan-role">{p.tagline}</p>
                      <ul className="bill-plan-limits">
                        <li><strong>{fmt(p.limits.maxWorkflows)}</strong> workflows</li>
                        <li><strong>{fmt(p.limits.monthlyRuns)}</strong> runs / month</li>
                        <li><strong>{fmt(p.limits.monthlyPages)}</strong> pages / month</li>
                        <li className={p.features.scheduling ? "" : "off"}>Scheduling</li>
                        <li className={p.features.proxies ? "" : "off"}>Proxies</li>
                        <li className={p.features.publicApi ? "" : "off"}>REST API &amp; webhooks</li>
                        <li className={p.features.sharedProxyPool ? "" : "off"}>Shared proxy pool</li>
                        <li className={p.features.captchaSolving ? "" : "off"}>CAPTCHA solving</li>
                      </ul>

                      {isCurrent ? (
                        usage.planStatus === "active" && !usage.lapsed && p.purchasable ? (
                          <button className="bill-btn ghost" onClick={cancel}>Cancel plan</button>
                        ) : usage.lapsed ? (
                          <button className="bill-btn" onClick={() => upgrade(p.slug)} disabled={busy === p.slug}>
                            {busy === p.slug ? "Working…" : "Fix payment"}
                          </button>
                        ) : (
                          <button className="bill-btn ghost" disabled>Your plan</button>
                        )
                      ) : p.purchasable ? (
                        <button
                          className={`bill-btn${p.featured ? " primary" : ""}`}
                          onClick={() => upgrade(p.slug)}
                          disabled={!!busy}
                        >
                          {busy === p.slug ? "Working…" : isDowngrade ? `Switch to ${p.name}` : `Upgrade to ${p.name}`}
                        </button>
                      ) : (
                        <button className="bill-btn ghost" onClick={cancel} disabled={currentSlug === "free"}>
                          {currentSlug === "free" ? "Your plan" : "Downgrade"}
                        </button>
                      )}
                    </article>
                  );
                })}
              </section>

              {usage.planStatus === "active" && current && current.purchasable && (
                <p className="bill-foot">
                  Changed your mind about cancelling? <button className="bill-link" onClick={resume}>Resume subscription</button>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
