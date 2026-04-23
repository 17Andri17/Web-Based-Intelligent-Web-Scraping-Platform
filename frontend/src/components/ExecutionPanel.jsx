import { useState, useRef, useEffect, useCallback } from "react";

/* =====================================================================
   ExecutionPanel
   Props:
     isOpen        bool
     onClose       fn
     logs          [{ line, level }]
     status        'idle' | 'running' | 'done' | 'error'
     results       object | null    — { [labelName]: data }
     onCancel      fn
   ===================================================================== */
export default function ExecutionPanel({ isOpen, onClose, logs, status, results, onCancel }) {
  const [activeTab,    setActiveTab]    = useState('logs');
  const [selectedKey,  setSelectedKey]  = useState(null);
  const [exportFormat, setExportFormat] = useState('json');
  const logsEndRef = useRef(null);

  // Auto-scroll log
  useEffect(() => {
    if (activeTab === 'logs') logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, activeTab]);

  // Switch to data tab once results arrive
  useEffect(() => {
    if (results && Object.keys(results).length > 0) {
      setActiveTab('data');
      setSelectedKey(prev => prev || Object.keys(results)[0]);
    }
  }, [results]);

  // Export helpers
  const downloadFile = (content, filename, mime) => {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Single combined file — all extraction results in one download
  const handleExport = () => {
    if (!results) return;
    if (exportFormat === 'json') {
      downloadFile(JSON.stringify(results, null, 2), 'results.json', 'application/json');
    } else {
      const sections = Object.entries(results).map(([key, data]) =>
        `# ${key}\n${toCSV(data)}`
      );
      downloadFile(sections.join('\n\n'), 'results.csv', 'text/csv');
    }
  };

  if (!isOpen) return null;

  const resultKeys  = results ? Object.keys(results) : [];
  const currentData = selectedKey ? results?.[selectedKey] : null;
  const hasResults  = resultKeys.length > 0;

  return (
    <div className="ep-overlay">
      <div className="ep-panel">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="ep-header">
          <div className="ep-header-left">
            <StatusBadge status={status} />
            <span className="ep-title">Workflow Execution</span>
          </div>
          <div className="ep-header-right">
            {status === 'running' && (
              <button className="ep-btn danger" onClick={onCancel}>
                <StopIcon /> Cancel
              </button>
            )}
            <button className="ep-close" onClick={onClose}>
              <XIcon />
            </button>
          </div>
        </div>

        {/* ── Tabs ────────────────────────────────────────────────────── */}
        <div className="ep-tabs">
          <button className={`ep-tab ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
            <TerminalIcon /> Logs
            {status === 'running' && <span className="ep-tab-pulse" />}
          </button>
          <button className={`ep-tab ${activeTab === 'data' ? 'active' : ''}`} onClick={() => setActiveTab('data')}
            disabled={!hasResults}>
            <DataIcon /> Results
            {hasResults && <span className="ep-tab-badge">{resultKeys.length}</span>}
          </button>
        </div>

        {/* ── Log view ────────────────────────────────────────────────── */}
        {activeTab === 'logs' && (
          <div className="ep-logs">
            {logs.length === 0 && status === 'idle' && (
              <div className="ep-empty-logs">Logs will appear here when the workflow runs</div>
            )}
            {logs.map((entry, i) => (
              <div key={i} className={`ep-log-line ${entry.level}`}>
                <span className="ep-log-prefix">{entry.level === 'error' ? '!' : '›'}</span>
                <span className="ep-log-text">{entry.line}</span>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}

        {/* ── Results / data view ─────────────────────────────────────── */}
        {activeTab === 'data' && (
          <div className="ep-data-view">
            {!hasResults ? (
              <div className="ep-empty-logs">
                {status === 'running' ? 'Waiting for results…' : 'No extraction results. Make sure your extraction steps are named.'}
              </div>
            ) : (
              <>
                {/* Dataset selector */}
                <div className="ep-data-sidebar">
                  {resultKeys.map(key => (
                    <button key={key}
                      className={`ep-ds-btn ${selectedKey === key ? 'active' : ''}`}
                      onClick={() => setSelectedKey(key)}>
                      <span className="ep-ds-icon">{getDataIcon(results[key])}</span>
                      <span className="ep-ds-label">{key}</span>
                      <span className="ep-ds-count">{getCount(results[key])}</span>
                    </button>
                  ))}
                </div>

                {/* Data preview */}
                <div className="ep-data-main">
                  {currentData !== null && currentData !== undefined && (
                    <>
                      {/* Toolbar */}
                      <div className="ep-data-toolbar">
                        <span className="ep-data-title">{selectedKey}</span>
                        <div className="ep-data-actions">
                          <div className="ep-format-toggle">
                            <button className={exportFormat === 'json' ? 'active' : ''} onClick={() => setExportFormat('json')}>JSON</button>
                            <button className={exportFormat === 'csv'  ? 'active' : ''} onClick={() => setExportFormat('csv')}>CSV</button>
                          </div>
                          <button className="ep-btn" onClick={handleExport}>
                            <DownloadIcon />
                            Export all results
                            <span className="ep-export-filename">
                              results.{exportFormat}
                            </span>
                          </button>
                        </div>
                      </div>

                      {/* Preview */}
                      <div className="ep-preview-area">
                        <DataPreview data={currentData} />
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* =====================================================================
   DataPreview — renders arrays as tables, objects as JSON, scalars as text
   ===================================================================== */
function DataPreview({ data }) {
  const [viewMode, setViewMode] = useState('auto');

  const isArray  = Array.isArray(data);
  const isObject = data !== null && typeof data === 'object' && !isArray;
  const isTableable = isArray && data.length > 0 && typeof data[0] === 'object' && data[0] !== null;
  const effectiveMode = viewMode === 'auto' ? (isTableable ? 'table' : 'json') : viewMode;

  return (
    <div className="ep-data-preview">
      {/* Mode switcher */}
      {isTableable && (
        <div className="ep-view-toggle">
          <button className={effectiveMode === 'table' ? 'active' : ''} onClick={() => setViewMode('table')}>
            <TableIcon2 /> Table
          </button>
          <button className={effectiveMode === 'json' ? 'active' : ''} onClick={() => setViewMode('json')}>
            {'{ }'} JSON
          </button>
        </div>
      )}

      {/* Table view */}
      {effectiveMode === 'table' && isTableable && (
        <div className="ep-table-wrap">
          <table className="ep-table">
            <thead>
              <tr>
                <th className="ep-th ep-row-num">#</th>
                {Object.keys(data[0]).map(k => <th key={k} className="ep-th">{k}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.slice(0, 200).map((row, i) => (
                <tr key={i} className="ep-tr">
                  <td className="ep-td ep-row-num">{i + 1}</td>
                  {Object.keys(data[0]).map(k => (
                    <td key={k} className="ep-td">
                      <span className="ep-cell-value">{formatCell(row[k])}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data.length > 200 && (
            <div className="ep-table-truncated">Showing 200 of {data.length} rows</div>
          )}
        </div>
      )}

      {/* JSON view */}
      {effectiveMode === 'json' && (
        <pre className="ep-json-view">{JSON.stringify(data, null, 2)}</pre>
      )}

      {/* Scalar */}
      {!isArray && !isObject && (
        <pre className="ep-json-view">{String(data)}</pre>
      )}
    </div>
  );
}

/* =====================================================================
   Status badge
   ===================================================================== */
function StatusBadge({ status }) {
  const map = {
    idle:    { label: 'Ready',    cls: 'idle'    },
    running: { label: 'Running',  cls: 'running' },
    done:    { label: 'Complete', cls: 'done'    },
    error:   { label: 'Error',    cls: 'error'   },
  };
  const { label, cls } = map[status] || map.idle;
  return <span className={`ep-status-badge ${cls}`}>{label}</span>;
}

/* =====================================================================
   Helpers
   ===================================================================== */
function toCSV(data) {
  if (!Array.isArray(data)) return JSON.stringify(data);
  if (data.length === 0) return '';
  if (typeof data[0] !== 'object') return data.join('\n');
  const headers = Object.keys(data[0]);
  const rows    = data.map(r => headers.map(h => csvCell(r[h])).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function csvCell(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function getCount(data) {
  if (Array.isArray(data)) return data.length;
  if (data !== null && typeof data === 'object') return `{${Object.keys(data).length}}`;
  return '1';
}

function getDataIcon(data) {
  if (Array.isArray(data)) return '▤';
  if (data !== null && typeof data === 'object') return '{ }';
  return '"';
}

function formatCell(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/* ── Icons ── */
function XIcon()        { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>; }
function StopIcon()     { return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>; }
function TerminalIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4,17 10,11 4,5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>; }
function DataIcon()     { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>; }
function DownloadIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>; }
function TableIcon2()   { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>; }