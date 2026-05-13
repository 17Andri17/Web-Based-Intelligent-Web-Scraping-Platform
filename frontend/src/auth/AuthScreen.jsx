import React, { useState } from "react";
import { useAuth } from "./AuthContext";

export default function AuthScreen() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password);
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || "Authentication failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
          </svg>
          <span>WebScraper</span>
        </div>
        <h1 className="auth-title">{mode === "login" ? "Sign in" : "Create an account"}</h1>
        <p className="auth-subtitle">
          {mode === "login" ? "Welcome back. Sign in to access your saved workflows." : "Pick a username and password — that's all we need."}
        </p>

        <label className="auth-field">
          <span>Username</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="3-32 characters"
            required
            autoFocus
          />
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="At least 6 characters"
            required
          />
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
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
