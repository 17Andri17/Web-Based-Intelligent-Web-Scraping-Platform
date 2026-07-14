# Platform analysis — errors, upgrades, and competitive roadmap

*Scope: production-ready for a single local user first (per product decision);
scaling/multi-tenant work is explicitly out of scope here and already mapped in
[SCALING_AND_DB_MIGRATION.md](./SCALING_AND_DB_MIGRATION.md). Competitors
benchmarked: Browse AI, Octoparse.*

---

## 1. Executive summary

The platform is architecturally further along than its README suggests. The
execution pipeline (persisted runs → error classification → staged self-healing
with deterministic verification → auto-adopt policy → versioned rollback) is
genuinely competitive with — and in transparency, ahead of — what Browse AI
markets as "robots that adapt". API discovery (propose the site's own JSON API
instead of scraping the DOM) and clean-code export are differentiators neither
competitor ships.

The gaps are not in the engine; they are in the **first ten minutes of use** and
in **what happens to the data after extraction**:

1. A non-technical user is dropped into an editor with a URL bar and a step
   palette full of terms like `FOR_EACH_ELEMENTS` and "JS expression". All the
   machinery for a guided "click twice, get a table" flow already exists
   (heuristic container detection, AI field proposal, pagination detector,
   live preview) — it just isn't chained into a wizard.
2. Extracted data leads a short life: view per-run, download JSON/CSV, done.
   No dataset view across runs, no change monitoring/alerts (Browse AI's core
   product), no Sheets/Excel delivery, no email/notification on failure.
3. A handful of real bugs (one breaks code download for workflows using custom
   actions or subflows) and production-hardening items (frontend has no build
   script, hardcoded API URL, fallback JWT secret) stand between "works in dev"
   and "production-ready locally".

Everything below is ordered so section 7 can be read as the actionable roadmap.

---

## 2. What the platform already does well

Feature inventory, grouped by the competitor concept it matches:

| Capability | Status | Notes |
|---|---|---|
| Visual point-and-click builder on a live streamed browser | ✅ strong | Real Chromium pixel stream w/ input forwarding, HiDPI, selector tool, breadcrumb/ancestor picker, HTML source tree inspector |
| AI field suggestion for lists | ✅ strong | LLM proposal + live-DOM verification + heuristic fallback + "intent rescue" merging (`server.js` aiExtractListFields) — degrades gracefully with no API key |
| Pagination handling | ✅ strong | Three native containers (scroll/button/URL) + a two-phase detector (static DOM scan + empirical scroll test) with confidence scores |
| Self-healing | ✅ differentiator | Empty-result detection ("passed but captured nothing"), snapshot-verified fixes, confidence-gated auto-adopt, one-click manual adopt, full audit trail in `run_repairs` |
| Run history & versioning | ✅ strong | Every run pins an executed version; one-click rollback; logs, repairs, AI summaries |
| Scheduling | ⚠️ partial | Interval + time-of-day anchor only; no cron, no weekday selection |
| Public REST API | ✅ strong | `/v1` with API keys (hashed), idempotency, cursor pagination, rate limits, quotas, signed webhooks, consistent error shape — 61 tests green |
| Webhooks | ⚠️ partial | Dispatcher + API exist; **no UI** to register/manage them |
| Proxies | ✅ strong | Per-user proxies, pools with rotation, platform-shared pools, AES-256-GCM-encrypted passwords, WebRTC leak guard |
| Anti-bot / stealth | ✅ strong | Device profiles, UA/client-hints consistency, worker source-rewrite (fixes `hasInconsistentWorkerValues`), consent auto-dismiss with click-to-teach |
| CAPTCHA | ✅ strong | Free always-on detection; opt-in solving (CapSolver/2Captcha); solve-by-hand in the live stream |
| List → detail ("enrich") | ✅ | RUN_SUBFLOW enrich mode (docs/WORKFLOW_ENRICH.md) — matches Octoparse detail-page extraction |
| Code export | ✅ differentiator | Download standalone Puppeteer script + tailored README (competitors lock you in) |
| API discovery | ✅ differentiator | Passive XHR/fetch capture → propose the underlying JSON API → replay-verify → EXTRACT_API step. Neither competitor has this |
| Data delivery | ❌ gap | JSON/CSV download + webhook step only. No Sheets/Excel/Airtable/Zapier, no e-mail |
| Monitoring / change alerts | ❌ gap | Browse AI's flagship. Baseline machinery (prior-run medians) already exists in healing |
| Templates / prebuilt robots | ❌ gap | Both competitors lead onboarding with a template gallery |
| Bulk input (run per URL list) | ⚠️ hidden | Achievable with variables + FOR_EACH but not productized |

---

## 3. Bugs found (concrete, with locations)

### 3.1 High — code download broken for custom actions & subflows

`backend/server.js:1552-1553` (the `downloadCode` socket handler):

```js
const customActions = resolveCustomActions(steps, socket.user.id);
const subflows = resolveSubflows(steps, socket.user.id, data.workflowId || null);
```

Both resolvers are **async** (`workflow/dependencyResolver.js`) but are not
awaited — `generateCode` receives two `Promise` objects. `ctx.customActions?.[actionId]`
on a Promise is `undefined`, so the downloaded script contains
`throw new Error("Custom action … is not available (was it deleted?)")` and
subflows are silently skipped with a warning comment
(`workflowCodegen.js:742-744, 799-800`). The execute path does this correctly
(`server.js:712,741` awaits both) — only the download path is broken.

**Fix:** make the handler `async` and `await` both calls (2-line change).

### 3.2 Medium — socket listener stacking on repeated navigation

`backend/server.js:587-588`: every `navigate` event registers a **new**
`socket.on('disconnect', stopStreaming)` and `socket.on('stopStreaming', stopStreaming)`
on the same long-lived socket. A user who navigates N times in one session
accumulates N listener pairs → Node's `MaxListenersExceededWarning` at 11, and
every stale closure (holding the old CDP session object) stays reachable for
the socket's lifetime. The stale handlers also all fire on the next
`stopStreaming`, each tearing down whatever the *current* session is (the first
one wins; the rest no-op — correct today, but fragile).

**Fix:** keep one listener per connection that reads the current session from
`userSessions`, or `socket.off(...)` the previous pair before registering (the
`modeReapplyListeners` map two screens up already models this pattern).

### 3.3 Medium — `SAVE_DATA` relative paths land in (or fail in) the OS temp dir

Generated scripts run as a child process with `cwd` set to the temp directory
(`runner.service.js:53`), and `SAVE_DATA` does a plain
`fs.writeFileSync(destination)` (`workflowCodegen.js:735`) with no `mkdir`.
The UI's own placeholder suggests `./output/results.json`
(`actionDefinitions.js:1602`), which therefore throws `ENOENT` (missing
`output/` dir in the tmp cwd) — and a bare `./results.json` "succeeds" into a
directory the user will never look in. Scheduled/API runs make this worse since
there's no interactive log to notice.

**Fix:** resolve relative destinations against a per-user exports directory
(e.g. `backend/data/exports/<userId>/`), `mkdir -p` the parent, and surface the
absolute path in the run log / results UI. (Also consider allowlisting the
base directory — a workflow shouldn't be able to write to arbitrary paths on
the host once anyone but you can define workflows.)

### 3.4 Low — README known issues still open & stale

`README.md` still lists "Fix multiple context opening error" and "Fix scrolling
when ending ousid canvas", while also listing already-done items ("Create
workflow designer"). Related present-day limitation worth documenting: one live
editor page per account — opening the app in two tabs silently reroutes the
stream/bindings to the newest socket (`server.js` reconnect path).

### 3.5 Hardening notes (fine locally today, must-fix before any exposure)

- `middleware/auth.js:5` — JWT secret falls back to `'dev-secret-change-me'`.
  The server should **refuse to boot** without `JWT_SECRET` (it already has the
  fail-fast pattern for DB init at `server.js:1871-1874`).
- `frontend/src/api/client.js:3` — `API_BASE` is hardcoded to
  `http://localhost:3001`; should come from `import.meta.env.VITE_API_BASE`.
- `frontend/package.json` — **no `build` script** (only `dev`). There is
  currently no way to produce a production bundle; add `build`/`preview`, and
  ideally have Express serve the built assets so one process serves everything
  (also removes the `cors({ origin: '*' })` + socket.io `origin: '*'` wildcard).
- No rate limiting/lockout on `/api/auth/login|register`, password minimum is
  6 chars, and registration is open — on a LAN-reachable port anyone can mint
  an account. Bind to `127.0.0.1` by default and/or add an
  `ALLOW_REGISTRATION=false` flag once your own account exists.
- Data growth: `runs.results_json` and `run_logs` are kept forever with no
  retention/pruning; heavy scheduled scraping will balloon the SQLite file.
- Resource ceiling: scheduler `CONCURRENCY=3` + API worker `2` means up to 5
  concurrent headless Chromes plus the editor browser — worth a global cap
  (single env var) so a laptop doesn't thrash.

### 3.6 Verified-working (tested in this analysis)

`npm test` (22 assertions), `test:db` smoke (full CRUD + cascade), and
`test:api` (61 checks incl. auth, idempotency, quotas, rate limits, webhooks)
all pass. The pipeline/self-healing design decisions are consistently enforced
in code (e.g. auto-adopt requires high confidence + verification + no manual
flags; destructive `remove-step` heals are never auto-adopted).

---

## 4. Production-readiness checklist (local, single user)

Beyond the fixes in §3:

1. **One-command start** — `npm run build` in frontend, Express serves
   `frontend/dist`, single `npm start` (or a `Dockerfile`/`docker-compose.yml`
   with a mounted volume for `backend/data/`). Add `pm2`/systemd notes for
   auto-restart.
2. **Boot-time env validation** — hard-fail on missing `JWT_SECRET`; log
   clear one-line warnings for optional-but-recommended keys (LLM, captcha,
   proxy encryption) exactly like their runtime services already do.
3. **Retention job** — nightly prune of `run_logs` older than N days and
   `results_json` beyond the last K runs per workflow (keep the runs rows for
   history), plus tmp-script cleanup on boot for files left by a crash.
4. **Health endpoint** — `/healthz` returning DB + browser-launch status, so a
   process manager can restart on failure.
5. **CI** — a GitHub Actions workflow running the three existing suites on
   push; they are fast and already green, so this is nearly free.
6. **README rewrite** — real setup guide (env vars, first workflow, feature
   map). The current README's to-do list undersells about 30k lines of work.

---

## 5. UX analysis

### 5.1 For non-technical users — friction inventory

The core insight: **every capability a "click two items and get a table" flow
needs already exists**, but the user must know the order to invoke them.

| # | Friction | Where | Proposal |
|---|---|---|---|
| 1 | Empty-state drops user into an editor; no guidance | app shell | **Quick Scrape wizard** (§6.1) — the single highest-impact change |
| 2 | Two-mode interaction (Navigate vs Select) is invisible/unexplained | live view toolbar | First-run coach marks; hold-<kbd>Shift</kbd> to temporarily select; mode auto-suggestion when the user seems to be trying to select |
| 3 | Step vocabulary is engineer-speak: `FOR_EACH_ELEMENTS`, `EXTRACT_ATTRIBUTE`, "Condition (JS expression)" | actionDefinitions/controlDefinitions | Plain-language labels ("Loop over each product card", "Get link/image address"); keep the technical name as a subtitle |
| 4 | 11+ params ask for raw JS expressions (`IF`, `WHILE`, `SET_VARIABLE`, `TRANSFORM_DATA` custom, …) | actionDefinitions.js:712,774,1465,1519… | **No-code condition builder**: field/operator/value dropdowns compiling to the JS expression; "Edit as code" toggle preserves full power |
| 5 | CSS selectors appear as bare text inputs in step editors | many steps | Every selector field gets a "pick on page" button (the reselect flow exists — `reselectStepId` in main.jsx — extend it to all selector params) + a live match-count badge (machinery exists in previewStep) |
| 6 | No home screen: workflows/runs/schedules live behind modals | main.jsx | **Dashboard landing page** (§6.2) |
| 7 | No templates or examples to learn from | — | **Template gallery** (§6.3) |
| 8 | Failure states are informative but buried (per-workflow History modal) | RunsHistory | Surface `needs_review` counts on the dashboard + a global "attention" inbox; the AI summaries are already user-friendly — show them earlier |
| 9 | Schedule editor = minutes math | ScheduleEditor.jsx | "Every day at 9:00", weekday checkboxes; keep custom minutes as advanced |
| 10 | Results are per-run snapshots | RunsHistory data tab | **Dataset view** per workflow (§6.4) |

### 5.2 For technical users — what's missing

Power features already present (custom JS actions, subflows, variables with
`{{a[*].b}}` projections, transform pipelines, EXTRACT_API, code download,
REST API) are genuinely good. Gaps:

1. **Webhook management UI** — today only `POST /v1/webhooks` can register one.
2. **Workflow export/import/duplicate** — no JSON export, no duplicate button;
   needed for backup, sharing, and "start from a copy" iteration.
3. **Cron scheduling** — the `schedules` table is interval-based; add an
   optional `cron_expression` column and evaluate with a tiny cron parser.
4. **Run inputs in the UI** — `/v1` accepts `inputs` overriding workflow
   variables; the editor's Run button should too ("Run with inputs…").
5. **Per-workflow execution settings** — nav timeout, retry budget, healing
   on/off (some users will want deterministic runs), user-agent override.
6. **Selector debugging** — a "why did this match 0 elements?" panel showing
   the healing validators' verdicts interactively rather than only post-run.

---

## 6. Proposed feature additions (the competitive plays)

### 6.1 Quick Scrape wizard (vs Browse AI's core loop) — highest priority

One button on the empty state and toolbar: **"Scrape a list from this page"**.
Chain what already exists:

1. User enters URL → navigate (existing).
2. Auto-run container detection (`extractListHeuristics.proposeFromContainer`)
   → highlight the best repeating container, let the user click to confirm or
   pick another (list-field pick mode exists).
3. Auto-run AI field proposal (`aiExtractListFields`) → editable column list
   with live sample values (ExtractListFieldsEditor exists).
4. Auto-run `detectPagination` → one-click "also scrape the next N pages"
   using the top suggestion.
5. Land in the normal editor with a named EXTRACT_LIST (+ pagination container)
   and the Data Preview tab open.

This is ~90% orchestration of existing socket events. It converts the platform
from "powerful editor" to "Browse AI-simple with an editor underneath".

### 6.2 Dashboard home screen

Route the post-login landing to a workflow dashboard: cards/table with name,
last run status (green/amber/red), records extracted, next scheduled run,
sparkline of recent run record-counts (data already in `runs`), and buttons:
Run, Edit, History, Schedule, Duplicate, Export. Global "Needs review" inbox
across workflows. This matches the mental model both competitors train users
on, and it's where monitoring (§6.5) will live.

### 6.3 Template gallery

Ship 6–10 saved workflows as JSON seeds ("Products from a category page",
"Job listings", "News headlines", "Table from a page", "Detail-page enrich
demo") + a "start from template" flow that just loads the steps and asks for a
URL. Cheap to build once workflow export/import (§5.2.2) exists — templates
are the same JSON format.

### 6.4 Dataset view (accumulate across runs)

Per workflow, a "Data" tab that unions rows across runs with `first_seen_at` /
`last_seen_at` (dedupe key = user-chosen field, defaulting to the
EXTRACT_LIST's dedupe field which already exists in COLLECT_LIST). Export the
dataset, not just a run. This is the substrate for:

### 6.5 Monitoring & change alerts (Browse AI's flagship)

A per-workflow toggle: "Monitor for changes". After each scheduled run, diff
against the previous run (row-level add/remove/change using the dedupe key) and
(a) store the diff summary on the run row, (b) fire `run.changed` through the
existing webhook dispatcher, (c) show a change feed on the dashboard. The
baseline/median machinery in `healingStats` and `recentSuccessfulResults`
already proves the data access pattern. E-mail can come later; webhook + UI
feed first (works with ntfy/Slack/Discord via URL for a local user).

### 6.6 Data delivery integrations

Priority order for a local single user:
1. **Excel (.xlsx) export** — one dependency (`exceljs`), an extra format in
   `resultsExport.js` + the two download menus. Non-technical users live in
   Excel; CSV-with-`#`-sections is hostile to them.
2. **Google Sheets push** — OAuth or (simpler locally) service-account JSON +
   sheet ID per workflow; append rows on run completion via the webhook
   dispatcher path.
3. Zapier/Make need a public URL — defer until hosting; the signed-webhook
   surface is already the right foundation.

### 6.7 Bulk runs over an input list (Octoparse "URL list loop")

First-class "Input list" on a workflow: paste/upload CSV of URLs (or search
terms), run the workflow once per row (sequential locally), results tagged
with the input. The variables + `/v1` `inputs` plumbing already exists;
this is a UI + a loop in the pipeline caller.

### 6.8 Promote API Discovery in the UX

It's the platform's most distinctive capability and currently hides behind a
panel toggle. When discovery finds a high-confidence verified source while the
user is building a DOM scrape of the same data, show a non-blocking hint:
"This site serves this data as JSON — switch to the API for a faster, more
robust scrape (no selectors to break)". That sentence is also the marketing.

---

## 7. Prioritized roadmap

**P0 — correctness & production hygiene (days)**
1. Fix `downloadCode` missing `await` (§3.1)
2. Fix navigate listener stacking (§3.2)
3. Fix `SAVE_DATA` relative-path behavior (§3.3)
4. Frontend `build` script + env-driven `API_BASE` + Express static serving
5. Enforce `JWT_SECRET`, bind default listen address to localhost, registration flag
6. Retention/pruning job + tmp cleanup + global browser-concurrency cap
7. CI running the three existing suites; README rewrite

**P1 — the non-technical breakthrough (1–2 weeks)**
8. Quick Scrape wizard (§6.1)
9. Dashboard home + needs-review inbox (§6.2)
10. Plain-language step labels + selector "pick on page" everywhere + match-count badges
11. No-code condition builder with "edit as code" escape hatch
12. Friendly schedule picker (time-of-day / weekdays)

**P2 — competitive feature parity (2–4 weeks)**
13. Workflow export/import/duplicate → template gallery (§6.3, §5.2.2)
14. Dataset view (§6.4) → monitoring & change alerts (§6.5)
15. Excel export, then Google Sheets delivery (§6.6)
16. Webhook management UI (§5.2.1)
17. Bulk input lists (§6.7)

**P3 — power-user & differentiation polish**
18. Cron schedules; per-workflow execution settings; run-with-inputs UI
19. API-discovery nudges in the editor (§6.8)
20. Selector debugging panel; healing-history analytics ("this workflow healed 3× this month — consider re-pinning selectors")

---

## 8. Where this leaves the product vs competitors

With P0+P1 shipped, the honest pitch is: *Browse AI's simplicity for list
scraping, Octoparse's depth for workflow logic, plus three things neither has —
transparent verified self-healing, site-API discovery, and no lock-in (your
scraper exports as runnable code).* P2 closes the two real gaps (monitoring,
data delivery). Nothing in this roadmap requires the scaling work — every item
runs single-process against SQLite, and the seams the codebase already drew
(pipeline callbacks, webhook dispatcher, repos) are the right attachment
points for all of it.
