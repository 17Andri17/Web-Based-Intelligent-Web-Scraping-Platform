import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { authApi, getToken, setToken } from "../api/client";

const AuthContext = createContext(null);

/* Pick up a token handed back by the OAuth callback.

   The backend redirects to /auth/callback#token=… — a URL *fragment*, never a
   query string, because a fragment is not sent to any server and so keeps the
   token out of access logs, Referer headers and proxies. It is read once here
   and immediately stripped from the address bar so it doesn't linger in
   history or get copy-pasted out of the URL. */
function consumeOAuthRedirect() {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash || "";
  if (!hash.includes("token=") && !hash.includes("error=")) return null;

  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  const error = params.get("error");

  // replaceState rather than assigning location.hash: the latter leaves the
  // fragment in history, which is exactly what we're trying to avoid.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);

  return { token, error };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // Read the redirect before the first render so there is no flash of the
  // sign-in screen for a user who just authorised with Google.
  const [redirect] = useState(() => consumeOAuthRedirect());
  const [token, setTokenState] = useState(() => {
    if (redirect && redirect.token) { setToken(redirect.token); return redirect.token; }
    return getToken();
  });
  const [loading, setLoading] = useState(!!(redirect?.token || getToken()));
  const [authError, setAuthError] = useState(redirect?.error || null);

  useEffect(() => {
    if (!token) { setUser(null); setLoading(false); return; }
    let cancelled = false;
    authApi.me()
      .then(({ user }) => { if (!cancelled) setUser(user); })
      .catch((err) => {
        if (cancelled) return;
        // A suspended account answers 403 with a message worth showing —
        // otherwise the user is silently bounced to sign-in and tries again
        // forever with no idea why.
        if (err?.response?.status === 403) {
          setAuthError(err.response.data?.error || "This account is suspended.");
        }
        setToken(null); setTokenState(null); setUser(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const adopt = useCallback(({ token, user }) => {
    setToken(token);
    setTokenState(token);
    setUser(user);
    setAuthError(null);
  }, []);

  const login = useCallback(async (email, password) => {
    adopt(await authApi.login(email, password));
  }, [adopt]);

  const register = useCallback(async (email, password) => {
    adopt(await authApi.register(email, password));
  }, [adopt]);

  const logout = useCallback(() => {
    setToken(null);
    setTokenState(null);
    setUser(null);
    setAuthError(null);
  }, []);

  // Re-read the session after anything that changes the plan (checkout,
  // cancellation, an admin comp) so the UI's gating matches the server's.
  const refresh = useCallback(async () => {
    if (!getToken()) return null;
    const { user } = await authApi.me();
    setUser(user);
    return user;
  }, []);

  /* Convenience readers so components ask "may I?" instead of reimplementing
     the plan rules. These mirror the server's entitlements service, but they
     are ONLY for hiding affordances — the server is what enforces, and any
     check here is a courtesy to the user, not a security boundary. */
  const can = useCallback((feature) => !!user?.plan?.features?.[feature], [user]);
  const limit = useCallback((key) => user?.plan?.limits?.[key] ?? null, [user]);

  const value = useMemo(() => ({
    user, token, loading, authError,
    login, register, logout, refresh, adopt,
    can, limit,
    isAdmin: !!user?.isAdmin,
    plan: user?.plan || null,
  }), [user, token, loading, authError, login, register, logout, refresh, adopt, can, limit]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
