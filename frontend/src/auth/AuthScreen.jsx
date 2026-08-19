import React, { useState, useEffect } from "react";
import { useAuth } from "./AuthContext";
import { authApi } from "../api/client";
import { Link } from "../router";
import ScrapientMark from "../brand/ScrapientMark";

/* Provider glyphs. Inlined rather than loaded from a CDN — the app must sign
   people in with no network dependency beyond its own origin. Google's is
   drawn in its brand colours because a monochrome Google "G" reads as broken
   to anyone who has seen the real button. */
function GoogleGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
  );
}

function GitHubGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
    </svg>
  );
}

/* A wrench, not a brand mark — the dev provider is a tool, and giving it
   anything resembling a logo would be the first step toward someone mistaking
   it for a real sign-in method. */
function DevGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
  );
}

const GLYPHS = { google: GoogleGlyph, github: GitHubGlyph, dev: DevGlyph };

export default function AuthScreen() {
  const { login, register, authError } = useAuth();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [providers, setProviders] = useState([]);
  // Only meaningful for the dev provider; harmless otherwise.
  const [devEmail, setDevEmail] = useState("dev@localhost");

  // Rendered from the server's list so a deployment without GitHub
  // credentials never shows a GitHub button that leads to a 503.
  useEffect(() => {
    let cancelled = false;
    authApi.providers()
      .then((list) => { if (!cancelled) setProviders(list || []); })
      .catch(() => { /* no providers is a valid state — the form still works */ });
    return () => { cancelled = true; };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password);
    } catch (err) {
      const data = err?.response?.data;
      setError(data?.error || err?.message || "Authentication failed");
      // The server tells us this account signs in with a provider rather than
      // a password — surface the button instead of leaving them to guess.
      if (data?.code === "use_oauth" && Array.isArray(data.providers)) {
        setProviders((prev) => {
          const known = new Set(prev.map((p) => p.name));
          return [...prev, ...data.providers
            .filter((n) => !known.has(n))
            .map((n) => ({ name: n, label: n === "github" ? "GitHub" : "Google" }))];
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const shown = error || authError;

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">
          <ScrapientMark size={34} />
          <span>Scrapient</span>
        </div>

        <h1 className="auth-title">
          {mode === "login" ? "Sign in" : "Create your account"}
        </h1>
        <p className="auth-subtitle">
          {mode === "login"
            ? "Welcome back. Your scrapers are where you left them."
            : "Free forever for one scraper. No card required."}
        </p>

        {providers.length > 0 && (
          <>
            <div className="auth-oauth">
              {providers.map((p) => {
                const Glyph = GLYPHS[p.name];
                // The dev provider signs in as whatever address you give it,
                // so it gets a field rather than a bare button — that's what
                // makes it possible to test the "link to an existing account
                // by verified e-mail" path locally.
                if (p.local) {
                  return (
                    <div key={p.name} className="auth-oauth-dev">
                      <span className="auth-oauth-dev-tag">Development only</span>
                      <div className="auth-oauth-dev-row">
                        <input
                          type="email"
                          value={devEmail}
                          onChange={(e) => setDevEmail(e.target.value)}
                          placeholder="dev@localhost"
                          aria-label="Sign in as (development)"
                        />
                        <button
                          type="button"
                          className="auth-oauth-btn is-dev"
                          onClick={() => authApi.startOAuth(p.name, { email: devEmail || "dev@localhost" })}
                        >
                          {Glyph ? <Glyph /> : null}
                          <span>{p.label}</span>
                        </button>
                      </div>
                      <p className="auth-oauth-dev-note">
                        Signs in as that address with no password and no provider.
                        Use the same address as an existing account to test linking.
                      </p>
                    </div>
                  );
                }
                return (
                  <button
                    key={p.name}
                    type="button"
                    className="auth-oauth-btn"
                    onClick={() => authApi.startOAuth(p.name)}
                  >
                    {Glyph ? <Glyph /> : null}
                    <span>Continue with {p.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="auth-divider"><span>or</span></div>
          </>
        )}

        {/* type="text" when signing IN, type="email" when signing UP.

            The server accepts either an e-mail or a username on login, so
            that accounts created before the email column existed can still
            get in. But an <input type="email"> is validated by the BROWSER
            before submit, so a bare username never reaches the server at all
            — it's rejected with "please include an '@'". Those accounts were
            locked out of the UI while the backend was happily accepting them.

            Registration still requires a real address, since that's the
            identity every new account is keyed on. */}
        <label className="auth-field">
          <span>{mode === "login" ? "E-mail or username" : "E-mail"}</span>
          <input
            type={mode === "login" ? "text" : "email"}
            // inputMode keeps the '@'-friendly keyboard on mobile even though
            // the input is type="text".
            inputMode="email"
            autoComplete={mode === "login" ? "username" : "email"}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={mode === "login" ? "you@company.com or yourname" : "you@company.com"}
            required
            autoFocus
          />
        </label>

        <label className="auth-field">
          <span className="auth-field-label">
            Password
            {/* Only on sign-in: offering "forgot it?" while someone is
                choosing a brand-new password is nonsense. */}
            {mode === "login" && (
              <Link to="/forgot" className="auth-field-link" tabIndex={0}>Forgot password?</Link>
            )}
          </span>
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "login" ? "Your password" : "At least 8 characters"}
            minLength={mode === "register" ? 8 : undefined}
            required
          />
        </label>

        {shown && <div className="auth-error">{shown}</div>}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create free account"}
        </button>

        <div className="auth-switch">
          {mode === "login" ? (
            <>New here? <button type="button" onClick={() => { setMode("register"); setError(null); }}>Create an account</button></>
          ) : (
            <>Already have an account? <button type="button" onClick={() => { setMode("login"); setError(null); }}>Sign in</button></>
          )}
        </div>
      </form>
    </div>
  );
}
