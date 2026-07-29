import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import io from "socket.io-client";
import { useWorkflow, findStepLocation, getContainer } from "./workflow/useWorkflow";
import { createAction, createControl } from "./workflow/stepFactory";
import { ACTION_TYPES } from "./actions/actionTypes";
import { CONTROL_TYPES } from "./workflow/controlDefinitions";
import WorkflowPanel from "./components/WorkflowPanel";
import ElementInspector, { ForEachContextBanner } from "./components/ElementInspector";
import ExecutionPanel from "./components/ExecutionPanel";
import DataPreviewPanel from "./components/DataPreviewPanel";
import CompactWorkflowSidebar from "./components/CompactWorkflowSidebar";
import HtmlInspectorPanel from "./components/HtmlInspectorPanel";
import PaginationDetector from "./components/PaginationDetector";
import ApiSourcesPanel from "./components/ApiSourcesPanel";
import Dashboard from "./components/Dashboard";
import GuidedCoach, { coachStepIndex } from "./components/GuidedCoach";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import AuthScreen from "./auth/AuthScreen";
import WorkflowsMenu from "./workflows/WorkflowsMenu";
import CustomActionsMenu from "./customActions/CustomActionsMenu";
import ProxiesMenu from "./proxies/ProxiesMenu";
import ApiKeysMenu from "./apiKeys/ApiKeysMenu";
import WebhooksMenu from "./webhooks/WebhooksMenu";
import { API_BASE, customActionsApi, workflowsApi, aiApi } from "./api/client";
import "./styles/PaginationDetector.css";
import "./styles/ApiSourcesPanel.css";
import "./styles/app.css";
import "./styles/ExecutionPanel.css";
import "./styles/DataPreviewPanel.css";
import "./styles/CompactWorkflowSidebar.css";
import "./styles/HtmlInspectorPanel.css";
import "./styles/auth.css";

// Empty API_BASE (production, same-origin) → connect Socket.IO to the current
// origin by passing undefined.
const SERVER_URL = API_BASE || undefined;

// Build a "Call Data API" (EXTRACT_API) step from a discovered API source
// (from the API Discovery panel). Maps the endpoint, captured headers/body,
// detected collection path, and pagination param into the step's params.
const SIZE_PARAM_RX = /^(limit|size|per[_-]?page|page[_-]?size|count|rows|top)$/i;
const OFFSET_PARAM_RX = /^(offset|start|skip|from)$/i;
function buildApiStepFromSource(source) {
  const pag = (source.queryParams || []).filter((p) => p.role === "pagination");
  // Loop on a page/offset/cursor param, not a bare page-size param.
  const primary = pag.find((p) => !SIZE_PARAM_RX.test(p.name)) || pag[0] || null;
  const sizeParam = pag.find((p) => SIZE_PARAM_RX.test(p.name));
  const isOffset = primary && OFFSET_PARAM_RX.test(primary.name);
  const startNum = primary && /^\d+$/.test(String(primary.value))
    ? parseInt(primary.value, 10) : (isOffset ? 0 : 1);
  const sizeNum = sizeParam && /^\d+$/.test(String(sizeParam.value)) ? parseInt(sizeParam.value, 10) : null;
  const pageStep = isOffset ? (sizeNum || 20) : 1;

  // Prefill the JSON path only when the detected collection path is a clean
  // dot-path (no array indices) the codegen's pluck can walk.
  const rawPath = source.recordShape && source.recordShape.path;
  const jsonPath = (typeof rawPath === "string" && /^[\w.]+$/.test(rawPath)) ? rawPath : "";

  const step = createAction(
    ACTION_TYPES.EXTRACT_API,
    {
      method: source.method || "GET",
      url: source.url,
      headers: source.requestHeaders || {},
      body: source.requestBody || null,
      jsonPath,
      paginate: !!primary,
      pageParam: primary ? primary.name : "",
      pageParamIn: "query",
    },
    { startPage: startNum, pageStep, maxPages: 50, stopWhenEmpty: true }
  );

  const pathLast = source.path ? source.path.split("/").filter(Boolean).slice(-1)[0] : "";
  step.label = (source.ai && source.ai.title && source.ai.title.trim()) || pathLast || "API data";
  return step;
}

// ── Workflow-variable substitution (client-side preview path) ───────────
// The codegen handles `{{name}}` at run time by emitting JS template
// literals; in the editor's live preview we don't have those generated
// declarations, so we substitute the variable VALUES into selectors /
// URLs / etc. before sending the payload to the backend's previewStep.
// References to undeclared names are left untouched (verbatim text).
// Same reference syntax as the codegen. A variable NAME may contain spaces
// (e.g. "Escape Room Listings"), so we only exclude the structural chars
// . [ ] { } from the name / dotted-path segments. The `[*]` projection form
// is intentionally NOT resolved here (it needs a runtime array), so those
// references are left as literal text for the run to substitute.
// Dotted paths only resolve if the ROOT name is a declared workflow variable
// AND it's an object. (Iteration variables like `product.link` only exist at
// run time, so the live preview leaves them as literal text — the user can
// still verify them once they hit Run.)
const VAR_RX = /\{\{\s*([^.[\]{}]+(?:\.[^.[\]{}]+)*)\s*\}\}/g;
function resolveVars(s, vars) {
  if (typeof s !== "string" || !s.includes("{{")) return s;
  const map = new Map();
  for (const v of vars || []) {
    if (v && typeof v.name === "string" && v.name) map.set(v.name, v.value);
  }
  if (map.size === 0) return s;
  return s.replace(VAR_RX, (full, path) => {
    const parts = path.split(".").map(p => p.trim());
    if (!map.has(parts[0])) return full;     // root not a declared variable → leave for runtime
    let cur = map.get(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      if (cur == null || typeof cur !== "object") return full;
      cur = cur[parts[i]];
    }
    return cur == null ? "" : String(cur);
  });
}
function deepResolveVars(obj, vars) {
  if (obj == null) return obj;
  if (typeof obj === "string") return resolveVars(obj, vars);
  if (Array.isArray(obj)) return obj.map(v => deepResolveVars(v, vars));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepResolveVars(v, vars);
    return out;
  }
  return obj;
}

// Depth-first scan for a step type anywhere in the workflow tree (branches
// included). Used to avoid double-adding singleton-ish steps like
// DISMISS_COOKIE_BANNER / SOLVE_CAPTCHA.
function treeHasStepType(arr, type) {
  for (const s of arr || []) {
    if (!s || typeof s !== "object") continue;
    if (s.type === type) return true;
    for (const key of ["body", "then", "else", "try", "catch"]) {
      if (Array.isArray(s[key]) && treeHasStepType(s[key], type)) return true;
    }
  }
  return false;
}

// Every NAVIGATE url anywhere in the workflow tree (the pinned start step plus
// any recorded mid-flow navigations), templates included. Interpolated urls
// like `{{url}}/reviews` are kept here and resolved against the variables'
// sample values by the caller — a start step built with an input variable
// still points at a concrete page while you build, so it can be matched to the
// live-browser url. Used to decide whether the page the user drifted to is one
// the workflow already reaches on its own.
function collectNavigateUrls(steps) {
  const out = [];
  const walk = (arr) => {
    for (const s of arr || []) {
      if (!s || typeof s !== "object") continue;
      if (s.type === "NAVIGATE" && s.params?.url) {
        out.push(s.params.url);
      }
      // Recurse into control-block child containers (then / else / body / …),
      // which are the only array-valued properties directly on a step.
      for (const v of Object.values(s)) if (Array.isArray(v)) walk(v);
    }
  };
  walk(steps);
  return out;
}

// Root index where a page-setup step (close cookie banner, solve CAPTCHA)
// should land: right after the start NAVIGATE, behind any setup steps already
// attached there — so they stack in arrival order and stay glued to the
// navigation they belong to.
function stickyInsertIndex(root) {
  if (!root?.length || root[0]?.type !== "NAVIGATE") return 0;
  let i = 1;
  while (i < root.length && root[i]?.attach) i++;
  return i;
}

// Index for inserting "after" a step, skipping past any followers attached
// to it — a new step must not split an attached group (e.g. land between a
// Navigate and its stuck Close Cookie Banner).
function insertIndexAfter(rootSteps, loc) {
  const container = getContainer(rootSteps, loc.containerPath) || [];
  let i = loc.index + 1;
  while (i < container.length && container[i]?.attach) i++;
  return i;
}

// Write text to the local clipboard. navigator.clipboard needs a secure
// context (https / localhost); fall back to the hidden-textarea trick so
// copy still works when the app is served over plain http on a LAN host.
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }
}

function App() {
  const { user, token, loading: authLoading, logout } = useAuth();

  if (authLoading) {
    return <div className="auth-loading">Connecting…</div>;
  }
  if (!user || !token) {
    return <AuthScreen />;
  }
  return <AppShell user={user} token={token} onLogout={logout} />;
}

function AppShell({ user, token, onLogout }) {
  const { steps, totalCount, setSteps, addStep, updateStep, deleteStep, reorderSteps, updateLabelById, updateParamsById, addStepAt, moveStepById, setAttachById, undo, redo, canUndo, canRedo } = useWorkflow();
  const [activeTab, setActiveTab] = useState("stream");

  // List-field pick coordination — lifted here so pick mode survives the
  // tab switch from Workflow → Live Browser (the editor that starts the
  // pick would otherwise unmount and kill the mode). Tracks which
  // EXTRACT_LIST step is currently picking; null = not picking.
  const [listPickStepId,      setListPickStepId]      = useState(null);
  const [sidebarExpandStepId, setSidebarExpandStepId] = useState(null);
  // AI extract-list-fields request in flight, owned here (not by the
  // inspector) so the answer still lands after the sidebar switches to the
  // workflow tab and the inspector unmounts. { requestId, stepId } | null.
  const pendingAiListRef = useRef(null);
  const aiListTimeoutRef = useRef(null);
  const [aiListBusyStepId, setAiListBusyStepId] = useState(null);

  const canvasRef            = useRef(null);
  const canvasContainerRef   = useRef(null);
  const socketRef            = useRef(null);
  // Mirror the socket in state so child components that need to subscribe
  // to events (e.g. ExtractListFieldsEditor) can react when the connection
  // becomes ready. socketRef is still the primary handle for emits in the
  // imperative code paths below — keeping both avoids touching dozens of
  // call sites.
  const [socket, setSocket] = useState(null);
  const resizeTimeoutRef     = useRef(null);
  const isStreamingRef       = useRef(false);
  const latestFrameRef       = useRef(null);
  const isRenderingRef       = useRef(false);
  // Remote viewport size in CSS pixels (from `viewportUpdated`). The frames
  // are captured at devicePixelRatio scale, so the canvas backing store is
  // dpr× larger than the remote page's coordinate space — mouse positions
  // must be mapped against THIS size, not canvas.width/height.
  const viewportCssRef       = useRef(null);
  // While a page is loading AND the cookie-consent auto-dismiss is analysing
  // it, we pause forwarding the user's clicks to the backend so a stray click
  // can't land on a half-loaded page or fight the consent handler. Released
  // shortly after `pageReady`, with a hard safety timeout so it can never stay
  // stuck if the load/ready signal never arrives.
  const interactionLockedRef = useRef(false);
  const unlockTimerRef       = useRef(null);
  const maxLockTimerRef      = useRef(null);

  const [status,          setStatus]          = useState("");
  const [urlInput,        setUrlInput]        = useState("");
  // Live URL of the puppeteer page — updated whenever the backend reports a
  // navigation (link click, history nav, redirect). Used to keep the URL bar
  // in sync with where the page actually is, and to flag mismatches against
  // the workflow's pinned start URL.
  const [currentPageUrl,  setCurrentPageUrl]  = useState("");
  // Bumped every time the backend says the page's `load` event has fired.
  // Used as a dependency of the preview effect so previews re-fire against
  // a fully-loaded page (rather than racing the navigation).
  const [pageReadyTick,   setPageReadyTick]   = useState(0);
  const [mode,            setMode]            = useState("navigation");
  const [cursorType,      setCursorType]      = useState("default");
  const [isConnected,     setIsConnected]     = useState(false);
  const [selectedElement, setSelectedElement] = useState(null);
  const [childrenList,    setChildrenList]     = useState(null);  // { levelsUp, children }
  // Result of the power-user "adjust selector" apply — { ok, matchCount,
  // primary, fallbacks, error } | null. Cleared when the selection changes.
  const [manualSelResult, setManualSelResult] = useState(null);
  const [toast,           setToast]           = useState(null);   // { msg, type }
  const toastTimerRef = useRef(null);
  // Click-to-teach cookie-banner prompt (see browser/consent.js): when the
  // user manually dismisses a banner the auto-detection missed — in ANY
  // mode, including plain navigation — the page reports the clicked control
  // and we offer to record it as a "Close Cookie Banner" step.
  // { selector, selectorType, fallbackSelectors, text, kind } | null
  const [cookiePrompt, setCookiePrompt] = useState(null);
  const cookiePromptTimerRef = useRef(null);
  // Selectors the user said "No thanks" to — don't re-offer this session.
  const declinedCookieSelectorsRef = useRef(new Set());

  // CAPTCHA prompt (see browser/captcha.js): when a challenge is detected on
  // the streamed page we surface a banner so the user can solve it in place,
  // auto-solve it (if a solver is configured), or add a "Solve CAPTCHA" step.
  // { captchaType, sitekey, action, url, provider, solverConfigured, solving } | null
  const [captchaPrompt, setCaptchaPrompt] = useState(null);
  const captchaPromptTimerRef = useRef(null);
  // True once this session auto-recorded a "Close Cookie Banner" step from
  // the auto-dismiss cascade. Also stays true if the user deletes that step
  // — we shouldn't keep re-adding something they removed on purpose.
  const cookieStepAutoAddedRef = useRef(false);

  // Preview data: separate from steps so updates don't re-trigger emission
  const [previewData,     setPreviewData]     = useState({});
  // Sidebar: shared inspector + workflow panel
  const [showSidebar,     setShowSidebar]     = useState(false);
  const [sidebarTab,      setSidebarTab]      = useState("inspector");
  // Drag-resizable width (all three sidebar tabs share it) + a maximize
  // toggle for the HTML tab, which hides the canvas entirely since there's
  // nothing useful to see on a frozen/offscreen stream at that point anyway.
  const [sidebarWidth,    setSidebarWidth]    = useState(360);
  const [htmlMaximized,   setHtmlMaximized]   = useState(false);
  const isResizingSidebarRef = useRef(false);
  // Closing the sidebar always drops the maximize state too — reopening it
  // (from any entry point) should start back in the normal split view
  // rather than re-hiding the canvas from under the user.
  useEffect(() => {
    if (!showSidebar) setHtmlMaximized(false);
  }, [showSidebar]);
  // Pagination detection
  const [paginationOpen,  setPaginationOpen]  = useState(false);
  const [paginationDetecting, setPaginationDetecting] = useState(false);
  const [paginationSuggestions, setPaginationSuggestions] = useState(null);
  const [paginationError,    setPaginationError]    = useState(null);
  const [paginationManualWaiting, setPaginationManualWaiting] = useState(false); // true when waiting for element click // "inspector" | "workflow"

  // API discovery — analyze captured network calls, propose the data API
  const [apiPanelOpen,   setApiPanelOpen]   = useState(false);
  const [apiAnalyzing,   setApiAnalyzing]   = useState(false);
  const [apiSources,     setApiSources]     = useState(null);
  const [apiError,       setApiError]       = useState(null);
  const [apiCaptured,    setApiCaptured]    = useState(0);
  const [apiConsidered,  setApiConsidered]  = useState(0);
  const [apiAiAvailable, setApiAiAvailable] = useState(false);

  // Gather the values the user is currently scraping (from step previews and
  // the selected element) so the backend can match them against captured API
  // responses — the strongest signal for "this endpoint returns their data".
  // Empty is fine: discovery falls back to structure-only scoring.
  const collectSampleValues = useCallback(() => {
    const out = [];
    const push = (v) => {
      if (v == null) return;
      const s = String(v).trim();
      if (s && s.length >= 2 && s.length <= 120) out.push(s);
    };
    for (const pd of Object.values(previewData || {})) {
      if (!pd) continue;
      push(pd.previewValue);
      if (Array.isArray(pd.previewValues)) pd.previewValues.slice(0, 20).forEach(push);
      if (Array.isArray(pd.previewRows)) {
        pd.previewRows.slice(0, 10).forEach((row) => {
          if (row && typeof row === "object") Object.values(row).slice(0, 12).forEach(push);
          else push(row);
        });
      }
    }
    if (selectedElement) { push(selectedElement.text); push(selectedElement.textContent); }
    // De-dupe, cap.
    return Array.from(new Set(out)).slice(0, 60);
  }, [previewData, selectedElement]);

  const runApiAnalysis = useCallback(() => {
    setApiPanelOpen(true);
    setApiAnalyzing(true);
    setApiSources(null);
    setApiError(null);
    socketRef.current?.emit("analyzeApiSources", { sampleValues: collectSampleValues() });
  }, [collectSampleValues]);
  const [reselectStepId,  setReselectStepId]  = useState(null); // step id awaiting element re-pick
  const [reselectIsLoop,  setReselectIsLoop]  = useState(false);
  // Which param the next page-pick writes to. null = the step's primary
  // `selector` (with selectorType + fallbacks), the classic reselect. A field
  // key (e.g. "endSelector", "loadingSelector") means the "Pick on page"
  // button on a secondary selector field in the step editor is driving it.
  const [reselectField,   setReselectField]   = useState(null);
  // Insert target: where new steps from ElementInspector will land
  // null = root end (default); { type:"inside"|"after"|"root_end", stepId? }
  const [insertTarget, setInsertTarget] = useState(null);

  // ForEach context: when set, actions are added inside the loop body
  const [forEachCtx, setForEachCtx] = useState(null); // { stepId }
  const stepsRef = useRef(steps);
  useEffect(() => { stepsRef.current = steps; }, [steps]);
  // Stable refs for reselect (avoid stale closures in socket handler)
  const reselectStepIdRef            = useRef(null);
  const reselectFieldRef             = useRef(null);
  const updateParamsByIdRef          = useRef(null);
  const handleUpdateParamsRef        = useRef(null);
  const paginationManualWaitingRef   = useRef(false);
  useEffect(() => { reselectStepIdRef.current          = reselectStepId; },          [reselectStepId]);
  useEffect(() => { reselectFieldRef.current           = reselectField; },            [reselectField]);
  useEffect(() => { updateParamsByIdRef.current         = updateParamsById; },         [updateParamsById]);
  useEffect(() => { paginationManualWaitingRef.current  = paginationManualWaiting; }, [paginationManualWaiting]);
  const insertTargetRef = useRef(null);
  useEffect(() => { insertTargetRef.current = insertTarget; }, [insertTarget]);
  // Set right before emitting selectElementByPath from the HTML tab, so the
  // resulting elementSelected event updates selectedElement (to sync the
  // tree's expand/highlight) without yanking focus away to the Inspector
  // tab — the user is actively browsing the source tree.
  const selectingFromHtmlTabRef = useRef(false);
  // Keep the latest inspector selection accessible from callbacks that the
  // auto-name helper runs from — handleAddStep clears the React state
  // immediately, but we still need the data for the AI request.
  const selectedElementRef = useRef(null);
  useEffect(() => { selectedElementRef.current = selectedElement; }, [selectedElement]);

  // ── Execution state ──────────────────────────────────────────────────────
  const [execPanelOpen, setExecPanelOpen] = useState(false);
  const [execStatus,    setExecStatus]    = useState("idle");
  const [execLogs,      setExecLogs]      = useState([]);
  // Map stepId → "idle" | "running" | "done" | "error" — powers the live
  // Flow tab in the Execution Panel.
  const [execStepStates, setExecStepStates] = useState({});
  // Map loopStepId → { total, index, running } so the Flow tab can show
  // "N / M iterations" pills for active loops.
  const [execIterations, setExecIterations] = useState({});
  const [execLastStepId, setExecLastStepId] = useState(null);
  const [execResults,   setExecResults]   = useState(null);
  // Persisted run id for the current live run (carried on executionStarted /
  // executionDone). Lets the Results panel fetch server-rendered exports
  // (e.g. .xlsx) for the run it just produced.
  const [execRunId,     setExecRunId]     = useState(null);
  // Flow tree for the live "Flow" tab. The backend sends this at run start
  // with each RUN_SUBFLOW's steps inlined (so the tab shows exactly what a
  // subflow runs). Falls back to the local `steps` when absent.
  const [execFlowTree,  setExecFlowTree]  = useState(null);
  const sessionMetaRef = useRef({});
  // Workflow-level variables (ServiceNow-style). Kept in state so the
  // Variables panel re-renders on every edit, and mirrored into the
  // meta payload sent to the backend on run / save.
  const [workflowVariables, setWorkflowVariables] = useState([]);
  const [variablesCollapsed, setVariablesCollapsed] = useState(false);

  // ── Toast helper ─────────────────────────────────────────────────────────
  const showToast = useCallback((msg, type = "success") => {
    clearTimeout(toastTimerRef.current);
    setToast({ msg, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 2400);
  }, []);

  // ── Workflows menu / current workflow ────────────────────────────────────
  const [workflowsOpen,     setWorkflowsOpen]     = useState(false);
  const [currentWorkflowId, setCurrentWorkflowId] = useState(null);
  const [currentWorkflowName, setCurrentWorkflowName] = useState("");
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // ── Dashboard home + Quick Scrape wizard ─────────────────────────────────
  // The dashboard is the landing screen after login: workflows, their run
  // status, and a "needs attention" inbox. The wizard is the guided
  // point-and-click flow for building a list scraper from scratch.
  const [dashboardOpen, setDashboardOpen] = useState(true);
  // Inline first-scrape coach: guides the user through the REAL controls
  // (URL bar → Select → click → Inspector → Run) instead of a parallel wizard.
  const [coachOpen,     setCoachOpen]     = useState(false);

  // ── Proxy servers ──────────────────────────────────────────────────────
  const [proxiesOpen, setProxiesOpen] = useState(false);
  // { mode: 'single', id } | { mode: 'pool', poolId } | { mode: 'platform' } | null.
  // Persisted into workflow.meta.proxy on save (see performNavigate and
  // WorkflowsMenu's currentMeta below) — read by
  // services/proxyResolver.service.js for both scheduled/manual runs and
  // server.js's navigate handler for the live preview. A 'pool'/'platform'
  // selection rotates to a different member proxy on each resolution.
  const [selectedProxy, setSelectedProxy] = useState(null);

  // ── API keys (public /v1 API credentials) ────────────────────────────────
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const [webhooksOpen, setWebhooksOpen] = useState(false);

  // ── Custom actions (user-defined reusable steps) ─────────────────────────
  const [customActionsOpen, setCustomActionsOpen] = useState(false);
  const [customActions,     setCustomActions]     = useState([]);
  const refreshCustomActions = useCallback(async () => {
    try { setCustomActions(await customActionsApi.list()); } catch (_) {}
  }, []);
  useEffect(() => { refreshCustomActions(); }, [refreshCustomActions]);

  // Saved-workflow list used by the RUN_SUBFLOW step's dropdown picker.
  // Populated on first mount and refreshed when the Workflows menu
  // creates / deletes a workflow (handled via onSaved/onLoaded below).
  const [availableWorkflows, setAvailableWorkflows] = useState([]);
  const refreshAvailableWorkflows = useCallback(async () => {
    try { setAvailableWorkflows(await workflowsApi.list()); } catch (_) {}
  }, []);
  useEffect(() => { refreshAvailableWorkflows(); }, [refreshAvailableWorkflows]);

  // ── Socket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    const socket = io(SERVER_URL, { auth: { token }, transports: ["websocket"] });
    socketRef.current = socket;
    setSocket(socket);
    socket.on("connect_error", (err) => {
      setStatus(`Connection error: ${err.message}`);
    });

    socket.on("connect",    () => { setStatus("Connected"); setIsConnected(true); });
    socket.on("disconnect", () => { setStatus("Disconnected"); setIsConnected(false); isStreamingRef.current = false; });
    socket.on("message",    msg  => setStatus(typeof msg === "string" ? msg : (msg.msg || "")));
    socket.on("frame",      data => { latestFrameRef.current = data; });
    socket.on("cursorType", data => setCursorType(data.cursor));
    // Page navigated inside puppeteer (link click, redirect, history nav)
    socket.on("pageUrlChanged", ({ url }) => {
      if (typeof url === "string") setCurrentPageUrl(url);
      // A navigation just started (e.g. the user clicked a link in nav mode):
      // pause clicks again until this new page loads + consent settles.
      lockInteraction();
    });
    // DOM is parsed and ready — re-fire all step previews so the Data tab
    // populates against the freshly loaded page (especially needed right
    // after opening a saved workflow, where the navigate is still in
    // flight when the steps-changed effect first ran).
    socket.on("pageReady", () => { setPageReadyTick(t => t + 1); releaseInteractionSoon(); });
    socket.on("actionResult", res => setStatus(res.success ? "Action executed." : "Action failed: " + (res.error || "")));

    // ── CAPTCHA detected on the streamed page (see browser/captcha.js) ──────
    // Offer to solve it here (free — you can just click it in the preview),
    // auto-solve it (when a server-side solver is configured), or add a
    // "Solve CAPTCHA" step so unattended runs handle it too.
    socket.on("captchaDetected", (data) => {
      const hasSolveStep = treeHasStepType(stepsRef.current, "SOLVE_CAPTCHA");
      clearTimeout(captchaPromptTimerRef.current);
      setCaptchaPrompt({
        captchaType:      data.captchaType || "unknown",
        sitekey:          data.sitekey || null,
        action:           data.action || null,
        url:              data.url || "",
        provider:         data.provider || "none",
        solverConfigured: !!data.solverConfigured,
        hasSolveStep,
        solving:          false,
      });
      // The banner is informational; keep it up a while but not forever.
      captchaPromptTimerRef.current = setTimeout(() => setCaptchaPrompt(null), 45000);
    });
    socket.on("captchaSolveResult", (res) => {
      if (res.ok) {
        showToast(res.injected ? "🧩 CAPTCHA solved" : "🧩 Token obtained — submit the form", "success");
        clearTimeout(captchaPromptTimerRef.current);
        setCaptchaPrompt(null);
      } else {
        showToast("🧩 " + (res.error || "Couldn't auto-solve — solve it in the preview"), "error");
        setCaptchaPrompt(p => (p ? { ...p, solving: false } : p));
      }
    });
    // ── Cookie banner auto-dismissed (see browser/consent.js) ───────────────
    // The cascade just clicked a consent banner on the live page. Record it
    // as a real workflow step so unattended runs do the same — stuck right
    // after the start NAVIGATE (attach = moves together with it in DnD).
    // With no selector the step uses the same automatic detection cascade.
    socket.on("consentAutoHandled", ({ name }) => {
      if (cookieStepAutoAddedRef.current) return;
      if (treeHasStepType(stepsRef.current, "DISMISS_COOKIE_BANNER")) return;
      cookieStepAutoAddedRef.current = true;
      const step = createAction("DISMISS_COOKIE_BANNER", {
        selector: "", selectorType: "css", fallbackSelectors: [],
      });
      step.attach = true;
      step.label = name && name !== "heuristic" && name !== "close-button"
        ? `Close cookie banner (${name})`
        : "Close cookie banner";
      addStep(step, [], stickyInsertIndex(stepsRef.current));
      showToast("🍪 Cookie banner closed — recorded as a step after Navigate", "success");
    });

    socket.on("viewportUpdated", (data) => {
      sessionMetaRef.current.viewportWidth  = data.width;
      sessionMetaRef.current.viewportHeight = data.height;
      viewportCssRef.current = { width: data.width, height: data.height, dpr: data.dpr || 1 };
    });

    // Reply to a Ctrl/Cmd+C forwarded from the canvas: the remote page's
    // current text selection, to be written into the LOCAL clipboard.
    socket.on("selectionText", ({ text }) => {
      if (!text) { setStatus("Nothing selected to copy"); return; }
      writeClipboard(text).then((ok) => {
        if (ok) showToast("📋 Copied selection to clipboard", "success");
        else setStatus("Couldn't write to clipboard");
      });
    });

    socket.on("browserEvent", (data) => {
      if (data.type === "workflowStep") {
        addStep(createAction(data.action, data.params || {}, data.advanced || {}), [], null);
      }
      // Click-to-teach cookie-banner detection (see browser/consent.js): the
      // user manually clicked something that classifies as a consent control
      // (works from navigation mode — no mode switch needed). Offer to record
      // it as a "Close Cookie Banner" step unless the workflow already has
      // one or the user declined this selector before.
      if (data.type === "consentClickCandidate") {
        const sel = data.selector || "";
        const hasDismissStep = treeHasStepType(stepsRef.current, "DISMISS_COOKIE_BANNER");
        if (sel && !hasDismissStep && !declinedCookieSelectorsRef.current.has(sel)) {
          clearTimeout(cookiePromptTimerRef.current);
          setCookiePrompt({
            selector:          sel,
            selectorType:      data.selectorType || "css",
            fallbackSelectors: data.fallbackSelectors || [],
            text:              data.text || "",
            kind:              data.kind || "accept",
          });
          // The offer is contextual — don't let it linger once the moment
          // has passed.
          cookiePromptTimerRef.current = setTimeout(() => setCookiePrompt(null), 20000);
        }
      }
      if (data.type === "elementSelected") {
        if (paginationManualWaitingRef.current) {
          // Manual pagination button selection
          const el = data.element;
          const sel = el.selector || '';
          const previewTxt = el.text || sel;
          paginationManualWaitingRef.current = false;
          setPaginationManualWaiting(false);
          setPaginationSuggestions(prev => [
            ...(prev || []),
            { type: 'next_button', confidence: 1, selector: sel,
              previewText: previewTxt, description: 'Manually selected pagination button.' }
          ]);
          setPaginationOpen(true);
          socketRef.current?.emit('resetSelection');
        } else if (reselectStepIdRef.current) {
          const el = data.element;
          const field = reselectFieldRef.current;
          if (field) {
            // "Pick on page" for a specific secondary selector field: write
            // just that field. selectorType is shared per step, so keep it in
            // sync too; fallbacks belong to the primary selector only.
            updateParamsByIdRef.current(reselectStepIdRef.current, {
              [field]: el.selector || '',
              selectorType: el.selectorType || 'css',
            });
            // The pick came from the step editor — take the user back to it.
            setActiveTab('workflow');
          } else {
            updateParamsByIdRef.current(reselectStepIdRef.current, {
              selector: el.selector || '',
              selectorType: el.selectorType || 'css',
              fallbackSelectors: el.fallbackSelectors || [],
            });
          }
          reselectStepIdRef.current = null;
          setReselectStepId(null);
          reselectFieldRef.current = null;
          setReselectField(null);
          socketRef.current?.emit('resetSelection');
        } else {
          setManualSelResult(null);
          setSelectedElement(data.element);
          setChildrenList(null);
          if (selectingFromHtmlTabRef.current) {
            selectingFromHtmlTabRef.current = false;
          } else {
            setShowSidebar(true);
            setSidebarTab("inspector");
          }
        }
      }
      if (data.type === "multiElementSelected") {
        // A fresh group selection supersedes any prior "adjust selector" result.
        setManualSelResult(null);
        setSelectedElement({
          isMultiSelection:  true,
          commonSelector:    data.commonSelector || "",
          matchCount:        data.matchCount      || 0,
          selectorCount:     data.selectorCount   || 0,
          elements:          data.elements        || [],
          selector:          data.commonSelector  || "",
          selectorType:      "css",
          fallbackSelectors: data.fallbackSelectors || [],
          strategy:          data.strategy || "",
          // Hierarchical (tiered) similar-selection progress
          tierIndex:         data.tierIndex,
          tierCount:         data.tierCount,
          tierLabel:         data.tierLabel || "",
          nextTier:          data.nextTier || null,
          // Manual multi-add (user hand-picks a cross-class set)
          manualAdd:         data.manualAdd || false,
          sampleCount:       data.sampleCount,
          tag:               data.elements?.[0]?.tag || "",
          classes:           "",
          text:              "",
        });
        setShowSidebar(true);
        setSidebarTab("inspector");
        setChildrenList(null);
      }
      if (data.type === "selectionCleared") {
        // Just drop the visible selection. Loop mode is its own piece of
        // state — only the banner × should be able to exit it, otherwise
        // a side-effect (mode switch, page reset, etc.) would silently
        // turn off the scope and re-aim insertions at the workflow root.
        setSelectedElement(null);
      }
    });

    // Children list for breadcrumb picker
    socket.on("childrenList", (data) => {
      setChildrenList(data);
    });

    // Power-user "adjust selector" result: an edited primary was applied on
    // the page. On success, fold the freshly-matched set + regenerated
    // fallbacks back into the live multi-selection so downstream actions
    // (For-Each / Extract List) use the edited selector.
    socket.on("manualSelectorResult", (data) => {
      setManualSelResult(data || null);
      if (data && data.ok) {
        setSelectedElement((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            isMultiSelection:  true,
            commonSelector:    data.primary,
            selector:          data.primary,
            selectorType:      data.selectorType || "css",
            matchCount:        data.matchCount,
            selectorCount:     data.matchCount,
            fallbackSelectors: data.fallbacks || [],
            elements:          data.elements || prev.elements,
            manualAdd:         false,
            manualEdited:      true,
            // A hand-edited selector is no longer on a tier ladder.
            tierIndex:         undefined,
            tierCount:         undefined,
            nextTier:          null,
          };
        });
      }
    });

    // Execution events
    socket.on("executionStarted", (info) => {
      setExecStatus("running"); setExecLogs([]); setExecResults(null);
      setExecStepStates({}); setExecIterations({}); setExecLastStepId(null);
      setExecRunId(info?.runId ?? null);
    });
    // Flow tree with subflow steps inlined — arrives just before
    // executionStarted. Kept in its own state so the reset above doesn't
    // wipe it; the Flow tab prefers it over the local step tree.
    socket.on("executionFlowTree", (data) => {
      setExecFlowTree(Array.isArray(data?.steps) ? data.steps : null);
    });
    socket.on("executionLog",     (entry) => { setExecLogs(prev => [...prev, entry]); });
    // Live flow tracking: STEP_BEGIN flips a step into "running" and
    // marks the previous one as "done" (since they execute sequentially
    // and a STEP_BEGIN of step B implies step A finished). STEP_ERROR
    // marks the current step as "error". Iteration events count loops.
    socket.on("executionStepBegin", (info) => {
      const id = info?.id;
      if (!id) return;
      setExecStepStates(prev => {
        const next = { ...prev };
        // mark whichever step was running as "done"
        for (const k of Object.keys(next)) if (next[k] === "running") next[k] = "done";
        next[id] = "running";
        return next;
      });
      setExecLastStepId(id);
    });
    socket.on("executionStepError", (info) => {
      const id = info?.step?.id;
      if (!id) return;
      setExecStepStates(prev => ({ ...prev, [id]: "error" }));
    });
    socket.on("executionIteration", (info) => {
      const id = info?.stepId;
      if (!id) return;
      setExecIterations(prev => {
        const cur = prev[id] || {};
        if (info.kind === "start") return { ...prev, [id]: { total: info.total || 0, index: 0, running: true } };
        if (info.kind === "tick")  return { ...prev, [id]: { ...cur, index: (info.index ?? 0) + 1, running: true } };
        if (info.kind === "end")   return { ...prev, [id]: { ...cur, running: false } };
        return prev;
      });
    });
    socket.on("executionDone",    ({ success, results, status, runId }) => {
      if (runId != null) setExecRunId(runId);
      // `status` is the persisted run status ('success' | 'error' | 'needs_review' | 'cancelled').
      // We map it to the local 4-state for the panel: idle/running/done/error.
      const ok = status === "success" || success;
      setExecStatus(ok ? "done" : "error");
      if (results && Object.keys(results).length > 0) setExecResults(results);
      // No STEP_BEGIN follows the final step, so it would otherwise stay
      // stuck in the "running" (spinner) state. Flip any step still marked
      // running to its terminal state now that the run has ended.
      setExecStepStates(prev => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          if (next[k] === "running") next[k] = ok ? "done" : "error";
        }
        return next;
      });
      // Likewise, stop any loop iteration counters still pulsing.
      setExecIterations(prev => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          if (next[k]?.running) next[k] = { ...next[k], running: false };
        }
        return next;
      });
    });
    // Server auto-creates a workflow row when none was passed; learn its id
    // so subsequent runs / history / schedule actions know which workflow
    // this draft belongs to.
    socket.on("workflowAutoCreated", ({ id, name }) => {
      setCurrentWorkflowId(id);
      // Use the functional setter so we don't capture a stale value from
      // the outer scope — this handler is registered once at mount.
      if (name) setCurrentWorkflowName(prev => prev || name);
      showToast(`✓ Saved draft as "${name}"`, "success");
    });
    socket.on("codeReady", ({ code, readme }) => {
      downloadTextFile(code, "workflow.js", "text/javascript");
      // Bundle a how-to-run README. Stagger the second download slightly so
      // browsers don't suppress it as a duplicate-download attempt.
      if (readme) setTimeout(() => downloadTextFile(readme, "README.md", "text/markdown"), 300);
    });
    socket.on("apiSourcesDetected", ({ sources, error, capturedCount, consideredCount, aiAvailable }) => {
      setApiAnalyzing(false);
      setApiSources(sources || []);
      setApiError(error || null);
      setApiCaptured(capturedCount || 0);
      setApiConsidered(consideredCount || 0);
      setApiAiAvailable(!!aiAvailable);
    });

    // AI enrichment for a single source comes back here; merge it into the
    // matching card (or clear its loading flag on failure).
    socket.on("apiSourceEnriched", ({ id, ai, error }) => {
      setApiSources((prev) => (prev || []).map((s) =>
        s.id === id ? { ...s, aiLoading: false, ...(ai ? { ai } : {}) } : s
      ));
      if (error) setStatus(`AI: ${error}`);
    });

    socket.on("paginationDetected", ({ suggestions, error }) => {
      setPaginationDetecting(false);
      setPaginationSuggestions(suggestions || []);
      setPaginationError(error || null);
    });

    // AI extract-list fields requested from the element inspector ("Add with
    // AI prompt"). Handled here — not in the inspector — because adding the
    // step immediately opens its editor in the workflow sidebar, which
    // unmounts the inspector before the answer arrives.
    socket.on("aiExtractListFieldsResult", (payload) => {
      const pending = pendingAiListRef.current;
      if (!pending || payload.requestId !== pending.requestId) return;
      pendingAiListRef.current = null;
      clearTimeout(aiListTimeoutRef.current);
      setAiListBusyStepId(null);

      if (!payload.ok) {
        const code = payload.code || "";
        const msg =
          code === "NO_API_KEY" ? "AI is not configured on the server (set LLM_API_KEY) — add fields manually" :
          code === "NO_PAGE"    ? "No active browser page — navigate to the target URL first" :
          code === "NO_SAMPLE"  ? (payload.error || "No matching element on the live page") :
          payload.error || "AI couldn't detect fields — add them in the editor";
        showToast(`✨ ${msg}`, "error");
        return;
      }
      // Convert the verified array [{name, selector, kind, attribute}] into
      // the params.fields object shape expected by the editor + codegen. An
      // empty selector is VALID — it means "the container element itself".
      const fieldsObj = {};
      for (const f of payload.fields || []) {
        if (!f || !f.name) continue;
        if (typeof f.selector !== "string") continue;
        const kind = f.kind === "attr" || f.kind === "html" ? f.kind : "text";
        if (kind === "attr" && !f.attribute) continue;
        fieldsObj[f.name] = {
          selector: f.selector,
          kind,
          attribute: kind === "attr" ? f.attribute : null,
        };
      }
      const count = Object.keys(fieldsObj).length;
      if (count === 0) {
        showToast("✨ AI found no usable fields — add them manually below", "error");
        return;
      }
      // Route through handleUpdateParams (not the raw hook fn) so the
      // empty→non-empty fields transition still triggers auto-naming when
      // the AI response carries no table name of its own.
      (handleUpdateParamsRef.current || updateParamsByIdRef.current)(pending.stepId, { fields: fieldsObj });
      // Auto-name the step with the AI's Title Case table name ("Product
      // Listings") — it was just created here, so there's no label to clobber.
      if (payload.name) updateLabelById(pending.stepId, payload.name);
      const via = payload.source === "heuristic" ? " (via built-in detector)" : "";
      showToast(`✨ AI added ${count} field${count === 1 ? "" : "s"}${via} — review them in the editor`, "success");
    });
    socket.on("previewResult", ({ stepId, previewValue, previewValues, previewElements, previewRows, previewTable, totalMatched, previewError, notFound }) => {
      setPreviewData(prev => ({
        ...prev,
        [stepId]: {
          ...(prev[stepId] || {}),
          ...(previewValue    !== undefined ? { previewValue }    : {}),
          ...(previewValues   !== undefined ? { previewValues }   : {}),
          ...(previewElements !== undefined ? { previewElements } : {}),
          ...(previewRows     !== undefined ? { previewRows }     : {}),
          ...(previewTable    !== undefined ? { previewTable }    : {}),
          ...(totalMatched    !== undefined ? { totalMatched }    : {}),
          ...(previewError    !== undefined ? { previewError }    : {}),
          ...(notFound        !== undefined ? { notFound }        : {}),
        },
      }));
    });

    return () => { socket.disconnect(); setSocket(null); };
  }, [token]);

  // ── Render loop ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    async function renderLoop() {
      requestAnimationFrame(renderLoop);
      if (!latestFrameRef.current || isRenderingRef.current) return;
      isRenderingRef.current = true;
      try {
        const frame = latestFrameRef.current; latestFrameRef.current = null;
        // The stream is a single uniform-resolution JPEG feed (the backend
        // downscales the 2x render to the client's dpr), so every frame is
        // the same size — sizing the canvas to the frame never oscillates,
        // and there is no second frame type to blur/jump between.
        const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width; canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        if (bitmap.close) bitmap.close();
      } catch (_) {}
      isRenderingRef.current = false;
    }
    renderLoop();
  }, []);

  // ── Wheel forwarding (non-passive so we can preventDefault) ─────────────
  // React's synthetic onWheel is passive by default, so preventDefault() in
  // an onWheel prop would be ignored and the host page would scroll. We
  // attach a native listener with passive:false so wheeling over the
  // streamed canvas scrolls the remote page and never the host UI.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e) => {
      if (!isStreamingRef.current) return;
      e.preventDefault();
      const { x, y } = scaled(e);
      const LINE_HEIGHT = 33;
      const factor = e.deltaMode === 1 ? LINE_HEIGHT
                   : e.deltaMode === 2 ? (canvasContainerRef.current?.clientHeight || 800)
                   : 1;
      socketRef.current?.emit("userAction", {
        type: "wheel",
        x, y,
        deltaX: e.deltaX * factor,
        deltaY: e.deltaY * factor,
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ── Resize ────────────────────────────────────────────────────────────────
  const handleResize = useCallback(() => {
    if (!canvasContainerRef.current || !socketRef.current || !isStreamingRef.current) return;
    clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      const rect = canvasContainerRef.current?.getBoundingClientRect();
      if (rect?.width > 0 && rect?.height > 0)
        socketRef.current.emit("resizeViewport", {
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
          devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        });
    }, 150);
  }, []);

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    window.addEventListener("resize", handleResize);
    return () => { ro.disconnect(); window.removeEventListener("resize", handleResize); clearTimeout(resizeTimeoutRef.current); };
  }, [handleResize]);

  // ── Undo / redo keyboard shortcuts ─────────────────────────────────────────
  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo — for workflow
  // edits. Skipped when focus is in a text field (native text undo wins) or on
  // the streamed canvas (that forwards keys to the remote page).
  const undoRef = useRef(undo), redoRef = useRef(redo);
  useEffect(() => { undoRef.current = undo; redoRef.current = redo; }, [undo, redo]);
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "CANVAS" ||
          (t && t.isContentEditable)) return;
      const k = (e.key || "").toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undoRef.current(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redoRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Mode ──────────────────────────────────────────────────────────────────
  const changeMode = (newMode) => {
    // While in a ForEach loop context the user must stay in selection mode
    // so they can pick items belonging to the iterator. Bail before changing
    // anything so we don't drop their selection in passing.
    if (newMode !== "selection" && forEachCtx) return;
    setMode(newMode);
    if (newMode !== "selection") {
      // Leaving selection mode tears down every page-side highlight
      // subsystem (the injected script does this on setMode) — mirror the
      // list-field pick state here so the editor's pick UI can't go stale.
      if (listPickStepId) handleStopListPick();
      socketRef.current?.emit("resetSelection");
      setSelectedElement(null);
    }
    // Any mode transition clears the sidebar step-hover highlight — it's a
    // hover preview and must never survive a context change (this is the
    // separate data-scraper-hl mechanism, so clear it explicitly here too).
    socketRef.current?.emit("clearHighlight");
    socketRef.current?.emit("setMode", { mode: newMode });
  };

  // ── Reset to a fresh workflow (like just logging in) ─────────────────────
  // Clears steps, closes the backend page, resets URL bar, drops run results.
  const resetWorkflow = useCallback(() => {
    setSteps([]);
    // End any in-flight list-field pick — the page it targeted is going away.
    setListPickStepId(null);
    socketRef.current?.emit("stopListFieldPick");
    cookieStepAutoAddedRef.current = false;
    setCurrentWorkflowId(null);
    setCurrentWorkflowName("");
    setExecResults(null);
    setExecRunId(null);
    setExecLogs([]);
    setExecStatus("idle");
    setExecPanelOpen(false);
    setSelectedElement(null);
    setForEachCtx(null);
    setChildrenList(null);
    setInsertTarget(null);
    setUrlInput("");
    setCurrentPageUrl("");
    sessionMetaRef.current = {};
    setWorkflowVariables([]);
    setSelectedProxy(null);
    socketRef.current?.emit("stopStreaming");
    isStreamingRef.current = false;
    setStatus("");
    // Wipe the last streamed frame so the canvas isn't showing a stale page.
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    latestFrameRef.current = null;
  }, [setSteps]);

  // Pending URL-change confirmation (shown when user changes URL on an
  // existing workflow). Payload: { newUrl }.
  const [urlChangeDialog, setUrlChangeDialog] = useState(null);

  // Treat two URLs as "the same page" if they only differ by hash (#anchor),
  // trailing slashes, http↔https, or the leading "www." subdomain. The first
  // three cases are common automatic redirects; stripping "www." matches how
  // most sites treat the bare apex domain and the www alias as the same site.
  // We deliberately do NOT strip other subdomains (app.x.com vs x.com are
  // different things).
  const sameUrlIgnoringHash = useCallback((a, b) => {
    if (!a || !b) return !a && !b;
    const norm = (u) => {
      try {
        const x = new URL(u);
        const host = x.hostname.replace(/^www\./i, "").toLowerCase();
        const path = x.pathname.replace(/\/+$/, "") || "/";
        // Treat http and https as the same — many sites force one and
        // redirect the other, which we don't want to flag as drift.
        return `${host}${path}${x.search}`;
      } catch { return u; }
    };
    return norm(a) === norm(b);
  }, []);

  const pinnedUrl = (steps[0]?.type === "NAVIGATE" && steps[0]?.pinned)
    ? (steps[0].params?.url || "")
    : "";
  // The start URL with any `{{var}}` resolved to the variables' sample values —
  // i.e. the concrete page the workflow opens while you build it. This is what
  // the URL bar shows and what drift is measured against, so a start step
  // written as `{{url}}/reviews` isn't perpetually flagged just for containing
  // a variable.
  const resolvedPinnedUrl = useMemo(
    () => resolveVars(pinnedUrl, workflowVariables),
    [pinnedUrl, workflowVariables]
  );
  // Every page the workflow itself navigates to (start URL + any recorded
  // mid-flow Navigate steps), with `{{var}}` references resolved to sample
  // values and any still-unresolved templates dropped (they can't map to one
  // concrete page). The drift warning only fires when the live page matches
  // NONE of these — so a variable-driven start URL, or a page you've recorded a
  // Navigate step for, stops being flagged and steps recorded there line up
  // with the workflow at run time.
  const navUrls = useMemo(() => collectNavigateUrls(steps), [steps]);
  const resolvedNavUrls = useMemo(
    () => navUrls.map(u => resolveVars(u, workflowVariables)).filter(u => !u.includes("{{")),
    [navUrls, workflowVariables]
  );
  const currentPageIsReachable = !!currentPageUrl
    && resolvedNavUrls.some(u => sameUrlIgnoringHash(currentPageUrl, u));
  const onDifferentPage = !!(pinnedUrl && currentPageUrl) && !currentPageIsReachable;

  // Whenever the puppeteer page reports a new URL (link click, redirect,
  // history nav), reflect it in the URL bar — that's what a real browser
  // does. The user's in-flight typing can get clobbered if a page-driven
  // navigation arrives mid-edit; this is the same compromise every browser
  // makes.
  useEffect(() => {
    if (currentPageUrl) setUrlInput(currentPageUrl);
  }, [currentPageUrl]);

  // Keep the URL bar in sync with the pinned step's URL whenever the user
  // edits it via the step editor modal — showing the RESOLVED url (sample
  // values substituted for `{{var}}`) so the bar reads as a real, navigable
  // address rather than the raw `{{url}}/reviews` template.
  useEffect(() => {
    const pinned = steps[0]?.type === "NAVIGATE" && steps[0]?.pinned ? steps[0] : null;
    const pUrl = resolveVars(pinned?.params?.url || "", workflowVariables);
    if (pinned && pUrl !== urlInput) {
      setUrlInput(pUrl);
    }
    // We intentionally don't depend on urlInput — that would create a cycle
    // (typing in the URL bar would reset itself on each keystroke).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, workflowVariables]);

  // ── Click-to-teach cookie prompt actions ─────────────────────────────────
  // Insert the recorded "Close Cookie Banner" step right after the start
  // NAVIGATE step (the banner shows on page load), or at the very start when
  // the workflow doesn't begin with a navigation. The step never fails when
  // the banner is absent, so it's safe on repeat visits with stored consent.
  const acceptCookiePrompt = () => {
    if (!cookiePrompt) return;
    const step = createAction("DISMISS_COOKIE_BANNER", {
      selector:          cookiePrompt.selector,
      selectorType:      cookiePrompt.selectorType || "css",
      fallbackSelectors: cookiePrompt.fallbackSelectors || [],
    });
    step.attach = true;   // stays glued to the Navigate it belongs to
    step.label  = cookiePrompt.text ? `Close cookie banner (“${cookiePrompt.text}”)` : "Close cookie banner";
    addStep(step, [], stickyInsertIndex(stepsRef.current));
    showToast("🍪 Added \"Close Cookie Banner\" step", "success");
    clearTimeout(cookiePromptTimerRef.current);
    setCookiePrompt(null);
  };
  const declineCookiePrompt = () => {
    if (cookiePrompt?.selector) declinedCookieSelectorsRef.current.add(cookiePrompt.selector);
    clearTimeout(cookiePromptTimerRef.current);
    setCookiePrompt(null);
  };

  // ── CAPTCHA prompt (see browser/captcha.js) ──────────────────────────────
  // Ask the backend to auto-solve the detected challenge (only offered when a
  // solver provider is configured server-side).
  const autoSolveCaptcha = () => {
    if (!captchaPrompt) return;
    socketRef.current?.emit("solveCaptcha", {
      captchaType: captchaPrompt.captchaType,
      sitekey:     captchaPrompt.sitekey,
      action:      captchaPrompt.action,
      url:         captchaPrompt.url,
    });
    showToast("🧩 Solving CAPTCHA…", "info");
    setCaptchaPrompt(p => (p ? { ...p, solving: true } : p));
  };
  // Record a "Solve CAPTCHA" step so unattended runs handle this challenge too.
  const addSolveCaptchaStep = () => {
    const step = createAction("SOLVE_CAPTCHA", {});
    step.attach = true;   // stays glued to the Navigate it belongs to
    addStep(step, [], stickyInsertIndex(stepsRef.current));
    showToast("🧩 Added \"Solve CAPTCHA\" step", "success");
    clearTimeout(captchaPromptTimerRef.current);
    setCaptchaPrompt(null);
  };
  const dismissCaptchaPrompt = () => {
    clearTimeout(captchaPromptTimerRef.current);
    setCaptchaPrompt(null);
  };

  // Pause click forwarding for the loading + consent-analysis window.
  const lockInteraction = useCallback(() => {
    interactionLockedRef.current = true;
    clearTimeout(unlockTimerRef.current);
    // Safety net: never stay locked more than 8s, even if pageReady never
    // fires (e.g. a hash navigation that doesn't trigger a load event).
    clearTimeout(maxLockTimerRef.current);
    maxLockTimerRef.current = setTimeout(() => { interactionLockedRef.current = false; }, 8000);
  }, []);
  // Release shortly after the page is ready, giving the first consent passes
  // (which run on a ~600ms cadence) a moment to dismiss any banner first.
  const releaseInteractionSoon = useCallback((delay = 1500) => {
    clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = setTimeout(() => {
      interactionLockedRef.current = false;
      clearTimeout(maxLockTimerRef.current);
    }, delay);
  }, []);

  // Low-level: tell the backend to navigate and start streaming the new URL.
  const performNavigate = useCallback((url) => {
    // Resolve `{{var}}` against the variables' sample values before handing the
    // url to the headless browser — a start step written as `{{url}}/reviews`
    // must open the concrete sample page, not a literal template string.
    const target = resolveVars(url, workflowVariables);
    if (!socketRef.current || !target) return;
    setStatus("Navigating...");
    lockInteraction();   // pause clicks until the page loads + consent settles
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    const vpW = Math.floor(rect?.width) || 1280;
    const vpH = Math.floor(rect?.height) || 720;
    sessionMetaRef.current = { ...sessionMetaRef.current, startUrl: target, viewportWidth: vpW, viewportHeight: vpH, proxy: selectedProxy };
    // Honour the start step's cookie-consent preference in the live editor too
    // (e.g. "Leave popup visible"), so what you see while building matches what
    // the workflow will do. Falls back to accept.
    const pinned = steps[0]?.type === "NAVIGATE" && steps[0]?.pinned ? steps[0] : null;
    const consent = pinned?.advanced?.consent || "accept";
    socketRef.current.emit("navigate", {
      url: target, mode, consent,
      viewportWidth: vpW, viewportHeight: vpH,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      proxy: selectedProxy,
    });
    isStreamingRef.current = true;
  }, [mode, steps, lockInteraction, selectedProxy, workflowVariables]);

  // Load a full workflow object into the editor. Shared by the Workflows menu
  // (onLoaded) and the Dashboard's "Open" action so both behave identically.
  // Declared after performNavigate — it references it in its dependency array.
  const loadWorkflowIntoEditor = useCallback((wf) => {
    // Normalise: mark the first NAVIGATE step as the pinned start URL. Older
    // workflows saved before pinning won't have this flag.
    const loadedSteps = (wf.steps || []).map((s, i) =>
      i === 0 && s.type === "NAVIGATE" && !s.pinned ? { ...s, pinned: true } : s
    );
    setSteps(loadedSteps);
    // A loaded workflow speaks for itself: if it already has a dismiss step
    // the scan blocks re-adds; if it doesn't, allow the auto-record again.
    cookieStepAutoAddedRef.current = false;
    setCurrentWorkflowId(wf.id);
    setCurrentWorkflowName(wf.name);
    if (wf.meta) sessionMetaRef.current = { ...sessionMetaRef.current, ...wf.meta };
    const loadedVars = Array.isArray(wf.meta?.variables) ? wf.meta.variables : [];
    setWorkflowVariables(loadedVars);
    setSelectedProxy(wf.meta?.proxy || (wf.meta?.proxyId ? { mode: "single", id: wf.meta.proxyId } : null));
    setExecResults(null);
    setExecRunId(null);
    setExecLogs([]);
    setExecStatus("idle");
    const startUrlRaw = loadedSteps[0]?.type === "NAVIGATE"
      ? loadedSteps[0]?.params?.url || ""
      : wf.meta?.startUrl || "";
    // Resolve `{{var}}` with THIS workflow's own sample values (the
    // workflowVariables state hasn't updated yet in this tick, so use the
    // freshly-loaded list). performNavigate resolves again, but a concrete
    // url passes through unchanged.
    const startUrl = resolveVars(startUrlRaw, loadedVars);
    setUrlInput(startUrl);
    if (startUrl) performNavigate(startUrl);
  }, [performNavigate, setSteps]);

  // Open a workflow by id from the Dashboard: fetch the full record, load it,
  // and leave the dashboard.
  const openWorkflowById = useCallback(async (id) => {
    try {
      const wf = await workflowsApi.get(id);
      loadWorkflowIntoEditor(wf);
      setDashboardOpen(false);
      setActiveTab("stream");
    } catch (err) {
      showToast(`✗ Couldn't open workflow: ${err?.response?.data?.error || err.message}`, "error");
    }
  }, [loadWorkflowIntoEditor, showToast]);

  // ── Navigate ──────────────────────────────────────────────────────────────
  // Three paths:
  //   1) Empty workflow → create a pinned NAVIGATE step and navigate.
  //   2) Existing workflow, same URL as pinned step → just re-navigate.
  //   3) Existing workflow, different URL → open the confirmation dialog.
  const handleNavigate = () => {
    const url = urlInput.trim();
    if (!url) return;

    const pinnedStep   = steps[0]?.type === "NAVIGATE" && steps[0]?.pinned ? steps[0] : null;
    const pinnedUrl    = pinnedStep?.params?.url;
    const hasWorkflow  = steps.length > 0;

    if (!pinnedStep && !hasWorkflow) {
      // Fresh start — create the pinned step and navigate.
      const step = createAction("NAVIGATE", { url });
      step.pinned = true;
      addStep(step, [], null);
      performNavigate(url);
      return;
    }

    // Same URL — refresh without prompting. The bar shows the RESOLVED start
    // url (sample values substituted), so compare against the resolved pinned
    // url too; otherwise re-navigating a `{{url}}/reviews` start page would be
    // mistaken for a URL change.
    const resolvedPinned = resolveVars(pinnedUrl || "", workflowVariables);
    if (pinnedStep && (url === pinnedUrl || sameUrlIgnoringHash(url, resolvedPinned))) {
      performNavigate(pinnedUrl);
      return;
    }

    // Existing workflow + URL changed → ask the user what to do.
    setUrlChangeDialog({ newUrl: url });
  };

  // "Add navigate step" from the off-start warning: the user clicked/redirected
  // their way to a page the workflow doesn't reach on its own. Record a movable
  // NAVIGATE step (appended at the end) so the flow actually visits this page —
  // after which the page stops being flagged and any steps recorded here line
  // up with the workflow. Mirrors the UrlChangeDialog "Add as step" path, but
  // for a drift the live browser produced rather than a typed URL.
  const addNavigateStepForCurrentPage = () => {
    const url = (currentPageUrl || urlInput || "").trim();
    if (!url) return;
    addStep(createAction("NAVIGATE", { url }), [], null);
    showToast("✓ Added a Navigate step for this page — steps recorded here now match the workflow", "success");
  };

  // ── Auto-suggest a snake_case label for new extraction / loop steps ───
  // Best-effort: silently does nothing if the AI is unconfigured or the
  // suggestion is unusable. Only fires for steps with no existing label.
  const AUTO_NAME_TYPES = new Set([
    "EXTRACT_TEXT", "EXTRACT_ATTRIBUTE", "EXTRACT_HTML",
    "EXTRACT_TABLE", "EXTRACT_LIST", "EXTRACT_JSON",
    "FOR_EACH_ELEMENTS",
  ]);
  const maybeAutoNameStep = useCallback((step) => {
    if (!step) { console.debug('[ai-name] no step'); return; }
    if (step.label) { console.debug('[ai-name] step already labelled:', step.label); return; }
    if (!AUTO_NAME_TYPES.has(step.type)) { console.debug('[ai-name] type not eligible:', step.type); return; }

    // An EXTRACT_LIST added via "configure later" has no fields yet, so the
    // collection it represents is still unknown — naming it now would only be
    // a guess. Skip until the user adds fields (they can rename from the table).
    if (step.type === "EXTRACT_LIST") {
      const f = step.params?.fields;
      const hasFields = f && typeof f === "object" && Object.keys(f).length > 0;
      if (!hasFields) { console.debug('[ai-name] EXTRACT_LIST has no fields yet — skipping'); return; }
    }

    const el = selectedElementRef.current;
    // Pull a few meaningful ancestors out of the breadcrumb (last entry is
    // the target itself; skip <html>/<body> generics). This gives the LLM
    // structural context — e.g. a <span> inside a <div.product-card> is
    // probably a price/title, not a navigation label.
    const breadcrumb = Array.isArray(el?.breadcrumb) ? el.breadcrumb : [];
    const ancestors = breadcrumb
      .slice(0, -1)                                  // drop the element itself
      .map(b => (typeof b === 'string' ? b : b?.label))
      .filter(Boolean)
      .filter(l => l !== 'html' && l !== 'body')
      .slice(-4);                                    // closest 4 ancestors

    const payload = {
      stepType:   step.type,
      selector:   step.params?.selector || el?.selector || el?.commonSelector || "",
      attribute:  step.params?.attribute || "",
      tag:        el?.tag || el?.elements?.[0]?.tag || "",
      classes:    el?.classes || "",
      text:       (el?.text || "").slice(0, 200),
      html:       (el?.html || el?.outerHtml || "").slice(0, 400),
      ancestors,
      // Parent context — often contains a sibling label that names what
      // the target value actually means (e.g. <h2>180</h2> sitting next
      // to <h4>Cert Providers</h4>). The LLM uses this to pick a name
      // grounded in the page's own labels.
      parentTag:  el?.parentTag  || "",
      parentText: (el?.parentText || "").slice(0, 400),
      parentHtml: (el?.parentHtml || "").slice(0, 600),
      href:       el?.href || undefined,
      src:        el?.src || undefined,
      matchCount: el?.isMultiSelection ? el.matchCount : undefined,
    };
    console.debug('[ai-name] requesting suggestion for', step.id, payload);

    aiApi.suggestStepName(payload).then((name) => {
      console.debug('[ai-name] got reply for', step.id, '→', JSON.stringify(name));
      if (!name) return;
      // Only apply if the step still exists and the user hasn't named it
      // manually in the meantime.
      const loc = findStepLocation(stepsRef.current, step.id);
      if (!loc) { console.debug('[ai-name] step disappeared before suggestion arrived'); return; }
      let cur = stepsRef.current;
      for (let i = 0; i < loc.containerPath.length; i += 2) cur = cur[loc.containerPath[i]][loc.containerPath[i + 1]];
      const current = cur?.[loc.index];
      if (!current) { console.debug('[ai-name] container lookup failed'); return; }
      if (current.label) { console.debug('[ai-name] user already named the step'); return; }
      console.debug('[ai-name] applying', name, 'to', step.id);
      updateLabelById(step.id, name);
    });
  }, [updateLabelById]);

  // Params updater that also auto-names an Extract List the moment it gains its
  // first fields. We deferred naming when the list was added "configure later"
  // (no fields = unknown collection); once fields arrive we know what it holds.
  // Only fires on the empty → non-empty transition and only when the list is
  // still unnamed, so editing/deleting fields later — or a list the user
  // already named — is left untouched.
  const handleUpdateParams = useCallback((id, patch) => {
    updateParamsById(id, patch);
    if (!patch || !patch.fields) return;

    const loc = findStepLocation(stepsRef.current, id);
    if (!loc) return;
    let cur = stepsRef.current;
    for (let i = 0; i < loc.containerPath.length; i += 2) cur = cur[loc.containerPath[i]][loc.containerPath[i + 1]];
    const prev = cur?.[loc.index];
    if (!prev || prev.type !== "EXTRACT_LIST" || prev.label) return;

    const hadFields = prev.params?.fields && Object.keys(prev.params.fields).length > 0;
    const hasFields = Object.keys(patch.fields).length > 0;
    if (!hadFields && hasFields) {
      maybeAutoNameStep({ ...prev, params: { ...prev.params, ...patch } });
    }
  }, [updateParamsById, maybeAutoNameStep]);
  useEffect(() => { handleUpdateParamsRef.current = handleUpdateParams; }, [handleUpdateParams]);

  // ── AI extract-list fields (from the inspector's "Add with AI prompt") ──
  // Fires the request and tracks it here; the result listener in the socket
  // effect applies the fields/label to the step whenever the answer lands.
  const requestAiExtractListFields = useCallback((stepId, containerSelector, hint) => {
    if (!socketRef.current || !containerSelector) return;
    const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    pendingAiListRef.current = { requestId, stepId };
    setAiListBusyStepId(stepId);
    clearTimeout(aiListTimeoutRef.current);
    aiListTimeoutRef.current = setTimeout(() => {
      if (pendingAiListRef.current?.requestId !== requestId) return;
      pendingAiListRef.current = null;
      setAiListBusyStepId(null);
      showToast("✨ AI request timed out — add fields manually or retry from the editor", "error");
    }, 60000);
    socketRef.current.emit("aiExtractListFields", {
      containerSelector,
      selectorType: "css",
      hint: hint || "",
      existingFields: {},
      requestId,
    });
  }, [showToast]);

  // Open an EXTRACT_LIST step's editor in the workflow sidebar. Used right
  // after the step is added (manually or with AI) so the user immediately
  // sees the fields, can adjust them, or pick more from the still-selected
  // elements on the page.
  const openListStepEditor = useCallback((stepId) => {
    setActiveTab("stream");
    setShowSidebar(true);
    setSidebarTab("workflow");
    setSidebarExpandStepId(stepId);
  }, []);

  // ── Add step from inspector ───────────────────────────────────────────────
  const handleAddStep = useCallback((step, opts = {}) => {
    const { isForEach = false } = opts;

    // An Extract List should never be "added and nothing else happens":
    // open its editor in the workflow sidebar right away so the user sees
    // the fields (AI-filled or empty), can adjust them, or keep picking —
    // the elements stay selected on the page.
    if (step.type === "EXTRACT_LIST" && !isForEach) {
      openListStepEditor(step.id);
    }

    if (isForEach) {
      // ForEach loops always go to insertTarget or root, then activate forEach context
      const target = insertTargetRef.current;
      if (target && target.type !== 'root_end') {
        const loc = findStepLocation(stepsRef.current, target.stepId);
        if (loc) {
          if (target.type === 'inside') addStepAt(step, [...loc.containerPath, loc.index, 'body'], null);
          else addStepAt(step, loc.containerPath, insertIndexAfter(stepsRef.current, loc));
        } else addStep(step, [], null);
      } else {
        addStep(step, [], null);
      }
      showToast("∀ ForEach loop added — steps will go inside it", "loop");
      setChildrenList(null);
      const iteratorSelector = step.params?.selector || '';
      setForEachCtx({ stepId: step.id, iteratorSelector });
      if (iteratorSelector) socketRef.current?.emit("setForEachScope", { iteratorSelector });
      // Auto-point insert target inside the new loop
      setInsertTarget({ type: 'inside', stepId: step.id });
      // Force selection mode while in loop context so the only thing the
      // user can do is pick items belonging to the iterator. The backend's
      // setForEachScope restricts WHICH elements are pickable; this just
      // makes sure they're in selection mode to do so.
      setMode('selection');
      socketRef.current?.emit("setMode", { mode: 'selection' });
      maybeAutoNameStep(step);
      return;
    }

    // ── Determine destination ──────────────────────────────────────────────
    const target = insertTargetRef.current;

    if (target && target.type !== 'root_end') {
      // User has explicitly set an insert target
      const loc = findStepLocation(stepsRef.current, target.stepId);
      if (loc) {
        if (target.type === 'inside') {
          // `index` is optional. When set (e.g. pagination loops aim
          // index:0 so extractions land BEFORE the IF/click/wait that
          // came pre-populated in the body), we insert at that slot
          // and then advance the target so subsequent adds chain
          // naturally after THIS new step — instead of all going to
          // the same index 0 in reverse order.
          const insertIdx = target.index ?? null;
          addStepAt(step, [...loc.containerPath, loc.index, 'body'], insertIdx);
          showToast(`✓ Step added inside loop`, "success");
          if (insertIdx !== null) {
            setInsertTarget({ type: 'after', stepId: step.id });
          }
          maybeAutoNameStep(step);
          return;
        } else {
          addStepAt(step, loc.containerPath, insertIndexAfter(stepsRef.current, loc));
          showToast(`✓ Step added after target`, "success");
          // Advance the target so a follow-up step lands after THIS new
          // one rather than re-inserting at the same slot (which would
          // make consecutive adds appear in reverse order).
          setInsertTarget({ type: 'after', stepId: step.id });
        }
        // Keep the element selected after adding — the user may want to
        // chain another action on the same element (e.g. extract text +
        // then extract href on the same anchor).
        maybeAutoNameStep(step);
        return;
      }
    }

    if (forEachCtx) {
      // Add step inside the current ForEach loop body. The loop can be
      // nested (e.g. inside a WHILE pagination loop), so we use the
      // recursive findStepLocation rather than a root-level search.
      const loc = findStepLocation(stepsRef.current, forEachCtx.stepId);
      if (loc) {
        addStepAt(step, [...loc.containerPath, loc.index, 'body'], null);
        showToast("✓ Step added inside ForEach loop", "success");
      } else {
        addStep(step, [], null);
        showToast("✓ Step added", "success");
        setForEachCtx(null);
      }
    } else {
      addStep(step, [], null);
      const label = step.type?.replace(/_/g, " ").toLowerCase() || "step";
      showToast(`✓ ${label} added to workflow`, "success");
    }
    maybeAutoNameStep(step);
  }, [addStep, addStepAt, forEachCtx, showToast, insertTarget, maybeAutoNameStep, openListStepEditor]);

  // Delete any step by id — used by the compact workflow sidebar so steps
  // can be removed without leaving the Live Browser view.
  const handleDeleteStepById = useCallback((id) => {
    const loc = findStepLocation(stepsRef.current, id);
    if (!loc) return;
    deleteStep(loc.containerPath, loc.index);
    showToast("✓ Step removed", "success");
  }, [deleteStep, showToast]);

  // ── Breadcrumb navigation ─────────────────────────────────────────────────
  const handleSelectAncestor = useCallback((levelsUp) => {
    setChildrenList(null);
    socketRef.current?.emit("navigateAncestor", { levelsUp });
  }, []);

  const handleGetChildren = useCallback((levelsUp) => {
    setChildrenList(null);
    socketRef.current?.emit("getChildrenOf", { levelsUp });
  }, []);

  const handleSelectChild = useCallback((levelsUp, childIndex) => {
    setChildrenList(null);
    socketRef.current?.emit("selectChildByIndex", { levelsUp, childIndex });
  }, []);

  const handleHoverAncestor = useCallback((levelsUp) => {
    socketRef.current?.emit("hoverAncestor", { levelsUp });
  }, []);

  const handleHoverPickerChild = useCallback((levelsUp, childIndex) => {
    socketRef.current?.emit("hoverPickerChild", { levelsUp, childIndex });
  }, []);

  const handleUnhoverPickerChild = useCallback(() => {
    socketRef.current?.emit("unhoverPickerChild");
  }, []);

  // ── Close inspector ───────────────────────────────────────────────────────
  // Note: closing the inspector does NOT exit ForEach loop mode. Loop mode
  // is its own piece of state — the user explicitly exits it via the
  // ForEach banner's × button. That keeps the loop context alive across
  // accidental clicks / element changes.
  const handleCloseInspector = useCallback(() => {
    socketRef.current?.emit("resetSelection");
    setSelectedElement(null);
    setChildrenList(null);
    setManualSelResult(null);
  }, []);

  // ── Manual multi-element add + selector adjust ────────────────────────────
  // "Select more similar elements yourself" — enter a mode where clicking
  // elements anywhere on the page adds them to a hand-picked set and the
  // backend re-derives the most specific comma-free selector covering them.
  const handleStartManualAdd = useCallback(() => {
    setManualSelResult(null);
    socketRef.current?.emit("startMultiElementAdd");
  }, []);

  const handleStopManualAdd = useCallback(() => {
    socketRef.current?.emit("stopMultiElementAdd");
    // The injected tool keeps the derived group as a confirmed selection and
    // does NOT re-emit — clear the manualAdd flag locally so the panel flips
    // back to its resting state.
    setSelectedElement((prev) => (prev ? { ...prev, manualAdd: false } : prev));
  }, []);

  // Power-user selector edit: apply a hand-typed primary and regenerate
  // fallbacks (answered on `manualSelectorResult`).
  const handleApplyManualSelector = useCallback((selector, selectorType) => {
    socketRef.current?.emit("applyManualSelector", { selector, selectorType });
  }, []);

  const handleClearForEachCtx = useCallback(() => {
    socketRef.current?.emit("clearForEachScope");
    // Park the insertion point right AFTER the ForEach we're exiting, so
    // the next inspector-driven step lands at the ForEach's parent level
    // (e.g. still inside an enclosing WHILE pagination loop) rather than
    // bouncing back to the workflow root.
    if (forEachCtx?.stepId) {
      setInsertTarget({ type: 'after', stepId: forEachCtx.stepId });
    }
    setForEachCtx(null);
  }, [forEachCtx]);

  // ── List-field pick (click elements in the page to add EXTRACT_LIST fields) ─
  const handleStartListPick = useCallback((stepId, containerSelector, fields = []) => {
    if (!socketRef.current || !containerSelector) return;
    setListPickStepId(stepId);
    socketRef.current.emit("startListFieldPick", { containerSelector, fields });
    // Bring the live browser into view with this step's editor open in the
    // workflow sidebar, so the page is clickable AND the fields editor (which
    // receives the picks) stays mounted.
    setActiveTab("stream");
    setShowSidebar(true);
    setSidebarTab("workflow");
    setSidebarExpandStepId(stepId);
  }, []);

  const handleStopListPick = useCallback(() => {
    setListPickStepId(null);
    socketRef.current?.emit("stopListFieldPick");
  }, []);

  const handleSidebarExpandHandled = useCallback(() => setSidebarExpandStepId(null), []);

  // ── Sidebar resize (drag handle) ─────────────────────────────────────────
  // Shared by all three sidebar tabs — Inspector/Workflow/HTML all just lay
  // out their existing flex/percentage-based content into whatever width
  // this leaves them, so widening it doesn't need any of their own CSS to
  // change.
  const startSidebarResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    isResizingSidebarRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const rowWidth = canvasContainerRef.current?.parentElement?.clientWidth || 1600;
      const maxWidth = Math.max(320, rowWidth - 320); // keep the canvas usable
      const next = Math.min(maxWidth, Math.max(300, startWidth + (startX - ev.clientX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      isResizingSidebarRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [sidebarWidth]);

  // Safety: if the user navigates away from the Live Browser tab while a pick
  // is in progress, stop it so the page isn't left intercepting clicks.
  useEffect(() => {
    if (listPickStepId && activeTab !== "stream") handleStopListPick();
  }, [activeTab, listPickStepId, handleStopListPick]);

  // A page navigation destroys the injected pick mode with the old page —
  // mirror it here so the editor's pick UI doesn't stay "active" against a
  // page that is no longer picking.
  const lastPickUrlRef = useRef(currentPageUrl);
  useEffect(() => {
    if (lastPickUrlRef.current !== currentPageUrl) {
      lastPickUrlRef.current = currentPageUrl;
      if (listPickStepId) handleStopListPick();
    }
  }, [currentPageUrl, listPickStepId, handleStopListPick]);

  // Deleting the step that owns the pick session ends the session.
  useEffect(() => {
    if (listPickStepId && !findStepLocation(steps, listPickStepId)) handleStopListPick();
  }, [steps, listPickStepId, handleStopListPick]);

  // ── Run / Download / Cancel ───────────────────────────────────────────────
  const handleRun = () => {
    if (!socketRef.current || steps.length === 0) return;
    setExecPanelOpen(true);
    setExecStatus("idle");
    setExecLogs([]);
    setExecResults(null);
    setExecRunId(null);
    // Pass workflowId when the user has a saved workflow loaded so the run
    // is recorded against it. If the workflow hasn't been saved yet, the
    // backend will auto-create a draft and emit `workflowAutoCreated`.
    socketRef.current.emit("executeWorkflow", {
      steps,
      meta: { ...sessionMetaRef.current, variables: workflowVariables },
      workflowId: currentWorkflowId || null,
      workflowName: currentWorkflowName || null,
    });
  };

  const handleDownloadCode = () => {
    if (!socketRef.current) return;
    socketRef.current.emit("downloadCode", {
      steps,
      meta: { ...sessionMetaRef.current, variables: workflowVariables },
    });
  };

  const handleCancelExecution = () => {
    socketRef.current?.emit("cancelExecution");
  };

  const downloadTextFile = (content, filename, mime) => {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Canvas helpers ────────────────────────────────────────────────────────
  // Tracks whether the user is currently dragging on the canvas. Set on
  // pointerdown, cleared on pointerup/cancel. Pointer capture keeps move
  // events flowing to the canvas even when the cursor leaves it, so this
  // ref is what lets us suppress the `leave` reset during a drag.
  const isDraggingRef = useRef(false);

  // Keys we've forwarded a keydown for but not yet a keyup. The remote browser
  // keeps a key "down" until it sees the matching keyup, but the canvas only
  // receives keyup while it's focused — so Alt+Tab, switching tabs, or clicking
  // elsewhere in the app drops the keyup and leaves the key stuck down. A stuck
  // modifier then poisons every click (Alt+click downloads the link, Ctrl+click
  // opens a hidden tab). We track held keys here and flush keyups on focus loss.
  const heldKeysRef = useRef(new Set());
  const releaseHeldKeys = useCallback(() => {
    if (!heldKeysRef.current.size) return;
    for (const key of heldKeysRef.current) {
      socketRef.current?.emit("userAction", { type: "keyup", key });
    }
    heldKeysRef.current.clear();
  }, []);

  // Flush held keys whenever the canvas can no longer observe their release:
  // window blur (Alt+Tab / app switch) and the tab becoming hidden. The canvas
  // also calls releaseHeldKeys on its own onBlur (focus moving to other UI).
  useEffect(() => {
    const onWinBlur = () => releaseHeldKeys();
    const onVisibility = () => { if (document.hidden) releaseHeldKeys(); };
    window.addEventListener("blur", onWinBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onWinBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [releaseHeldKeys]);

  // Convert a browser pointer/mouse event to puppeteer-page coordinates.
  // CDP input events use CSS pixels, but the screencast frames (and thus
  // the canvas backing store) are captured at devicePixelRatio scale — so
  // map against the remote viewport's CSS size, not canvas.width/height.
  // Clamps to the viewport extent so drag positions outside the canvas
  // don't go negative or run past the page edge.
  const scaled = (e) => {
    const c = canvasRef.current, r = c.getBoundingClientRect();
    const vw = viewportCssRef.current?.width  || c.width;
    const vh = viewportCssRef.current?.height || c.height;
    const xRaw = (e.clientX - r.left) * (vw / r.width);
    const yRaw = (e.clientY - r.top)  * (vh / r.height);
    const x = Math.max(0, Math.min(vw - 1, Math.round(xRaw)));
    const y = Math.max(0, Math.min(vh - 1, Math.round(yRaw)));
    return { x, y };
  };
  // Whether the last mousedown was actually forwarded to the backend. A
  // mouseup must mirror its mousedown: if the interaction lock flips
  // between the two, forwarding only half of the pair desyncs the remote
  // mouse-button state ("'left' is already pressed") and from then on
  // every other click is silently dropped.
  const mouseDownForwardedRef = useRef(false);
  const emit = (type, extra = {}) => {
    // Don't send mouse/keyboard events to the backend when there's no active
    // page — e.g. after "New workflow" before the next navigate. Otherwise
    // hover events race against a torn-down execution context.
    if (!isStreamingRef.current) return;
    // While the page is loading and the consent banner is being analysed,
    // swallow clicks so a stray click can't hit a half-loaded page or race
    // the auto-dismiss. Hover/scroll/keys still flow.
    if (type === "mousedown") {
      if (interactionLockedRef.current) {
        mouseDownForwardedRef.current = false;
        setStatus("Loading… clicks paused");
        return;
      }
      mouseDownForwardedRef.current = true;
    } else if (type === "mouseup") {
      // Paired with a swallowed mousedown → swallow too. Paired with a
      // forwarded mousedown → always forward, even if the lock has engaged
      // in the meantime.
      if (!mouseDownForwardedRef.current) {
        if (interactionLockedRef.current) setStatus("Loading… clicks paused");
        return;
      }
      mouseDownForwardedRef.current = false;
    }
    socketRef.current?.emit("userAction", { type, ...extra });
  };

  // Keys that we should never preventDefault for, so the host browser can
  // still open devtools / refresh tabs / use OS shortcuts.
  const isPassthroughKey = (e) => {
    if (e.key === "F12") return true;
    if (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "i" || e.key === "J" || e.key === "j" || e.key === "C" || e.key === "c")) return true;
    if (e.ctrlKey && (e.key === "t" || e.key === "T" || e.key === "w" || e.key === "W" || e.key === "n" || e.key === "N")) return true;
    if (e.metaKey && (e.key === "t" || e.key === "T" || e.key === "w" || e.key === "W" || e.key === "n" || e.key === "N")) return true;
    return false;
  };

  // ── Emit previewStep on param changes only (debounced + fingerprinted) ──
  const previewDebounceRef = useRef(null);
  const lastFingerprintRef = useRef("");
  const PREVIEW_TYPES = new Set(["EXTRACT_TEXT","EXTRACT_ATTRIBUTE","EXTRACT_HTML","EXTRACT_TABLE","EXTRACT_LIST","EXTRACT_JSON","FOR_EACH_ELEMENTS","FOR_EACH"]);
  const BRANCH_KEYS = ["body","then","else","try","catch"];
  function collectPreviewable(arr, parentContainerSelector) {
    const out = [];
    for (const s of arr || []) {
      if (typeof s !== "object" || !s) continue;
      const isPreviewable =
        (s.kind === "action"  && PREVIEW_TYPES.has(s.type)) ||
        (s.kind === "control" && PREVIEW_TYPES.has(s.type));
      if (isPreviewable) {
        const sel = s.params?.selector || s.params?.containerSelector || "";
        if (sel) {
          // For loops: include the IDs of the steps in each branch so a child
          // being added / removed / reordered changes the loop's fingerprint
          // and re-triggers its preview (otherwise a step leaving the loop
          // wouldn't refresh the loop's data view).
          const childIds = s.kind === "control"
            ? BRANCH_KEYS.flatMap(k => (Array.isArray(s[k]) ? s[k].map(c => c.id) : []))
            : undefined;
          const payload = { stepId: s.id, type: s.type, params: s.params };
          if (s.kind === "action") {
            // Even when there's no enclosing loop we still store '' so that
            // a step "leaving" a loop (containerSelector going from .x → '')
            // shows up in the fingerprint and re-fires the preview.
            payload.containerSelector = parentContainerSelector || "";
          }
          if (childIds) payload._childIds = childIds;
          out.push(payload);
        }
      }
      const loopSel = (s.kind === "control" && PREVIEW_TYPES.has(s.type))
        ? (s.params?.selector || s.params?.containerSelector || "") : parentContainerSelector;
      for (const key of BRANCH_KEYS) {
        if (Array.isArray(s[key])) out.push(...collectPreviewable(s[key], loopSel || ""));
      }
    }
    return out;
  }
  // Fingerprint: id + type + params + containerSelector + childIds (for loops).
  // The fields beyond id/type/params ensure that moving a step into/out of a
  // loop, or adding/removing a child inside a loop, both re-fire the affected
  // previews so the Data tab stays in sync with the workflow tree.
  //
  // pageReadyTick is also a dependency so previews re-fire after the page
  // finishes loading — required when opening a saved workflow where the
  // navigation finishes AFTER the steps-changed effect first ran.
  const pageReadyTickRef = useRef(0);
  useEffect(() => {
    const items = collectPreviewable(steps, "");
    const fp = JSON.stringify(items.map(p => ({
      id: p.stepId,
      type: p.type,
      params: p.params,
      parent: p.containerSelector || null,
      kids:   p._childIds || null,
    })));
    // Include variable values in the fingerprint so editing a variable
    // re-fires the preview (because the resolved selector / url etc.
    // might be different now).
    const fpWithVars = fp + '|vars:' + JSON.stringify(
      (workflowVariables || []).map(v => [v?.name, v?.value])
    );
    const pageReady = pageReadyTick !== pageReadyTickRef.current;
    pageReadyTickRef.current = pageReadyTick;
    // Skip if nothing changed AND it isn't a page-ready re-fire request.
    if (!pageReady && fpWithVars === lastFingerprintRef.current) return;
    lastFingerprintRef.current = fpWithVars;
    if (!socketRef.current) return;
    clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(() => {
      items.forEach(p => {
        // Strip the internal _childIds before sending — it's just for
        // the fingerprint, not something the backend handler needs.
        const { _childIds, ...payload } = p;
        // Resolve `{{var}}` references against the current workflow
        // variables before sending. The backend's previewStep handler
        // works against the live page, so it needs the actual selector
        // (or URL, or text), not the placeholder syntax.
        payload.params = deepResolveVars(payload.params, workflowVariables);
        if (payload.containerSelector) {
          payload.containerSelector = resolveVars(payload.containerSelector, workflowVariables);
        }
        socketRef.current?.emit("previewStep", payload);
      });
    }, 400);
    return () => clearTimeout(previewDebounceRef.current);
  }, [steps, pageReadyTick, workflowVariables]);

  // Count extraction steps for the Data tab badge. Only walk known control
  // branches — other array fields on a step (previewElements, fallbackSelectors)
  // would otherwise be traversed and inflate the count.
  const EXTRACTION_TYPES_SET = new Set(["EXTRACT_TEXT","EXTRACT_ATTRIBUTE","EXTRACT_HTML","EXTRACT_TABLE","EXTRACT_LIST","EXTRACT_JSON"]);
  const COUNT_BRANCH_KEYS = ["body","then","else","try","catch"];
  function countExtraction(arr) {
    return (arr||[]).reduce((n,s) => {
      let c = (s.kind==="action" && EXTRACTION_TYPES_SET.has(s.type)) ? 1 : 0;
      for (const k of COUNT_BRANCH_KEYS) if (Array.isArray(s[k])) c += countExtraction(s[k]);
      return n + c;
    }, 0);
  }
  const extractionCount = countExtraction(steps);

  const isRunDisabled = steps.length === 0 || execStatus === "running";

  // First-scrape coach: current step derived purely from live editor state, so
  // it advances as the user actually does each thing. `coachTarget` names the
  // real control to spotlight this step.
  const coachStep = coachStepIndex({
    pageLoaded:   !!currentPageUrl,
    mode,
    hasSelection: !!(selectedElement && selectedElement.isMultiSelection),
    hasList:      steps.some(s => s.type === "EXTRACT_LIST" || s.type === "COLLECT_LIST"),
    hasRun:       !!execRunId || execStatus === "done",
  });
  const coachTarget = coachOpen ? ["url", "mode", "canvas", "sidebar", "run"][coachStep] : null;
  const spot = (name) => (coachTarget === name ? " coach-spotlight" : "");

  // "Pick on page" for a selector field in the step editor: jump to the live
  // page in Select mode and arm the next click to write that field. fieldKey
  // null = the step's primary selector (classic reselect); a key targets a
  // secondary selector field (endSelector, loadingSelector, …).
  const onPickOnPage = (stepId, fieldKey = null) => {
    reselectStepIdRef.current = stepId;
    reselectFieldRef.current  = fieldKey;
    setReselectStepId(stepId);
    setReselectField(fieldKey);
    setActiveTab("stream");
    changeMode("selection");
    showToast("Click the element on the page to set this selector", "success");
  };

  return (
    <div className="app-container">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="header-left">
          <div className="logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
            <span>WebScraper</span>
          </div>
        </div>
        <div className="header-center">
          <div className="connection-status">
            <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`} />
            <span className="status-text">{status || (isConnected ? "Ready" : "Connecting…")}</span>
          </div>
        </div>
        <div className="header-right">
          {/* Undo / redo (Ctrl+Z / Ctrl+Y) */}
          <div className="header-undo-group">
            <button
              className="header-icon-btn"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>
              </svg>
            </button>
            <button
              className="header-icon-btn"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Y)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h1"/>
              </svg>
            </button>
          </div>
          <button className="header-btn secondary" onClick={() => setDashboardOpen(true)}
            title="Back to the dashboard">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9.5L12 3l9 6.5"/><path d="M5 10v10h14V10"/>
            </svg>
            Home
          </button>
          <button className="header-btn secondary"
            onClick={() => {
              if (steps.length > 0 && !confirm("Start a new workflow? Unsaved changes will be lost.")) return;
              resetWorkflow();
            }}
            title="Start a fresh workflow (closes the current page)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New
          </button>
          <button className="header-btn secondary" onClick={() => setWorkflowsOpen(true)}
            title="Save or open workflows">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/>
            </svg>
            Workflows{currentWorkflowName ? `: ${currentWorkflowName}` : ""}
          </button>
          <button className="header-btn secondary" onClick={() => setCustomActionsOpen(true)}
            title="Create reusable custom actions">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16,18 22,12 16,6"/><polyline points="8,6 2,12 8,18"/>
            </svg>
            Custom Actions
            {customActions.length > 0 && <span className="tab-badge">{customActions.length}</span>}
          </button>
          <button className="header-btn secondary" onClick={handleDownloadCode}
            disabled={steps.length === 0} title="Download as Node.js script">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download Code
          </button>
          <button
            className={`header-btn run-btn ${execStatus === "running" ? "running" : ""}${spot("run")}`}
            onClick={execStatus === "running" ? () => setExecPanelOpen(true) : handleRun}
            disabled={isRunDisabled && execStatus !== "running"}
          >
            {execStatus === "running" ? <><SpinnerIcon /> Running…</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Run</>}
          </button>
          {(execStatus === "done" || execStatus === "error") && (
            <button className={`header-btn secondary ${execStatus === "error" ? "error-badge" : "success-badge"}`}
              onClick={() => setExecPanelOpen(true)}>
              {execStatus === "done" ? "✅ Results" : "❌ Error"}
            </button>
          )}
          <div style={{ position: "relative" }}>
            <button className="user-chip" onClick={() => setUserMenuOpen(v => !v)} title={user.username}>
              <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
              <span>{user.username}</span>
            </button>
            {userMenuOpen && (
              <>
                <div style={{position:"fixed",inset:0,zIndex:40}} onClick={() => setUserMenuOpen(false)} />
                <div className="user-popover">
                  <button className="item" onClick={() => {
                    setUserMenuOpen(false);
                    if (steps.length > 0 && !confirm("Start a new workflow? Unsaved changes will be lost.")) return;
                    resetWorkflow();
                  }}>New workflow</button>
                  <button className="item" onClick={() => { setUserMenuOpen(false); setWorkflowsOpen(true); }}>Workflows…</button>
                  <button className="item" onClick={() => { setUserMenuOpen(false); setCustomActionsOpen(true); }}>Custom actions…</button>
                  <button className="item" onClick={() => { setUserMenuOpen(false); setProxiesOpen(true); }}>Proxies…</button>
                  <button className="item" onClick={() => { setUserMenuOpen(false); setApiKeysOpen(true); }}>API keys…</button>
                  <button className="item" onClick={() => { setUserMenuOpen(false); setWebhooksOpen(true); }}>Webhooks…</button>
                  <button className="item danger" onClick={() => { setUserMenuOpen(false); onLogout(); }}>Sign out</button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="tab-bar">
        <button className={`tab-btn ${activeTab === "stream" ? "active" : ""}`} onClick={() => setActiveTab("stream")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          Live Browser
        </button>
        <button className={`tab-btn ${activeTab === "workflow" ? "active" : ""}`} onClick={() => setActiveTab("workflow")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16,3 21,3 21,8"/><line x1="4" y1="20" x2="21" y2="3"/>
            <polyline points="21,16 21,21 16,21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>
          </svg>
          Workflow
          {totalCount > 0 && <span className="tab-badge">{totalCount}</span>}
        </button>
        <button className={`tab-btn ${activeTab === "data" ? "active" : ""}`} onClick={() => setActiveTab("data")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
          </svg>
          Data
          {extractionCount > 0 && <span className="tab-badge" style={{background:"var(--accent-success)"}}>{extractionCount}</span>}
        </button>
      </div>

      {/* ── Main ──────────────────────────────────────────────────────────── */}
      <main className="main-content">
        <div className={`stream-panel ${activeTab !== "stream" ? "hidden-panel" : ""}`}>
          {/* Control bar */}
          <div className="control-bar">
            <div className={`mode-toggle${spot("mode")}`}>
              <button
                className={`mode-btn ${mode === "navigation" ? "active" : ""}`}
                onClick={() => { if (!forEachCtx) changeMode("navigation"); }}
                disabled={!!forEachCtx}
                title={forEachCtx ? "Exit ForEach loop mode to switch to Navigate" : "Navigate the page"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>
                Navigate
              </button>
              <button className={`mode-btn ${mode === "selection" ? "active" : ""}`} onClick={() => changeMode("selection")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 9l7 7 7-7"/></svg>
                Select
              </button>
            </div>
            <div className={`url-input-wrapper${onDifferentPage ? " url-input-wrapper--warn" : ""}${spot("url")}`}>
              {onDifferentPage && pinnedUrl && (
                // Back to the workflow's start URL — only shown while we've
                // drifted away from it. Sends the user (and any future
                // inspector actions) back to the page the workflow was built
                // on without forcing them to retype the URL.
                <button
                  className="url-back-btn"
                  title={`Back to start URL — ${resolvedPinnedUrl}`}
                  onClick={() => { setUrlInput(resolvedPinnedUrl); performNavigate(pinnedUrl); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="15,18 9,12 15,6"/>
                  </svg>
                </button>
              )}
              <svg className="url-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              <input className="url-input" type="text" value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleNavigate()}
                placeholder="Enter URL to navigate…" />
              <button className="go-btn" onClick={handleNavigate}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12,5 19,12 12,19"/>
                </svg>
              </button>
            </div>
            {onDifferentPage && (
              <div className="url-warning" title="The page has navigated away from the workflow's start URL. New actions you record here may not match when the workflow runs from the start.">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                </svg>
                <span>Off the workflow's start URL</span>
                <button
                  className="url-warning-add"
                  onClick={addNavigateStepForCurrentPage}
                  title="Record a Navigate step to this page so the workflow reaches it — after that this page is no longer flagged and steps you add here will match at run time"
                >
                  + Add navigate step
                </button>
              </div>
            )}

            {/* Sidebar toggle */}
            <button
              className={`inspector-toggle-btn ${showSidebar ? "active" : ""}${spot("sidebar")}`}
              onClick={() => setShowSidebar(v => !v)}
              title={showSidebar ? "Hide sidebar" : "Show sidebar"}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>
              </svg>
              {selectedElement?.isMultiSelection ? `${selectedElement.matchCount} elements` : "Sidebar"}
            </button>
            {/* View page source — opens the sidebar straight to the HTML tab */}
            <button
              className={`inspector-toggle-btn ${showSidebar && sidebarTab === "html" ? "active" : ""}`}
              onClick={() => { setShowSidebar(true); setSidebarTab("html"); }}
              title="View HTML source"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
              </svg>
              Source
            </button>
            {/* Guided coach — walks the real controls; toggleable any time. */}
            <button
              className={`inspector-toggle-btn quick-scrape-btn ${coachOpen ? "active" : ""}`}
              onClick={() => setCoachOpen(v => !v)}
              title="Step-by-step guide to building your first scraper"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              Guide
            </button>
            {/* Pagination detector */}
            <button
              className="inspector-toggle-btn"
              onClick={() => {
                setPaginationOpen(true);
                setPaginationDetecting(true);
                setPaginationSuggestions(null);
                setPaginationError(null);
                socketRef.current?.emit("detectPagination");
              }}
              title="Detect pagination on current page"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9,18 15,12 9,6"/>
              </svg>
              Pagination
            </button>
            {/* API discovery */}
            <button
              className="inspector-toggle-btn"
              onClick={runApiAnalysis}
              title="Analyze the page's network calls and propose its data API"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 7h16M4 12h16M4 17h10"/><circle cx="19" cy="17" r="2"/>
              </svg>
              API
            </button>
          </div>

          {/* Stream body: canvas + inspector sidebar side by side */}
          <div className="stream-body">
            <div
              className={`canvas-container${showSidebar ? " canvas-container--with-sidebar" : ""}${spot("canvas")}`}
              ref={canvasContainerRef}
              style={htmlMaximized && sidebarTab === "html" ? { display: "none" } : undefined}
            >
              <canvas ref={canvasRef} className="browser-canvas" tabIndex={0}
                style={{ cursor: mode === "selection" ? "crosshair" : cursorType, outline: "none" }}
                onContextMenu={e => e.preventDefault()}
                onPointerDown={e => {
                  e.preventDefault();
                  // Pointer capture keeps pointermove/pointerup flowing to
                  // the canvas even after the cursor leaves it, so a drag
                  // (e.g. text selection or scroll-bar grab) no longer
                  // snaps back when the user wanders off the canvas.
                  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
                  // Focus the canvas so subsequent key presses are routed
                  // to the remote page (e.g. typing in a form field).
                  e.currentTarget.focus();
                  isDraggingRef.current = true;
                  const {x, y} = scaled(e);
                  // Forward the live modifier state so the backend can drop any
                  // stuck modifier (e.g. an Alt whose keyup was lost to Alt+Tab)
                  // before the click — otherwise a plain click can land as
                  // Alt+click and download the link instead of navigating.
                  emit("mousedown", { x, y, altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey });
                  setStatus(`Clicked: x=${x}, y=${y}`);
                }}
                onPointerMove={e => {
                  const {x, y} = scaled(e);
                  emit("hover", { x, y });
                }}
                onPointerUp={e => {
                  e.preventDefault();
                  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
                  isDraggingRef.current = false;
                  const {x, y} = scaled(e);
                  emit("mouseup", { x, y });
                }}
                onPointerCancel={() => { isDraggingRef.current = false; }}
                onPointerLeave={() => {
                  // While dragging, pointer capture keeps us tracking even
                  // outside the canvas — don't fire the reset.
                  if (isDraggingRef.current) return;
                  emit("leave");
                }}
                onKeyDown={e => {
                  if (!isStreamingRef.current) return;
                  if (isPassthroughKey(e)) return;
                  // Copy: the user only sees a pixel stream, so a forwarded
                  // Ctrl+C would copy into the REMOTE browser's clipboard.
                  // Fetch the remote selection instead and write it to the
                  // local clipboard (handled in the selectionText listener).
                  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "c" || e.key === "C")) {
                    e.preventDefault();
                    socketRef.current?.emit("getSelection");
                    return;
                  }
                  // Paste: mirror image of copy — the remote browser can't
                  // see the host clipboard, so read it here and send the
                  // text over to be inserted at the remote caret.
                  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) {
                    e.preventDefault();
                    navigator.clipboard?.readText?.()
                      .then((text) => { if (text) emit("paste", { text }); })
                      .catch(() => { setStatus("Clipboard read blocked — allow clipboard access to paste"); });
                    return;
                  }
                  e.preventDefault();
                  heldKeysRef.current.add(e.key);
                  emit("keydown", { key: e.key, code: e.code });
                }}
                onKeyUp={e => {
                  if (!isStreamingRef.current) return;
                  if (isPassthroughKey(e)) return;
                  e.preventDefault();
                  heldKeysRef.current.delete(e.key);
                  emit("keyup", { key: e.key, code: e.code });
                }}
                onBlur={releaseHeldKeys}
              />
              <div className={`mode-indicator ${mode}`}>
                {mode === "selection"
                  ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 9l7 7 7-7"/></svg> Selection Mode — click elements to inspect</>
                  : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg> Navigation Mode</>
                }
              </div>
              {cookiePrompt && (
                <div className="cookie-teach-prompt">
                  <span className="cookie-teach-emoji">🍪</span>
                  <div className="cookie-teach-body">
                    <strong>Looks like you closed a cookie banner</strong>
                    <div className="cookie-teach-sub">
                      {cookiePrompt.text ? <>You clicked <em>“{cookiePrompt.text}”</em>. </> : null}
                      Add a step that does this on every run? It's skipped when
                      no banner appears (e.g. consent already given).
                    </div>
                  </div>
                  <div className="cookie-teach-actions">
                    <button className="cookie-teach-add" onClick={acceptCookiePrompt}>Add step</button>
                    <button className="cookie-teach-dismiss" onClick={declineCookiePrompt}>No thanks</button>
                  </div>
                </div>
              )}
              {captchaPrompt && (
                <div className="cookie-teach-prompt captcha-prompt">
                  <span className="cookie-teach-emoji">🧩</span>
                  <div className="cookie-teach-body">
                    <strong>CAPTCHA detected ({captchaPrompt.captchaType.replace(/_/g, " ")})</strong>
                    <div className="cookie-teach-sub">
                      {captchaPrompt.captchaType === "cloudflare_interstitial"
                        ? <>This usually clears itself in a few seconds — give it a moment. </>
                        : <>Solve it right here in the preview (just click it). </>}
                      {captchaPrompt.solverConfigured && captchaPrompt.sitekey
                        ? <>Or auto-solve it via <em>{captchaPrompt.provider}</em>.</>
                        : <>For unattended runs, add a step or configure a solver.</>}
                    </div>
                  </div>
                  <div className="cookie-teach-actions">
                    {captchaPrompt.solverConfigured && captchaPrompt.sitekey && (
                      <button className="cookie-teach-add" onClick={autoSolveCaptcha} disabled={captchaPrompt.solving}>
                        {captchaPrompt.solving ? "Solving…" : "Auto-solve"}
                      </button>
                    )}
                    {!captchaPrompt.hasSolveStep && (
                      <button className="cookie-teach-dismiss" onClick={addSolveCaptchaStep}>Add step</button>
                    )}
                    <button className="cookie-teach-dismiss" onClick={dismissCaptchaPrompt}>Dismiss</button>
                  </div>
                </div>
              )}
            </div>

            {/* Unified sidebar — always in flow next to canvas when on Live Browser */}
            {showSidebar && !(htmlMaximized && sidebarTab === "html") && (
              <div
                className="sidebar-resize-handle"
                onPointerDown={startSidebarResize}
                title="Drag to resize"
              />
            )}
            {showSidebar && (
              <div
                className="inspector-sidebar"
                style={htmlMaximized && sidebarTab === "html" ? { width: "100%" } : { width: sidebarWidth }}
              >
                {/* Tab bar */}
                <div className="sidebar-tab-bar">
                  <button
                    className={`sidebar-tab-btn ${sidebarTab === "inspector" ? "active" : ""}`}
                    onClick={() => setSidebarTab("inspector")}
                    title="Element Inspector"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <span className="sidebar-tab-label">Inspector</span>
                  </button>
                  <button
                    className={`sidebar-tab-btn ${sidebarTab === "workflow" ? "active" : ""}`}
                    onClick={() => setSidebarTab("workflow")}
                    title="Workflow"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/>
                    </svg>
                    <span className="sidebar-tab-label">Workflow</span>
                  </button>
                  <button
                    className={`sidebar-tab-btn ${sidebarTab === "html" ? "active" : ""}`}
                    onClick={() => setSidebarTab("html")}
                    title="HTML Inspector"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                    </svg>
                    <span className="sidebar-tab-label">HTML</span>
                  </button>
                  <button className="sidebar-tab-close" onClick={() => setShowSidebar(false)} title="Hide sidebar">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>

                {/* Inspector tab */}
                {sidebarTab === "inspector" && (
                  selectedElement ? (
                    <ElementInspector
                      element={selectedElement}
                      childrenList={childrenList}
                      forEachCtx={forEachCtx}
                      onClose={handleCloseInspector}
                      onAddStep={handleAddStep}
                      onSelectAncestor={handleSelectAncestor}
                      onGetChildren={handleGetChildren}
                      onSelectChild={handleSelectChild}
                      onHoverPickerChild={handleHoverPickerChild}
                      onHoverAncestor={handleHoverAncestor}
                      onUnhoverPickerChild={handleUnhoverPickerChild}
                      onClearForEachCtx={handleClearForEachCtx}
                      socket={socket}
                      onUpdateParams={handleUpdateParams}
                      onAiExtractList={requestAiExtractListFields}
                      onStartManualAdd={handleStartManualAdd}
                      onStopManualAdd={handleStopManualAdd}
                      onApplyManualSelector={handleApplyManualSelector}
                      manualSelResult={manualSelResult}
                    />
                  ) : (
                    <div className="sidebar-no-element">
                      {/* Still surface the loop-mode banner here so the user
                          can exit without first having to select an element. */}
                      {forEachCtx && (
                        <ForEachContextBanner
                          forEachCtx={forEachCtx}
                          onClear={handleClearForEachCtx}
                        />
                      )}
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      </svg>
                      <p>{forEachCtx
                        ? "Click an item inside the loop iterator to add steps for each iteration."
                        : "Click an element in the browser to inspect it"}</p>
                    </div>
                  )
                )}

                {/* Workflow tab */}
                {sidebarTab === "workflow" && (
                  <CompactWorkflowSidebar
                    steps={steps}
                    forEachCtx={forEachCtx}
                    socket={socket}
                    previewData={previewData}
                    listPickStepId={listPickStepId}
                    onStartListPick={handleStartListPick}
                    onStopListPick={handleStopListPick}
                    aiListBusyStepId={aiListBusyStepId}
                    onDeleteStep={handleDeleteStepById}
                    expandStepId={sidebarExpandStepId}
                    onExpandHandled={handleSidebarExpandHandled}
                    reselectStepId={reselectStepId}
                    onReselect={(id, isLoop) => {
                      // Re-selecting an element and list-field picking are
                      // mutually exclusive page modes — end the pick first.
                      if (listPickStepId) handleStopListPick();
                      setReselectStepId(id);
                      // Classic reselect targets the step's primary selector —
                      // clear any stale "pick on page" field target.
                      setReselectField(null);
                      reselectFieldRef.current = null;
                      setReselectIsLoop(!!isLoop);
                      if (isLoop) socketRef.current?.emit("startForEachSelection");
                      else socketRef.current?.emit("startElementSelection");
                    }}
                    onCancelReselect={() => { setReselectStepId(null); setReselectField(null); reselectFieldRef.current = null; socketRef.current?.emit("resetSelection"); }}
                    onHighlight={(sel) => socketRef.current?.emit("highlightSelector", { selector: sel })}
                    onClearHighlight={() => socketRef.current?.emit("clearHighlight")}
                    onUpdateParams={handleUpdateParams}
                    onUpdateLabel={updateLabelById}
                    insertTarget={insertTarget}
                    onSetInsertTarget={setInsertTarget}
                    onMoveStep={moveStepById}
                  />
                )}

                {/* HTML tab — DevTools-style source tree */}
                {sidebarTab === "html" && (
                  <HtmlInspectorPanel
                    socket={socket}
                    active={sidebarTab === "html"}
                    refreshKey={`${currentPageUrl}|${pageReadyTick}`}
                    selectedPath={!selectedElement?.isMultiSelection ? selectedElement?.path : null}
                    onBeforeSelect={() => { selectingFromHtmlTabRef.current = true; }}
                    maximized={htmlMaximized}
                    onToggleMaximize={() => setHtmlMaximized(v => !v)}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {activeTab === "workflow" && (
          <WorkflowPanel
            steps={steps} totalCount={totalCount} setSteps={setSteps}
            onAdd={(step, ...rest) => { addStep(step, ...rest); maybeAutoNameStep(step); }} onUpdate={updateStep} onDelete={deleteStep} onReorder={reorderSteps}
            insertTarget={insertTarget}
            onSetInsertTarget={setInsertTarget}
            onMoveStep={moveStepById}
            onToggleAttach={setAttachById}
            customActions={customActions}
            offStartUrl={onDifferentPage}
            pinnedUrl={resolvedPinnedUrl}
            currentPageUrl={currentPageUrl}
            onReturnToStart={() => { if (pinnedUrl) { setUrlInput(resolvedPinnedUrl); performNavigate(pinnedUrl); } }}
            onAddNavigateStep={addNavigateStepForCurrentPage}
            socket={socket}
            previewData={previewData}
            variables={workflowVariables}
            onVariablesChange={setWorkflowVariables}
            variablesCollapsed={variablesCollapsed}
            onToggleVariablesCollapsed={() => setVariablesCollapsed(c => !c)}
            availableWorkflows={availableWorkflows}
            currentWorkflowId={currentWorkflowId}
            listPickStepId={listPickStepId}
            onStartListPick={handleStartListPick}
            onStopListPick={handleStopListPick}
            onPickOnPage={onPickOnPage}
            reselectStepId={reselectStepId}
            reselectField={reselectField}
          />
        )}
        {activeTab === "data" && (
          <DataPreviewPanel
            steps={steps}
            execResults={execResults}
            previewData={previewData}
            onUpdateLabel={updateLabelById}
            onUpdateParams={handleUpdateParams}
          />
        )}
      </main>

      {/* ── Manual pagination element selection banner ────────────────────── */}
      {paginationManualWaiting && !paginationOpen && (
        <div className="pd-selection-banner">
          <span className="pd-pulse" style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:"var(--accent-primary)",animation:"pdPulse 1.2s ease-in-out infinite",flexShrink:0}}/>
          Click the pagination button or link on the page…
          <button
            style={{marginLeft:"auto",background:"none",border:"1px solid rgba(255,255,255,0.2)",borderRadius:5,color:"inherit",fontSize:12,padding:"3px 10px",cursor:"pointer"}}
            onClick={() => { setPaginationManualWaiting(false); setPaginationOpen(true); socketRef.current?.emit("resetSelection"); }}
          >Cancel</button>
        </div>
      )}

      {/* ── Pagination Detector ──────────────────────────────────────────── */}
      {paginationOpen && (
        <PaginationDetector
          isDetecting={paginationDetecting}
          suggestions={paginationSuggestions}
          error={paginationError}
          manualWaiting={paginationManualWaiting ? 'button' : null}
          onDetect={() => {
            setPaginationDetecting(true);
            setPaginationSuggestions(null);
            setPaginationError(null);
            socketRef.current?.emit("detectPagination");
          }}
          onClose={() => { setPaginationOpen(false); setPaginationManualWaiting(false); socketRef.current?.emit("resetSelection"); }}
          onAdd={(step, pagType) => {
            addStep(step);
            // Native pagination containers run their body once per page (or,
            // for infinite scroll, once the page is fully loaded). Either way
            // the user's extraction steps belong INSIDE the container, so we
            // point the insert target there regardless of the detected type.
            void pagType;
            setInsertTarget({ type: 'inside', stepId: step.id, index: 0 });
            setPaginationOpen(false);
          }}
          onManualButton={() => {
            setPaginationOpen(false);        // hide modal so browser is clickable
            setPaginationManualWaiting(true);
            socketRef.current?.emit("startElementSelection");
          }}
          onManualInfinite={() => {
            // Drop in a native Infinite Scroll container — the scroll/stop
            // logic lives in codegen, so the user just adds their extraction
            // steps inside it.
            const step = createControl(CONTROL_TYPES.PAGINATE_SCROLL);
            addStep(step);
            setInsertTarget({ type: 'inside', stepId: step.id, index: 0 });
            setPaginationOpen(false);
          }}
        />
      )}

      {/* ── API Discovery ────────────────────────────────────────────────── */}
      {apiPanelOpen && (
        <ApiSourcesPanel
          isAnalyzing={apiAnalyzing}
          sources={apiSources}
          error={apiError}
          capturedCount={apiCaptured}
          consideredCount={apiConsidered}
          aiAvailable={apiAiAvailable}
          onAnalyze={runApiAnalysis}
          onClose={() => setApiPanelOpen(false)}
          onUse={(source) => {
            const step = buildApiStepFromSource(source);
            addStep(step);
            setApiPanelOpen(false);
            setStatus(`Added "Call Data API" step: ${step.label}`);
          }}
          onEnrich={(source) => {
            setApiSources((prev) => (prev || []).map((s) =>
              s.id === source.id ? { ...s, aiLoading: true } : s
            ));
            socketRef.current?.emit("enrichApiSource", { source });
          }}
        />
      )}

      {/* ── Execution Panel ──────────────────────────────────────────────── */}
      <ExecutionPanel
        isOpen={execPanelOpen} onClose={() => setExecPanelOpen(false)}
        logs={execLogs} status={execStatus} results={execResults}
        runId={execRunId}
        onCancel={handleCancelExecution}
        steps={execFlowTree || steps}
        stepStates={execStepStates}
        iterations={execIterations}
        lastStepId={execLastStepId}
      />

      {/* ── URL-change confirmation ────────────────────────────────────── */}
      {urlChangeDialog && (
        <UrlChangeDialog
          newUrl={urlChangeDialog.newUrl}
          currentName={currentWorkflowName}
          canSaveCurrent={!!currentWorkflowId}
          onCancel={() => {
            // Revert the URL bar back to the pinned step's URL.
            const pinned = steps[0]?.type === "NAVIGATE" && steps[0]?.pinned ? steps[0] : null;
            if (pinned) setUrlInput(resolveVars(pinned.params?.url || "", workflowVariables));
            setUrlChangeDialog(null);
          }}
          onSaveAndStartNew={async () => {
            // Update the existing workflow in place, then reset and navigate.
            try {
              await workflowsApi.update(
                currentWorkflowId,
                currentWorkflowName,
                steps,
                sessionMetaRef.current || null,
              );
              showToast(`✓ Updated "${currentWorkflowName}"`, "success");
            } catch (err) {
              showToast(`✗ Save failed: ${err?.response?.data?.error || err.message}`, "error");
              return; // keep the dialog so the user can pick another option
            }
            const url = urlChangeDialog.newUrl;
            setUrlChangeDialog(null);
            resetWorkflow();
            setUrlInput(url);
            // Start a fresh workflow on the new URL.
            const step = createAction("NAVIGATE", { url });
            step.pinned = true;
            addStep(step, [], null);
            performNavigate(url);
          }}
          onSaveAs={() => {
            // No current id (or user wants a copy) → defer to the Workflows
            // menu so the user can give it a name, then they can retry.
            setUrlChangeDialog(null);
            setWorkflowsOpen(true);
          }}
          onDiscardAndStartNew={() => {
            const url = urlChangeDialog.newUrl;
            setUrlChangeDialog(null);
            resetWorkflow();
            setUrlInput(url);
            const step = createAction("NAVIGATE", { url });
            step.pinned = true;
            addStep(step, [], null);
            performNavigate(url);
          }}
          onAddAsStep={() => {
            // Keep the current workflow; just visit the new URL AND record a
            // movable (non-pinned) NAVIGATE step at the end of the workflow.
            const url = urlChangeDialog.newUrl;
            setUrlChangeDialog(null);
            addStep(createAction("NAVIGATE", { url }), [], null);
            performNavigate(url);
            // Revert the URL bar back to the pinned step's URL — it represents
            // the workflow's start URL, not the current page.
            const pinned = steps[0]?.type === "NAVIGATE" && steps[0]?.pinned ? steps[0] : null;
            if (pinned) setUrlInput(resolveVars(pinned.params?.url || "", workflowVariables));
            showToast("✓ Added Navigate step to current workflow", "success");
          }}
        />
      )}

      {/* ── Custom actions library ──────────────────────────────────────── */}
      <CustomActionsMenu
        open={customActionsOpen}
        onClose={() => setCustomActionsOpen(false)}
        showToast={showToast}
        onChanged={refreshCustomActions}
      />

      <ProxiesMenu
        open={proxiesOpen}
        onClose={() => setProxiesOpen(false)}
        showToast={showToast}
        isAdmin={!!user?.isAdmin}
        selectedProxy={selectedProxy}
        onSelectProxy={(proxy) => {
          setSelectedProxy(proxy);
          // Re-apply immediately to the live preview rather than waiting for
          // the next unrelated navigation to pick it up.
          if (urlInput) performNavigate(urlInput);
        }}
      />

      {/* ── API keys (public /v1 API credentials) ───────────────────────── */}
      <ApiKeysMenu
        open={apiKeysOpen}
        onClose={() => setApiKeysOpen(false)}
        showToast={showToast}
      />

      {/* ── Webhooks (run + change-monitoring push endpoints) ─────────────── */}
      <WebhooksMenu
        open={webhooksOpen}
        onClose={() => setWebhooksOpen(false)}
        showToast={showToast}
      />

      {/* ── Workflows menu (save / open / delete) ───────────────────────── */}
      {/* ── Dashboard (landing screen) ──────────────────────────────────────── */}
      <Dashboard
        open={dashboardOpen}
        userName={user.username}
        onNewScrape={() => {
          if (steps.length > 0 && !confirm("Start a new scrape? Unsaved changes to the current workflow will be lost.")) return;
          resetWorkflow();
          setDashboardOpen(false);
          setActiveTab("stream");
          setCoachOpen(true);
        }}
        onNewBlank={() => {
          if (steps.length > 0 && !confirm("Start a new workflow? Unsaved changes will be lost.")) return;
          resetWorkflow();
          setDashboardOpen(false);
          setActiveTab("stream");
        }}
        onOpenWorkflow={openWorkflowById}
        onManageWorkflows={() => setWorkflowsOpen(true)}
        showToast={showToast}
        reloadKey={dashboardOpen ? currentWorkflowId : null}
        openWorkflow={steps.length > 0 ? {
          name: currentWorkflowName || "Untitled draft",
          stepCount: totalCount,
          saved: !!currentWorkflowId,
          url: pinnedUrl || currentPageUrl || "",
        } : null}
        onResumeEditing={() => setDashboardOpen(false)}
      />

      {/* ── First-scrape coach (guides the real controls, not a wizard) ─────── */}
      <GuidedCoach
        open={coachOpen}
        stepIndex={coachStep}
        onClose={() => setCoachOpen(false)}
        onFocusUrl={() => { setActiveTab("stream"); setTimeout(() => document.querySelector(".url-input")?.focus(), 0); }}
        onSelectMode={() => { if (!forEachCtx) changeMode("selection"); }}
        onOpenInspector={() => { setShowSidebar(true); setSidebarTab("inspector"); }}
        onRun={() => { if (!isRunDisabled) handleRun(); }}
        onOpenData={() => setActiveTab("data")}
      />

      <WorkflowsMenu
        open={workflowsOpen}
        onClose={() => setWorkflowsOpen(false)}
        currentSteps={steps}
        currentMeta={{ ...sessionMetaRef.current, variables: workflowVariables, proxy: selectedProxy }}
        currentWorkflowId={currentWorkflowId}
        currentName={currentWorkflowName}
        showToast={showToast}
        onSaved={(wf) => {
          setCurrentWorkflowId(wf.id);
          setCurrentWorkflowName(wf.name);
          refreshAvailableWorkflows();   // make the new/updated workflow pickable as a subflow
        }}
        onLoaded={(wf) => { loadWorkflowIntoEditor(wf); setDashboardOpen(false); }}
      />

      {/* ── Toast notification ────────────────────────────────────────────── */}
      {toast && (
        <div className={`app-toast app-toast--${toast.type}`}>
          {toast.type === "loop"
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="17,1 21,5 17,9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7,23 3,19 7,15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20,6 9,17 4,12"/></svg>
          }
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   URL change confirmation dialog
   Shown when the user types a new URL into the bar while a workflow already
   exists. Lets them save & restart, discard & restart, or add the new URL as
   another Navigate step on the same workflow.
   ────────────────────────────────────────────────────────────────────────── */
function UrlChangeDialog({ newUrl, currentName, canSaveCurrent, onCancel, onSaveAndStartNew, onSaveAs, onDiscardAndStartNew, onAddAsStep }) {
  return (
    <div className="wf-overlay" onClick={onCancel}>
      <div className="wf-modal url-change-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>Change URL?</h2>
          <button className="wf-close" onClick={onCancel} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="wf-body">
          <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "0 0 14px" }}>
            You're about to navigate to <code style={{ color: "var(--accent-primary)", wordBreak: "break-all" }}>{newUrl}</code>,
            but your current workflow starts on a different page. What would you like to do?
          </p>

          <div className="url-change-options">
            {canSaveCurrent ? (
              <button className="url-change-opt" onClick={onSaveAndStartNew}>
                <strong>Save &amp; start new</strong>
                <span>Save changes to <em>{currentName}</em>, then begin a fresh workflow on the new URL.</span>
              </button>
            ) : (
              <button className="url-change-opt" onClick={onSaveAs}>
                <strong>Save current first…</strong>
                <span>Open the workflows panel to name and save the current workflow before continuing.</span>
              </button>
            )}

            <button className="url-change-opt" onClick={onAddAsStep}>
              <strong>Visit &amp; add Navigate step</strong>
              <span>Keep working on this workflow. The new URL becomes another (movable) Navigate step at the end.</span>
            </button>

            <button className="url-change-opt danger" onClick={onDiscardAndStartNew}>
              <strong>Discard &amp; start new</strong>
              <span>Throw away the current workflow and start fresh on the new URL.</span>
            </button>

            <button className="url-change-opt subtle" onClick={onCancel}>
              <strong>Cancel</strong>
              <span>Don't navigate — leave the workflow as it is.</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      style={{ animation: "spin 0.8s linear infinite" }}>
      <path d="M21 12a9 9 0 1 1-6.22-8.56"/>
    </svg>
  );
}

createRoot(document.getElementById("root")).render(
  <AuthProvider>
    <App />
  </AuthProvider>
);