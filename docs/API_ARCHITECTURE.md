# Public REST API — architecture (draft)

The public API is the programmatic front door to the scraping platform: it lets
a **program** (not a human in the UI) trigger a scraper, check on it, and get
the extracted data back. This is the capability that puts the product on par
with Octoparse / ParseHub / Browse AI, which all ship a REST API.

## Scope for v1 (decided)

- **Trigger-and-fetch only.** The API can *run existing* workflows and *return
  their data*. It does **not** create or edit workflows — those are built in the
  visual UI. (Write access to workflows via API is a possible later addition;
  most competitor APIs are trigger-and-fetch, so this is the right starting
  line.)
- **Audience: third-party developers first.** The API is designed as a product
  other developers integrate against, which raises the bar on the things
  developers care about: stable versioning, predictable JSON errors, API keys,
  rate limits, pagination, and good docs. First-party integrations (Zapier /
  Google Sheets / a future mobile app) can be built on this same surface later.

Everything below marked _(later)_ is intentionally out of v1.

## Design principles

| Principle | Why |
|---|---|
| **Async by default** | Scrapes take seconds-to-minutes. `POST …/runs` returns immediately with a `run_id` (HTTP `202`); the caller polls or receives a webhook. An HTTP client never blocks on a scrape. |
| **API-key auth, not JWT** | Programs need long-lived credentials, not 7-day login tokens. Separate from the existing frontend JWT auth. |
| **Versioned under `/v1`** | Evolve without breaking integrations. Existing internal/frontend routes stay at `/api/*`; the public API is a new `/v1/*` surface. |
| **Thin front door over existing services** | The API layer authenticates, rate-limits, meters, then calls the **same** `workflows.repo` / `executionPipeline` the UI uses. No duplicated business logic. Self-healing, versioning, and run history come for free. |

## Authentication — API keys

- Format like `sk_live_…` / `sk_test_…`, sent as `Authorization: Bearer sk_live_…`.
- Stored **hashed** (like passwords), never in plaintext, in a new `api_keys`
  table scoped to `user_id` (and a future `workspace_id`).
- Created / revoked from the dashboard UI — **not** via the API itself.
- Request middleware: look up the key by hash → resolve the owner → scope all
  downstream data access to them. The data layer is already `user_id`-scoped, so
  this drops in cleanly.

```
api_keys: id, user_id, name, key_hash, prefix, last_used_at, created_at, revoked_at
```

## Endpoints (v1)

```
# Runs — the core trigger-and-fetch loop
POST   /v1/workflows/:id/runs      Trigger a run        → 202 { run_id, status: "queued" }
GET    /v1/runs/:id                Run status + metadata
GET    /v1/runs/:id/data           Extracted data       (?format=json|csv)
GET    /v1/runs/:id/logs           Run logs
POST   /v1/runs/:id/cancel         Cancel a queued/running run
GET    /v1/runs                    List runs            (filter by workflow/status; paginated)

# Workflows — READ ONLY in v1 (so callers can discover ids to run)
GET    /v1/workflows               List workflows
GET    /v1/workflows/:id           Get one

# Webhooks — push instead of poll
POST   /v1/webhooks                Register an endpoint (events: run.completed, run.failed)
GET    /v1/webhooks                List
DELETE /v1/webhooks/:id            Remove

# Account
GET    /v1/usage                   Current period: runs used, quota, plan

# (later) POST/PATCH/DELETE /v1/workflows           create/edit workflows via API
# (later) GET/PUT/DELETE     /v1/workflows/:id/schedule   manage schedules via API
```

Optionally accept run inputs in the trigger body (e.g. a URL or search term the
workflow references as a variable):

```
POST /v1/workflows/42/runs
{ "inputs": { "query": "wireless headphones" } }
→ 202 { "run_id": 9001, "status": "queued" }
```

## The core flow — a run's life

The API endpoint **only enqueues**; a **worker** runs the existing
`executionPipeline`. Same pipeline the UI uses, so healing / versioning / run
history all apply.

```
  Client                API (/v1)            Queue           Worker                DB
    │  POST .../runs        │                  │               │                    │
    ├──────────────────────>│  auth key        │               │                    │
    │                       │  check quota     │               │                    │
    │                       ├─ create run row ─────────────────────────────────────>│ runs: status=queued
    │                       ├─ enqueue job ───>│               │                    │
    │  202 { run_id }       │                  │               │                    │
    │<──────────────────────┤                  │               │                    │
    │                       │                  ├── job ───────>│ executionPipeline  │
    │                       │                  │               │  .executeAndPersist│
    │                       │                  │               ├─ run + heal + save >│ runs: status=success
    │                       │                  │               ├─ fire webhook ─────>  POST client URL
    │  GET .../runs/:id  (poll, optional)      │               │                    │
    │<─────────── status: success ─────────────────────────────────────────────────┤
    │  GET .../runs/:id/data                   │               │                    │
    │<─────────── extracted JSON/CSV ──────────────────────────────────────────────┤
```

## How it maps onto the current codebase

| API needs | Already exists | New to build |
|---|---|---|
| Trigger / execute | `executionPipeline.executeAndPersist`, `runStore` | thin `/v1` route + enqueue |
| Workflows (read) | `workflows.repo` | `/v1` read wrappers + serialization |
| Data export (JSON/CSV) | logic in `routes/runs.routes.js` | reuse (extract into a shared serializer) |
| Run status / logs | `runStore` | `/v1` wrappers |
| Auth | — | `api_keys` table + middleware |
| Webhooks | — | `webhooks` table + dispatcher (fired from the pipeline on completion) |
| Quotas / metering | — | usage counter + middleware (also read by billing) |
| Rate limiting | — | per-key limiter (Redis, shared with the queue) |
| Async execution | run rows + pipeline | job queue (BullMQ/Redis) + worker process |

Roughly **70% is thin wrappers** over services that already exist; the genuinely
new parts are **API keys, webhooks, rate limiting, usage metering**, and the
**job queue + worker** that turns a trigger into a background run.

## Cross-cutting conventions (matter most for third-party devs)

- **Errors** — one consistent shape everywhere:
  `{ "error": { "code": "invalid_api_key", "message": "...", "request_id": "..." } }`.
- **Status codes** — `202` accepted (run queued), `401` bad/missing key,
  `402` over quota, `404` not found / not owned, `409` idempotency conflict,
  `429` rate limited (with `Retry-After`).
- **Idempotency** — optional `Idempotency-Key` header on `POST …/runs` so a
  retried trigger doesn't double-run.
- **Pagination** — cursor-based (`?limit=&cursor=`) on list endpoints; never
  offset (rows shift under you).
- **Webhook security** — signed payloads (HMAC in a header) so the receiver can
  verify the call really came from us; document verification.
- **Rate limits** — per API key, surfaced in `X-RateLimit-*` response headers.

## New database tables

```
api_keys:  id, user_id, name, key_hash, prefix, last_used_at, created_at, revoked_at
webhooks:  id, user_id, url, secret, events (json), active, created_at
usage:     id, user_id, period (e.g. '2026-07'), runs_used, pages_used, updated_at
```

(`runs` already exists — it gains a `queued` status and an optional
`triggered_via` / `api_key_id` column so API-triggered runs are attributable.)

## Suggested build order

1. **`api_keys` table + auth middleware** — unlocks everything; nothing works
   without it.
2. **Job queue + worker** (BullMQ/Redis) — enqueue → background `executionPipeline`.
   (The data layer is already async/stateless-ready from the DB migration, so a
   separate worker process is now a deployment concern, not a rewrite.)
3. **`POST /v1/workflows/:id/runs` + `GET /v1/runs/:id` + `/data`** — the core
   trigger→fetch loop; this is the minimum sellable API.
4. **Webhooks** (`run.completed` / `run.failed`) — push delivery.
5. **Rate limiting + usage metering** — ties into billing/plans.
6. **Read-only `GET /v1/workflows`** — discovery of runnable workflow ids.

Everything past step 3 is additive; a developer can already trigger a scrape and
fetch its data after step 3.
