# Intelligent Web Scraping Platform

A web-based, visual web-scraping platform with automated workflow generation and
adaptive (self-healing) data extraction. You build a scraper by pointing and
clicking on a **live streamed browser**, the platform proposes the fields to
extract with AI, and when a site's markup drifts it repairs the workflow
automatically — with every fix verified and auditable.

It aims to combine the simplicity of Browse AI, the workflow depth of Octoparse,
and two things neither offers: **transparent, verified self-healing** and
**site-API discovery** (using a site's own JSON API instead of scraping the DOM
when one exists). Scrapers can also be exported as a standalone, runnable
Puppeteer script — no lock-in.

> Status: designed to run **locally for a single user** today. Multi-tenant
> scaling is deliberately out of scope for now — see
> [docs/SCALING_AND_DB_MIGRATION.md](docs/SCALING_AND_DB_MIGRATION.md).

---

## Quick start

Requirements: Node.js 20+, and a Chrome/Chromium install (the app auto-detects
common locations; override with `CHROME_PATH`).

### Development (two processes, hot reload)

```bash
# 1. Backend (API + live-browser streaming)
cd backend
npm install
node server.js        # http://127.0.0.1:3001

# 2. Frontend (Vite dev server) — in a second terminal
cd frontend
npm install
npm run dev           # http://localhost:5173
```

Open the Vite URL, register an account, and build your first workflow.

### Production (single process, local)

```bash
cd frontend && npm install && npm run build   # emits frontend/dist
cd ../backend && npm install && node server.js
```

When `frontend/dist` exists the backend serves the built UI from the **same
origin**, so everything is available at `http://127.0.0.1:3001`. Put it behind a
process manager (pm2/systemd) for auto-restart, and back up `backend/data/`.

---

## Configuration

All configuration is via environment variables (copy `backend/.env.example` to
`backend/.env`). Everything has a sensible default; nothing is required to start.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` to expose on the LAN (only after securing auth). |
| `JWT_SECRET` | auto-generated | Token signing secret. If unset, a random one is generated and persisted to `backend/data/.jwt-secret`. |
| `ALLOW_REGISTRATION` | `true` | Set `false` to close signups once your account exists. |
| `DB_CLIENT` | `sqlite` | `sqlite` (local file) or `postgres`. |
| `DATABASE_URL` | — | Postgres connection string (when `DB_CLIENT=postgres`). |
| `WS_MAX_CONCURRENT_RUNS` | `3` | Global cap on concurrent headless-Chrome workflow runs. |
| `WS_EXPORT_DIR` | `backend/data/exports` | Where `Save Data` writes relative file paths. |
| `RUN_LOG_RETENTION_DAYS` | `30` | Prune run logs older than this (0 disables). |
| `RUN_RESULTS_RETENTION_COUNT` | `100` | Keep results JSON for the newest N runs per workflow (0 disables). |
| `GROQ_API_KEY` / `LLM_API_KEY` | — | Enables AI field suggestion and self-healing (free tier: console.groq.com). |
| `PROXY_ENCRYPTION_KEY` | — | Required to store proxy passwords (AES-256-GCM at rest). |
| `CAPTCHA_PROVIDER` / `CAPTCHA_API_KEY` | — | Optional auto-solving; detection is always on and free. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | Enables e-mail alerts for failed runs and change monitoring. Without it those alerts are webhook-only. Each user sets their own address in-app. |
| `MAIL_FROM` | `WebScraper <SMTP_USER>` | From address on alert e-mails. |
| `PUBLIC_APP_URL` | — | Public URL of this instance, used only to link back from alert e-mails. Omitted from the mail when unset. |

See `backend/.env.example` for the full annotated list (LLM model fallback,
webhook/rate-limit tuning, etc.).

---

## What it does

- **Visual builder on a live browser** — a real Chromium stream with input
  forwarding; click elements to build selectors, inspect the DOM, pick
  ancestors/children via breadcrumbs.
- **AI field suggestion** — proposes list/table columns from a sample, verifies
  every selector against the live DOM, and falls back to heuristics with no API
  key.
- **Pagination** — native scroll / next-button / URL-parameter strategies with
  an auto-detector.
- **Self-healing** — detects "ran fine but captured nothing", proposes a fix,
  **verifies it against a page snapshot**, re-runs to confirm, and only
  auto-adopts high-confidence verified fixes (everything else is a one-click
  proposal). Full audit trail per run.
- **Run history & versioning** — every run pins the exact workflow version;
  one-click rollback.
- **Scheduling** — interval + optional time-of-day anchor.
- **Proxies** — per-user proxies and rotating pools, encrypted credentials,
  WebRTC-leak guard.
- **CAPTCHA & anti-bot** — device-profile stealth, consent auto-dismiss, free
  CAPTCHA detection, optional auto-solving.
- **API discovery** — passively captures a page's XHR/fetch traffic and proposes
  the underlying JSON API as a faster, sturdier alternative to DOM scraping.
- **Public REST API** (`/v1`) — trigger workflows and fetch data programmatically
  with API keys, idempotency, webhooks, rate limits, and quotas. See
  [docs/API_REFERENCE.md](docs/API_REFERENCE.md).
- **Code export** — download any workflow as a standalone Puppeteer script plus
  a tailored README.

---

## Testing

```bash
cd backend
npm test          # pure/unit (healing classifiers, validators, codegen)
npm run test:db   # SQLite schema + repository smoke test
npm run test:api  # public /v1 API (auth, idempotency, quotas, webhooks)
```

CI (`.github/workflows/ci.yml`) runs all three on every push, plus a frontend
production build.

---

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — putting the platform on the public
  internet (Cloudflare Tunnel today, VPS later).
- [docs/PLATFORM_ANALYSIS.md](docs/PLATFORM_ANALYSIS.md) — architecture review,
  bug/UX analysis, and the competitive roadmap this project is executing.
- [docs/API_ARCHITECTURE.md](docs/API_ARCHITECTURE.md) /
  [docs/API_REFERENCE.md](docs/API_REFERENCE.md) — the public REST API.
- [docs/API_DISCOVERY.md](docs/API_DISCOVERY.md) — using a site's own API.
- [docs/WORKFLOW_ENRICH.md](docs/WORKFLOW_ENRICH.md) — list → detail-page enrichment.
- [docs/SCROLLING_AND_LISTS.md](docs/SCROLLING_AND_LISTS.md),
  [docs/CAPTCHA_HANDLING.md](docs/CAPTCHA_HANDLING.md),
  [docs/SCALING_AND_DB_MIGRATION.md](docs/SCALING_AND_DB_MIGRATION.md).

---

## Project layout

```
backend/        Express API, Socket.IO streaming, workflow codegen + runner,
                self-healing pipeline, SQLite/Postgres data layer
frontend/       React + Vite visual editor
docs/           Architecture and feature documentation
evaluation/     Benchmark HTML fixtures for extraction/healing
```

Scrape responsibly — respect target sites' terms of service and `robots.txt`,
and only collect data you're allowed to access.
