'use strict';

/* ===========================================================================
   apiSerialize
   ---------------------------------------------------------------------------
   DB row → public API (/v1) JSON shapes. One place so the REST endpoints and
   the webhook payloads describe a run identically (snake_case keys — this is
   the shape third-party developers integrate against, distinct from the
   camelCase internal /api/* responses).
   ========================================================================= */

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

function serializeRun(row) {
  if (!row) return null;
  const failed = ['error', 'needs_review'].includes(row.status);
  return {
    id: row.id,
    object: 'run',
    workflow_id: row.workflow_id,
    status: row.status,
    trigger: row.trigger,
    queued_at: row.queued_at || null,
    started_at: row.status === 'queued' ? null : row.started_at,
    finished_at: row.finished_at || null,
    duration_ms: row.duration_ms ?? null,
    retry_count: row.retry_count ?? 0,
    error: failed ? {
      category: row.error_category || null,
      message: row.error_message || null,
      summary: row.ai_summary || null,
    } : null,
    // has_results is precomputed in paginated list queries; detail queries
    // carry the full results_json column instead.
    has_data: 'has_results' in row ? !!row.has_results : !!row.results_json,
  };
}

function serializeWorkflowSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    object: 'workflow',
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Full shape: adds the workflow's entry URL and its declared variables — the
// names a caller may override via `inputs` when triggering a run. Steps stay
// private: the API is trigger-and-fetch, not a workflow editor.
function serializeWorkflow(row) {
  if (!row) return null;
  const meta = row.meta_json ? safeJson(row.meta_json) || {} : {};
  const variables = Array.isArray(meta.variables) ? meta.variables : [];
  return {
    ...serializeWorkflowSummary(row),
    start_url: meta.startUrl || null,
    variables: variables
      .filter(v => v && typeof v.name === 'string' && v.name.trim())
      .map(v => ({
        name: v.name,
        type: (v.type || 'string').toLowerCase(),
        description: v.description || null,
        default: v.value ?? null,
      })),
  };
}

function serializeWebhook(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    object: 'webhook',
    url: row.url,
    events: safeJson(row.events) || [],
    active: row.active === 1 || row.active === true,
    created_at: row.created_at,
  };
  if (includeSecret) out.secret = row.secret;
  return out;
}

module.exports = { serializeRun, serializeWorkflow, serializeWorkflowSummary, serializeWebhook };
