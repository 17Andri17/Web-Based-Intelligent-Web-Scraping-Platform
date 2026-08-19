import React, { useState, useEffect } from "react";
import { authApi } from "../api/client";
import { useAuth } from "./AuthContext";
import { Link, useRouter } from "../router";
import ScrapientMark from "../brand/ScrapientMark";

/*
  The three screens reached by clicking a link in an e-mail, plus the form
  that asks for one. They share the sign-in card's shell so arriving from a
  mail client doesn't feel like landing on a different product.

  All three are reachable while signed out — a reset or confirmation link is
  opened from a mailbox, which may not be the browser holding the session.
*/

function Shell({ title, subtitle, children }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <ScrapientMark size={34} bg="var(--bg-secondary)" />
          <span>Scrapient</span>
        </div>
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

/* Reads ?token=… once. Kept out of component state deliberately: the token is
   single-use, and re-reading it on a re-render could fire a second consume
   attempt that the server correctly rejects as already-used. */
function useQueryToken() {
  const [token] = useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("token");
  });
  return token;
}

/* ── "I forgot my password" ─────────────────────────────────────────────── */
export function ForgotPasswordScreen() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.forgot(email);
      setSent(true);
    } catch (err) {
      // The only real failure is SMTP being unconfigured on the server; an
      // unknown address still resolves 200 by design.
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  if (sent) {
    return (
      <Shell
        title="Check your inbox"
        subtitle={`If ${email} has an account with a password, a reset link is on its way. It works once and expires in an hour.`}
      >
        <p className="auth-hint">
          Nothing arrived? Check spam, or make sure you didn't sign up with Google or GitHub —
          those accounts don't have a password to reset.
        </p>
        <div className="auth-switch">
          <Link to="/login">Back to sign in</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Reset your password"
      subtitle="We'll e-mail you a link to choose a new one."
    >
      <form onSubmit={submit} className="auth-form">
        <label className="auth-field">
          <span>E-mail</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            required
            autoFocus
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? "Sending…" : "Send reset link"}
        </button>
      </form>
      <div className="auth-switch">
        Remembered it? <Link to="/login">Sign in</Link>
      </div>
    </Shell>
  );
}

/* ── Choosing the new password ──────────────────────────────────────────── */
export function ResetPasswordScreen() {
  const token = useQueryToken();
  const { adopt } = useAuth();
  const { navigate } = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!token) {
    return (
      <Shell title="Link not valid" subtitle="This page needs a reset link from your e-mail.">
        <div className="auth-switch"><Link to="/forgot">Request a new link</Link></div>
      </Shell>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    // Checked here rather than server-side: it's a typo guard, not a security
    // rule, and the server has no business knowing the user typed it twice.
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    setBusy(true);
    setError(null);
    try {
      // The server signs them in as part of the reset — they've just proved
      // mailbox control and chosen a password, so asking them to type it
      // again would be friction with no benefit.
      adopt(await authApi.reset(token, password));
      navigate("/app", { replace: true });
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  return (
    <Shell title="Choose a new password" subtitle="You'll be signed in straight away.">
      <form onSubmit={submit} className="auth-form">
        <label className="auth-field">
          <span>New password</span>
          <input
            type="password" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters" minLength={8} required autoFocus
          />
        </label>
        <label className="auth-field">
          <span>Confirm password</span>
          <input
            type="password" autoComplete="new-password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type it again" minLength={8} required
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? "Saving…" : "Set password and sign in"}
        </button>
      </form>
      <div className="auth-switch"><Link to="/forgot">Request a new link</Link></div>
    </Shell>
  );
}

/* ── Confirming an address ──────────────────────────────────────────────── */
export function VerifyEmailScreen() {
  const token = useQueryToken();
  const { refresh, user } = useAuth();
  const [state, setState] = useState("working"); // working | done | failed
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!token) { setState("failed"); setMessage("This page needs a confirmation link from your e-mail."); return; }
    let cancelled = false;
    authApi.verifyEmail(token)
      .then(() => {
        if (cancelled) return;
        setState("done");
        // If they happen to be signed in in this browser, update the session
        // so the "confirm your e-mail" banner disappears immediately rather
        // than lingering until the next page load.
        refresh().catch(() => {});
      })
      .catch((err) => {
        if (cancelled) return;
        setState("failed");
        setMessage(err?.response?.data?.error || err.message);
      });
    return () => { cancelled = true; };
  }, [token, refresh]);

  if (state === "working") {
    return <Shell title="Confirming…" subtitle="One moment." />;
  }

  if (state === "done") {
    return (
      <Shell title="E-mail confirmed" subtitle="Thanks — that's all we needed.">
        <p className="auth-hint">
          You'll now get alerts when a scraper breaks, and you can reset your password if you lose it.
        </p>
        <div className="auth-switch">
          <Link to={user ? "/app" : "/login"}>{user ? "Back to Scrapient" : "Sign in"}</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Couldn't confirm that" subtitle={message}>
      <p className="auth-hint">
        Sign in and we'll send you a fresh confirmation link from the banner at the top.
      </p>
      <div className="auth-switch"><Link to="/login">Sign in</Link></div>
    </Shell>
  );
}

/* ── In-app nudge ───────────────────────────────────────────────────────────
   Shown inside the application, not on these screens. Dismissible, because an
   unverified address blocks nothing today — it only limits alerts and password
   recovery — and a permanent undismissable bar for a soft requirement is the
   kind of thing people learn to ignore everywhere else in the product. */
export function VerifyEmailBanner({ onOpenAccount }) {
  const { user, refresh } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!user || dismissed || (user.email && user.emailVerified)) return null;

  /* Two distinct states, not one.

     An account with NO address at all is one created before e-mail was an
     identity here. It cannot be nagged to "confirm" anything — there is
     nothing to confirm — so it gets a different message and a different
     action: open the account panel and add one. Collapsing both into
     "confirm your e-mail" would be nonsense for exactly the users who most
     need to act. */
  const missing = !user.email;

  const resend = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const out = await authApi.resendVerification();
      if (out.alreadyVerified) { await refresh(); return; }
      setStatus({ kind: "ok", text: `Sent to ${user.email}. Check your inbox.` });
    } catch (err) {
      setStatus({ kind: "err", text: err?.response?.data?.error || err.message });
    } finally { setBusy(false); }
  };

  return (
    <div className="verify-banner" role="status">
      <span className="verify-banner-text">
        {missing ? (
          <>Your account has no e-mail address. Add one to get alerts when a scraper
            breaks — and so you can get back in if you forget your password.</>
        ) : (
          <>Confirm <strong>{user.email}</strong> to get alerts when a scraper breaks —
            and so you can reset your password if you lose it.</>
        )}
      </span>
      {status && (
        <span className={`verify-banner-status is-${status.kind}`}>{status.text}</span>
      )}
      {missing ? (
        <button className="verify-banner-btn" onClick={onOpenAccount}>Add e-mail</button>
      ) : (
        <button className="verify-banner-btn" onClick={resend} disabled={busy}>
          {busy ? "Sending…" : "Resend e-mail"}
        </button>
      )}
      <button
        className="verify-banner-close"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >×</button>
    </div>
  );
}
