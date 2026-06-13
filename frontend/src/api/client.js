import axios from "axios";

export const API_BASE = "http://localhost:3001";
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

export const workflowsApi = {
  list:   () => api.get("/api/workflows").then(r => r.data.workflows),
  get:    (id) => api.get(`/api/workflows/${id}`).then(r => r.data.workflow),
  create: (name, steps, meta) => api.post("/api/workflows", { name, steps, meta }).then(r => r.data.workflow),
  update: (id, name, steps, meta) => api.put(`/api/workflows/${id}`, { name, steps, meta }).then(r => r.data.workflow),
  remove: (id) => api.delete(`/api/workflows/${id}`).then(r => r.data),
};

export const customActionsApi = {
  list:   () => api.get("/api/custom-actions").then(r => r.data.customActions),
  get:    (id) => api.get(`/api/custom-actions/${id}`).then(r => r.data.customAction),
  create: (payload) => api.post("/api/custom-actions", payload).then(r => r.data.customAction),
  update: (id, payload) => api.put(`/api/custom-actions/${id}`, payload).then(r => r.data.customAction),
  remove: (id) => api.delete(`/api/custom-actions/${id}`).then(r => r.data),
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
  upsertForWorkflow: (workflowId, intervalMinutes, isActive, startAtIso = null) =>
    api.put(`/api/schedules/workflow/${workflowId}`, { intervalMinutes, isActive, startAtIso }).then(r => r.data.schedule),
  removeForWorkflow: (workflowId) =>
    api.delete(`/api/schedules/workflow/${workflowId}`).then(r => r.data),
};

export const runsApi = {
  list:     (workflowId)         => api.get("/api/runs", { params: workflowId ? { workflowId } : {} }).then(r => r.data.runs),
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
};
