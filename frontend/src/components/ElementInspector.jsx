import { useState, useCallback } from "react";
import { actionDefinitions } from "../actions/actionDefinitions";
import { createAction } from "../workflow/stepFactory";

// ─── Action catalogue ─────────────────────────────────────────────────────
// Groups actions by category with metadata for the UI.
// "smartDefault" functions receive the element info and return pre-filled param values.

const CATEGORIES = [
  {
    id: "interaction",
    label: "Interaction",
    color: "#3fb950",
    actions: [
      {
        type: "CLICK_ELEMENT",
        icon: "▶",
        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, fallbackSelectors: el.fallbackSelectors }),
        quickAdd: true,
      },
      {
        type: "HOVER_ELEMENT",
        icon: "✋",
        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector }),
      },
      {
        type: "TYPE_TEXT",
        icon: "✏️",
        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, clearFirst: true, pressEnter: false }),
        showWhen: (el) => el.isInput,
      },
      {
        type: "CLEAR_INPUT",
        icon: "🗑️",
        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector }),
        showWhen: (el) => el.isInput,
      },
      {
        type: "SCROLL_TO_ELEMENT",
        icon: "⬇",
        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector }),
      },
      {
        type: "PRESS_KEY",
        icon: "⌨️",
        needsEl: false,
        smartDefault: () => ({ key: "Enter", count: 1 }),
      },
      {
        type: "SCROLL_PAGE",
        icon: "📜",
        needsEl: false,
        smartDefault: () => ({ direction: "down", amount: 500 }),
      },
      {
        type: "UPLOAD_FILE",
        icon: "📎",
        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector }),
        showWhen: (el) => el.tag === "input",
      },
    ],
  },
  {
    id: "extraction",
    label: "Extraction",
    color: "#58a6ff",
    actions: [
      {
        type: "EXTRACT_TEXT",
        icon: "📝",
        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, fallbackSelectors: el.fallbackSelectors, multiple: false }),
        quickAdd: true,
      },
      {
        type: "EXTRACT_ATTRIBUTE",
        icon: "🔗",
        needsEl: true,
        smartDefault: (el) => ({
          selector: el.selector,
          attribute: el.href ? "href" : el.src ? "src" : "",
          multiple: false,
        }),
        showWhen: (el) => el.isLink || el.isImg || el.href || el.src,
      },
      {
        type: "EXTRACT_HTML",
        icon: "🧩",
        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, mode: "inner" }),
      },
      {
        type: "EXTRACT_TABLE",
        icon: "📋",
        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, hasHeader: true }),
        showWhen: (el) => el.isTable,
        quickAdd: true,
      },
      {
        type: "EXTRACT_LIST",
        icon: "📑",
        needsEl: true,
        smartDefault: (el) => ({ containerSelector: el.selector }),
      },
      {
        type: "EXTRACT_JSON",
        icon: "{ }",
        needsEl: false,
        smartDefault: () => ({ source: "jsonld" }),
      },
    ],
  },
  {
    id: "navigation",
    label: "Navigation",
    color: "#d29922",
    actions: [
      {
        type: "NAVIGATE",
        icon: "🌐",
        needsEl: false,
        smartDefault: () => ({ url: "" }),
      },
      {
        type: "GO_BACK",
        icon: "◀",
        needsEl: false,
        smartDefault: () => ({}),
        quickAdd: true,
      },
      {
        type: "RELOAD_PAGE",
        icon: "🔄",
        needsEl: false,
        smartDefault: () => ({}),
        quickAdd: true,
      },
      {
        type: "OPEN_NEW_TAB",
        icon: "➕",
        needsEl: false,
        smartDefault: () => ({ url: "" }),
      },
      {
        type: "SWITCH_TAB",
        icon: "⇄",
        needsEl: false,
        smartDefault: () => ({ tabIndex: 0 }),
      },
    ],
  },
  {
    id: "flow",
    label: "Flow Control",
    color: "#a371f7",
    actions: [
      {
        type: "WAIT",
        icon: "⏱️",
        needsEl: false,
        smartDefault: () => ({ duration: 1000 }),
        quickAdd: true,
      },
      {
        type: "WAIT_FOR_SELECTOR",
        icon: "👁️",
        needsEl: false,
        smartDefault: (el) => ({ selector: el?.selector || "", state: "visible", timeout: 30000 }),
      },
      {
        type: "WAIT_FOR_NAVIGATION",
        icon: "⏳",
        needsEl: false,
        smartDefault: () => ({}),
      },
      {
        type: "CONDITION",
        icon: "🔀",
        needsEl: false,
        smartDefault: () => ({ expression: "" }),
      },
      {
        type: "LOOP",
        icon: "🔁",
        needsEl: false,
        smartDefault: () => ({ mode: "forEach", source: "", count: 10 }),
      },
      {
        type: "BREAK_LOOP",
        icon: "⛔",
        needsEl: false,
        smartDefault: () => ({}),
        quickAdd: true,
      },
    ],
  },
  {
    id: "data",
    label: "Data",
    color: "#f78166",
    actions: [
      {
        type: "SET_VARIABLE",
        icon: "📦",
        needsEl: false,
        smartDefault: () => ({ name: "", value: "" }),
      },
      {
        type: "TRANSFORM_DATA",
        icon: "🔧",
        needsEl: false,
        smartDefault: () => ({ source: "", operation: "trim" }),
      },
      {
        type: "APPEND_TO_LIST",
        icon: "➕",
        needsEl: false,
        smartDefault: () => ({ listName: "results", item: "" }),
      },
      {
        type: "SAVE_DATA",
        icon: "💾",
        needsEl: false,
        smartDefault: () => ({ source: "results", format: "json", destination: "./output/results.json" }),
      },
    ],
  },
];

// Flatten for lookups
const ALL_ACTIONS = CATEGORIES.flatMap(cat =>
  cat.actions.map(a => ({ ...a, categoryId: cat.id, categoryLabel: cat.label, categoryColor: cat.color }))
);

// ─── Main component ────────────────────────────────────────────────────────

export default function ElementInspector({ element, onClose, onAddStep }) {
  const [activeCategory, setActiveCategory] = useState("interaction");
  const [selectedAction, setSelectedAction] = useState(null);
  const [addedFlash, setAddedFlash] = useState(false);

  const cat = CATEGORIES.find(c => c.id === activeCategory);
  const visibleActions = cat ? cat.actions.filter(a => !a.showWhen || a.showWhen(element)) : [];

  const handleSelectAction = (actionMeta) => {
    setSelectedAction(actionMeta);
  };

  const handleAdd = useCallback((params, advanced) => {
    const step = createAction(actionMeta.type, params, advanced);
    onAddStep(step);
    setAddedFlash(true);
    setTimeout(() => setAddedFlash(false), 1200);
  }, [selectedAction, onAddStep]);

  // Smart quick-add (no config needed)
  const handleQuickAdd = (actionMeta) => {
    const def = actionDefinitions[actionMeta.type];
    if (!def) return;
    const smartParams = actionMeta.smartDefault ? actionMeta.smartDefault(element) : {};
    const advanced = buildDefaultAdvanced(def);
    const step = createAction(actionMeta.type, { ...buildDefaultParams(def), ...smartParams }, advanced);
    onAddStep(step);

    // Visual flash on the card
    setAddedFlash(actionMeta.type);
    setTimeout(() => setAddedFlash(null), 1000);
  };

  if (!element) return null;

  return (
    <div className="ei-overlay" onClick={onClose}>
      <div className="ei-panel" onClick={e => e.stopPropagation()}>

        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="ei-header">
          <div className="ei-header-info">
            <span className="ei-tag">&lt;{element.tag}&gt;</span>
            {element.classes && (
              <span className="ei-classes">{element.classes.slice(0, 60)}</span>
            )}
          </div>
          <button className="ei-close" onClick={onClose} title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* ── Selector pill ──────────────────────────────────────────────── */}
        <div className="ei-selector-row">
          <span className="ei-selector-icon">🎯</span>
          <code className="ei-selector">{element.selector}</code>
          {element.similarCount > 1 && (
            <span className="ei-similar-badge">{element.similarCount} similar</span>
          )}
        </div>

        {/* ── Breadcrumb ─────────────────────────────────────────────────── */}
        {element.breadcrumb?.length > 0 && (
          <div className="ei-breadcrumb">
            {element.breadcrumb.map((seg, i) => (
              <span key={i}>
                <span className="ei-breadcrumb-seg">{seg.label}</span>
                {i < element.breadcrumb.length - 1 && <span className="ei-breadcrumb-sep"> › </span>}
              </span>
            ))}
          </div>
        )}

        {/* ── Element preview ────────────────────────────────────────────── */}
        {(element.text || element.href || element.src) && (
          <div className="ei-preview">
            {element.text && <div className="ei-preview-text">"{element.text}"</div>}
            {element.href && <div className="ei-preview-attr"><span className="ei-attr-name">href</span> {element.href}</div>}
            {element.src  && <div className="ei-preview-attr"><span className="ei-attr-name">src</span> {element.src}</div>}
          </div>
        )}

        <div className="ei-body">
          {/* ── Category tabs ──────────────────────────────────────────── */}
          <div className="ei-tabs">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                className={`ei-tab ${activeCategory === c.id ? 'active' : ''}`}
                style={activeCategory === c.id ? { borderColor: c.color, color: c.color } : {}}
                onClick={() => { setActiveCategory(c.id); setSelectedAction(null); }}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* ── Action cards ───────────────────────────────────────────── */}
          <div className="ei-action-grid">
            {visibleActions.map(actionMeta => {
              const def = actionDefinitions[actionMeta.type];
              if (!def) return null;
              const isSelected = selectedAction?.type === actionMeta.type;
              const isFlashing = addedFlash === actionMeta.type;

              return (
                <div
                  key={actionMeta.type}
                  className={`ei-action-card ${isSelected ? 'selected' : ''} ${isFlashing ? 'flash' : ''}`}
                  style={isSelected ? { borderColor: cat.color } : {}}
                  onClick={() => handleSelectAction(actionMeta)}
                >
                  <div className="ei-action-icon">{actionMeta.icon}</div>
                  <div className="ei-action-label">{def.label}</div>
                  {actionMeta.quickAdd && (
                    <button
                      className="ei-quick-add"
                      title="Add with defaults"
                      onClick={e => { e.stopPropagation(); handleQuickAdd(actionMeta); }}
                    >
                      +
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Action configurator ────────────────────────────────────── */}
          {selectedAction && (
            <ActionConfigurator
              key={selectedAction.type}
              actionMeta={selectedAction}
              element={element}
              accentColor={cat?.color}
              onAdd={(params, advanced) => {
                const step = createAction(selectedAction.type, params, advanced);
                onAddStep(step);
                setAddedFlash(selectedAction.type);
                setTimeout(() => setAddedFlash(null), 1000);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Action configurator ──────────────────────────────────────────────────
// Shows the full input form for the selected action and handles Add.

function ActionConfigurator({ actionMeta, element, accentColor, onAdd }) {
  const def = actionDefinitions[actionMeta.type];
  if (!def) return null;

  const smartDefaults = actionMeta.smartDefault ? actionMeta.smartDefault(element) : {};
  const [params,   setParams]   = useState({ ...buildDefaultParams(def),   ...smartDefaults });
  const [advanced, setAdvanced] = useState(buildDefaultAdvanced(def));
  const [added,    setAdded]    = useState(false);

  const setParam   = (k, v) => setParams(p => ({ ...p, [k]: v }));
  const setAdv     = (k, v) => setAdvanced(a => ({ ...a, [k]: v }));

  const handleAdd = () => {
    onAdd(params, advanced);
    setAdded(true);
    setTimeout(() => setAdded(false), 1200);
  };

  const hasAdvanced = def.advanced && Object.keys(def.advanced).length > 0;
  const [showAdv, setShowAdv] = useState(false);

  return (
    <div className="ei-configurator">
      <div className="ei-config-header">
        <span style={{ color: accentColor }}>{actionMeta.icon}</span>
        <span className="ei-config-title">{def.label}</span>
        {def.description && <span className="ei-config-desc">{def.description}</span>}
      </div>

      {/* Selector chip (read-only, for element-bound actions) */}
      {actionMeta.needsEl && element?.selector && (
        <div className="ei-config-selector">
          <span className="ei-attr-name">selector</span>
          <code>{params.selector || element.selector}</code>
        </div>
      )}

      {/* Main inputs */}
      <div className="ei-config-fields">
        {Object.entries(def.inputs || {}).map(([key, inputDef]) => {
          // Skip selector / fallbackSelectors — shown separately or auto-filled
          if (key === 'selector' || key === 'fallbackSelectors') return null;
          return (
            <ConfigField
              key={key}
              fieldKey={key}
              def={inputDef}
              value={params[key]}
              onChange={v => setParam(key, v)}
              accentColor={accentColor}
            />
          );
        })}
      </div>

      {/* Advanced toggle */}
      {hasAdvanced && (
        <button className="ei-adv-toggle" onClick={() => setShowAdv(v => !v)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ transform: showAdv ? 'rotate(180deg)' : 'rotate(0)', transition: '150ms' }}>
            <polyline points="6,9 12,15 18,9"/>
          </svg>
          {showAdv ? 'Hide' : 'Show'} advanced options
        </button>
      )}

      {showAdv && hasAdvanced && (
        <div className="ei-config-fields ei-adv-fields">
          {Object.entries(def.advanced).map(([key, advDef]) => (
            <ConfigField
              key={key}
              fieldKey={key}
              def={advDef}
              value={advanced[key]}
              onChange={v => setAdv(key, v)}
              accentColor={accentColor}
            />
          ))}
        </div>
      )}

      <button
        className="ei-add-btn"
        style={{ background: added ? '#3fb950' : accentColor }}
        onClick={handleAdd}
      >
        {added
          ? <><CheckIcon /> Added!</>
          : <><PlusIcon /> Add to workflow</>
        }
      </button>
    </div>
  );
}

// ─── Individual field renderer ────────────────────────────────────────────

function ConfigField({ fieldKey, def, value, onChange, accentColor }) {
  const label = def.label || fieldKey;
  const required = def.required;

  return (
    <div className="ei-field">
      <label className="ei-field-label">
        {label}{required && <span className="ei-required">*</span>}
      </label>

      {def.type === 'string' && (
        <input
          className="ei-input"
          type="text"
          value={value ?? ''}
          placeholder={def.placeholder || ''}
          onChange={e => onChange(e.target.value)}
          style={{ '--accent': accentColor }}
        />
      )}

      {def.type === 'number' && (
        <input
          className="ei-input"
          type="number"
          value={value ?? (def.default ?? '')}
          onChange={e => onChange(Number(e.target.value))}
          style={{ '--accent': accentColor }}
        />
      )}

      {def.type === 'boolean' && (
        <label className="ei-checkbox-label">
          <input
            type="checkbox"
            className="ei-checkbox"
            checked={!!value}
            onChange={e => onChange(e.target.checked)}
            style={{ accentColor }}
          />
          <span>{value ? 'Enabled' : 'Disabled'}</span>
        </label>
      )}

      {def.type === 'select' && (
        <select
          className="ei-select"
          value={value ?? def.default ?? ''}
          onChange={e => onChange(e.target.value)}
        >
          {(def.options || []).map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      )}

      {def.type === 'array' && (
        <input
          className="ei-input"
          type="text"
          value={(value || []).join(', ')}
          placeholder="Comma-separated values"
          onChange={e => onChange(e.target.value.split(',').map(v => v.trim()).filter(Boolean))}
          style={{ '--accent': accentColor }}
        />
      )}

      {/* keyvalue type used by EXTRACT_LIST fields */}
      {def.type === 'keyvalue' && (
        <KeyValueEditor value={value || {}} onChange={onChange} accentColor={accentColor} />
      )}
    </div>
  );
}

// ─── Key-value editor (for EXTRACT_LIST fields map) ───────────────────────

function KeyValueEditor({ value, onChange, accentColor }) {
  const entries = Object.entries(value);

  const setEntry = (i, k, v) => {
    const next = [...entries];
    next[i] = [k, v];
    onChange(Object.fromEntries(next));
  };

  const addEntry = () => onChange({ ...value, '': '' });

  const removeEntry = (i) => {
    const next = entries.filter((_, idx) => idx !== i);
    onChange(Object.fromEntries(next));
  };

  return (
    <div className="ei-kv">
      {entries.map(([k, v], i) => (
        <div key={i} className="ei-kv-row">
          <input
            className="ei-input ei-kv-input"
            placeholder="field name"
            value={k}
            onChange={e => setEntry(i, e.target.value, v)}
          />
          <span className="ei-kv-arrow">→</span>
          <input
            className="ei-input ei-kv-input"
            placeholder="child selector"
            value={v}
            onChange={e => setEntry(i, k, e.target.value)}
          />
          <button className="ei-kv-remove" onClick={() => removeEntry(i)} title="Remove">×</button>
        </div>
      ))}
      <button className="ei-kv-add" onClick={addEntry} style={{ color: accentColor }}>
        + Add field
      </button>
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="20,6 9,17 4,12"/>
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildDefaultParams(def) {
  const params = {};
  for (const [key, input] of Object.entries(def.inputs || {})) {
    params[key] = input.default !== undefined ? input.default : (input.type === 'array' ? [] : '');
  }
  return params;
}

function buildDefaultAdvanced(def) {
  const advanced = {};
  for (const [key, adv] of Object.entries(def.advanced || {})) {
    if (adv.default !== undefined) advanced[key] = adv.default;
  }
  return advanced;
}