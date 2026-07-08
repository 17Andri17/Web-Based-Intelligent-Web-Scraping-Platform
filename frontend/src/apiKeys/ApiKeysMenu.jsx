import React, { useEffect, useState } from "react";
import { apiKeysApi, API_BASE } from "../api/client";
import "../styles/ApiKeysMenu.css";

/*
  API keys panel — dashboard management of public-API (/v1) credentials.

  Keys authenticate programs against the public REST API (docs/API_REFERENCE.md).
  They are created and revoked HERE, never via the API itself, so a leaked key
  can't mint more keys. The plaintext key exists client-side for exactly one
  render after creation (the backend only stores its hash) — hence the
  copy-it-now reveal step.
*/

export default function ApiKeysMenu({ open, onClose, showToast }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false); // name form visible
  const [draftName, setDraftName] = useState("");
  const [revealed, setRevealed] = useState(null);  // { key, name } — shown once
  const [copied, setCopied] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await apiKeysApi.list());
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (open) { refresh(); setCreating(false); setDraftName(""); setRevealed(null); setCopied(false); }
  }, [open]);

  if (!open) return null;

  const activeKeys = keys.filter(k => !k.revokedAt);
  const revokedKeys = keys.filter(k => k.revokedAt);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { key } = await apiKeysApi.create(draftName.trim());
      setRevealed({ key, name: draftName.trim() });
      setCopied(false);
      setCreating(false);
      setDraftName("");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const revoke = async (k) => {
    if (!confirm(`Revoke "${k.name}" (${k.prefix}…)? Programs using this key will get 401s immediately. This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiKeysApi.revoke(k.id);
      showToast?.(`✓ Revoked "${k.name}"`, "success");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(revealed.key);
      setCopied(true);
      showToast?.("✓ Key copied to clipboard", "success");
    } catch (_) {
      // Clipboard API can be unavailable (http, permissions) — the key is
      // visible and selectable, so manual copy still works.
      showToast?.("Copy failed — select the key text and copy manually", "error");
    }
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal ca-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>API keys</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="wf-body">
          {error && <div className="wf-error">{error}</div>}

          {/* One-time reveal after creation */}
          {revealed && (
            <div className="ak-reveal">
              <div className="ak-reveal-title">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                Key created — copy it now
              </div>
              <div className="ak-reveal-hint">
                This is the only time the full key is shown. Only a hash is stored on the server —
                if you lose it, revoke it and create a new one.
              </div>
              <div className="ak-keyrow">
                <code className="ak-key">{revealed.key}</code>
                <button className="modal-btn primary" onClick={copyKey}>{copied ? "✓ Copied" : "Copy"}</button>
              </div>
              <div className="ak-reveal-hint">
                Use it as a Bearer token against the public API:
                <pre className="ak-code">{`curl -H "Authorization: Bearer ${revealed.key.slice(0, 12)}…" \\
  ${API_BASE}/v1/workflows`}</pre>
                See <code>docs/API_REFERENCE.md</code> for the full API (trigger runs, fetch data, webhooks).
              </div>
              <div className="ca-footer">
                <button className="modal-btn secondary" onClick={() => setRevealed(null)}>Done</button>
              </div>
            </div>
          )}

          {!revealed && (
            <>
              <div className="ca-hint">
                API keys let programs trigger your workflows and fetch their data through the public
                REST API (<code>/v1</code>) — without a login session. Keep them secret; anyone
                holding a key can run your workflows and read your extracted data.
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
                <div className="wf-section-title">Active keys</div>
                {!creating && <button className="wf-save-btn" onClick={() => { setCreating(true); setError(null); }}>+ New key</button>}
              </div>

              {creating && (
                <div className="ca-editor ak-create">
                  <div className="ca-field">
                    <label>Name <span className="ca-hint">(what will use this key — e.g. "Zapier", "CI pipeline")</span></label>
                    <input
                      type="text"
                      value={draftName}
                      onChange={e => setDraftName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && draftName.trim() && !busy) create(); }}
                      placeholder="e.g. Production integration"
                      maxLength={80}
                      autoFocus
                    />
                  </div>
                  <div className="ca-footer">
                    <button className="modal-btn secondary" onClick={() => { setCreating(false); setDraftName(""); }} disabled={busy}>Cancel</button>
                    <button className="modal-btn primary" onClick={create} disabled={busy || !draftName.trim()}>
                      {busy ? "Creating…" : "Create key"}
                    </button>
                  </div>
                </div>
              )}

              {loading ? (
                <div className="wf-empty">Loading…</div>
              ) : activeKeys.length === 0 && !creating ? (
                <div className="wf-empty">No API keys yet. Click <strong>+ New key</strong> to create one for your integration.</div>
              ) : (
                <div className="wf-list">
                  {activeKeys.map(k => (
                    <div className="wf-item" key={k.id}>
                      <div className="info">
                        <span className="name">{k.name}</span>
                        <span className="meta">
                          <code className="ak-prefix">{k.prefix}…</code>
                          {" · created "}{formatDate(k.createdAt)}
                          {" · "}{k.lastUsedAt ? `last used ${formatDate(k.lastUsedAt)}` : "never used"}
                        </span>
                      </div>
                      <div className="actions">
                        <button className="danger" onClick={() => revoke(k)} disabled={busy}>Revoke</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {revokedKeys.length > 0 && (
                <>
                  <div className="wf-section-title" style={{ marginTop: 18 }}>Revoked</div>
                  <div className="wf-list ak-revoked">
                    {revokedKeys.map(k => (
                      <div className="wf-item" key={k.id}>
                        <div className="info">
                          <span className="name">{k.name}</span>
                          <span className="meta">
                            <code className="ak-prefix">{k.prefix}…</code>
                            {" · revoked "}{formatDate(k.revokedAt)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
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
  // SQLite returns 'YYYY-MM-DD HH:MM:SS' in UTC; show locally.
  const d = new Date(s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}
