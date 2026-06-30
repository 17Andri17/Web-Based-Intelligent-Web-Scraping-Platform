# Scaling foundations & the Postgres migration

This document scopes the four "ready-to-scale" architectural habits and tracks
the incremental migration from SQLite to a dual-backend (SQLite **or** Postgres)
data layer.

The guiding principle for a solo dev: **start small, but don't make choices now
that force a rewrite later.** None of this requires distributed infrastructure
today. It requires drawing a few seams in the right places so that "scaling"
later becomes a *deployment* change, not a *code* change.

---

## The four architectural habits (scoped)

### 1. Stateless backend

**Goal:** no run/session state lives in process memory; everything durable lives
in Postgres/Redis. This is what lets you eventually run more than one backend
process behind a load balancer.

**Where we are today — in-memory state that must move:**

| Location | In-memory state | Why it blocks scale | Fix |
|---|---|---|---|
| `services/scheduler.service.js` | `inflight` Set, `running` counter | Two backend processes would both dispatch the same due schedule → duplicate runs | Claim due schedules with an atomic DB update (`UPDATE … WHERE next_run_at <= now RETURNING`), or move dispatch to a Redis-backed queue (BullMQ) |
| `services/runStore.service.js` | `logCounters` Map (per-run log sequence) | A second process writing logs for the same run would collide on `seq` | Derive `seq` from the DB (`SELECT max(seq)+1`) or a per-run sequence, or let logs be append-only with a DB-generated ordering |
| `server.js` | `userSessions`, per-user puppeteer pages/listeners | Live-browser sessions are inherently stateful and sticky to one process | Acceptable short-term with sticky sessions; long-term the browser tier becomes its own pool (habit #2) |

**Scope of work:** small. The scheduler claim-and-bump is already *almost*
atomic (`bumpScheduleAfterRun` runs before dispatch); the remaining piece is
making the "is it mine to run" decision a DB write rather than an in-process
Set. The log counter moves to the DB as part of the `runStore` migration slice.

### 2. Browser sessions decoupled from the web server

**Goal:** the Chromium/puppeteer tier can be lifted out of the API process into
its own worker pool without touching API/route code.

**Where we are today:** `browser/BrowserManager.js` already centralizes browser
lifecycle, and `services/scraper.service.js` is a thin per-user facade. The live
interactive streaming (`puppeteer-stream` + Socket.IO) lives *inside* `server.js`
and is legitimately sticky to one process.

**Scope of work:** medium, mostly *containment* now and *extraction* later.
- **Now (cheap):** keep all puppeteer access behind `BrowserManager` /
  `scraper.service` — no route or service should `require('puppeteer')`
  directly. (Audit: only the browser layer does today — keep it that way.)
- **Later:** the headless *execution* path (`workflow/WorkflowExecutor.js` +
  `executionPipeline`) becomes a queue consumer that can run on a separate
  machine. The interactive *streaming* path stays on the API tier behind sticky
  sessions. Decoupling the two is the real win and the queue (habit from the
  Tier-1 plan) is the seam.

### 3. Config via env, secrets out of code

**Goal:** every environment-specific value and secret comes from the
environment, never from source.

**Where we are today:** good. `dotenv`, `.env.example`, `JWT_SECRET`,
`LLM_API_KEY`, `DB_PATH` are all env-driven; `.env` is git-ignored.

**Scope of work:** small / ongoing.
- `JWT_SECRET` defaults to `'dev-secret-change-me'` — fine for dev, but the
  server should **refuse to boot in production** (`NODE_ENV=production`) if it's
  unset. (Tracked, not yet enforced.)
- New DB config (`DB_CLIENT`, `DATABASE_URL`) added to `.env.example` as part of
  this migration.

### 4. Everything keyed by `user_id` (+ a future `workspace_id`)

**Goal:** every tenant-owned row is scoped so that adding team workspaces later
is a column + filter change, not a data model rewrite.

**Where we are today:** every domain table already carries `user_id` and queries
filter on it. Good.

**Scope of work:** small, deferred. When workspaces land, add a nullable
`workspace_id` to `workflows`, `custom_actions`, `schedules`, `runs`,
`workflow_versions` (default = the owner's personal workspace) and widen the
ownership checks. Doing it now would be speculative; the point is the schema is
*shaped* to accept it (single owner column, consistent filtering).

---

## The Postgres migration

### Why

SQLite (`better-sqlite3`) is **synchronous** and single-writer. It's perfect for
local dev and a single-instance deploy, but concurrent writers serialize and you
can't run multiple backend processes against one file. Postgres removes both
limits and is the standard target for a small SaaS.

### Strategy: dual-backend, incremental, never-broken

We are **not** doing a big-bang rewrite. Instead:

1. **One async data-access layer** (`backend/db/client.js`) that speaks either
   SQLite or Postgres, chosen by `DB_CLIENT` (default `sqlite`). Local dev keeps
   zero-setup SQLite; production flips one env var.
2. **Portable SQL.** Our SQL uses `?` placeholders and `RETURNING id` for
   inserts — both work on modern SQLite (≥3.35, which `better-sqlite3` bundles)
   and on Postgres after a trivial `?`→`$n` translation. Schema DDL is emitted
   per-dialect (`schema.js`).
3. **A real migration runner** (`migrate.js` + `db/migrations/`) replaces the
   ad-hoc `addColumnIfMissing` calls.
4. **Slice-by-slice conversion.** The legacy synchronous `db/index.js` stays in
   place so unmigrated code keeps working; we convert one vertical slice at a
   time to the async client, verifying after each. The app is shippable at every
   commit. When the last slice lands, `db/index.js` is deleted and `schema.js`
   becomes the single source of truth.

> ⚠️ Until every slice is migrated, `DB_CLIENT=postgres` is **not** fully
> functional (unmigrated code still talks to SQLite). Keep the default
> (`sqlite`) until the checklist below is complete.

### The async contract (`db/client.js`)

```js
await db.init();                         // ensure schema + run migrations
await db.get(sql, params);               // → one row | undefined
await db.all(sql, params);               // → row[]
await db.run(sql, params);               // → { changes, lastID }   (UPDATE/DELETE)
await db.get('INSERT … RETURNING id', p) // → { id }   (uniform insert id)
await db.tx(async (t) => { … });         // transaction; t has get/all/run
db.dialect;                              // 'sqlite' | 'postgres'
```

Conventions that keep SQL portable across both engines:
- Placeholders are always `?` (translated to `$1,$2,…` for Postgres).
- Inserts that need the new id use `… RETURNING id` and `db.get(...)`.
- Timestamps default to `CURRENT_TIMESTAMP` (not SQLite's `datetime('now')`).
- Booleans are stored as `0/1` integers (portable; no dialect `BOOLEAN`).
- `undefined` binds are coerced to `null` (SQLite rejects `undefined`).

### Conversion checklist

- [x] Async dual-backend client (`db/client.js`)
- [x] Per-dialect schema (`db/schema.js`)
- [x] Migration runner + baseline migration (`db/migrate.js`, `db/migrations/`)
- [x] `pg` dependency (lazy-loaded; only required in Postgres mode)
- [x] `.env.example`: `DB_CLIENT`, `DATABASE_URL`
- [x] **Slice 1 — auth/users** (`routes/auth.routes.js` → `repositories/users.repo.js`)
- [ ] Slice 2 — workflows (`routes/workflows.routes.js`)
- [ ] Slice 3 — custom actions (`routes/customActions.routes.js`)
- [ ] Slice 4 — `runStore.service.js` (runs, logs, repairs, versions, schedules) — the hub; move `logCounters` into the DB here (habit #1)
- [ ] Slice 5 — runs/schedules routes (`routes/runs.routes.js`, `routes/schedules.routes.js`)
- [ ] Slice 6 — `executionPipeline` + `scheduler` await the now-async `runStore`; make schedule dispatch claim atomically (habit #1)
- [ ] Slice 7 — `server.js` DB calls (custom-action resolution, subflow resolution)
- [ ] Retire legacy `db/index.js`; `schema.js` becomes the single source of truth
- [ ] Add a Postgres path to CI / a compose file for local Postgres

### Running against Postgres (once migration completes)

```bash
# docker run --name scraper-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16
export DB_CLIENT=postgres
export DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres
node server.js   # db.init() creates the schema + applies migrations on boot
```
