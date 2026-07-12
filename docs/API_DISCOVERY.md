# API Discovery — analyze network calls, propose the data API

Most modern sites are thin frontends over a JSON backend: the page you see is
rendered from XHR/`fetch`/GraphQL calls the browser makes to the site's own API.
When that's true, calling the API directly beats scraping the rendered DOM on
every axis — it's faster, paginates cleanly, returns structured data, and is
immune to the CSS/DOM churn (and much of the anti-bot friction) that selector
scraping has to fight.

**API Discovery** watches those calls while the user browses a page in the live
editor and proposes the underlying data endpoint. The rule of thumb: _if the
data can be obtained more optimally than reading it off the page, at least point
out that the API exists — and, where possible, prove it works._

This is a **detect-only** feature today (it surfaces endpoints and ready-to-use
`fetch`/cURL snippets). Turning a discovered endpoint into a first-class
`EXTRACT_API` workflow step is the planned fast-follow (see _Roadmap_).

## Design principles

| Principle | Why |
|---|---|
| **Heuristics decide, AI only enriches** | Which endpoint is the data source is decided deterministically (value matching + structure scoring). No LLM is in that path. AI is reserved for later enrichment (field naming, plain-English summaries) and never gets a vote on correctness. |
| **Passive capture, never interception** | We only *listen* to the CDP `Network` domain. We never pause or rewrite a request — that would change timing and raise the page's detection surface. |
| **Prove it, don't just guess** | A discovered endpoint is replayed and its response diffed against the data the page showed. Verification turns a guess into a fact and empirically answers the auth question. |
| **Reuse the session we already have** | The platform already runs an authenticated, stealth browser (with proxies/login). For cookie-gated APIs, "authorization by simple login" is solved by replaying that session's cookies. |

## Pipeline

```
 navigate ──▶ networkCapture ──▶ apiDiscovery.analyze ──▶ apiReplay.verifyMany ──▶ panel
 (CDP Network)   (ring buffer)    (filter/match/auth/score)   (prove + auth tier)
```

1. **Capture** — `browser/networkCapture.js` opens a dedicated CDP session on
   the page target, enables the `Network` domain, and keeps a bounded per-user
   ring buffer of finalized XHR/fetch records (method, URL, request headers incl.
   the real Cookie/Authorization from `*ExtraInfo` events, and JSON response
   bodies under a size cap). Attached on `navigate`, cleared per navigation,
   detached on disconnect.

2. **Analyze** — `services/apiDiscovery.service.js` (pure heuristics):
   - **Filter** out non-2xx, non-JSON, and known analytics/ad/telemetry beacons.
   - **Group** records by logical endpoint (`method + origin + path`) so
     pagination calls collapse into one candidate with an occurrence count.
   - **Match** each response body against the values the user is scraping
     (`sampleValues`). Raw + digits-only matching catches prices/counts. A
     response that contains the scraped values *is* the source — strongest
     signal. With no selection yet, fall back to **data-richness** scoring
     (arrays of objects, item counts, field diversity).
   - **Classify auth** from the merged request headers + query:
     `open` → `session` → `bearer` → `signed` (least usable).
   - **Score** confidence from match fraction, richness, auth tier, and reuse.

3. **Verify** — `services/apiReplay.service.js` replays the top candidates
   (bounded concurrency, time-boxed, SSRF-guarded to public http(s) only):
   - **Probe A** strips all credentials. Success ⇒ `open-verified` (truly open,
     regardless of what headers the browser attached).
   - **Probe B** replays with the browser's session cookies + captured auth.
     Success ⇒ `verified` (needs the logged-in session we already have).
   - Otherwise `blocked` (WAF/anti-bot or signed) / `unverified` (network error).

4. **Propose** — `components/ApiSourcesPanel.jsx` renders ranked cards with a
   confidence bar, an **auth-tier badge**, a **verification badge**, the returned
   fields, detected pagination params, and copy-ready `fetch()` / cURL snippets.

## Authorization tiers

| Tier | Signal | What the platform can do |
|---|---|---|
| **Open** | No auth header, no auth query, works stripped | Use directly. Best case; confirmed by Probe A. |
| **Session** | Request rode the browser's cookies | Replay the authenticated browser's cookies. This is the "simple login" case — the session already exists. |
| **Bearer / API key** | Token in a header or query param | Replayable within the session; flagged as possibly short-lived. |
| **Signed (HMAC)** | `x-signature` / `hmac` / signed query, regenerated per request in-browser | Reported honestly as detected-but-not-replayable. Not proposed as usable. |

## Files

| File | Role |
|---|---|
| `backend/browser/networkCapture.js` | Passive CDP `Network` capture, per-user ring buffer. |
| `backend/services/apiDiscovery.service.js` | Heuristic filter / match / auth-classify / score. No LLM. |
| `backend/services/apiReplay.service.js` | Two-probe replay verification + SSRF guard. |
| `backend/server.js` | `analyzeApiSources` / `clearApiCapture` socket handlers; attaches capture on `navigate`. |
| `frontend/src/components/ApiSourcesPanel.jsx` | Read-only "API Sources" panel. |

## Socket contract

- **Client → server** `analyzeApiSources` `{ sampleValues?: string[], verify?: boolean }`
- **Server → client** `apiSourcesDetected` `{ sources, capturedCount, consideredCount, error? }`

Each `source`: `{ method, url, origin, path, authTier, authSignals, confidence,
matchedValues, totalSampleValues, recordShape{kind,itemCount,fields},
queryParams[{name,value,role}], occurrences, summary, curl, fetchSnippet,
verification }`.

## Caveats

- **Undocumented = unstable.** Private endpoints can change without notice.
  Verification-on-run partially mitigates this and dovetails with self-healing.
- **Terms of service.** Using a site's private API may fall under its ToS even
  where DOM scraping is tolerated. The panel surfaces this.
- **Not universal.** Server-rendered pages (no XHR) and signed-request APIs
  won't yield a usable endpoint — the panel says so rather than force a bad
  suggestion.
- **Replay vs. WAF.** A server-side replay may trip protection the stealth
  browser slipped past; such candidates come back `blocked`.

## Roadmap

- **`EXTRACT_API` step type** — turn a discovered endpoint into a workflow step
  (method, URL template, headers, auth mode, response JSON path → fields) that
  `workflowCodegen.js` emits as a `fetch()` loop, paginating via the detected
  param. This replaces a browser run with a handful of HTTP calls.
- **AI enrichment** (`apiDiscoveryAI.service.js`) — friendly field names, a
  one-line endpoint summary, and tie-breaking when heuristics are ambiguous.
  Built on `llm.service.safeChat`, degrading gracefully when unconfigured.
