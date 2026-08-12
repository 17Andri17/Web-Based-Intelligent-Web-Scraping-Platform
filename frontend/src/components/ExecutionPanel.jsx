import { useState, useRef, useEffect, useCallback } from "react";
import { resultsToCsv } from "../utils/resultsExport";
import { runsApi } from "../api/client";
import useDialog from "./useDialog";

/* =====================================================================
   ExecutionPanel
   Props:
     isOpen        bool
     onClose       fn
     logs          [{ line, level }]
     status        'idle' | 'running' | 'done' | 'error'
     results       object | null    — { [labelName]: data }
     onCancel      fn
     runId         number | null   — persisted run id for this run; enables
                                     the server-rendered Excel (.xlsx) export
   ===================================================================== */
export default function ExecutionPanel({
  isOpen, onClose, logs, status, results, onCancel, runId = null,
  steps = [], stepStates = {}, iterations = {}, lastStepId = null,
  rowsCaptured = 0, stepTimes = {}, workers = {}, lanes = {}, laneTotals = {},
  stalled = false,
}) {
  // Focus trap, Escape, focus restore, scroll lock, backdrop semantics.
  // closeOnBackdrop stays off: this panel shows a run in flight and had no
  // backdrop dismissal before — losing sight of a running job because a
  // click landed outside would be a regression, not a fix.
  const { overlayProps, dialogProps } = useDialog({ open: isOpen, onClose, closeOnBackdrop: false });
  const [activeTab,    setActiveTab]    = useState('flow');
  const [selectedKey,  setSelectedKey]  = useState(null);
  const [exportFormat, setExportFormat] = useState('json');
  const [exportErr,    setExportErr]    = useState(null);
  const logsEndRef = useRef(null);

  // Auto-scroll log
  useEffect(() => {
    if (activeTab === 'logs') logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, activeTab]);

  // Switch to the data tab once results arrive — but not while the run is
  // still going: yanking the user off the Flow view mid-run (a paginated API
  // step publishes results per page now) would hide the thing they opened the
  // panel to watch.
  useEffect(() => {
    if (!results || Object.keys(results).length === 0) return;
    setSelectedKey(prev => prev || Object.keys(results)[0]);
    if (status !== 'running') setActiveTab('data');
  }, [results, status]);

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

  // Single combined file — all extraction results in one download.
  // JSON/CSV serialise in the browser from the in-memory results (fast, no
  // round-trip). XLSX is binary and rendered server-side, so it fetches the
  // workbook for this persisted run — hence it needs a runId.
  const handleExport = async () => {
    if (!results) return;
    setExportErr(null);
    if (exportFormat === 'json') {
      downloadFile(JSON.stringify(results, null, 2), 'results.json', 'application/json');
    } else if (exportFormat === 'csv') {
      downloadFile(resultsToCsv(results), 'results.csv', 'text/csv');
    } else if (exportFormat === 'xlsx') {
      if (runId == null) { setExportErr('Excel export needs a saved run — try again once the run finishes.'); return; }
      try {
        const blob = await runsApi.downloadDataBlob(runId, 'xlsx');
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `run-${runId}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        setExportErr(err?.response?.data?.error || err.message || 'Excel export failed');
      }
    }
  };

  if (!isOpen) return null;

  const resultKeys  = results ? Object.keys(results) : [];
  const currentData = selectedKey ? results?.[selectedKey] : null;
  const hasResults  = resultKeys.length > 0;

  return (
    <div className="ep-overlay" {...overlayProps}>
      <div className="ep-panel" {...dialogProps}>
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="ep-header">
          <div className="ep-header-left">
            <StatusBadge status={status} />
            <span className="ep-title">Workflow Execution</span>
            {runId != null && <span className="ep-run-id">Run #{runId}</span>}
            {/* Rows safely stored so far. A long run otherwise looks identical
                at minute 1 and minute 40 — this is the one number that shows
                it is actually getting somewhere, and it is the count that
                would survive if the run stopped right now. */}
            {status === 'running' && rowsCaptured > 0 && (
              <span className="ep-rows-live" title="Rows captured and saved so far — kept even if the run stops">
                {rowsCaptured.toLocaleString()} rows saved
              </span>
            )}
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

        {/* Nothing is reporting on this run. Said plainly, with the way out
            right next to it — an unexplained spinner with a Cancel that does
            nothing is the worst version of this. */}
        {stalled && status === 'running' && (
          <div className="ep-stalled">
            <span className="ep-stalled-icon">!</span>
            <span>
              This run isn&rsquo;t reporting progress — the server that was executing it may have
              stopped. Anything it captured is saved. Use Stop to close it out.
            </span>
            <button className="ep-btn danger" onClick={onCancel}>Stop</button>
          </div>
        )}

        {/* ── Tabs ────────────────────────────────────────────────────── */}
        <div className="ep-tabs">
          <button className={`ep-tab ${activeTab === 'flow' ? 'active' : ''}`} onClick={() => setActiveTab('flow')}>
            <FlowIcon /> Flow
            {status === 'running' && <span className="ep-tab-pulse" />}
          </button>
          <button className={`ep-tab ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
            <TerminalIcon /> Logs
          </button>
          <button className={`ep-tab ${activeTab === 'data' ? 'active' : ''}`} onClick={() => setActiveTab('data')}
            disabled={!hasResults}>
            <DataIcon /> Results
            {hasResults && <span className="ep-tab-badge">{resultKeys.length}</span>}
          </button>
        </div>

        {/* ── Live Flow view ──────────────────────────────────────────── */}
        {activeTab === 'flow' && (
          <div className="ep-flow">
            {(!steps || steps.length === 0) ? (
              <div className="ep-empty-logs">
                {status === 'running'
                  ? 'Loading the step list for this run…'
                  : 'No steps to show.'}
              </div>
            ) : (
              <ul className="ep-flow-tree">
                {steps.map(s => (
                  <FlowNode
                    key={s.id}
                    step={s}
                    depth={0}
                    stepStates={stepStates}
                    iterations={iterations}
                    lastStepId={lastStepId}
                    stepTimes={stepTimes}
                    workers={workers}
                    lanes={lanes}
                    laneTotals={laneTotals}
                  />
                ))}
              </ul>
            )}
          </div>
        )}

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
                            <button className={exportFormat === 'json' ? 'active' : ''} onClick={() => { setExportFormat('json'); setExportErr(null); }}>JSON</button>
                            <button className={exportFormat === 'csv'  ? 'active' : ''} onClick={() => { setExportFormat('csv'); setExportErr(null); }}>CSV</button>
                            {runId != null && (
                              <button className={exportFormat === 'xlsx' ? 'active' : ''} onClick={() => { setExportFormat('xlsx'); setExportErr(null); }}>Excel</button>
                            )}
                          </div>
                          <button className="ep-btn" onClick={handleExport}>
                            <DownloadIcon />
                            Export all results
                            <span className="ep-export-filename">
                              {exportFormat === 'xlsx' ? `run-${runId}.xlsx` : `results.${exportFormat}`}
                            </span>
                          </button>
                        </div>
                      </div>

                      {exportErr && <div className="ep-export-err">{exportErr}</div>}

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

/* =====================================================================
   FlowNode — recursive renderer for one step in the live flow tree.
   Children come from control blocks' branch arrays (body/then/else/etc).
   ===================================================================== */
const FLOW_BRANCH_KEYS = ["body", "then", "else", "try", "catch"];
const FLOW_LOOP_TYPES  = new Set(["FOR_EACH", "FOR_EACH_ELEMENTS", "FOR_EACH_ROW", "WHILE", "REPEAT",
  "PAGINATE_SCROLL", "PAGINATE_BUTTON", "PAGINATE_URL"]);
// RUN_SUBFLOW modes that run the subflow once per item — show a loop-style
// "N / M" iteration badge, just like a real loop.
const SUBFLOW_ITER_MODES = new Set(["iterate", "enrich"]);

/* How long a step took.

   A step that ran once shows its duration. A step INSIDE a loop ran once per
   iteration, so a total would be meaningless next to its siblings — it shows
   the average instead, with the run count so the number is interpretable. The
   loop itself ran once at its own level, so it shows the whole thing. */
function formatMs(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ""}`;
}

function StepTiming({ timing }) {
  if (!timing || !timing.n) return null;
  const avg = timing.ms / timing.n;
  const repeated = timing.n > 1;
  return (
    <span
      className="ep-flow-time"
      title={repeated
        ? `Ran ${timing.n.toLocaleString()} times · ${formatMs(avg)} average · ${formatMs(timing.ms)} total`
        : `Took ${formatMs(timing.ms)}`}
    >
      {repeated ? `~${formatMs(avg)}` : formatMs(timing.ms)}
      {repeated && <span className="ep-flow-time-n">×{timing.n.toLocaleString()}</span>}
    </span>
  );
}

/* What each parallel worker is doing.

   "12 of 30" is the whole story at concurrency 1 and almost none of it at
   concurrency 8, where the useful questions are whether every worker is busy
   and roughly where they are. One compact lane per worker answers both in a
   single row; it disappears entirely when there's nothing to disambiguate. */
function WorkerLanes({ workers, lanes, total, bodySteps }) {
  const [open, setOpen] = useState(false);
  if (!Array.isArray(workers) || workers.length < 2) return null;
  const busy = workers.filter(w => w != null).length;
  const detail = lanes || {};

  return (
    <div className="ep-flow-workers-wrap">
      <button
        type="button"
        className="ep-flow-workers"
        onClick={() => setOpen(o => !o)}
        title={open ? "Hide what each worker is doing" : "Show what each worker is doing"}
      >
        <span className={"ep-flow-workers-caret" + (open ? " open" : "")}>▸</span>
        <span className="ep-flow-workers-label">
          {busy} of {workers.length} working
        </span>
        {/* Collapsed: one chip per worker with the item it holds. Enough to
            see the pool is saturated without opening anything. */}
        {!open && workers.map((item, i) => (
          <span
            key={i}
            className={"ep-flow-worker" + (item == null ? " ep-flow-worker--idle" : "")}
          >
            {item == null ? "·" : item + 1}
          </span>
        ))}
      </button>

      {/* Expanded: what each worker is actually doing right now. This is the
          detail that the shared step row cannot show — with N workers on the
          same subflow body, one row can only ever display one of them. */}
      {open && (
        <ul className="ep-flow-lanes">
          {workers.map((item, i) => (
            <WorkerLane
              key={i}
              n={i}
              item={item}
              detail={detail[i] || {}}
              total={total}
              bodySteps={bodySteps}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/* One worker. Collapsed it is a single line — which item, which step, where in
   any loop. Opened it renders the SAME step tree as the main view, but scored
   with this worker's own states, so you can see one worker's pass through the
   body in isolation instead of the blur of all of them at once. */
function WorkerLane({ n, item, detail, total, bodySteps }) {
  const [open, setOpen] = useState(false);
  const idle = item == null;
  const canExpand = !idle && Array.isArray(bodySteps) && bodySteps.length > 0;

  return (
    <li className={"ep-flow-lane-wrap" + (idle ? " ep-flow-lane--idle" : "")}>
      <div
        className={"ep-flow-lane" + (canExpand ? " ep-flow-lane--clickable" : "")}
        onClick={canExpand ? () => setOpen(o => !o) : undefined}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        onKeyDown={canExpand ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(o => !o); } } : undefined}
        title={canExpand ? (open ? "Hide this worker's steps" : "Show this worker's steps") : undefined}
      >
        {canExpand
          ? <span className={"ep-flow-lane-caret" + (open ? " open" : "")}>▸</span>
          : <span className="ep-flow-lane-caret ep-flow-lane-caret--none" />}
        <span className="ep-flow-lane-n">{n + 1}</span>
        {idle ? (
          <span className="ep-flow-lane-idle">idle</span>
        ) : (
          <>
            <span className="ep-flow-lane-item">
              item {item + 1}{total ? ` / ${total}` : ""}
            </span>
            {detail.step && !open && (
              <span className="ep-flow-lane-step">
                {detail.step.label?.trim() || friendlyType(detail.step.type)}
              </span>
            )}
            {detail.iter && !open && (
              <span className="ep-flow-lane-iter">
                {detail.iter.total ? `${detail.iter.index}/${detail.iter.total}` : detail.iter.index}
              </span>
            )}
          </>
        )}
      </div>

      {open && canExpand && (
        <ul className="ep-flow-tree ep-flow-lane-tree">
          {bodySteps.map(s => (
            <FlowNode
              key={s.id}
              step={s}
              depth={0}
              stepStates={detail.stepStates || {}}
              iterations={detail.iterations || {}}
              lastStepId={detail.lastStepId || null}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/* How many workers are on this step right now.

   A step inside a parallel subflow has no single state — N workers are at N
   different points. It used to be left "idle" for that reason, which read as
   "never ran" for the steps doing most of the work. Counting the lanes gives
   it an honest state of its own: running in N workers. */
function laneSummary(laneDetail, stepId) {
  if (!laneDetail || !stepId) return null;
  let running = 0, done = 0, error = 0;
  for (const lane of Object.values(laneDetail)) {
    const st = lane && lane.stepStates && lane.stepStates[stepId];
    if (st === "running") running++;
    else if (st === "done") done++;
    else if (st === "error") error++;
  }
  return (running || done || error) ? { running, done, error } : null;
}

function FlowNode({ step, depth, stepStates, iterations, lastStepId, stepTimes = {}, workers = {},
                    lanes = {}, laneTotals = {}, inParallel = false, parallelOwner = null }) {
  if (!step || typeof step !== "object") return null;
  const timing = stepTimes[step.id];
  const workerItems = workers[step.id];
  const laneDetail = lanes[step.id];

  // Inside a parallel loop, state comes from the lanes rather than the shared
  // stream — the shared one deliberately holds nothing for these steps.
  const summary = parallelOwner ? laneSummary(lanes[parallelOwner], step.id) : null;
  const state = summary
    ? (summary.running > 0 ? "parallel" : summary.error > 0 ? "error" : "done")
    : (stepStates[step.id] || "idle");
  const iter  = iterations[step.id];

  // A loop that several workers run at once. Its per-lane index restarts on
  // every item and interleaves across workers, so showing it reads as noise —
  // the running total across all lanes is the number that means something.
  const laneTotal = inParallel ? laneTotals[step.id] : null;
  const isParallelHere = Array.isArray(workerItems) && workerItems.length > 1;
  const isLoop = step.kind === "control" && FLOW_LOOP_TYPES.has(step.type);
  const isSubflowIter = step.kind === "action" && step.type === "RUN_SUBFLOW"
    && SUBFLOW_ITER_MODES.has(step.params?.mode);

  // Control branches (body / then / else / try / catch).
  const branches = [];
  for (const key of FLOW_BRANCH_KEYS) {
    if (Array.isArray(step[key]) && step[key].length > 0) {
      branches.push([key, step[key]]);
    }
  }
  // A RUN_SUBFLOW carries the subflow's own inlined steps under
  // `subflowSteps` (sent by the backend). Rendering them makes the Flow tab
  // show exactly what the subflow runs, nested under the Run Subflow row.
  const subflowSteps = Array.isArray(step.subflowSteps) ? step.subflowSteps : null;

  const label = step.label?.trim() || friendlyType(step.type) || "step";

  return (
    <li className={"ep-flow-node ep-flow-state-" + state}>
      <div className="ep-flow-row" style={{ paddingLeft: 4 + depth * 14 }}>
        <FlowStatusDot state={state} running={state === "running"} />
        <span className="ep-flow-type">{stepKindIcon(step)}</span>
        <span className="ep-flow-label">{label}</span>
        <span className="ep-flow-typetag">{friendlyType(step.type)}</span>
        {(isLoop || isSubflowIter) && laneTotal != null && (
          <span
            className="ep-flow-iter"
            title={`${laneTotal.toLocaleString()} iterations completed across all workers. Per-worker position is in the worker list above — a single number here would jump between workers and describe none of them.`}
          >
            {laneTotal.toLocaleString()} done
          </span>
        )}
        {(isLoop || isSubflowIter) && laneTotal == null && iter && (
          <span
            className="ep-flow-iter"
            title={iter.total ? `Iteration ${iter.index} of ${iter.total}` : `Iteration ${iter.index}`}
          >
            {iter.total ? `${iter.index}/${iter.total}` : iter.index}
            {iter.running && <span className="ep-flow-iter-pulse" />}
          </span>
        )}
        {summary && summary.running > 0 && (
          <span
            className="ep-flow-parallel"
            title={`${summary.running} worker${summary.running === 1 ? "" : "s"} running this step right now`}
          >
            ×{summary.running}
          </span>
        )}
        <StepTiming timing={timing} />
      </div>
      {(isLoop || isSubflowIter) && (
        <WorkerLanes
          workers={workerItems}
          lanes={laneDetail}
          total={iter && iter.total}
          bodySteps={subflowSteps || step.body}
        />
      )}
      {branches.map(([key, list]) => (
        <ul key={key} className="ep-flow-branch">
          {branches.length > 1 && <li className="ep-flow-branch-label" style={{ paddingLeft: 4 + (depth + 1) * 14 }}>{key}</li>}
          {list.map(s => (
            <FlowNode
              key={s.id}
              step={s}
              depth={depth + 1}
              stepStates={stepStates}
              iterations={iterations}
              lastStepId={lastStepId}
              stepTimes={stepTimes}
              workers={workers}
              lanes={lanes}
              laneTotals={laneTotals}
              inParallel={inParallel || isParallelHere}
              parallelOwner={isParallelHere ? step.id : parallelOwner}
            />
          ))}
        </ul>
      ))}
      {subflowSteps && subflowSteps.length > 0 && (
        <ul className="ep-flow-branch ep-flow-subflow">
          <li className="ep-flow-branch-label ep-flow-subflow-label" style={{ paddingLeft: 4 + (depth + 1) * 14 }}>
            ⇉ {step.subflowName || "subflow"}
          </li>
          {subflowSteps.map(s => (
            <FlowNode
              key={s.id}
              step={s}
              depth={depth + 1}
              stepStates={stepStates}
              iterations={iterations}
              lastStepId={lastStepId}
              stepTimes={stepTimes}
              workers={workers}
              lanes={lanes}
              laneTotals={laneTotals}
              inParallel={inParallel || isParallelHere}
              parallelOwner={isParallelHere ? step.id : parallelOwner}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
function FlowStatusDot({ state, running }) {
  return <span className={"ep-flow-dot ep-flow-dot--" + state}>{running ? <span className="ep-flow-dot-spin" /> : null}</span>;
}
function friendlyType(t) {
  if (!t) return "";
  return t.toLowerCase().replace(/_/g, " ");
}
function stepKindIcon(step) {
  if (step.kind === "control") return "⌥";
  switch (step.type) {
    case "NAVIGATE":            return "🌐";
    case "GO_BACK":             return "◀";
    case "CLICK_ELEMENT":       return "▶";
    case "DISMISS_COOKIE_BANNER": return "🍪";
    case "TYPE_TEXT":           return "✏️";
    case "SCROLL_PAGE":         return "📜";
    case "WAIT":                return "⏱";
    case "EXTRACT_TEXT":        return "📝";
    case "EXTRACT_ATTRIBUTE":   return "🔗";
    case "EXTRACT_HTML":        return "🧩";
    case "EXTRACT_TABLE":       return "📋";
    case "EXTRACT_LIST":        return "📑";
    case "EXTRACT_JSON":        return "{}";
    case "RUN_SUBFLOW":         return "⇉";
    default:                    return "•";
  }
}

/* ── Icons ── */
function FlowIcon()     { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M8 6h6a2 2 0 0 1 2 2v2"/><path d="M8 18h6a2 2 0 0 0 2-2v-2"/></svg>; }
function XIcon()        { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>; }
function StopIcon()     { return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>; }
function TerminalIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4,17 10,11 4,5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>; }
function DataIcon()     { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>; }
function DownloadIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>; }
function TableIcon2()   { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>; }