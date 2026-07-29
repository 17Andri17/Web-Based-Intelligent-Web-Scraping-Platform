import React, { useEffect, useState } from "react";
import { webhooksApi } from "../api/client";
import "../styles/ApiKeysMenu.css";

/*
  Webhooks panel — dashboard management of push endpoints.

  When a run finishes (or a monitored workflow's data changes), the platform
  POSTs a signed event to every endpoint subscribed to it. This is where a
  logged-in user registers those endpoints and picks events — so change-
  monitoring alerts can reach Slack / ntfy / Discord / their own server without
  touching the API. The signing secret is shown exactly once on creation.
*/

export default function WebhooksMenu({ open, onClose, showToast }) {
  const [hooks, setHooks]     = useState([]);
  const [events, setEvents]   = useState([]);   // [{ event, label }]
  const [loading, setLoading] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);

  const [creating, setCreating] = useState(false);
  const [url, setUrl]           = useState("");
  const [picked, setPicked]     = useState({}); // event -> bool
  const [revealed, setRevealed] = useState(null); // { url, secret } shown once
  const [copied, setCopied]     = useState(false);

  const refresh = async () => {
    setLoading(true); setError(null);
    try {
      const [list, evs] = await Promise.all([webhooksApi.list(), webhooksApi.events()]);
      setHooks(list);
      setEvents(evs);
      // Default new-webhook selection: all events on.
      setPicked(Object.fromEntries(evs.map(e => [e.event, true])));
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (open) { refresh(); setCreating(false); setUrl(""); setRevealed(null); setCopied(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const chosenEvents = events.filter(e => picked[e.event]).map(e => e.event);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const wh = await webhooksApi.create(url.trim(), chosenEvents);
      setRevealed({ url: wh.url, secret: wh.secret });
      setCopied(false);
      setCreating(false);
      setUrl("");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const remove = async (h) => {
    if (!confirm(`Delete this webhook?\n${h.url}\nEvents will stop being delivered to it.`)) return;
    setBusy(true); setError(null);
    try {
      await webhooksApi.remove(h.id);
      showToast?.("✓ Webhook deleted", "success");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
      showToast?.("✓ Signing secret copied", "success");
    } catch (_) {
      showToast?.("Copy failed — select the secret text and copy manually", "error");
    }
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal ca-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>Webhooks</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="wf-body">
          {error && <div className="wf-error">{error}</div>}

          {/* One-time secret reveal after creation */}
          {revealed && (
            <div className="ak-reveal">
              <div className="ak-reveal-title">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                Webhook created — copy the signing secret now
              </div>
              <div className="ak-reveal-hint">
                This secret is shown only once. Each delivery is signed with it
                (<code>X-Scraper-Signature</code>) so your receiver can verify the request is genuine.
              </div>
              <div className="ak-keyrow">
                <code className="ak-key">{revealed.secret}</code>
                <button className="modal-btn primary" onClick={copySecret}>{copied ? "✓ Copied" : "Copy"}</button>
              </div>
              <div className="ak-reveal-hint">
                Delivering to <code>{revealed.url}</code>. Verification details are in <code>docs/API_REFERENCE.md</code>.
                Tip: services like ntfy, Slack and Discord accept a plain incoming-webhook URL.
              </div>
              <div className="ca-footer">
                <button className="modal-btn secondary" onClick={() => setRevealed(null)}>Done</button>
              </div>
            </div>
          )}

          {!revealed && (
            <>
              <div className="ca-hint">
                Get pinged when a run finishes or a monitored workflow's data changes. The platform
                POSTs a signed JSON event to each URL you add here — point it at Slack, Discord, ntfy,
                or your own server.
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
                <div className="wf-section-title">Your endpoints</div>
                {!creating && <button className="wf-save-btn" onClick={() => { setCreating(true); setError(null); }}>+ New webhook</button>}
              </div>

              {creating && (
                <div className="ca-editor ak-create">
                  <div className="ca-field">
                    <label>URL <span className="ca-hint">(where events are POSTed)</span></label>
                    <input
                      type="text"
                      value={url}
                      onChange={e => setUrl(e.target.value)}
                      placeholder="https://hooks.slack.com/services/…"
                      maxLength={2048}
                      autoFocus
                    />
                  </div>
                  <div className="ca-field">
                    <label>Events</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      {events.map(e => (
                        <label key={e.event} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                          <input
                            type="checkbox"
                            checked={!!picked[e.event]}
                            onChange={ev => setPicked(p => ({ ...p, [e.event]: ev.target.checked }))}
                            style={{ marginTop: 2 }}
                          />
                          <span>
                            <code style={{ fontSize: 12 }}>{e.event}</code>
                            <span style={{ display: "block", color: "var(--text-secondary)", fontSize: 12 }}>{e.label}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="ca-footer">
                    <button className="modal-btn secondary" onClick={() => { setCreating(false); setUrl(""); }} disabled={busy}>Cancel</button>
                    <button className="modal-btn primary" onClick={create} disabled={busy || !url.trim() || chosenEvents.length === 0}>
                      {busy ? "Creating…" : "Create webhook"}
                    </button>
                  </div>
                </div>
              )}

              {loading ? (
                <div className="wf-empty">Loading…</div>
              ) : hooks.length === 0 && !creating ? (
                <div className="wf-empty">No webhooks yet. Add one to receive run and change alerts.</div>
              ) : (
                <div className="wf-list">
                  {hooks.map(h => (
                    <div className="wf-item" key={h.id}>
                      <div className="info">
                        <span className="name" style={{ wordBreak: "break-all" }}>{h.url}</span>
                        <span className="meta">
                          {(h.events || []).map(ev => <code key={ev} className="ak-prefix" style={{ marginRight: 6 }}>{ev}</code>)}
                          {" · created "}{formatDate(h.created_at)}
                        </span>
                      </div>
                      <div className="actions">
                        <button className="danger" onClick={() => remove(h)} disabled={busy}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(s) {
  if (!s) return "";
  const d = new Date(String(s).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}
