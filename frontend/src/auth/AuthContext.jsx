import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { authApi, getToken, setToken } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setTokenState] = useState(getToken());
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!token) { setUser(null); setLoading(false); return; }
    let cancelled = false;
    authApi.me()
      .then(({ user }) => { if (!cancelled) setUser(user); })
      .catch(() => { if (!cancelled) { setToken(null); setTokenState(null); setUser(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const login = useCallback(async (username, password) => {
    const { token, user } = await authApi.login(username, password);
    setToken(token);
    setTokenState(token);
    setUser(user);
  }, []);

  const register = useCallback(async (username, password) => {
    const { token, user } = await authApi.register(username, password);
    setToken(token);
    setTokenState(token);
    setUser(user);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setTokenState(null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, token, loading, login, register, logout }), [user, token, loading, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
