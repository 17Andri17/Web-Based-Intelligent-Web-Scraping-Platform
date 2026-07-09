# CAPTCHA Handling

How the platform deals with CAPTCHAs / anti-bot challenges — both **while you
build a scraper** (the live editor) and **while a scraper runs** (generated
scripts / scheduled + API runs). The design is deliberately **free by default**
with a **cheap, opt-in paid path** you can switch on later without changing any
workflows.

---

## TL;DR — your options and what they cost

| Layer | What it does | Cost |
|-------|--------------|------|
| **1. Avoidance** | Stealth fingerprints + proxies stop most CAPTCHAs from ever appearing | Free (already built) — proxies extra if you use paid ones |
| **2. Detection** | Recognise reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, Cloudflare "Just a moment", image CAPTCHAs; read the sitekey | **Free, always on** |
| **3a. Manual solve (building)** | You solve the challenge yourself in the live browser preview | **Free** |
| **3b. Wait-out (Cloudflare)** | Cloudflare interstitials that clear themselves are simply waited out | **Free** |
| **3c. Auto-solve (running)** | A solving service returns a token we inject | **~$0.30–3 per 1000 solves**, opt-in |
| **3d. Flag** | No solver + a real challenge → run marked `needs_review` with the CAPTCHA type | **Free** |

**Can you go free now and pay a little later?** Yes. Ship with detection +
manual-solve-in-editor + flag-on-run (all free). When a production workflow
starts hitting CAPTCHAs unattended, set two env vars and you get automated
solving at cents-per-hundred. **No workflow or code changes** are needed to
switch — the solver is a pluggable provider.

---

## The three layers

### 1. Avoidance (best ROI, mostly free)

The cheapest CAPTCHA is the one that never fires. The platform already ships a
strong anti-detection stack (`backend/browser/stealthCore.js`): rotating,
internally-consistent device profiles, worker-context fingerprint patching, and
a WebRTC leak guard when a proxy is set. Pair that with **good proxies**
(`backend/services/proxyResolver.service.js`) — residential/mobile IPs trigger
far fewer challenges than datacenter IPs — and lower your request rate. This
removes more CAPTCHAs than any solver, and most of it is free.

### 2. Detection (free, always on)

`backend/browser/captcha.js` is the single source of truth for *"is there a
challenge here, and what is it?"* — modelled on the existing cookie-consent
module (`backend/browser/consent.js`). The core `__captchaDetectOnce()` is pure
DOM and runs **per frame** (widgets render inside cross-origin iframes). It
recognises:

- **reCAPTCHA v2** (checkbox / image) and **v3** (invisible/badge)
- **hCaptcha**
- **Cloudflare Turnstile**
- **Cloudflare interstitial** ("Checking your browser…", "Just a moment…")
- **Generic image / text CAPTCHAs** (heuristic)

and extracts the **sitekey** needed to solve token challenges. Detection is
wired into both consumers so preview and real runs can't drift:

- **Live editor** — `buildInjectedCaptchaScript()` is injected via
  `evaluateOnNewDocument` in `backend/server.js` alongside the selector tool and
  consent script. When a challenge appears it reports `{ type:'captcha', … }`
  over the existing `sendToNode` binding; the server forwards it to the browser
  as a `captchaDetected` socket event.
- **Generated scripts** — `buildCodegenCaptchaHelper()` inlines `detectCaptcha`
  and `solveCaptcha` into the standalone Puppeteer script
  (`backend/workflow/workflowCodegen.js`).

### 3. Solving (two paths, one detector)

**While building (free).** The editor streams the *real* browser over CDP and
forwards your mouse and keyboard. So when a CAPTCHA is detected we show a banner
and **you just solve it in the preview**. Cloudflare interstitials are flagged
as self-clearing so you know to wait. If a solver is configured server-side, the
banner also offers a one-click **Auto-solve**. You can also click **Add step**
to drop a `Solve CAPTCHA` step so unattended runs handle the same challenge.

**While running (opt-in paid, or free flag).** Headless runs have no human, so
after each navigation (and in the explicit **Solve CAPTCHA** step) the generated
script calls `solveCaptcha(page, …)`, which:

1. detects across every frame;
2. a **Cloudflare interstitial** with no sitekey → **waits** for it to clear
   (usually a few seconds) — no solver cost;
3. a **solvable token widget** + a **configured provider** → gets a token from
   the provider, injects it into the page's hidden response field, fires the
   widget callback, and continues;
4. **otherwise** → prints a `CAPTCHA_DETECTED:` marker so the execution pipeline
   classifies the run as `CAPTCHA` → `needs_review`, and either continues
   (`onUnsolved: 'continue'`, the NAVIGATE default) or fails the step
   (`onUnsolved: 'fail'`, available on the Solve CAPTCHA step).

`backend/services/errorClassifier.service.js` gained a `CAPTCHA` category. It is
**never** treated as a selector problem, so the self-healing / LLM-repair loop
doesn't waste passes on it — it goes straight to `needs_review` with an
actionable message.

---

## Turning on paid auto-solving (when you're ready)

Set two environment variables — nothing else changes:

```bash
CAPTCHA_PROVIDER=capsolver     # or: twocaptcha
CAPTCHA_API_KEY=your_key_here
```

Optional tuning (defaults shown):

```bash
CAPTCHA_HANDLING=on            # 'off' disables detection + solving globally
CAPTCHA_SOLVE_TIMEOUT_MS=180000
CAPTCHA_POLL_MS=3000
CAPTCHA_HTTP_TIMEOUT_MS=20000
```

That's it. Existing workflows immediately start auto-solving on unattended runs,
and the editor gains the **Auto-solve** button. Downloaded standalone scripts
read the same env vars, so they can opt in independently.

### Provider comparison

| Provider | ~Price / 1000 solves | Notes |
|----------|----------------------|-------|
| **CapSolver** | ~$0.30–0.80 | AI-based, cheapest for tokens; supported here |
| **CapMonster Cloud** | ~$0.30–0.60 | AI-based; easy to add (same shape as CapSolver) |
| **2Captcha** | ~$1–3 | Human+AI, widest coverage, very reliable; supported here |
| **Anti-Captcha** | ~$1–2 | Similar to 2Captcha; easy to add |

You pay **per solve**. A workflow that trips one CAPTCHA per run and runs a few
thousand times a month costs single-digit dollars. Start with CapSolver for the
lowest price; keep 2Captcha in your back pocket for coverage/reliability.

### Adding another provider

`backend/services/captchaSolver.service.js` holds the provider client as a
single dependency-free source string (`PROVIDER_CLIENT_SRC`) that is both
evaluated in-process (live editor) and inlined into generated scripts (runs) —
so the two paths can never diverge. Add a `__captchaSolve<Name>` branch there
(createTask/submit → poll → return token) and a name alias in
`normalizeProvider`. No other file needs to change.

### Free / self-hosted solving

Free approaches exist — Buster (audio-reCAPTCHA via speech-to-text) and local
OCR/vision models for simple image CAPTCHAs — but they're unreliable and
increasingly detected, so they aren't wired in by default. The provider
abstraction leaves the door open if you ever want to add a local solver as just
another provider.

---

## Where each piece lives

| File | Role |
|------|------|
| `backend/browser/captcha.js` | Detection + token-injection DOM (shared), live-editor injected script, codegen helper |
| `backend/services/captchaSolver.service.js` | Pluggable provider client (capsolver / twocaptcha), shared source string |
| `backend/workflow/workflowCodegen.js` | Inlines the helper; NAVIGATE auto-handle + `SOLVE_CAPTCHA` step |
| `backend/server.js` | Injects the detector into the editor; `captchaDetected` event + `solveCaptcha` handler |
| `backend/services/errorClassifier.service.js` | `CAPTCHA` error category (never a repair candidate) |
| `backend/services/runner.service.js` | Surfaces the `CAPTCHA_DETECTED:` marker |
| `backend/services/executionPipeline.service.js` | Routes `CAPTCHA` runs to `needs_review` with guidance |
| `frontend/src/actions/*` | `SOLVE_CAPTCHA` action + NAVIGATE "CAPTCHA handling" option |
| `frontend/src/main.jsx` | The `captchaDetected` banner (solve here / auto-solve / add step) |

---

## FAQ

**Does detection slow things down or get me blocked?** No. It's read-only DOM
inspection that never touches the network and never blocks the page or your
clicks — same footprint as the existing consent scanner.

**What if a CAPTCHA appears mid-scrape and I have no solver?** The run is marked
`needs_review` with the CAPTCHA type and a suggestion (configure a solver, or
lower your rate / switch to a residential proxy). Any data collected before the
block is still kept.

**Is anything secret baked into downloaded scripts?** No. Generated scripts read
`CAPTCHA_PROVIDER` / `CAPTCHA_API_KEY` from their own environment at run time, so
your key never lands in generated code.

**Legal / ethical note.** Only solve CAPTCHAs on sites you're authorised to
scrape, and respect each site's terms of service and `robots.txt`.
