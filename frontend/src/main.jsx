import React, { useRef, useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import io from "socket.io-client";
import { useWorkflow, findStepLocation } from "./workflow/useWorkflow";
import { createAction } from "./workflow/stepFactory";
import WorkflowPanel from "./components/WorkflowPanel";
import ElementInspector, { ForEachContextBanner } from "./components/ElementInspector";
import ExecutionPanel from "./components/ExecutionPanel";
import DataPreviewPanel from "./components/DataPreviewPanel";
import CompactWorkflowSidebar from "./components/CompactWorkflowSidebar";
import PaginationDetector from "./components/PaginationDetector";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import AuthScreen from "./auth/AuthScreen";
import WorkflowsMenu from "./workflows/WorkflowsMenu";
import CustomActionsMenu from "./customActions/CustomActionsMenu";
import { API_BASE, customActionsApi, workflowsApi, aiApi } from "./api/client";
import "./styles/PaginationDetector.css";
import "./styles/app.css";
import "./styles/ExecutionPanel.css";
import "./styles/DataPreviewPanel.css";
import "./styles/CompactWorkflowSidebar.css";
import "./styles/auth.css";

const SERVER_URL = API_BASE;

// ── Workflow-variable substitution (client-side preview path) ───────────
// The codegen handles `{{name}}` at run time by emitting JS template
// literals; in the editor's live preview we don't have those generated
// declarations, so we substitute the variable VALUES into selectors /
// URLs / etc. before sending the payload to the backend's previewStep.
// References to undeclared names are left untouched (verbatim text).
// Same regex as the codegen — top-level identifier or dotted path.
// Dotted paths only resolve if the ROOT identifier is a declared workflow
// variable AND it's an object. (Iteration variables like `product.link`
// only exist at run time, so the live preview leaves them as literal text
// — the user can still verify them once they hit Run.)
const VAR_RX = /\{\{\s*([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\s*\}\}/g;
function resolveVars(s, vars) {
  if (typeof s !== "string" || !s.includes("{{")) return s;
  const map = new Map();
  for (const v of vars || []) {
    if (v && typeof v.name === "string" && v.name) map.set(v.name, v.value);
  }
  if (map.size === 0) return s;
  return s.replace(VAR_RX, (full, path) => {
    const parts = path.split(".");
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
  const { steps, totalCount, setSteps, addStep, updateStep, deleteStep, reorderSteps, updateLabelById, updateParamsById, addStepAt, moveStepById } = useWorkflow();
  const [activeTab, setActiveTab] = useState("stream");

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
  const [toast,           setToast]           = useState(null);   // { msg, type }
  const toastTimerRef = useRef(null);

  // Preview data: separate from steps so updates don't re-trigger emission
  const [previewData,     setPreviewData]     = useState({});
  // Sidebar: shared inspector + workflow panel
  const [showSidebar,     setShowSidebar]     = useState(false);
  const [sidebarTab,      setSidebarTab]      = useState("inspector");
  // Pagination detection
  const [paginationOpen,  setPaginationOpen]  = useState(false);
  const [paginationDetecting, setPaginationDetecting] = useState(false);
  const [paginationSuggestions, setPaginationSuggestions] = useState(null);
  const [paginationError,    setPaginationError]    = useState(null);
  const [paginationManualWaiting, setPaginationManualWaiting] = useState(false); // true when waiting for element click // "inspector" | "workflow"
  const [reselectStepId,  setReselectStepId]  = useState(null); // step id awaiting element re-pick
  const [reselectIsLoop,  setReselectIsLoop]  = useState(false);
  // Insert target: where new steps from ElementInspector will land
  // null = root end (default); { type:"inside"|"after"|"root_end", stepId? }
  const [insertTarget, setInsertTarget] = useState(null);

  // ForEach context: when set, actions are added inside the loop body
  const [forEachCtx, setForEachCtx] = useState(null); // { stepId }
  const stepsRef = useRef(steps);
  useEffect(() => { stepsRef.current = steps; }, [steps]);
  // Stable refs for reselect (avoid stale closures in socket handler)
  const reselectStepIdRef            = useRef(null);
  const updateParamsByIdRef          = useRef(null);
  const paginationManualWaitingRef   = useRef(false);
  useEffect(() => { reselectStepIdRef.current          = reselectStepId; },          [reselectStepId]);
  useEffect(() => { updateParamsByIdRef.current         = updateParamsById; },         [updateParamsById]);
  useEffect(() => { paginationManualWaitingRef.current  = paginationManualWaiting; }, [paginationManualWaiting]);
  const insertTargetRef = useRef(null);
  useEffect(() => { insertTargetRef.current = insertTarget; }, [insertTarget]);
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
    socket.on("pageUrlChanged", ({ url }) => { if (typeof url === "string") setCurrentPageUrl(url); });
    // DOM is parsed and ready — re-fire all step previews so the Data tab
    // populates against the freshly loaded page (especially needed right
    // after opening a saved workflow, where the navigate is still in
    // flight when the steps-changed effect first ran).
    socket.on("pageReady", () => { setPageReadyTick(t => t + 1); });
    socket.on("actionResult", res => setStatus(res.success ? "Action executed." : "Action failed: " + (res.error || "")));
    socket.on("viewportUpdated", (data) => {
      sessionMetaRef.current.viewportWidth  = data.width;
      sessionMetaRef.current.viewportHeight = data.height;
    });

    socket.on("browserEvent", (data) => {
      if (data.type === "workflowStep") {
        addStep(createAction(data.action, data.params || {}, data.advanced || {}), [], null);
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
          updateParamsByIdRef.current(reselectStepIdRef.current, {
            selector: el.selector || '',
            selectorType: el.selectorType || 'css',
            fallbackSelectors: el.fallbackSelectors || [],
          });
          reselectStepIdRef.current = null;
          setReselectStepId(null);
          socketRef.current?.emit('resetSelection');
        } else {
          setSelectedElement(data.element);
          setChildrenList(null);
          setShowSidebar(true);
          setSidebarTab("inspector");
        }
      }
      if (data.type === "multiElementSelected") {
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

    // Execution events
    socket.on("executionStarted", () => {
      setExecStatus("running"); setExecLogs([]); setExecResults(null);
      setExecStepStates({}); setExecIterations({}); setExecLastStepId(null);
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
    socket.on("executionDone",    ({ success, results, status }) => {
      // `status` is the persisted run status ('success' | 'error' | 'needs_review' | 'cancelled').
      // We map it to the local 4-state for the panel: idle/running/done/error.
      if (status === "success" || success) setExecStatus("done");
      else setExecStatus("error");
      if (results && Object.keys(results).length > 0) setExecResults(results);
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
    socket.on("codeReady", ({ code }) => { downloadTextFile(code, "workflow.js", "text/javascript"); });
    socket.on("paginationDetected", ({ suggestions, error }) => {
      setPaginationDetecting(false);
      setPaginationSuggestions(suggestions || []);
      setPaginationError(error || null);
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
        const bitmap = await createImageBitmap(new Blob([frame], { type: "image/png" }));
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width; canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
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
        socketRef.current.emit("resizeViewport", { width: Math.floor(rect.width), height: Math.floor(rect.height) });
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

  // ── Mode ──────────────────────────────────────────────────────────────────
  const changeMode = (newMode) => {
    // While in a ForEach loop context the user must stay in selection mode
    // so they can pick items belonging to the iterator. Bail before changing
    // anything so we don't drop their selection in passing.
    if (newMode !== "selection" && forEachCtx) return;
    setMode(newMode);
    if (newMode !== "selection") {
      socketRef.current?.emit("resetSelection");
      setSelectedElement(null);
    }
    socketRef.current?.emit("setMode", { mode: newMode });
  };

  // ── Reset to a fresh workflow (like just logging in) ─────────────────────
  // Clears steps, closes the backend page, resets URL bar, drops run results.
  const resetWorkflow = useCallback(() => {
    setSteps([]);
    setCurrentWorkflowId(null);
    setCurrentWorkflowName("");
    setExecResults(null);
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
  const onDifferentPage = !!(pinnedUrl && currentPageUrl) && !sameUrlIgnoringHash(currentPageUrl, pinnedUrl);

  // Whenever the puppeteer page reports a new URL (link click, redirect,
  // history nav), reflect it in the URL bar — that's what a real browser
  // does. The user's in-flight typing can get clobbered if a page-driven
  // navigation arrives mid-edit; this is the same compromise every browser
  // makes.
  useEffect(() => {
    if (currentPageUrl) setUrlInput(currentPageUrl);
  }, [currentPageUrl]);

  // Keep the URL bar in sync with the pinned step's URL whenever the user
  // edits it via the step editor modal.
  useEffect(() => {
    const pinned = steps[0]?.type === "NAVIGATE" && steps[0]?.pinned ? steps[0] : null;
    const pUrl = pinned?.params?.url || "";
    if (pinned && pUrl !== urlInput) {
      setUrlInput(pUrl);
    }
    // We intentionally don't depend on urlInput — that would create a cycle
    // (typing in the URL bar would reset itself on each keystroke).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps]);

  // Low-level: tell the backend to navigate and start streaming the new URL.
  const performNavigate = useCallback((url) => {
    if (!socketRef.current || !url) return;
    setStatus("Navigating...");
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    const vpW = Math.floor(rect?.width) || 1280;
    const vpH = Math.floor(rect?.height) || 720;
    sessionMetaRef.current = { ...sessionMetaRef.current, startUrl: url, viewportWidth: vpW, viewportHeight: vpH };
    socketRef.current.emit("navigate", { url, mode, viewportWidth: vpW, viewportHeight: vpH });
    isStreamingRef.current = true;
  }, [mode]);

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

    if (pinnedStep && url === pinnedUrl) {
      // Same URL — refresh without prompting.
      performNavigate(url);
      return;
    }

    // Existing workflow + URL changed → ask the user what to do.
    setUrlChangeDialog({ newUrl: url });
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

  // ── Add step from inspector ───────────────────────────────────────────────
  const handleAddStep = useCallback((step, opts = {}) => {
    const { isForEach = false } = opts;

    if (isForEach) {
      // ForEach loops always go to insertTarget or root, then activate forEach context
      const target = insertTargetRef.current;
      if (target && target.type !== 'root_end') {
        const loc = findStepLocation(stepsRef.current, target.stepId);
        if (loc) {
          if (target.type === 'inside') addStepAt(step, [...loc.containerPath, loc.index, 'body'], null);
          else addStepAt(step, loc.containerPath, loc.index + 1);
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
          addStepAt(step, [...loc.containerPath, loc.index, 'body'], null);
          showToast(`✓ Step added inside loop`, "success");
        } else {
          addStepAt(step, loc.containerPath, loc.index + 1);
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
  }, [addStep, addStepAt, forEachCtx, showToast, insertTarget, maybeAutoNameStep]);

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

  // ── Run / Download / Cancel ───────────────────────────────────────────────
  const handleRun = () => {
    if (!socketRef.current || steps.length === 0) return;
    setExecPanelOpen(true);
    setExecStatus("idle");
    setExecLogs([]);
    setExecResults(null);
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

  // Convert a browser pointer/mouse event to puppeteer-page coordinates
  // (the canvas backing-store size, not its CSS size). Clamps to the
  // canvas extent so drag positions outside the canvas don't go negative
  // or run past the viewport.
  const scaled = (e) => {
    const c = canvasRef.current, r = c.getBoundingClientRect();
    const xRaw = (e.clientX - r.left) * (c.width  / r.width);
    const yRaw = (e.clientY - r.top)  * (c.height / r.height);
    const x = Math.max(0, Math.min(c.width  - 1, Math.round(xRaw)));
    const y = Math.max(0, Math.min(c.height - 1, Math.round(yRaw)));
    return { x, y };
  };
  const emit = (type, extra = {}) => {
    // Don't send mouse/keyboard events to the backend when there's no active
    // page — e.g. after "New workflow" before the next navigate. Otherwise
    // hover events race against a torn-down execution context.
    if (!isStreamingRef.current) return;
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
            className={`header-btn run-btn ${execStatus === "running" ? "running" : ""}`}
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
            <div className="mode-toggle">
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
            <div className={`url-input-wrapper${onDifferentPage ? " url-input-wrapper--warn" : ""}`}>
              {onDifferentPage && pinnedUrl && (
                // Back to the workflow's start URL — only shown while we've
                // drifted away from it. Sends the user (and any future
                // inspector actions) back to the page the workflow was built
                // on without forcing them to retype the URL.
                <button
                  className="url-back-btn"
                  title={`Back to start URL — ${pinnedUrl}`}
                  onClick={() => { setUrlInput(pinnedUrl); performNavigate(pinnedUrl); }}
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
              </div>
            )}

            {/* Sidebar toggle */}
            <button
              className={`inspector-toggle-btn ${showSidebar ? "active" : ""}`}
              onClick={() => setShowSidebar(v => !v)}
              title={showSidebar ? "Hide sidebar" : "Show sidebar"}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>
              </svg>
              {selectedElement?.isMultiSelection ? `${selectedElement.matchCount} elements` : "Sidebar"}
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
          </div>

          {/* Stream body: canvas + inspector sidebar side by side */}
          <div className="stream-body">
            <div className="canvas-container" ref={canvasContainerRef}>
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
                  emit("mousedown", { x, y });
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
                  e.preventDefault();
                  emit("keydown", { key: e.key, code: e.code });
                }}
                onKeyUp={e => {
                  if (!isStreamingRef.current) return;
                  if (isPassthroughKey(e)) return;
                  e.preventDefault();
                  emit("keyup", { key: e.key, code: e.code });
                }}
              />
              <div className={`mode-indicator ${mode}`}>
                {mode === "selection"
                  ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 9l7 7 7-7"/></svg> Selection Mode — click elements to inspect</>
                  : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg> Navigation Mode</>
                }
              </div>
            </div>

            {/* Unified sidebar — always in flow next to canvas when on Live Browser */}
            {showSidebar && (
              <div className="inspector-sidebar">
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
                    Inspector
                  </button>
                  <button
                    className={`sidebar-tab-btn ${sidebarTab === "workflow" ? "active" : ""}`}
                    onClick={() => setSidebarTab("workflow")}
                    title="Workflow"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/>
                    </svg>
                    Workflow
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
                      onUpdateParams={updateParamsById}
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
                    reselectStepId={reselectStepId}
                    onReselect={(id, isLoop) => {
                      setReselectStepId(id);
                      setReselectIsLoop(!!isLoop);
                      if (isLoop) socketRef.current?.emit("startForEachSelection");
                      else socketRef.current?.emit("startElementSelection");
                    }}
                    onCancelReselect={() => { setReselectStepId(null); socketRef.current?.emit("resetSelection"); }}
                    onHighlight={(sel) => socketRef.current?.emit("highlightSelector", { selector: sel })}
                    onClearHighlight={() => socketRef.current?.emit("clearHighlight")}
                    onUpdateParams={updateParamsById}
                    onUpdateLabel={updateLabelById}
                    insertTarget={insertTarget}
                    onSetInsertTarget={setInsertTarget}
                    onMoveStep={moveStepById}
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
            customActions={customActions}
            offStartUrl={onDifferentPage}
            pinnedUrl={pinnedUrl}
            currentPageUrl={currentPageUrl}
            onReturnToStart={() => { if (pinnedUrl) { setUrlInput(pinnedUrl); performNavigate(pinnedUrl); } }}
            socket={socket}
            previewData={previewData}
            variables={workflowVariables}
            onVariablesChange={setWorkflowVariables}
            variablesCollapsed={variablesCollapsed}
            onToggleVariablesCollapsed={() => setVariablesCollapsed(c => !c)}
            availableWorkflows={availableWorkflows}
            currentWorkflowId={currentWorkflowId}
          />
        )}
        {activeTab === "data" && (
          <DataPreviewPanel
            steps={steps}
            execResults={execResults}
            previewData={previewData}
            onUpdateLabel={updateLabelById}
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
          onAdd={(step) => {
            addStep(step);
            // Auto-set insert target based on pagination type:
            // Button/load-more → inside loop (each page needs scraping)
            // Infinite scroll → after loop (scrape after all content loads)
            const pType = step.params?.expression?.includes('scrollTo') ||
                          step.params?.expression?.includes('scrollHeight')
              ? 'infinite_scroll' : 'button';
            if (pType === 'infinite_scroll') {
              setInsertTarget({ type: 'after', stepId: step.id });
            } else {
              setInsertTarget({ type: 'inside', stepId: step.id });
            }
            setPaginationOpen(false);
          }}
          onManualButton={() => {
            setPaginationOpen(false);        // hide modal so browser is clickable
            setPaginationManualWaiting(true);
            socketRef.current?.emit("startElementSelection");
          }}
          onManualInfinite={() => {
            const scrollStep = {
              kind: "action", type: "SCROLL_PAGE", id: crypto.randomUUID(),
              label: "Scroll to bottom",
              params: { direction: "bottom" }, advanced: {},
            };
            const waitStep = {
              kind: "action", type: "WAIT", id: crypto.randomUUID(),
              label: "Wait for content to load",
              params: { duration: 2000 }, advanced: {},
            };
            addStep({
              kind: "control", type: "WHILE", id: crypto.randomUUID(),
              label: "Infinite scroll loop",
              params: {
                expression: [
                  "await page.evaluate(() => {",
                  "  const items = document.querySelectorAll('li,article,[class*=\"item\"],[class*=\"card\"],[class*=\"result\"]');",
                  "  if (items.length) items[items.length-1].scrollIntoView({block:'end',behavior:'instant'});",
                  "  window.scrollTo(0, document.body.scrollHeight);",
                  "  return (window.innerHeight + window.scrollY) < document.body.scrollHeight - 50;",
                  "})",
                ].join("\n"),
                maxIterations: 200,
              },
              body: [scrollStep, waitStep],
            });
            setPaginationOpen(false);
          }}
        />
      )}

      {/* ── Execution Panel ──────────────────────────────────────────────── */}
      <ExecutionPanel
        isOpen={execPanelOpen} onClose={() => setExecPanelOpen(false)}
        logs={execLogs} status={execStatus} results={execResults}
        onCancel={handleCancelExecution}
        steps={steps}
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
            if (pinned) setUrlInput(pinned.params?.url || "");
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
            if (pinned) setUrlInput(pinned.params?.url || "");
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

      {/* ── Workflows menu (save / open / delete) ───────────────────────── */}
      <WorkflowsMenu
        open={workflowsOpen}
        onClose={() => setWorkflowsOpen(false)}
        currentSteps={steps}
        currentMeta={{ ...sessionMetaRef.current, variables: workflowVariables }}
        currentWorkflowId={currentWorkflowId}
        currentName={currentWorkflowName}
        showToast={showToast}
        onSaved={(wf) => {
          setCurrentWorkflowId(wf.id);
          setCurrentWorkflowName(wf.name);
          refreshAvailableWorkflows();   // make the new/updated workflow pickable as a subflow
        }}
        onLoaded={(wf) => {
          // Normalise: mark the first NAVIGATE step as the pinned start URL.
          // Older workflows saved before the pinning feature won't have this flag.
          const loadedSteps = (wf.steps || []).map((s, i) =>
            i === 0 && s.type === "NAVIGATE" && !s.pinned ? { ...s, pinned: true } : s
          );
          setSteps(loadedSteps);
          setCurrentWorkflowId(wf.id);
          setCurrentWorkflowName(wf.name);
          if (wf.meta) sessionMetaRef.current = { ...sessionMetaRef.current, ...wf.meta };
          setWorkflowVariables(Array.isArray(wf.meta?.variables) ? wf.meta.variables : []);
          setExecResults(null);
          setExecLogs([]);
          setExecStatus("idle");

          // Populate the URL bar with the workflow's start URL and auto-navigate
          // so the user can immediately see the page they built the workflow on.
          const startUrl = loadedSteps[0]?.type === "NAVIGATE"
            ? loadedSteps[0]?.params?.url || ""
            : wf.meta?.startUrl || "";
          setUrlInput(startUrl);
          if (startUrl) performNavigate(startUrl);
        }}
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