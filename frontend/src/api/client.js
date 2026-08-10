import axios from "axios";

// API origin. In dev, Vite serves the UI on a different port than the API, so
// default to the local backend. In a production build the backend serves the
// built UI from the same origin, so VITE_API_BASE is normally left empty and
// requests go to relative paths. Override with VITE_API_BASE at build time to
// point at a remote backend.
export const API_BASE =
  (import.meta.env && import.meta.env.VITE_API_BASE !== undefined)
    ? import.meta.env.VITE_API_BASE
    : (import.meta.env && import.meta.env.DEV ? "http://localhost:3001" : "");
const TOKEN_KEY = "ws_auth_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, clear the bad token so the app falls back to the login screen.
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) setToken(null);
    return Promise.reject(err);
  }
);

export const authApi = {
  register: (username, password) => api.post("/api/auth/register", { username, password }).then(r => r.data),
  login:    (username, password) => api.post("/api/auth/login",    { username, password }).then(r => r.data),
  me:       () => api.get("/api/auth/me").then(r => r.data),
};

// Account-level e-mail alerts. `available` reflects whether this instance has
// SMTP configured at all — the UI hides the switches when it doesn't.
export const notificationsApi = {
  get:    () => api.get("/api/notifications").then(r => r.data),
  save:   (body) => api.put("/api/notifications", body).then(r => r.data.settings),
  remove: () => api.delete("/api/notifications").then(r => r.data),
  test:   (email) => api.post("/api/notifications/test", { email }).then(r => r.data),
};

export const workflowsApi = {
  list:   () => api.get("/api/workflows").then(r => r.data.workflows),
  get:    (id) => api.get(`/api/workflows/${id}`).then(r => r.data.workflow),
  create: (name, steps, meta) => api.post("/api/workflows", { name, steps, meta }).then(r => r.data.workflow),
  update: (id, name, steps, meta) => api.put(`/api/workflows/${id}`, { name, steps, meta }).then(r => r.data.workflow),
  remove: (id) => api.delete(`/api/workflows/${id}`).then(r => r.data),
  // Export / import / duplicate.
  exportBlob:  async (id) => { const r = await api.get(`/api/workflows/${id}/export`, { responseType: "blob" }); return r.data; },
  importFromEnvelope: (envelope, targetName) => api.post("/api/workflows/import", { ...envelope, targetName }).then(r => r.data),
  duplicate:   (id) => api.post(`/api/workflows/${id}/duplicate`).then(r => r.data.workflow),
  // Template gallery: ready-made starting points. `useTemplate` runs the same
  // import path as an uploaded export file and returns the new workflow.
  templates:   () => api.get("/api/workflows/templates/list").then(r => r.data.templates),
  useTemplate: (id, targetName) => api.post(`/api/workflows/templates/${id}/use`, { targetName }).then(r => r.data),
  // One row per workflow for the global "Data" screen: how much has each
  // scraper actually collected, and over how many runs.
  dataSummary: () => api.get("/api/workflows/dataset/summary").then(r => r.data),
  // Cross-run dataset: rows accumulated across a workflow's runs.
  // params: { output?, key?, limit?, offset? } (key = "__row__" for whole-row dedupe)
  dataset: (id, params = {}) => api.get(`/api/workflows/${id}/dataset`, { params }).then(r => r.data),
  datasetDownloadBlob: async (id, fmt = "csv", params = {}) => {
    const r = await api.get(`/api/workflows/${id}/dataset.${fmt}`, { params, responseType: "blob" });
    return r.data;
  },
  // Change monitoring: config + recent change feed for a workflow.
  getMonitor:    (id) => api.get(`/api/workflows/${id}/monitor`).then(r => r.data),
  // body: { isActive, outputKey?, keyField? } — keyField "" = whole-row, omit = auto
  saveMonitor:   (id, body) => api.put(`/api/workflows/${id}/monitor`, body).then(r => r.data.monitor),
  removeMonitor: (id) => api.delete(`/api/workflows/${id}/monitor`).then(r => r.data),
  // Full run-to-run diff, computed on demand (not the bounded summary stored on
  // the run). params: { runId?, baseRunId?, output?, key?, limit? }
  // key = "__row__" for whole-row matching; omit for the monitor's / automatic choice.
  diff:          (id, params = {}) => api.get(`/api/workflows/${id}/diff`, { params }).then(r => r.data),
  // Bulk / parameterized runs: enqueue one background run per input row.
  // rows = array of { variableName: value } objects. Returns { created, runIds }.
  bulkRun:       (id, rows) => api.post(`/api/workflows/${id}/bulk-run`, { rows }).then(r => r.data),
  // Google Sheets delivery: config + instance service-account status.
  getSheet:      (id) => api.get(`/api/workflows/${id}/sheet`).then(r => r.data),
  // body: { isActive, spreadsheet (id/URL), sheetName?, outputKey? }
  saveSheet:     (id, body) => api.put(`/api/workflows/${id}/sheet`, body).then(r => r.data.sheet),
  removeSheet:   (id) => api.delete(`/api/workflows/${id}/sheet`).then(r => r.data),
};

export const customActionsApi = {
  list:   () => api.get("/api/custom-actions").then(r => r.data.customActions),
  get:    (id) => api.get(`/api/custom-actions/${id}`).then(r => r.data.customAction),
  create: (payload) => api.post("/api/custom-actions", payload).then(r => r.data.customAction),
  update: (id, payload) => api.put(`/api/custom-actions/${id}`, payload).then(r => r.data.customAction),
  remove: (id) => api.delete(`/api/custom-actions/${id}`).then(r => r.data),
};

export const proxiesApi = {
  // Own proxies + every shared/platform proxy (each row carries a `scope`:
  // 'own' | 'shared') — the full picker list.
  list:   () => api.get("/api/proxies").then(r => r.data.proxies),
  get:    (id) => api.get(`/api/proxies/${id}`).then(r => r.data.proxy),
  create: (payload) => api.post("/api/proxies", payload).then(r => r.data.proxy),
  update: (id, payload) => api.put(`/api/proxies/${id}`, payload).then(r => r.data.proxy),
  remove: (id) => api.delete(`/api/proxies/${id}`).then(r => r.data),
  // Admin-only: manage individual platform/shared proxies.
  createShared: (payload) => api.post("/api/proxies/shared", payload).then(r => r.data.proxy),
  updateShared: (id, payload) => api.put(`/api/proxies/shared/${id}`, payload).then(r => r.data.proxy),
  removeShared: (id) => api.delete(`/api/proxies/shared/${id}`).then(r => r.data),
};

export const proxyPoolsApi = {
  // Own pools + every shared/platform pool — the full picker list. Each
  // pool carries isShared/isDefault and its resolved `members`.
  list:   () => api.get("/api/proxy-pools").then(r => r.data.pools),
  get:    (id) => api.get(`/api/proxy-pools/${id}`).then(r => r.data.pool),
  create: (payload) => api.post("/api/proxy-pools", payload).then(r => r.data.pool),
  update: (id, payload) => api.put(`/api/proxy-pools/${id}`, payload).then(r => r.data.pool),
  remove: (id) => api.delete(`/api/proxy-pools/${id}`).then(r => r.data),
  // Admin-only: manage platform pools (rotation groups built from shared proxies).
  createShared: (payload) => api.post("/api/proxy-pools/shared", payload).then(r => r.data.pool),
  updateShared: (id, payload) => api.put(`/api/proxy-pools/shared/${id}`, payload).then(r => r.data.pool),
  removeShared: (id) => api.delete(`/api/proxy-pools/shared/${id}`).then(r => r.data),
};

export const webhooksApi = {
  events: ()        => api.get("/api/webhooks/events").then(r => r.data.events),
  list:   ()        => api.get("/api/webhooks").then(r => r.data.webhooks),
  // Returns { ...webhook, secret } — the secret is shown exactly once.
  create: (url, events) => api.post("/api/webhooks", { url, events }).then(r => r.data.webhook),
  remove: (id)      => api.delete(`/api/webhooks/${id}`).then(r => r.data),
};

export const aiApi = {
  // Returns '' on any error / when AI isn't configured — caller should
  // treat the empty string as "no suggestion" and leave the label alone.
  suggestStepName: (payload) =>
    api.post("/api/ai/suggest-step-name", payload)
       .then(r => (r.data && typeof r.data.name === "string" ? r.data.name : ""))
       .catch(() => ""),
};

export const schedulesApi = {
  list:           ()             => api.get("/api/schedules").then(r => r.data.schedules),
  getForWorkflow: (workflowId)   => api.get(`/api/schedules/workflow/${workflowId}`).then(r => r.data.schedule),
  upsertForWorkflow: (workflowId, intervalMinutes, isActive, startAtIso = null, extra = {}) =>
    api.put(`/api/schedules/workflow/${workflowId}`, { intervalMinutes, isActive, startAtIso, ...extra }).then(r => r.data.schedule),
  removeForWorkflow: (workflowId) =>
    api.delete(`/api/schedules/workflow/${workflowId}`).then(r => r.data),
};

export const apiKeysApi = {
  list:   () => api.get("/api/api-keys").then(r => r.data.apiKeys),
  // The response carries the plaintext key exactly once ({ apiKey, key }) —
  // after this call it can never be retrieved again, only revoked.
  create: (name) => api.post("/api/api-keys", { name }).then(r => r.data),
  revoke: (id) => api.delete(`/api/api-keys/${id}`).then(r => r.data),
};

export const runsApi = {
  list:     (workflowId)         => api.get("/api/runs", { params: workflowId ? { workflowId } : {} }).then(r => r.data.runs),
  // Runs still queued or running. A run executes on the server, so it
  // survives a reload or closing the workflow — this is how the UI finds
  // one again and re-attaches to its progress.
  active:   ()                   => api.get("/api/runs/active").then(r => r.data.runs),
  get:      (id)                 => api.get(`/api/runs/${id}`).then(r => r.data.run),
  logs:     (id)                 => api.get(`/api/runs/${id}/logs`).then(r => r.data.logs),
  // Build download URLs that the auth interceptor doesn't touch — anchor
  // tags can't pass headers, so we include the token as a query parameter
  // and accept that the runs route will read it from there. (See note in
  // routes/runs.routes.js — the bearer token is the supported path; this
  // is a fallback used only for direct downloads.) Simpler: open in a new
  // tab using fetch + blob, which we do via downloadAsBlob below.
  downloadDataUrl: (id, fmt = "json") => `${API_BASE}/api/runs/${id}/data.${fmt}`,
  downloadDataBlob: async (id, fmt = "json") => {
    const r = await api.get(`/api/runs/${id}/data.${fmt}`, { responseType: "blob" });
    return r.data;
  },
  applyPatch: (id) => api.post(`/api/runs/${id}/apply-patch`).then(r => r.data.workflow),
  // Roll the workflow back to the exact version this run executed.
  restore:    (id) => api.post(`/api/runs/${id}/restore`).then(r => r.data.workflow),
  // Can this run be continued instead of re-run? → { resumable, reason?, items? }
  resumeInfo: (id) => api.get(`/api/runs/${id}/resume-info`).then(r => r.data),
  // Continue it: skips the items already captured, restores their rows.
  resume:     (id) => api.post(`/api/runs/${id}/resume`).then(r => r.data),
  // Split one big job across N independent runs; the dataset view unions them.
  shard: (workflowId, shards) =>
    api.post("/api/runs/shard", { workflowId, shards }).then(r => r.data),
};
