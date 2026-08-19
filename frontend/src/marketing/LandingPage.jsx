import React, { useEffect, useState } from "react";
import { billingApi } from "../api/client";
import { Link, useRouter } from "../router";
import ScrapientMark from "../brand/ScrapientMark";
import "../styles/marketing.css";

/*
  The public landing page.

  Built around one claim, because the product has exactly one thing
  competitors don't: scrapers that repair themselves and show their work. The
  hero is a mock repair log rather than a screenshot — it's the artefact that
  makes "self-healing" concrete in three seconds, and it's the thing a
  screenshot of a form builder can never convey.

  The pricing section reads from /api/billing/plans, the same catalogue the
  server enforces, so the numbers advertised here cannot drift from the
  numbers actually applied.
*/

/* The landing page stays reachable at / whether or not you're signed in —
   it's the page people share, and bouncing a logged-in visitor to the app
   would make the link behave differently for them than for everyone else.
   The nav is what adapts: an account holder gets "Open app" instead of the
   two sign-up buttons they have no use for. */
function Nav({ signedIn }) {
  const { navigate } = useRouter();
  return (
    <header className="mk-nav">
      <Link to="/" className="mk-brand" aria-label="Scrapient home">
        <ScrapientMark size={26} bg="var(--mk-bg)" />
        <span>Scrapient</span>
      </Link>
      <nav className="mk-nav-links">
        <a href="#how">How it works</a>
        <a href="#pricing">Pricing</a>
        {signedIn ? (
          <button className="mk-btn primary" onClick={() => navigate("/app")}>Open app</button>
        ) : (
          <>
            <button className="mk-btn ghost" onClick={() => navigate("/login")}>Sign in</button>
            <button className="mk-btn primary" onClick={() => navigate("/login?mode=register")}>
              Start free
            </button>
          </>
        )}
      </nav>
    </header>
  );
}

/* The hero artefact: a run that broke, diagnosed itself, verified the fix and
   came back green. Static markup, not a live run — it's an illustration, and
   pretending otherwise with a fake animation would be the kind of thing this
   product's audience notices and holds against you. */
function RepairLog() {
  const lines = [
    { t: "err",  time: "09:14:02", text: "Run #2841 finished — 0 rows captured" },
    { t: "warn", time: "09:14:02", text: '"Product price" matched nothing (was 48 rows yesterday)' },
    { t: "dim",  time: "09:14:03", text: "Fetching page snapshot…" },
    { t: "dim",  time: "09:14:05", text: "Proposed: .price-tag → [data-testid=\"price\"]" },
    { t: "ok",   time: "09:14:05", text: "Verified against snapshot — 48 matches" },
    { t: "dim",  time: "09:14:11", text: "Re-running to confirm…" },
    { t: "ok",   time: "09:14:38", text: "Run #2842 — 48 rows captured. Fix adopted." },
  ];
  return (
    <div className="mk-log" role="img" aria-label="A scraper detecting a broken selector, proposing a fix, verifying it against a page snapshot, and re-running successfully">
      <div className="mk-log-head">
        <span className="mk-log-dot" /><span className="mk-log-dot" /><span className="mk-log-dot" />
        <span className="mk-log-title">healing · products.acme.com</span>
      </div>
      <ol className="mk-log-body">
        {lines.map((l, i) => (
          <li key={i} className={`mk-log-line is-${l.t}`}>
            <span className="mk-log-time">{l.time}</span>
            <span className="mk-log-text">{l.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const STEPS = [
  {
    title: "Point and click on a live browser",
    body: "A real Chromium streams into the page. Click what you want and Scrapient builds the selector — then proposes the rest of the fields for you.",
  },
  {
    title: "It notices when nothing came back",
    body: "The failure that costs you money isn't a crash, it's a run that passes and captures nothing. Scrapient watches record counts per step and treats a silent zero as a failure.",
  },
  {
    title: "Fixes are verified, not guessed",
    body: "A proposed selector is tested against a snapshot of the page before it's trusted, then the run repeats end-to-end to confirm the data is really back. Only high-confidence verified fixes apply themselves; everything else waits for one click.",
  },
  {
    title: "And you can always leave",
    body: "Export any scraper as a standalone Puppeteer script with its own README. It runs on your machine, with no account and no Scrapient.",
  },
];

function PlanCards({ plans, onStart }) {
  const fmt = (n) => (n === null || n === undefined ? "Unlimited" : n.toLocaleString());
  return (
    <div className="mk-plans">
      {plans.map((p) => (
        <article key={p.slug} className={`mk-plan${p.featured ? " is-featured" : ""}`}>
          {p.featured && <span className="mk-plan-flag">Most popular</span>}
          <h3>{p.name}</h3>
          <div className="mk-plan-price">
            {p.price.monthly === 0 ? "Free" : `€${p.price.monthly}`}
            {p.price.monthly > 0 && <small>/month</small>}
          </div>
          <p className="mk-plan-role">{p.tagline}</p>
          <ul>
            <li><strong>{fmt(p.limits.maxWorkflows)}</strong> {p.limits.maxWorkflows === 1 ? "scraper" : "scrapers"}</li>
            <li><strong>{fmt(p.limits.monthlyRuns)}</strong> runs per month</li>
            <li className={p.features.selfHealing ? "" : "off"}>Verified self-healing</li>
            <li className={p.features.scheduling ? "" : "off"}>Scheduled runs</li>
            <li className={p.features.proxies ? "" : "off"}>Proxies</li>
            <li className={p.features.publicApi ? "" : "off"}>REST API &amp; webhooks</li>
            <li className={p.features.sharedProxyPool ? "" : "off"}>Managed proxy pool</li>
            <li className={p.features.captchaSolving ? "" : "off"}>CAPTCHA solving</li>
          </ul>
          <button
            className={`mk-btn ${p.featured ? "primary" : "ghost"} block`}
            onClick={() => onStart(p.slug)}
          >
            {p.price.monthly === 0 ? "Start free" : `Choose ${p.name}`}
          </button>
        </article>
      ))}
    </div>
  );
}

export default function LandingPage({ signedIn = false }) {
  const { navigate } = useRouter();
  const [plans, setPlans] = useState([]);

  useEffect(() => {
    billingApi.plans().then((d) => setPlans(d.plans || [])).catch(() => {});
  }, []);

  // Signing up is the same action for every tier — the plan choice is carried
  // through so the upgrade can be offered immediately after the account
  // exists, rather than asking for payment before there's anything to bill.
  // Someone already signed in skips straight to the app.
  const start = (slug) => navigate(
    signedIn ? "/app" : `/login?mode=register${slug !== "free" ? `&plan=${slug}` : ""}`);

  return (
    <div className="mk">
      <Nav signedIn={signedIn} />

      <main>
        <section className="mk-hero">
          <div className="mk-hero-copy">
            <p className="mk-eyebrow">Visual web scraping</p>
            <h1>Your scrapers will break.<br />These ones fix themselves.</h1>
            <p className="mk-lede">
              Build a scraper by clicking on a live browser. When the site changes,
              Scrapient finds the break, proposes a fix, <em>verifies it against the
              page</em>, and re-runs to prove the data came back — with a full audit
              trail of what changed and why.
            </p>
            <div className="mk-hero-cta">
              <button className="mk-btn primary lg" onClick={() => start("free")}>
                Start free — one scraper, no card
              </button>
              <a className="mk-btn ghost lg" href="#how">See how it works</a>
            </div>
            <p className="mk-hero-note">
              Free forever for one site. Export any scraper as a Puppeteer script — no lock-in.
            </p>
          </div>
          <div className="mk-hero-art"><RepairLog /></div>
        </section>

        <section className="mk-section" id="how">
          <div className="mk-section-head">
            <p className="mk-eyebrow">How it works</p>
            <h2>Every other tool hands the break back to you</h2>
            <p className="mk-lede">
              A redesign ships, your selector stops matching, and the run keeps
              reporting success while capturing nothing. You find out from your data,
              days later. That's the problem Scrapient is built around.
            </p>
          </div>
          <div className="mk-steps">
            {STEPS.map((s, i) => (
              <article key={s.title} className="mk-step">
                {/* Numbered because these are sequential — this is the order the
                    product actually works in, not decoration. */}
                <span className="mk-step-num">{String(i + 1).padStart(2, "0")}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mk-section mk-alt" id="more">
          <div className="mk-section-head">
            <p className="mk-eyebrow">Also included</p>
            <h2>The unglamorous parts, handled</h2>
          </div>
          <div className="mk-grid">
            {[
              ["Uses the site's own API", "Scrapient watches a page's network traffic and offers to pull from the JSON API behind it — faster, cheaper, and immune to redesigns."],
              ["Pagination that just works", "Scroll, next-button and URL-parameter strategies, with a detector that picks the right one."],
              ["Runs on a schedule", "Interval or cron, with e-mail alerts when something fails and change monitoring when data moves."],
              ["Straight into a spreadsheet", "Google Sheets delivery, CSV, XLSX, or a REST API and webhooks if you'd rather write code."],
              ["Version history", "Every run pins the exact version of the scraper that produced it. Roll back in one click."],
              ["Proxies and anti-bot", "Per-user proxies with encrypted credentials, rotating pools, device-profile stealth and CAPTCHA detection."],
            ].map(([h, b]) => (
              <article key={h} className="mk-card">
                <h3>{h}</h3>
                <p>{b}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mk-section" id="pricing">
          <div className="mk-section-head">
            <p className="mk-eyebrow">Pricing</p>
            <h2>Start free. Pay when it's doing real work.</h2>
            <p className="mk-lede">
              Self-healing is on every plan, including the free one — you should see
              the thing you'd be paying for before you pay for it.
            </p>
          </div>
          {plans.length > 0
            ? <PlanCards plans={plans} onStart={start} />
            : <p className="mk-dim">Loading plans…</p>}
          <p className="mk-fineprint">
            Prices in EUR, excluding VAT. Cancel any time — you keep access until the
            end of the period you've paid for.
          </p>
        </section>

        <section className="mk-cta">
          <h2>Point at a page. See what it pulls.</h2>
          <p>One scraper, 50 runs a month, free forever. No card, no trial clock.</p>
          <button className="mk-btn primary lg" onClick={() => start("free")}>Start free</button>
        </section>
      </main>

      <footer className="mk-foot">
        <div className="mk-foot-brand">
          <ScrapientMark size={20} bg="var(--mk-bg-alt)" />
          <span>Scrapient</span>
        </div>
        <p className="mk-dim">
          Scrape responsibly — respect each site's terms and robots.txt, and only
          collect data you're allowed to access.
        </p>
        <p className="mk-dim">© {new Date().getFullYear()} Scrapient · scrapient.app</p>
      </footer>
    </div>
  );
}
