# Deployment

How to put this platform on the public internet. The primary path documented
here is a **Cloudflare Tunnel from the machine you already develop on** — the
fastest way to a working `https://` URL, and the right choice for a v1 test
instance. A sketch of the eventual VPS migration is at the end.

---

## What this deployment is

One Node process serves everything. When `frontend/dist` exists, the backend
serves the built React UI from the **same origin** as the API
([backend/app.js](../backend/app.js)), so there is no CORS setup, no second
server, and no API URL to configure — the frontend just uses relative paths.

```
visitor's browser
   │  https://scraper.example.xyz
   ▼
Cloudflare edge
   │  (tunnel — no inbound port on your router)
   ▼
cloudflared  ──►  127.0.0.1:3001   Express + Socket.IO
                                     ├── editor Chrome  (one shared process)
                                     └── run Chrome × N (one per workflow run)
```

The tunnel is an **outbound** connection from your machine to Cloudflare. No
port is forwarded, no firewall rule is added, and your home IP is never
published. This is the main security advantage over exposing a port directly.

**What it is not:** a durable production deployment. The site is down whenever
this machine sleeps, reboots, or loses its network. Move to a VPS before
anyone depends on it.

---

## Prerequisites

| | |
|---|---|
| Node.js | 20+ (tested on 22) |
| Chrome/Chromium | Auto-detected; override with `CHROME_PATH` |
| cloudflared | `winget install --id Cloudflare.cloudflared` |
| Cloudflare account | Free — only needed for a named tunnel (§ 4B) |
| Domain | Only for § 4B. Any registrar; nameservers must move to Cloudflare |

---

## 1. Configuration

Everything lives in `backend/.env` (see
[backend/.env.example](../backend/.env.example) for the annotated full list).
These are the ones that matter specifically for a **publicly reachable**
instance:

| Variable | Set to | Why it matters in public |
|---|---|---|
| `ALLOW_REGISTRATION` | **`false`** | **The critical one.** Defaults to `true`. An account here is not just a login — it can drive a real Chrome to any URL, schedule unattended jobs, and consume your bandwidth and IP reputation. Close it before the URL exists. |
| `JWT_SECRET` | a long random string | Without it a random secret is generated and persisted to `backend/data/.jwt-secret`, which works — but setting it explicitly means logins survive even if that directory is cleared. |
| `HOST` | **leave unset** | Defaults to `127.0.0.1`, which is exactly right here: `cloudflared` connects over loopback, so the app should refuse every other interface. Only set `0.0.0.0` when running behind a reverse proxy on a server. |
| `PUBLIC_APP_URL` | `https://your-domain` | Only used to put a working link in alert e-mails. Omitted from the mail when unset — it never points at `localhost` by accident. |
| `PROXY_ENCRYPTION_KEY` | 32 random bytes | Required before any proxy with a password can be saved. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `WS_MAX_CONCURRENT_RUNS` | `3` (default) | Each concurrent run launches its own Chrome. Lower it if the machine gets starved while you're using it. |
| `DB_CLIENT` | `sqlite` (default) | Keep it. The Postgres migration is incremental — see [SCALING_AND_DB_MIGRATION.md](SCALING_AND_DB_MIGRATION.md). |

Registration is read per request, but changing `.env` requires a restart to
take effect.

---

## 2. Build the frontend

```bash
cd frontend && npm run build
```

This emits `frontend/dist`, which is **git-ignored** — it is a build artifact,
not source. The backend checks for `frontend/dist/index.html` at startup:

- **present** → serves the React UI at `/`
- **absent** → serves the string `Scraper API running`

If your public URL shows that plain-text string, this step is the reason.

> **Rebuild after every frontend change.** A stale `dist` is served silently
> against a newer backend, which surfaces as inexplicable UI bugs.

---

## 3. Start the backend and verify locally

```bash
cd backend && node server.js
```

Check `http://127.0.0.1:3001` — you should get the **UI**, not the API stub.
`http://127.0.0.1:3001/healthz` returns `{"status":"ok","db":true,...}` and is
the endpoint to watch if you later add uptime monitoring.

Log in with your existing account now, while it's still local. If registration
is already closed and you have no account, temporarily set
`ALLOW_REGISTRATION=true`, restart, register, set it back to `false`, restart.
Do that **before** the tunnel exists, never after.

> ⚠️ **Tunnel port 3001, never the Vite dev server on 5173.** In dev mode the
> frontend hardcodes `http://localhost:3001` as its API origin
> ([client.js](../frontend/src/api/client.js)) — which resolves to the
> *visitor's* machine, so every API call fails for everyone but you. The
> single-origin production build has no such problem.

---

## 4. Expose it

### A. Quick tunnel — throwaway URL, no account

```bash
cloudflared tunnel --url http://localhost:3001
```

Prints a `https://<random-words>.trycloudflare.com` URL immediately. No login,
no domain, no config. The URL changes on every restart and the tunnel dies with
the terminal — this is for proving the setup works, not for keeping.

**Test it properly:** open the URL on your phone (not just another tab), log
in, and start a live browser preview. The preview is the real test — it proves
WebSockets are surviving the tunnel, which nothing else exercises.

### B. Named tunnel — your own domain, persistent

First move the domain's nameservers to Cloudflare (add the site in the
dashboard; the registrar side takes minutes to hours to propagate).

```bash
cloudflared tunnel login
```

Opens a browser to authorize and writes a certificate to
`%USERPROFILE%\.cloudflared\cert.pem`.

```bash
cloudflared tunnel create scraper-v1
```

Creates the tunnel and writes its credentials to
`%USERPROFILE%\.cloudflared\<TUNNEL-UUID>.json`. **Note the UUID it prints** —
it's the credentials filename you need next.

```bash
cloudflared tunnel route dns scraper-v1 scraper.example.xyz
```

Creates the proxied DNS record pointing the hostname at the tunnel.

Now copy [cloudflared-config.example.yml](cloudflared-config.example.yml) to
`%USERPROFILE%\.cloudflared\config.yml` and fill in the tunnel name, the
credentials path (with the UUID from above), and your hostname. Validate it:

```bash
cloudflared tunnel ingress validate
```

Then run it:

```bash
cloudflared tunnel run scraper-v1
```

Certificates for the hostname are issued by Cloudflare automatically — there is
nothing to configure and nothing to renew.

---

## 5. Survive reboots

Two processes must come back on their own: `cloudflared` **and** the backend.
Installing only the tunnel as a service is a common mistake — you get a working
public hostname pointing at nothing, which reads as a 502.

**cloudflared**

```bash
cloudflared service install
```

The service runs as `LocalSystem`, whose profile directory is *not* yours, so
copy the config and credentials where it will find them:

```bash
mkdir "C:\Windows\System32\config\systemprofile\.cloudflared"
copy "%USERPROFILE%\.cloudflared\config.yml" "C:\Windows\System32\config\systemprofile\.cloudflared\"
copy "%USERPROFILE%\.cloudflared\<TUNNEL-UUID>.json" "C:\Windows\System32\config\systemprofile\.cloudflared\"
```

Then `Restart-Service cloudflared` and confirm with `cloudflared tunnel info
scraper-v1` that a connector is registered.

*(Alternative: a dashboard-managed tunnel supports `cloudflared service install
<TOKEN>`, which needs no `config.yml` at all. Use that if you'd rather manage
ingress in the Cloudflare UI than in a file.)*

**The backend** — simplest is Task Scheduler: create a task that runs
`node server.js` in `backend/`, triggered *At startup*, set to "Run whether user
is logged on or not". Verify by actually rebooting; a task that silently fails
to start is the failure mode here.

---

## 6. Keep the machine awake

The site is down whenever this PC sleeps. Disable sleep (the display can still
sleep):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

---

## Security posture

What's reachable once the URL is public: the login endpoint, the static UI, the
`/v1` API surface (API-key authed, rate-limited, quota'd), and `/healthz`.
Registration is closed, so there is no way to mint a new account.

Worth understanding, because the risk profile differs from a disposable server:

- **Chrome runs with `--no-sandbox` and `--disable-web-security`**
  ([stealthCore.js](../backend/browser/stealthCore.js)) — normal for scraping,
  but it removes the wall between a hostile page and the OS. On a VPS the blast
  radius is a €4 machine; here it's your personal computer. Only visit pages you
  chose to visit, and keep registration closed.
- **No rate limiting on login.** With registration closed the surface is a
  single known username, so make that password long.
- **CORS is open** (`cors()` in [app.js](../backend/app.js), Socket.IO
  `origin: '*'`). Not a CSRF path, because auth tokens live in `localStorage`
  and travel as `Authorization` headers rather than cookies — another origin's
  JavaScript can't read them. Worth pinning to your hostname anyway when
  convenient.
- **Scrape responsibly.** Traffic exits from your home IP. Respect target
  sites' terms and `robots.txt`.

---

## Backups

Everything durable is in `backend/data/`: `app.sqlite` (all workflows, runs,
users), `.jwt-secret`, and `exports/`. It is git-ignored, so it exists in
exactly one place.

SQLite runs in WAL mode, so copying `app.sqlite` alone while the server is
running can capture a torn state. **Stop the backend, copy the whole directory,
start it again** — or use `sqlite3 app.sqlite ".backup backup.sqlite"`, which is
safe against a live database.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Public URL shows `Scraper API running` | `frontend/dist` missing | `cd frontend && npm run build`, restart |
| UI looks outdated / new features missing | Stale `dist` | Rebuild — it doesn't rebuild itself |
| Site works for you, all API calls fail for others | Tunnelling Vite (5173) instead of the built app (3001) | Point the tunnel at 3001 |
| Login works, live preview never appears | WebSocket not negotiated end-to-end | Socket.IO is websocket-only with no polling fallback; check the `originRequest` block in `config.yml` |
| Preview freezes after an idle period | Keepalives shorter than the idle stream | Raise `keepAliveTimeout` / `tcpKeepAlive` |
| Every workflow run fails instantly | Chrome not found by the spawned run script | Generated scripts read `CHROME_PATH` with a Windows-only fallback ([workflowCodegen.js](../backend/workflow/workflowCodegen.js)) — set `CHROME_PATH` on any non-Windows host |
| Machine slows to a crawl during runs | Too many concurrent Chromes | Lower `WS_MAX_CONCURRENT_RUNS`; `EDITOR_DEVICE_SCALE=1` also halves screencast cost |
| Site dies overnight | PC slept | § 6 |
| 502 after reboot | Tunnel service up, backend not | § 5 — both need to auto-start |
| Strangers appear in the user list | `ALLOW_REGISTRATION` not `false` | § 1, then restart |

---

## Later: moving to a VPS

When the tunnel's "my PC must be awake" constraint stops being acceptable, the
app itself needs no changes — only packaging. What differs:

- **Sizing is RAM-bound**, not CPU-bound: one editor Chrome plus up to
  `WS_MAX_CONCURRENT_RUNS` run Chromes. 2 GB is the floor, 4 GB is comfortable.
  A Hetzner CX22 (2 vCPU / 4 GB / 40 GB, ~€4/mo) fits well.
- **`HOST=0.0.0.0`** so the app is reachable from the reverse proxy — with its
  port unpublished to the host, so only the proxy is exposed.
- **`CHROME_PATH` becomes mandatory**, because the generated run scripts have
  only a Windows fallback path.
- **A reverse proxy for TLS** — Caddy needs three lines and handles Let's
  Encrypt and WebSocket upgrades automatically.
- **`backend/data` on a mounted volume**, or every redeploy starts from an empty
  database.
- **Egress matters.** The screencast streams JPEG frames continuously; prefer a
  host with generous included traffic over one that meters it.
