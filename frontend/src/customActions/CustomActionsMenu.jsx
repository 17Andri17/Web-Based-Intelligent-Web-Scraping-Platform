import React, { useEffect, useState } from "react";
import { customActionsApi } from "../api/client";

const INPUT_TYPES = [
  { value: "string",   label: "Text" },
  { value: "number",   label: "Number" },
  { value: "boolean",  label: "Boolean" },
  { value: "selector", label: "CSS selector" },
  { value: "json",     label: "JSON (object)" },
];

const SAMPLE_CODE = `// Custom action body — runs inside the workflow's Puppeteer script.
//
// Available in scope:
//   inputs  – { name → value } from the inputs you declared below
//   page    – Puppeteer Page (browser tab)
//   fetch   – global fetch
//   log     – console.log proxy (lines appear in the run panel)
//
// Return ONE value (object, array, string, number…). It will be stored in
// the workflow results under the step's label (or this action's name).
//
// Example: count anchor tags on the page
const count = await page.$$eval('a', els => els.length);
log('found', count, 'links');
return { count };
`;

function emptyDraft() {
  return {
    name: "",
    description: "",
    inputs: [],
    outputs: [],
    code: SAMPLE_CODE,
  };
}

export default function CustomActionsMenu({ open, onClose, showToast, onChanged }) {
  const [list,    setList]    = useState([]);
  const [editing, setEditing] = useState(null); // { id?, name, description, inputs, outputs, code }
  const [loading, setLoading] = useState(false);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setList(await customActionsApi.list());
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setLoading(false); }
  };

  useEffect(() => { if (open) { refresh(); setEditing(null); } }, [open]);

  if (!open) return null;

  const startNew  = () => { setEditing(emptyDraft()); setError(null); };
  const startEdit = (action) => { setEditing({ ...action }); setError(null); };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: editing.name,
        description: editing.description || "",
        inputs: editing.inputs || [],
        outputs: editing.outputs || [],
        code: editing.code || "",
      };
      const saved = editing.id
        ? await customActionsApi.update(editing.id, payload)
        : await customActionsApi.create(payload);
      showToast?.(`✓ ${editing.id ? "Updated" : "Created"} "${saved.name}"`, "success");
      setEditing(null);
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const remove = async (id, name) => {
    if (!confirm(`Delete custom action "${name}"? Workflows that use it will fail at execution.`)) return;
    setBusy(true);
    setError(null);
    try {
      await customActionsApi.remove(id);
      showToast?.(`✓ Deleted "${name}"`, "success");
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal ca-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>{editing ? (editing.id ? "Edit custom action" : "New custom action") : "Custom actions"}</h2>
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="wf-section-title">Your custom actions</div>
                <button className="wf-save-btn" onClick={startNew}>+ New action</button>
              </div>

              {loading ? (
                <div className="wf-empty">Loading…</div>
              ) : list.length === 0 ? (
                <div className="wf-empty">
                  No custom actions yet. Click <strong>+ New action</strong> to build a reusable step
                  with your own JS code.
                </div>
              ) : (
                <div className="wf-list">
                  {list.map(a => (
                    <div className="wf-item" key={a.id}>
                      <div className="info">
                        <span className="name">{a.name}</span>
                        <span className="meta">
                          {a.inputs.length} input{a.inputs.length !== 1 && "s"} · {a.outputs.length} output{a.outputs.length !== 1 && "s"}
                          {a.description ? ` — ${a.description}` : ""}
                        </span>
                      </div>
                      <div className="actions">
                        <button onClick={() => startEdit(a)} disabled={busy}>Edit</button>
                        <button className="danger" onClick={() => remove(a.id, a.name)} disabled={busy}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {editing && (
            <ActionEditor
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

function ActionEditor({ draft, setDraft, onSave, onCancel, busy }) {
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  return (
    <div className="ca-editor">
      <div className="ca-field">
        <label>Name <span className="ca-hint">(shown in the step picker)</span></label>
        <input
          type="text"
          value={draft.name}
          onChange={e => set("name", e.target.value)}
          placeholder="e.g. Extract product price"
          maxLength={80}
        />
      </div>

      <div className="ca-field">
        <label>Description <span className="ca-hint">(optional)</span></label>
        <input
          type="text"
          value={draft.description || ""}
          onChange={e => set("description", e.target.value)}
          placeholder="One-line summary of what this action does"
          maxLength={500}
        />
      </div>

      <div className="ca-field">
        <label>Inputs <span className="ca-hint">— values the user provides when using this action</span></label>
        <SchemaListEditor
          items={draft.inputs}
          onChange={(items) => set("inputs", items)}
          allowType
        />
      </div>

      <div className="ca-field">
        <label>Outputs <span className="ca-hint">— names you return from your code (informational; the runtime stores whatever you return)</span></label>
        <SchemaListEditor
          items={draft.outputs}
          onChange={(items) => set("outputs", items)}
          allowType={false}
        />
      </div>

      <div className="ca-field">
        <label>Code body</label>
        <textarea
          className="ca-code"
          spellCheck={false}
          rows={16}
          value={draft.code || ""}
          onChange={e => set("code", e.target.value)}
        />
        <div className="ca-hint" style={{ marginTop: 6 }}>
          You have <code>inputs</code>, <code>page</code>, <code>fetch</code>, and <code>log</code> in scope.
          Return one value (object/array/scalar) — it's stored under the step's label in the run results.
        </div>
      </div>

      <div className="ca-footer">
        <button className="modal-btn secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="modal-btn primary" onClick={onSave} disabled={busy || !draft.name?.trim()}>
          {busy ? "Saving…" : (draft.id ? "Save changes" : "Create action")}
        </button>
      </div>
    </div>
  );
}

function SchemaListEditor({ items, onChange, allowType }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("string");

  const add = () => {
    const n = name.trim();
    if (!n) return;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(n)) {
      alert("Name must be a valid JS identifier (letters, digits, underscores; can't start with a digit).");
      return;
    }
    if (items.some(i => i.name === n)) {
      alert(`Duplicate name: ${n}`);
      return;
    }
    onChange([...items, allowType ? { name: n, type } : { name: n }]);
    setName("");
  };

  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));
  const updateType = (i, t) => onChange(items.map((it, idx) => idx === i ? { ...it, type: t } : it));

  return (
    <div className="ca-schema">
      {items.length === 0 && <div className="ca-empty-row">No entries yet.</div>}
      {items.map((it, i) => (
        <div className="ca-schema-row" key={i}>
          <code className="ca-schema-name">{it.name}</code>
          {allowType && (
            <select value={it.type || "string"} onChange={e => updateType(i, e.target.value)}>
              {INPUT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          <button className="ca-schema-remove" onClick={() => remove(i)} title="Remove">×</button>
        </div>
      ))}
      <div className="ca-schema-add">
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          placeholder="new_name"
        />
        {allowType && (
          <select value={type} onChange={e => setType(e.target.value)}>
            {INPUT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        <button onClick={add} className="wf-save-btn" style={{ padding: "0 12px" }}>+</button>
      </div>
    </div>
  );
}
