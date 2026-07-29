# Platform analysis — status, upgrades, and competitive roadmap

*Scope: production-ready for a single local user first (per product decision);
scaling/multi-tenant work is explicitly out of scope here and already mapped in
[SCALING_AND_DB_MIGRATION.md](./SCALING_AND_DB_MIGRATION.md). Competitors
benchmarked: Browse AI, Octoparse.*

*Last refreshed: 2026-07-25. This document doubles as the roadmap the project
is executing — sections are marked ✅ shipped / ⚠️ partial / ❌ open so it stays
an honest source of truth as work lands.*

---

## 1. Executive summary

The platform is architecturally well past its original README. The execution
pipeline (persisted runs → error classification → staged self-healing with
deterministic verification → auto-adopt policy → versioned rollback) is
genuinely competitive with — and in transparency, ahead of — what Browse AI
markets as "robots that adapt". API discovery (propose the site's own JSON API
instead of scraping the DOM) and clean-code export remain differentiators
neither competitor ships.

As of this refresh, the two gaps this document originally called out — **the
first ten minutes of use** and **what happens to the data after extraction** —
have largely been closed:

- The **Quick Scrape wizard**, **Dashboard home**, **no-code condition
  builder**, and **friendly schedule picker** turn the "dropped into an editor
  full of `FOR_EACH_ELEMENTS`" first-run into a guided path.
- The **cross-run Dataset view**, **Excel (.xlsx) export**, and **change
  monitoring** (row-level diff + `run.changed` webhook + change feed) give the
  extracted data a life beyond a single run — Browse AI's flagship capability.
- The original P0 correctness bugs and production-hardening items are all
  fixed (§3, §4).

The webhook management UI, cron/weekday schedules, Google Sheets delivery,
run-with-inputs, bulk input lists, and workflow export/import/duplicate have
since shipped too. What remains is a short **power-user tail** (§7 P2–P3): a
template gallery (now unblocked — the export format is the template format), a
selector-debugging panel, per-workflow execution settings, and API-discovery
nudges in the editor. None of it requires the scaling work.

---

## 2. Feature inventory

Grouped by the competitor concept it matches.

| Capability | Status | Notes |
|---|---|---|
| Visual point-and-click builder on a live streamed browser | ✅ strong | Real Chromium pixel stream w/ input forwarding, HiDPI, selector tool, breadcrumb/ancestor picker, HTML source tree inspector |
| Guided onboarding for non-technical users | ✅ shipped | **Inline first-scrape coach** (`GuidedCoach.jsx`) — spotlights the *real* controls (URL bar → Select → click → Inspector → Run) and auto-advances from live state, teaching the actual UI. Replaced the earlier floating Quick Scrape wizard, which duplicated the inspector/workflow in a weaker parallel path |
| Home dashboard | ✅ shipped | Post-login landing with per-workflow status cards, "Needs attention" inbox, and (new) change indicators (`Dashboard.jsx`) |
| AI field suggestion for lists | ✅ strong | LLM proposal + live-DOM verification + heuristic fallback + "intent rescue" merging — degrades gracefully with no API key |
| Pagination handling | ✅ strong | Three native containers (scroll/button/URL) + a two-phase detector (static DOM scan + empirical scroll test) with confidence scores |
| Self-healing | ✅ differentiator | Empty-result detection, snapshot-verified fixes, confidence-gated auto-adopt, one-click manual adopt, full audit trail in `run_repairs` |
| Run history & versioning | ✅ strong | Every run pins an executed version; one-click rollback; logs, repairs, AI summaries |
| No-code condition builder | ✅ shipped | Field/operator/value dropdowns compiling to JS, with "edit as code" preserved (`ConditionBuilder.jsx`); wired for IF / WHILE expressions |
| Scheduling | ✅ shipped | Interval + time-of-day anchor + **weekday filter + optional cron expression** (`ScheduleEditor.jsx`, migration 0006, `cron-parser`) |
| Public REST API | ✅ strong | `/v1` with API keys (hashed), idempotency, cursor pagination, rate limits, quotas, signed webhooks, consistent error shape |
| Webhooks | ✅ shipped | Dispatcher + API + three events (run.completed/failed/**changed**), **and a dashboard management UI** (`WebhooksMenu.jsx`, `/api/webhooks`) to register endpoints and pick events |
| Proxies | ✅ strong | Per-user proxies, pools with rotation, platform-shared pools, AES-256-GCM-encrypted passwords, WebRTC leak guard |
| Anti-bot / stealth | ✅ strong | Device profiles, UA/client-hints consistency, worker source-rewrite, consent auto-dismiss with click-to-teach |
| CAPTCHA | ✅ strong | Free always-on detection; opt-in solving (CapSolver/2Captcha); solve-by-hand in the live stream |
| List → detail ("enrich") | ✅ | RUN_SUBFLOW enrich mode (docs/WORKFLOW_ENRICH.md) |
| Code export | ✅ differentiator | Download standalone Puppeteer script + tailored README |
| API discovery | ✅ differentiator | Passive XHR/fetch capture → propose the underlying JSON API → replay-verify → EXTRACT_API step |
| **Cross-run dataset view** | ✅ shipped | Rows unioned + de-duplicated across a workflow's retained runs, with first/last-seen and times-seen; computed on read (`dataset.service.js`, `DatasetPanel.jsx`) |
| **Data delivery — Excel** | ✅ shipped | `.xlsx` workbook (one sheet per output list) from run results and datasets; JSON/CSV also (`resultsXlsx.js`) |
| **Monitoring / change alerts** | ✅ shipped | Per-workflow "watch for changes": row-level diff vs previous run, stored summary, `run.changed` webhook, dashboard + history change feed (`changeMonitor.service.js`, `MonitorEditor.jsx`) |
| Data delivery — Google Sheets | ✅ shipped | Per-workflow "append to a Google Sheet" on each successful run, via an instance-wide service account (`googleSheets.service.js`, `SheetDeliveryEditor.jsx`); Zapier/Make still open (need a public URL) |
| Templates / prebuilt robots | ❌ gap | Both competitors lead onboarding with a template gallery |
| Workflow export / import / duplicate | ✅ shipped | Portable JSON envelope (bundles referenced custom actions; strips per-user proxy), cross-account import that remaps custom-action ids, and same-account duplicate (`workflowPortable.js`, `WorkflowsMenu.jsx`). The prerequisite for templates is now in place |
| Bulk input (run per URL list) | ✅ shipped | "Run with inputs" (one) and "Bulk run from a list" (many) enqueue background runs per input row (`RunInputsDialog.jsx`, `POST /api/workflows/:id/bulk-run`), executed by the API worker |

---

## 3. Bugs — all fixed ✅

The concrete correctness bugs this analysis originally found have been fixed and
covered by tests. Recorded here for provenance.

### 3.1 ✅ Code download broken for custom actions & subflows

`downloadCode` passed the **unresolved Promises** from the async
`resolveCustomActions` / `resolveSubflows` into `generateCode`, so downloaded
scripts threw "custom action not available" and silently dropped subflows.
**Fixed:** the handler now awaits both (`server.js` `downloadCode`), matching
the execute path.

### 3.2 ✅ Socket listener stacking on repeated navigation

Every `navigate` re-registered `disconnect` / `stopStreaming` listeners on the
long-lived socket, leaking stale CDP-session closures and tripping Node's
`MaxListenersExceededWarning`. **Fixed:** a single `stopStreaming` listener per
connection reads the current session (`server.js`).

### 3.3 ✅ `SAVE_DATA` relative paths landed in the OS temp dir

Generated scripts ran with `cwd` in the temp dir and `SAVE_DATA` did a bare
`writeFileSync` with no `mkdir`, so `./output/results.json` threw ENOENT and a
bare filename "succeeded" somewhere invisible. **Fixed:** relative destinations
resolve against `WS_EXPORT_DIR` with `mkdirSync` (`workflowCodegen.js`,
`runner.service.js`).

### 3.4 ✅ CSV export dropped columns and mangled nested values *(found & fixed in this refresh)*

The CSV serialiser took headers from **row 0 only**, so any column absent from
the first row (the common enrich case where the first row's detail page failed)
was silently dropped from every export — the in-app download **and**
`GET /v1/runs/:id/data?format=csv`. A second, divergent copy in the frontend
stringified object cells as `[object Object]`. **Fixed:** a single header-union
serialiser ([resultsExport.js](../backend/utils/resultsExport.js)); the frontend
now shares it, with a parity test that fails the build if the two ever drift.

### 3.5 ✅ Production-hardening items

- **JWT secret** no longer falls back to `'dev-secret-change-me'` — resolves
  from `JWT_SECRET` or generates a persisted one (`middleware/auth.js`).
- **Frontend `API_BASE`** is env-driven (`VITE_API_BASE`), relative in prod
  (`api/client.js`); frontend has `build` / `preview` scripts and Express serves
  the built assets from the same origin.
- **Retention** — `maintenance.service.js` prunes old run logs and caps results
  per workflow.
- **Health endpoint** — `/healthz` (`app.js`).
- **Browser concurrency cap** — `WS_MAX_CONCURRENT_RUNS` (`runner.service.js`).
- **CI** — GitHub Actions runs the unit, DB, API, and frontend-build jobs on
  every push.

---

## 4. Production-readiness checklist (local, single user) — ✅ complete

1. ✅ **One-command start** — frontend `build`, Express serves `frontend/dist`
   from the same origin.
2. ✅ **Boot-time env** — hard-fail on missing DB; clear warnings for optional
   keys (LLM, captcha, proxy encryption).
3. ✅ **Retention job** — `maintenance.service.js`.
4. ✅ **Health endpoint** — `/healthz`.
5. ✅ **CI** — all suites green on push.
6. ✅ **README** — real setup guide and feature map.

Remaining nice-to-have: a `Dockerfile` / `docker-compose.yml` with a mounted
volume for `backend/data/` and pm2/systemd notes (documented, not yet shipped).

---

## 5. UX status

### 5.1 Non-technical users — friction, mostly resolved

| # | Original friction | Status |
|---|---|---|
| 1 | Empty-state drops user into an editor | ✅ Quick Scrape wizard + Dashboard |
| 2 | Navigate vs Select mode invisible | ✅ the inline coach spotlights the mode toggle and can switch it for the user |
| 3 | Engineer-speak step names (`FOR_EACH_ELEMENTS`) | ⚠️ control descriptions added; JS-expression field labels softened with help text; a full step-name pass is still open |
| 4 | Raw JS expression fields | ✅ Condition builder for IF/WHILE + friendlier labels/help; ⚠️ SET_VARIABLE / TRANSFORM custom still raw |
| 5 | Bare selector text inputs | ✅ "Pick on page" now on every single-element selector field (generalized reselect); match-count badge on the primary selector |
| 6 | No home screen | ✅ Dashboard landing |
| 7 | No templates | ❌ still open (§6.3) |
| 8 | Failures buried | ✅ Needs-attention inbox + AI summaries on the dashboard |
| 9 | Schedule = minutes math | ✅ presets + "start at" time; ⚠️ no weekdays |
| 10 | Results are per-run snapshots | ✅ Dataset view + change monitoring |

### 5.2 Technical users — what's still missing

Power features present and good: custom JS actions, subflows, `{{a[*].b}}`
projections, transform pipelines, EXTRACT_API, code download, full REST API,
cross-run datasets, change-diff webhooks. Gaps:

1. ✅ **Webhook management UI** — `WebhooksMenu.jsx` + `/api/webhooks` register
   endpoints and pick events (incl. run.changed) from the dashboard.
2. ✅ **Workflow export / import / duplicate** — portable JSON export/import
   (with custom-action bundling + id remap) and same-account duplicate.
3. ✅ **Cron / weekday scheduling** — weekday checkboxes + optional cron.
4. ✅ **Run-with-inputs in the editor** — a caret next to Run opens a dialog to
   run a saved, parameterized workflow with specific values (single or bulk).
5. ❌ **Per-workflow execution settings** — nav timeout, retry budget, healing
   on/off (deterministic runs), UA override.
6. ✅ **Selector debugging** — an interactive "why did this match 0 elements?"
   panel: tests a CSS/XPath selector against the live page and returns a
   plain-language verdict (ok / hidden / iframe / partial / none), a sample of
   matches, and — via progressive relaxation — which part of the selector is the
   culprit (`SelectorDebugger.jsx`, `selectorDebug.js`, `debugSelector` socket).

---

## 6. Feature additions

### 6.1 ✅ Guided first-scrape coach — shipped (replaced the Quick Scrape wizard)
The original Quick Scrape wizard was a floating panel that re-implemented
navigate + selection + field detection + pagination in a weaker parallel path
and overlapped the sidebar. It was replaced by an **inline coach**
(`GuidedCoach.jsx`) that docks over the canvas and spotlights the *real*
controls in sequence (URL bar → Select toggle → click an item → Inspector →
Run → Data), auto-advancing as the user acts and offering a "do it for me"
button per step. It teaches the actual UI, so the second scrape needs no guide.

### 6.2 ✅ Dashboard home — shipped
Post-login landing: per-workflow cards with last-run status, needs-attention
inbox, schedule/next-run, and change indicators. `Dashboard.jsx`.

### 6.3 ❌ Template gallery — open (now unblocked)
Ship 6–10 saved workflows as JSON seeds + a "start from template" flow. The
workflow export/import format (§5.2.2, now shipped) IS the template format — a
template is just a bundled export, imported on demand — so this is now mostly a
gallery UI + a handful of seed `.workflow.json` files.

### 6.4 ✅ Dataset view — shipped
Per-workflow "Data across runs": rows unioned and de-duplicated across retained
successful runs, with first/last-seen and times-seen, exportable as CSV/Excel.
Computed on read, so it works retroactively with no new storage.
`dataset.service.js`, `DatasetPanel.jsx`.

### 6.5 ✅ Monitoring & change alerts — shipped
Per-workflow "Watch for changes": after each successful run, diff against the
previous run (row-level add/remove/change, keyed the same way the dataset view
dedupes), store the summary on the run, and fire `run.changed` through the
webhook dispatcher when something changed. Change feed on the dashboard, in run
history, and in the monitor editor. `changeDiff.service.js`,
`changeMonitor.service.js`, `MonitorEditor.jsx`. E-mail delivery is still
future; webhook (ntfy/Slack/Discord via URL) + UI feed ship today.

### 6.6 Data delivery integrations
1. ✅ **Excel (.xlsx) export** — shipped (`resultsXlsx.js`), one sheet per output
   list, wired into run results and dataset downloads.
2. ✅ **Google Sheets push** — shipped. Per-workflow config appends each
   successful run's chosen list to a sheet (header row written when empty, rows
   aligned to existing columns thereafter). Auth is an instance-wide service
   account (`GOOGLE_SERVICE_ACCOUNT_JSON`); the user shares the sheet with its
   e-mail. Fire-and-forget from the pipeline finish path, like change
   monitoring. `googleSheets.service.js`, `sheetsDelivery.service.js`,
   `SheetDeliveryEditor.jsx`. No `googleapis` dependency — the OAuth JWT flow
   uses the existing `jsonwebtoken` + `node-fetch`.
3. ❌ Zapier/Make — need a public URL; defer until hosting.

### 6.7 ✅ Bulk runs over an input list — shipped
"Run with inputs" (one) and "Bulk run from a list" (many) live behind a caret
next to the editor's Run button. A pasted list (one value per line) or a CSV
whose header names the workflow's variables becomes one input row per line;
each enqueues a background run (`createQueuedRun`, trigger `bulk`) that the API
worker executes headless — so self-healing, monitoring, sheets delivery and
webhooks all apply, and each run's inputs are stored and shown in history.
`RunInputsDialog.jsx`, `utils/bulkInputs.js`, `POST /api/workflows/:id/bulk-run`,
shared validator `utils/workflowInputs.js` (also used by `/v1`).

### 6.8 ❌ Promote API Discovery in the UX — open
When discovery finds a high-confidence verified source while the user builds a
DOM scrape of the same data, show a non-blocking "this site serves this as JSON
— switch for a faster, sturdier scrape" hint.

---

## 7. Prioritized roadmap

**P0 — correctness & production hygiene — ✅ done**
1. ✅ `downloadCode` await (§3.1)
2. ✅ navigate listener stacking (§3.2)
3. ✅ `SAVE_DATA` relative-path behavior (§3.3)
4. ✅ CSV header-union + shared serialiser (§3.4)
5. ✅ frontend `build` + env-driven `API_BASE` + same-origin static serving
6. ✅ `JWT_SECRET` enforcement, localhost default, registration flag
7. ✅ retention/pruning + browser-concurrency cap + `/healthz`
8. ✅ CI running all suites; README rewrite

**P1 — the non-technical breakthrough — ✅ done**
9. ✅ Quick Scrape wizard (§6.1)
10. ✅ Dashboard home + needs-review inbox (§6.2)
11. ✅ No-code condition builder with "edit as code"
12. ✅ Friendly schedule picker (time-of-day)
13. ⚠️ selector "pick on page" everywhere ✅ + JS-expression labels softened ✅;
    a full plain-language step-name pass is still open

**P2 — competitive feature parity — mostly done**
14. ✅ Dataset view (§6.4)
15. ✅ Monitoring & change alerts (§6.5)
16. ✅ Excel export (§6.6.1)
17. ✅ Workflow export/import/duplicate (§5.2.2); ❌ template gallery (§6.3, now unblocked)
18. ✅ Webhook management UI (§5.2.1)
19. ✅ Google Sheets delivery (§6.6.2)
20. ✅ Bulk input lists (§6.7)

**P3 — power-user & differentiation polish — partly done**
21. ✅ Cron / weekday schedules; ✅ run-with-inputs UI; ❌ per-workflow execution settings
22. ❌ API-discovery nudges in the editor (§6.8)
23. ✅ Selector debugging panel; ❌ healing-history analytics

---

## 8. Where this leaves the product vs competitors

With P0+P1 and most of P2 shipped, the honest pitch is now real: *Browse AI's
simplicity for list scraping (guided wizard, dashboard, monitoring & change
alerts), Octoparse's depth for workflow logic, plus three things neither has —
transparent verified self-healing, site-API discovery, and no lock-in (your
scraper exports as runnable code).* The remaining P2 items (templates via
workflow export/import, Google Sheets delivery, webhook UI, bulk inputs) are
breadth, not foundations — every one runs single-process against SQLite, and
the seams the codebase already drew (pipeline callbacks, webhook dispatcher,
repos, the dataset/diff services) are the attachment points for all of it.
