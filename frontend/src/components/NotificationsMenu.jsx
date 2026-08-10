import React, { useEffect, useState } from "react";
import { notificationsApi } from "../api/client";
import "../styles/NotificationsMenu.css";

/* =====================================================================
   NotificationsMenu — "e-mail me when…".

   Change monitoring and failure alerts existed but could only be
   delivered to a webhook URL, which is not something a non-technical
   user can produce. This is the reachable version of the same alerts.

   Account-level rather than per-workflow on purpose: the question people
   have is "tell me when my scrapers break or find something new", not
   "configure delivery for scraper #7".

   Props: open, onClose(), showToast(msg, type)
   ===================================================================== */

export default function NotificationsMenu({ open, onClose, showToast }) {
  const [available, setAvailable] = useState(true);
  const [loading, setLoading]     = useState(false);
  const [busy, setBusy]           = useState(false);
  const [testing, setTesting]     = useState(false);
  const [err, setErr]             = useState(null);

  const [email, setEmail]         = useState("");
  const [onFailure, setOnFailure] = useState(true);
  const [onChange, setOnChange]   = useState(true);
  const [isActive, setIsActive]   = useState(true);
  const [saved, setSaved]         = useState(null);   // last persisted settings

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true); setErr(null);
    notificationsApi.get()
      .then(d => {
        if (!alive) return;
        setAvailable(!!d.available);
        setSaved(d.settings);
        if (d.settings) {
          setEmail(d.settings.email || "");
          setOnFailure(d.settings.onFailure);
          setOnChange(d.settings.onChange);
          setIsActive(d.settings.isActive);
        }
      })
      .catch(e => { if (alive) setErr(e?.response?.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const s = await notificationsApi.save({ email: email.trim(), onFailure, onChange, isActive });
      setSaved(s);
      showToast?.("✓ Alert settings saved", "success");
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true); setErr(null);
    try {
      const out = await notificationsApi.test(email.trim());
      showToast?.(`✓ Test sent to ${out.sentTo}`, "success");
    } catch (e) {
      // Surfaced inline as well as in a toast: a delivery failure is the whole
      // reason this button exists, so it shouldn't vanish after 2 seconds.
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setTesting(false);
    }
  };

  const turnOff = async () => {
    if (!confirm("Stop sending e-mail alerts to this address?")) return;
    setBusy(true); setErr(null);
    try {
      await notificationsApi.remove();
      setSaved(null); setEmail(""); setOnFailure(true); setOnChange(true); setIsActive(true);
      showToast?.("Alerts turned off", "success");
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const dirty = !saved
    || saved.email !== email.trim()
    || saved.onFailure !== onFailure
    || saved.onChange !== onChange
    || saved.isActive !== isActive;

  return (
    <div className="wf-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wf-modal nm-modal">
        <div className="wf-header">
          <h2>E-mail alerts</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="wf-body">
          {loading ? (
            <div className="wf-empty">Loading…</div>
          ) : !available ? (
            /* Never offer a switch that would silently do nothing. */
            <div className="nm-unavailable">
              <strong>E-mail isn’t set up on this server yet.</strong>
              <p>
                Whoever runs this instance needs to add SMTP details to the backend
                environment (<code>SMTP_HOST</code>, <code>SMTP_PORT</code>,
                <code>SMTP_USER</code>, <code>SMTP_PASS</code>). Until then, alerts
                can still be delivered to a webhook URL.
              </p>
            </div>
          ) : (
            <>
              <p className="nm-intro">
                Get told when something needs you — without having to watch the dashboard.
              </p>

              <label className="nm-field">
                <span>Send alerts to</span>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </label>

              <div className="nm-toggles">
                <label className="nm-toggle">
                  <input type="checkbox" checked={onFailure} onChange={e => setOnFailure(e.target.checked)} />
                  <span>
                    <strong>When a scraper fails or needs a look</strong>
                    <em>Including runs that stopped part-way but kept what they had.</em>
                  </span>
                </label>
                <label className="nm-toggle">
                  <input type="checkbox" checked={onChange} onChange={e => setOnChange(e.target.checked)} />
                  <span>
                    <strong>When a watched page changes</strong>
                    <em>New, changed or removed rows — for scrapers with “Monitor for changes” on.</em>
                  </span>
                </label>
                <label className="nm-toggle">
                  <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
                  <span>
                    <strong>Alerts are on</strong>
                    <em>Uncheck to pause everything without losing these settings.</em>
                  </span>
                </label>
              </div>

              <p className="nm-note">
                Successful runs are never e-mailed — a scraper that works isn’t news,
                and daily “all fine” mail is how real alerts get ignored.
              </p>

              {saved?.lastSentAt && (
                <p className="nm-last">
                  Last sent {saved.lastSentAt}
                  {saved.lastStatus && saved.lastStatus !== "ok"
                    ? <span className="nm-last-err"> — {saved.lastStatus}</span>
                    : null}
                </p>
              )}

              {err && <div className="nm-error">{err}</div>}

              <div className="nm-actions">
                <button className="wf-save-btn" onClick={save} disabled={busy || !email.trim() || !dirty}>
                  {busy ? "Saving…" : dirty ? "Save" : "Saved"}
                </button>
                <button className="modal-btn secondary" onClick={sendTest} disabled={testing || !email.trim()}>
                  {testing ? "Sending…" : "Send a test"}
                </button>
                {saved && (
                  <button className="dash-link nm-off" onClick={turnOff} disabled={busy}>
                    Turn off alerts
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
