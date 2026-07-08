import React, { useEffect, useState } from "react";
import { proxiesApi } from "../api/client";

function emptyDraft(isShared) {
  return {
    label: "",
    protocol: "http",
    host: "",
    port: "",
    username: "",
    password: "",
    isShared,
  };
}

export default function ProxiesMenu({ open, onClose, showToast, isAdmin, selectedProxyId, onSelectProxy }) {
  const [list,    setList]    = useState([]);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setList(await proxiesApi.list());
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setLoading(false); }
  };

  useEffect(() => { if (open) { refresh(); setEditing(null); } }, [open]);

  if (!open) return null;

  const own = list.filter(p => p.scope === "own");
  const shared = list.filter(p => p.scope === "shared");

  const startNew  = (isShared) => { setEditing(emptyDraft(isShared)); setError(null); };
  const startEdit = (proxy) => { setEditing({ ...proxy, password: "" }); setError(null); };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        label: editing.label,
        protocol: editing.protocol,
        host: editing.host,
        port: Number(editing.port),
        username: editing.username || null,
        // Blank password on an edit means "leave it unchanged"; on a new
        // proxy it means "no password". The API distinguishes by whether
        // the field is present at all, so omit it entirely when blank AND
        // editing an existing one.
        ...(editing.password || !editing.id ? { password: editing.password || null } : {}),
      };
      const saved = editing.isShared
        ? (editing.id ? await proxiesApi.updateShared(editing.id, payload) : await proxiesApi.createShared(payload))
        : (editing.id ? await proxiesApi.update(editing.id, payload) : await proxiesApi.create(payload));
      showToast?.(`✓ ${editing.id ? "Updated" : "Created"} "${saved.label}"`, "success");
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const remove = async (proxy) => {
    if (!confirm(`Delete proxy "${proxy.label}"? Workflows using it will run without a proxy.`)) return;
    setBusy(true);
    setError(null);
    try {
      if (proxy.isShared) await proxiesApi.removeShared(proxy.id);
      else await proxiesApi.remove(proxy.id);
      if (selectedProxyId === proxy.id) onSelectProxy?.(null);
      showToast?.(`✓ Deleted "${proxy.label}"`, "success");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal ca-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>{editing ? (editing.id ? "Edit proxy" : "New proxy") : "Proxy servers"}</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="wf-body">
          {error && <div className="wf-error">{error}</div>}

          {!editing && (
            <>
              <div className="ca-field">
                <label>Active proxy for this workflow</label>
                <select
                  value={selectedProxyId || ""}
                  onChange={e => onSelectProxy?.(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">No proxy (direct connection)</option>
                  {own.map(p => <option key={p.id} value={p.id}>{p.label} ({p.protocol})</option>)}
                  {shared.map(p => <option key={p.id} value={p.id}>{p.label} (shared, {p.protocol})</option>)}
                </select>
                <div className="ca-hint" style={{ marginTop: 6 }}>
                  Applies to the live preview immediately, and is saved with the workflow for scheduled/manual runs.
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
                <div className="wf-section-title">Your proxies</div>
                <button className="wf-save-btn" onClick={() => startNew(false)}>+ New proxy</button>
              </div>

              {loading ? (
                <div className="wf-empty">Loading…</div>
              ) : own.length === 0 ? (
                <div className="wf-empty">
                  No proxies yet. Click <strong>+ New proxy</strong> to add your own residential/datacenter/SOCKS5 proxy.
                </div>
              ) : (
                <div className="wf-list">
                  {own.map(p => (
                    <div className="wf-item" key={p.id}>
                      <div className="info">
                        <span className="name">{p.label}</span>
                        <span className="meta">
                          {p.protocol}://{p.host}:{p.port}{p.username ? ` — auth: ${p.username}` : ""}
                        </span>
                      </div>
                      <div className="actions">
                        <button onClick={() => startEdit(p)} disabled={busy}>Edit</button>
                        <button className="danger" onClick={() => remove(p)} disabled={busy}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {isAdmin && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
                    <div className="wf-section-title">Platform proxies <span className="ca-hint">(shared with every user)</span></div>
                    <button className="wf-save-btn" onClick={() => startNew(true)}>+ New shared proxy</button>
                  </div>

                  {shared.length === 0 ? (
                    <div className="wf-empty">No shared proxies yet.</div>
                  ) : (
                    <div className="wf-list">
                      {shared.map(p => (
                        <div className="wf-item" key={p.id}>
                          <div className="info">
                            <span className="name">{p.label}</span>
                            <span className="meta">
                              {p.protocol}://{p.host}:{p.port}{p.username ? ` — auth: ${p.username}` : ""}
                            </span>
                          </div>
                          <div className="actions">
                            <button onClick={() => startEdit({ ...p, isShared: true })} disabled={busy}>Edit</button>
                            <button className="danger" onClick={() => remove({ ...p, isShared: true })} disabled={busy}>Delete</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {editing && (
            <ProxyEditor
              draft={editing}
              setDraft={setEditing}
              onSave={save}
              onCancel={() => setEditing(null)}
              busy={busy}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ProxyEditor({ draft, setDraft, onSave, onCancel, busy }) {
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const isSocks5 = draft.protocol === "socks5";

  return (
    <div className="ca-editor">
      <div className="ca-field">
        <label>Label</label>
        <input
          type="text"
          value={draft.label}
          onChange={e => set("label", e.target.value)}
          placeholder="e.g. Residential — US East"
          maxLength={80}
        />
      </div>

      <div className="ca-field">
        <label>Protocol</label>
        <select value={draft.protocol} onChange={e => set("protocol", e.target.value)}>
          <option value="http">HTTP</option>
          <option value="https">HTTPS</option>
          <option value="socks5">SOCKS5</option>
        </select>
      </div>

      <div className="ca-field" style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 3 }}>
          <label>Host</label>
          <input type="text" value={draft.host} onChange={e => set("host", e.target.value)} placeholder="proxy.example.com" maxLength={255} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Port</label>
          <input type="number" value={draft.port} onChange={e => set("port", e.target.value)} placeholder="8080" min={1} max={65535} />
        </div>
      </div>

      {isSocks5 ? (
        <div className="ca-hint">SOCKS5 proxies with a username/password aren't supported — Chrome only authenticates HTTP/HTTPS proxies this way. Use an IP-allowlisted SOCKS5 proxy instead.</div>
      ) : (
        <div className="ca-field" style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>Username <span className="ca-hint">(optional)</span></label>
            <input type="text" value={draft.username || ""} onChange={e => set("username", e.target.value)} maxLength={200} />
          </div>
          <div style={{ flex: 1 }}>
            <label>Password <span className="ca-hint">{draft.id ? "(leave blank to keep current)" : "(optional)"}</span></label>
            <input type="password" value={draft.password || ""} onChange={e => set("password", e.target.value)} maxLength={500} autoComplete="new-password" />
          </div>
        </div>
      )}

      <div className="ca-footer">
        <button className="modal-btn secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="modal-btn primary" onClick={onSave} disabled={busy || !draft.label?.trim() || !draft.host?.trim() || !draft.port}>
          {busy ? "Saving…" : (draft.id ? "Save changes" : "Create proxy")}
        </button>
      </div>
    </div>
  );
}
