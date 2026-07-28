# Public REST API — reference (v1)

The programmatic front door to the platform: trigger existing workflows,
poll (or get pushed) their status, and fetch the extracted data. Built to the
design in [API_ARCHITECTURE.md](./API_ARCHITECTURE.md) — trigger-and-fetch
only; workflows themselves are created in the visual UI.

Base URL: `https://<your-host>/v1` (the internal frontend keeps using
`/api/*` + JWT; the two surfaces are independent).

## Authentication

Create an API key in the dashboard (internally: `POST /api/api-keys` with your
JWT). The plaintext key (`sk_live_…`) is shown **once**; only its SHA-256 hash
is stored. Send it on every request:

```
Authorization: Bearer sk_live_…
```

Revoking a key (dashboard, `DELETE /api/api-keys/:id`) takes effect
immediately. Keys cannot be created or revoked through the public API itself,
so a leaked key can't mint more keys.

## Conventions

**Errors** — every error, on every endpoint, has one shape:

```json
{ "error": { "code": "invalid_api_key", "message": "…", "request_id": "req_…" } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` / `invalid_inputs` | Malformed parameter, body, or unknown input variable |
| 401 | `invalid_api_key` | Missing, malformed, unknown, or revoked key |
| 402 | `over_quota` | Monthly run quota reached |
| 404 | `not_found` / `no_data` | Doesn't exist **or isn't yours** (never distinguished) |
| 409 | `idempotency_conflict` / `not_cancellable` | Idempotency-Key reuse across workflows; run can't be cancelled |
| 413 | `payload_too_large` | Request body over the 4 MB limit |
| 429 | `rate_limited` | Per-key rate limit hit — honor `Retry-After` |
| 500 | `internal_error` | Our bug; report the `request_id` |

Every response carries an `X-Request-Id` header (echoed in error bodies) for
support/debugging.

**Rate limits** — per API key, fixed 60-second window
(`API_RATE_LIMIT_PER_MIN`, default 60). Every response includes
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (unix
seconds); 429s add `Retry-After` (seconds).

**Pagination** — cursor-based on list endpoints:

```
GET /v1/runs?limit=20              → { "object": "list", "data": [...], "has_more": true, "next_cursor": "9001" }
GET /v1/runs?limit=20&cursor=9001  → next (older) page
```

`limit` is 1–100 (default 20). Never offset-based — pages don't shift when new
runs appear.

**Idempotency** — pass an `Idempotency-Key` header (≤255 chars) on
`POST /v1/workflows/:id/runs`. Retrying with the same key returns the
original run instead of triggering a second one; reusing a key against a
*different* workflow is a 409.

## The core loop

```bash
# 1. discover a workflow id
curl -s $BASE/v1/workflows -H "Authorization: Bearer $KEY"

# 2. trigger (returns immediately — scrapes take seconds to minutes)
curl -s -X POST $BASE/v1/workflows/42/runs \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: order-1234" \
  -H "Content-Type: application/json" \
  -d '{ "inputs": { "query": "wireless headphones" } }'
# → 202 { "id": 9001, "object": "run", "status": "queued", ... }

# 3. poll until finished (or register a webhook instead — see below)
curl -s $BASE/v1/runs/9001 -H "Authorization: Bearer $KEY"
# → { "status": "success", "has_data": true, ... }

# 4. fetch the data
curl -s $BASE/v1/runs/9001/data                # JSON
curl -s "$BASE/v1/runs/9001/data?format=csv"   # CSV
curl -s "$BASE/v1/runs/9001/data?format=xlsx" -o run.xlsx   # Excel workbook
```

Run statuses: `queued → running → success | error | needs_review | cancelled`.
`needs_review` means the run finished but self-healing left something for a
human (partial data may still be available via `/data`).

## Endpoints

### Workflows (read-only)

| | |
|---|---|
| `GET /v1/workflows` | Paginated list of your workflows (id, name, timestamps) |
| `GET /v1/workflows/:id` | One workflow, including `start_url` and its declared `variables` — the names you may override via `inputs` when triggering. Steps are never exposed. |

### Runs

| | |
|---|---|
| `POST /v1/workflows/:id/runs` | Trigger. Body (optional): `{ "inputs": { <variable>: <value> } }`. Returns `202` with the queued run. Inputs must match variables declared on the workflow (see `GET /v1/workflows/:id`); unknown names are a 400 so typos fail loudly. |
| `GET /v1/runs` | List, newest first. Filters: `workflow_id`, `status`, plus `limit`/`cursor`. |
| `GET /v1/runs/:id` | Status + metadata (timings, retry count, error details when failed). |
| `GET /v1/runs/:id/data` | Extracted data. `?format=json` (default, `{ "object": "run.data", "data": {...} }`), `?format=csv` (one `# section` per output key), or `?format=xlsx` (an Excel workbook, one worksheet per output key). 404 `no_data` while the run is still queued/running. |
| `GET /v1/runs/:id/logs` | The run's execution log lines. |
| `POST /v1/runs/:id/cancel` | Cancel. A `queued` run is cancelled atomically before it starts (200). A `running` run is aborted via the worker (202 + `cancel_requested: true`); runs executing outside the API worker (UI-triggered, another process) return 409. |

API-triggered runs go through the exact same execution pipeline as UI and
scheduled runs — self-healing, workflow versioning, and run history all apply.

### Webhooks — push instead of poll

| | |
|---|---|
| `POST /v1/webhooks` | Register. Body: `{ "url": "https://…", "events": ["run.completed", "run.failed", "run.changed"] }` (`events` optional, defaults to `run.completed` + `run.failed`). Returns the endpoint **including its signing `secret` (`whsec_…`) — shown only this once.** |
| `GET /v1/webhooks` | List (secrets omitted). |
| `DELETE /v1/webhooks/:id` | Remove. |

Events fire for **every** finished run (API-, UI-, and schedule-triggered):
`run.completed` on `success`, `run.failed` on `error` / `needs_review`.
`run.changed` fires when a workflow with change monitoring enabled produces
data that differs from its previous run (its payload adds a `changes` object
with the diff summary alongside `run`). See docs/PLATFORM_ANALYSIS.md §6.5.
Delivery payload:

```json
{
  "id": "evt_…",
  "object": "event",
  "type": "run.completed",
  "created_at": "2026-07-08T12:34:56.000Z",
  "data": { "run": { "id": 9001, "workflow_id": 42, "status": "success", ... } }
}
```

Failed deliveries are retried twice (after 5s and 30s). Respond with a 2xx
quickly and process asynchronously.

**Verifying signatures** — every delivery is signed with your endpoint's
secret:

```
X-Scraper-Event: run.completed
X-Scraper-Signature: t=1751970000,v1=<hex hmac-sha256>
```

`v1` is `HMAC_SHA256(secret, "<t>.<raw request body>")`. Verify like this
(Node):

```js
const crypto = require('crypto');

function verify(secret, signatureHeader, rawBody, toleranceSec = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(signatureHeader || '');
  if (!m) return false;
  const [, t, v1] = m;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false; // replay guard
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

Compute the HMAC over the **raw** body bytes, before any JSON parsing.

### Account

| | |
|---|---|
| `GET /v1/usage` | `{ "period": "2026-07", "runs_used": 12, "runs_quota": 1000, "pages_used": 0, "plan": "free" }`. `runs_quota: null` = unlimited. Only API-triggered runs are metered. |

## How it runs (operator notes)

- **Async execution** — `POST …/runs` only creates a `runs` row with
  `status='queued'`; the in-process **apiWorker**
  (`backend/services/apiWorker.service.js`) claims queued runs with an atomic
  conditional UPDATE (same stateless pattern as the scheduler) and executes
  them through `executionPipeline`. The DB is the queue — no Redis required —
  and the claim is race-safe across processes, so the worker can later move to
  a dedicated process (or be replaced by BullMQ) as a pure deployment change.
- **Per-process caveats** (single-process deployments are unaffected): the
  rate-limit counters are in-memory per process, and cancelling a *running*
  run only works in the process executing it. Queued-run cancellation is
  DB-atomic and always works.
- **Crash recovery** — a run that was mid-flight when the process died stays
  `running`; queued runs survive restarts untouched and execute when the
  worker comes back.
- **Config** — see the "Public REST API" block in `backend/.env.example`
  (rate limit, quota, worker poll/concurrency, webhook timeout).
- **Tests** — `npm run test:api` boots the app on a throwaway SQLite DB and
  exercises the whole surface (60 checks), no browser needed.

## Not in v1 (by design)

Creating/editing workflows via API, managing schedules via API, API-side key
management, `sk_test_` keys, and per-page metering — see the "later" items in
[API_ARCHITECTURE.md](./API_ARCHITECTURE.md).
