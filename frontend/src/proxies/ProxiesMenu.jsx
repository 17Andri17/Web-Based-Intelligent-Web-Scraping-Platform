import React, { useEffect, useState } from "react";
import { proxiesApi, proxyPoolsApi } from "../api/client";
import { useConfirm } from "../components/ConfirmDialog";
import useDialog from "../components/useDialog";

function emptyProxyDraft(isShared) {
  return { kind: "proxy", label: "", protocol: "http", host: "", port: "", username: "", password: "", isShared };
}
function emptyPoolDraft(isShared) {
  return { kind: "pool", label: "", strategy: "random", memberProxyIds: [], isShared, isDefault: false };
}

// Encodes the "active proxy for this workflow" selection as a single
// <select> value, and back. { mode: 'none' } <-> "".
function encodeSpec(spec) {
  if (!spec || spec.mode === "none") return "";
  if (spec.mode === "platform") return "platform";
  if (spec.mode === "single") return `single:${spec.id}`;
  if (spec.mode === "pool") return `pool:${spec.poolId}`;
  return "";
}
function decodeSpec(value) {
  if (!value) return null;
  if (value === "platform") return { mode: "platform" };
  const [mode, idStr] = value.split(":");
  const id = Number(idStr);
  if (mode === "single") return { mode: "single", id };
  if (mode === "pool") return { mode: "pool", poolId: id };
  return null;
}

export default function ProxiesMenu({ open, onClose, showToast, isAdmin, selectedProxy, onSelectProxy }) {
  // Focus trap, Escape, focus restore, scroll lock, backdrop semantics.
  const { overlayProps, dialogProps } = useDialog({ open, onClose });
  const confirm = useConfirm();
  const [proxyList, setProxyList] = useState([]);
  const [poolList,  setPoolList]  = useState([]);
  const [editing,   setEditing]   = useState(null); // { kind: 'proxy'|'pool', ... }
  const [loading,   setLoading]   = useState(false);
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [proxies, pools] = await Promise.all([proxiesApi.list(), proxyPoolsApi.list()]);
      setProxyList(proxies);
      setPoolList(pools);
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setLoading(false); }
  };

  useEffect(() => { if (open) { refresh(); setEditing(null); } }, [open]);

  if (!open) return null;

  const ownProxies = proxyList.filter(p => p.scope === "own");
  const sharedProxies = proxyList.filter(p => p.scope === "shared");
  const ownPools = poolList.filter(p => !p.isShared);
  const sharedPools = poolList.filter(p => p.isShared);
  const hasPlatformPool = sharedPools.length > 0;

  const startNewProxy = (isShared) => { setEditing(emptyProxyDraft(isShared)); setError(null); };
  const startEditProxy = (proxy) => { setEditing({ ...proxy, kind: "proxy", password: "" }); setError(null); };
  const startNewPool = (isShared) => { setEditing(emptyPoolDraft(isShared)); setError(null); };
  const startEditPool = (pool) => { setEditing({ ...pool, kind: "pool", memberProxyIds: pool.members.map(m => m.id) }); setError(null); };

  const saveProxy = async () => {
    const payload = {
      label: editing.label,
      protocol: editing.protocol,
      host: editing.host,
      port: Number(editing.port),
      username: editing.username || null,
      ...(editing.password || !editing.id ? { password: editing.password || null } : {}),
    };
    return editing.isShared
      ? (editing.id ? proxiesApi.updateShared(editing.id, payload) : proxiesApi.createShared(payload))
      : (editing.id ? proxiesApi.update(editing.id, payload) : proxiesApi.create(payload));
  };

  const savePool = async () => {
    const payload = {
      label: editing.label,
      strategy: editing.strategy,
      memberProxyIds: editing.memberProxyIds,
      ...(editing.isShared ? { isDefault: !!editing.isDefault } : {}),
    };
    return editing.isShared
      ? (editing.id ? proxyPoolsApi.updateShared(editing.id, payload) : proxyPoolsApi.createShared(payload))
      : (editing.id ? proxyPoolsApi.update(editing.id, payload) : proxyPoolsApi.create(payload));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = editing.kind === "pool" ? await savePool() : await saveProxy();
      showToast?.(`✓ ${editing.id ? "Updated" : "Created"} "${saved.label}"`, "success");
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const removeProxy = async (proxy) => {
    if (!(await confirm({
      title: `Delete proxy "${proxy.label}"?`,
      message: "Any pool it belongs to loses it, and workflows pointed straight at it will run with no proxy at all.",
      confirmLabel: "Delete proxy", danger: true,
    }))) return;
    setBusy(true);
    setError(null);
    try {
      if (proxy.isShared) await proxiesApi.removeShared(proxy.id);
      else await proxiesApi.remove(proxy.id);
      if (selectedProxy?.mode === "single" && selectedProxy.id === proxy.id) onSelectProxy?.(null);
      showToast?.(`✓ Deleted "${proxy.label}"`, "success");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const removePool = async (pool) => {
    if (!(await confirm({
      title: `Delete pool "${pool.label}"?`,
      message: "Workflows rotating through it will run with no proxy at all.",
      detail: "The proxies themselves are kept.",
      confirmLabel: "Delete pool", danger: true,
    }))) return;
    setBusy(true);
    setError(null);
    try {
      if (pool.isShared) await proxyPoolsApi.removeShared(pool.id);
      else await proxyPoolsApi.remove(pool.id);
      if (selectedProxy?.mode === "pool" && selectedProxy.poolId === pool.id) onSelectProxy?.(null);
      showToast?.(`✓ Deleted "${pool.label}"`, "success");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="wf-overlay" {...overlayProps}>
      <div className="wf-modal ca-modal" {...dialogProps}>
        <div className="wf-header">
          <h2>{editing ? headerFor(editing) : "Proxy servers"}</h2>
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
                <select value={encodeSpec(selectedProxy)} onChange={e => onSelectProxy?.(decodeSpec(e.target.value))}>
                  <option value="">No proxy (direct connection)</option>
                  {hasPlatformPool && <option value="platform">Platform proxies (automatic)</option>}
                  {ownProxies.length > 0 && (
                    <optgroup label="Your proxies">
                      {ownProxies.map(p => <option key={`s${p.id}`} value={`single:${p.id}`}>{p.label} ({p.protocol})</option>)}
                    </optgroup>
                  )}
                  {ownPools.length > 0 && (
                    <optgroup label="Your pools (rotates)">
                      {ownPools.map(p => <option key={`p${p.id}`} value={`pool:${p.id}`}>{p.label} — {p.members.length} proxies, {strategyLabel(p.strategy)}</option>)}
                    </optgroup>
                  )}
                  {sharedProxies.length > 0 && (
                    <optgroup label="Shared proxies">
                      {sharedProxies.map(p => <option key={`s${p.id}`} value={`single:${p.id}`}>{p.label} (shared, {p.protocol})</option>)}
                    </optgroup>
                  )}
                  {sharedPools.length > 0 && (
                    <optgroup label="Shared pools (rotates)">
                      {sharedPools.map(p => <option key={`p${p.id}`} value={`pool:${p.id}`}>{p.label}{p.isDefault ? " (default)" : ""} — {p.members.length} proxies, {strategyLabel(p.strategy)}</option>)}
                    </optgroup>
                  )}
                </select>
                <div className="ca-hint" style={{ marginTop: 6 }}>
                  A pool picks a different member proxy on each run — use one to avoid hammering a single IP (e.g. a target that keeps
                  re-challenging with a CAPTCHA). Applies to the live preview immediately, and is saved with the workflow.
                </div>
              </div>

              <div className="wf-section-head" style={{ marginTop: 18 }}>
                <div className="wf-section-title">Your proxies</div>
                <button className="wf-save-btn" onClick={() => startNewProxy(false)}>+ New proxy</button>
              </div>
              {loading ? (
                <div className="wf-empty">Loading…</div>
              ) : ownProxies.length === 0 ? (
                <div className="wf-empty">No proxies yet. Click <strong>+ New proxy</strong> to add your own residential/datacenter/SOCKS5 proxy.</div>
              ) : (
                <ProxyList items={ownProxies} busy={busy} onEdit={startEditProxy} onRemove={removeProxy} />
              )}

              <div className="wf-section-head" style={{ marginTop: 18 }}>
                <div className="wf-section-title">Your pools <span className="ca-hint">(rotate through several of your proxies)</span></div>
                <button className="wf-save-btn" onClick={() => startNewPool(false)} disabled={ownProxies.length + sharedProxies.length === 0}>+ New pool</button>
              </div>
              {ownPools.length === 0 ? (
                <div className="wf-empty">
                  {ownProxies.length + sharedProxies.length === 0
                    ? "Add at least one proxy first, then group them into a pool."
                    : <>No pools yet. Click <strong>+ New pool</strong> to rotate across a group of proxies.</>}
                </div>
              ) : (
                <PoolList items={ownPools} busy={busy} onEdit={startEditPool} onRemove={removePool} />
              )}

              {isAdmin && (
                <>
                  <div className="wf-section-head" style={{ marginTop: 18 }}>
                    <div className="wf-section-title">Platform proxies <span className="ca-hint">(shared with every user)</span></div>
                    <button className="wf-save-btn" onClick={() => startNewProxy(true)}>+ New shared proxy</button>
                  </div>
                  {sharedProxies.length === 0 ? (
                    <div className="wf-empty">No shared proxies yet.</div>
                  ) : (
                    <ProxyList items={sharedProxies} busy={busy} onEdit={startEditProxy} onRemove={removeProxy} />
                  )}

                  <div className="wf-section-head" style={{ marginTop: 18 }}>
                    <div className="wf-section-title">Platform pools</div>
                    <button className="wf-save-btn" onClick={() => startNewPool(true)} disabled={sharedProxies.length === 0}>+ New shared pool</button>
                  </div>
                  {sharedProxies.length === 0 ? (
                    <div className="wf-empty">Mark a proxy as shared first, then group shared proxies into a platform pool.</div>
                  ) : sharedPools.length === 0 ? (
                    <div className="wf-empty">No shared pools yet. The first one you create becomes the default automatically.</div>
                  ) : (
                    <PoolList items={sharedPools} busy={busy} onEdit={startEditPool} onRemove={removePool} showDefault />
                  )}
                </>
              )}
            </>
          )}

          {editing?.kind === "proxy" && (
            <ProxyEditor draft={editing} setDraft={setEditing} onSave={save} onCancel={() => setEditing(null)} busy={busy} />
          )}
          {editing?.kind === "pool" && (
            <PoolEditor
              draft={editing}
              setDraft={setEditing}
              onSave={save}
              onCancel={() => setEditing(null)}
              busy={busy}
              eligibleProxies={editing.isShared ? sharedProxies : [...ownProxies, ...sharedProxies]}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function headerFor(editing) {
  const noun = editing.kind === "pool" ? "pool" : "proxy";
  if (!editing.id) return `New ${editing.isShared ? "shared " : ""}${noun}`;
  return `Edit ${noun}`;
}
function strategyLabel(s) { return s === "round_robin" ? "round-robin" : "random"; }

function ProxyList({ items, busy, onEdit, onRemove }) {
  return (
    <div className="wf-list">
      {items.map(p => (
        <div className="wf-item" key={p.id}>
          <div className="info">
            <span className="name">{p.label}</span>
            <span className="meta">{p.protocol}://{p.host}:{p.port}{p.username ? ` — auth: ${p.username}` : ""}</span>
          </div>
          <div className="actions">
            <button onClick={() => onEdit(p)} disabled={busy}>Edit</button>
            <button className="danger" onClick={() => onRemove(p)} disabled={busy}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function PoolList({ items, busy, onEdit, onRemove, showDefault }) {
  return (
    <div className="wf-list">
      {items.map(p => (
        <div className="wf-item" key={p.id}>
          <div className="info">
            <span className="name">{p.label}{showDefault && p.isDefault ? " ⭐ default" : ""}</span>
            <span className="meta">{p.members.length} proxies · {strategyLabel(p.strategy)} · {p.members.map(m => m.label).join(", ")}</span>
          </div>
          <div className="actions">
            <button onClick={() => onEdit(p)} disabled={busy}>Edit</button>
            <button className="danger" onClick={() => onRemove(p)} disabled={busy}>Delete</button>
          </div>
        </div>
      ))}
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
        <input type="text" value={draft.label} onChange={e => set("label", e.target.value)} placeholder="e.g. Residential — US East" maxLength={80} />
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

function PoolEditor({ draft, setDraft, onSave, onCancel, busy, eligibleProxies }) {
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const toggleMember = (id) => setDraft(d => ({
    ...d,
    memberProxyIds: d.memberProxyIds.includes(id) ? d.memberProxyIds.filter(x => x !== id) : [...d.memberProxyIds, id],
  }));

  return (
    <div className="ca-editor">
      <div className="ca-field">
        <label>Label</label>
        <input type="text" value={draft.label} onChange={e => set("label", e.target.value)} placeholder="e.g. Rotating pool — EU" maxLength={80} />
      </div>

      <div className="ca-field">
        <label>Rotation strategy</label>
        <select value={draft.strategy} onChange={e => set("strategy", e.target.value)}>
          <option value="random">Random — pick any member each run</option>
          <option value="round_robin">Round-robin — cycle through every member in order, no repeats until the pool wraps</option>
        </select>
      </div>

      <div className="ca-field">
        <label>Members {draft.isShared && <span className="ca-hint">(only shared proxies can be added to a platform pool)</span>}</label>
        {eligibleProxies.length === 0 ? (
          <div className="ca-hint">No eligible proxies yet.</div>
        ) : (
          <div className="ca-schema" style={{ maxHeight: 220, overflowY: "auto" }}>
            {eligibleProxies.map(p => (
              <label key={p.id} className="ca-schema-row" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={draft.memberProxyIds.includes(p.id)} onChange={() => toggleMember(p.id)} style={{ marginRight: 8 }} />
                <code className="ca-schema-name" style={{ flex: 1 }}>{p.label}</code>
                <span className="meta">{p.protocol}://{p.host}:{p.port}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {draft.isShared && (
        <div className="ca-field">
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={!!draft.isDefault} onChange={e => set("isDefault", e.target.checked)} />
            Make this the default platform pool ("Platform proxies (automatic)" resolves here)
          </label>
        </div>
      )}

      <div className="ca-footer">
        <button className="modal-btn secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="modal-btn primary" onClick={onSave} disabled={busy || !draft.label?.trim() || draft.memberProxyIds.length === 0}>
          {busy ? "Saving…" : (draft.id ? "Save changes" : "Create pool")}
        </button>
      </div>
    </div>
  );
}
