import React, { useEffect, useState } from "react";
import { authApi } from "../api/client";
import { useAuth } from "./AuthContext";
import { useConfirm } from "../components/ConfirmDialog";
import useDialog from "../components/useDialog";
import "../styles/AccountMenu.css";

/*
  Account panel — how you sign in.

  Exists mainly for two situations the sign-up form can't cover:

    • Accounts created before e-mail was an identity at all. They have a
      username and a password and nothing else, which means no alerts and no
      way to recover a forgotten password. Adding an address here fixes both.

    • OAuth accounts that want a password as well, so they aren't locked out
      if they ever lose access to the provider.

  Everything shown is server state; nothing is inferred locally. The panel
  re-reads the session after every change so what it displays and what the
  server will enforce can't drift.
*/

const PROVIDER_LABELS = { google: "Google", github: "GitHub", dev: "Dev Login" };

export default function AccountMenu({ open, onClose, showToast }) {
  const { overlayProps, dialogProps } = useDialog({ open, onClose });
  const { user, refresh } = useAuth();
  const confirm = useConfirm();

  const [email, setEmail] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState(null);

  const [resendBusy, setResendBusy] = useState(false);
  const [resendNote, setResendNote] = useState(null);

  useEffect(() => {
    if (!open) return;
    setEmail(user?.email || "");
    setEmailError(null); setPwError(null); setResendNote(null);
    setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
  }, [open, user]);

  if (!open || !user) return null;

  const hasPassword = user.hasPassword;
  const linked = user.linkedProviders || [];
  const emailChanged = email.trim().toLowerCase() !== (user.email || "").toLowerCase();

  const saveEmail = async (e) => {
    e.preventDefault();
    setEmailBusy(true);
    setEmailError(null);
    try {
      const out = await authApi.setEmail(email.trim());
      await refresh();
      showToast?.(out.verificationSent
        ? `Saved. Check ${email.trim()} for a confirmation link.`
        : "E-mail saved.");
    } catch (err) {
      setEmailError(err?.response?.data?.error || err.message);
    } finally { setEmailBusy(false); }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) { setPwError("The two passwords don't match."); return; }
    setPwBusy(true);
    setPwError(null);
    try {
      // An account with no password may set one without proving an old one —
      // there is nothing to prove, and the session is already the proof.
      await authApi.setPassword(hasPassword ? currentPassword : undefined, newPassword);
      await refresh();
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      showToast?.(hasPassword ? "Password changed." : "Password set.");
    } catch (err) {
      setPwError(err?.response?.data?.error || err.message);
    } finally { setPwBusy(false); }
  };

  const resend = async () => {
    setResendBusy(true);
    setResendNote(null);
    try {
      await authApi.resendVerification();
      setResendNote({ kind: "ok", text: `Sent to ${user.email}.` });
    } catch (err) {
      setResendNote({ kind: "err", text: err?.response?.data?.error || err.message });
    } finally { setResendBusy(false); }
  };

  const unlink = async (provider) => {
    const label = PROVIDER_LABELS[provider] || provider;
    if (!(await confirm({
      title: `Disconnect ${label}?`,
      message: `You'll no longer be able to sign in with ${label}.`,
      confirmLabel: "Disconnect", danger: true,
    }))) return;
    try {
      await authApi.unlink(provider);
      await refresh();
      showToast?.(`${label} disconnected.`);
    } catch (err) {
      // The server refuses to remove the last way in — an OAuth-only account
      // that unlinks its only provider would be locked out for good.
      showToast?.(err?.response?.data?.error || err.message);
    }
  };

  return (
    <div className="wf-overlay" {...overlayProps}>
      <div className="wf-modal acct-modal" {...dialogProps}>
        <div className="wf-header">
          <h2>Account</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="wf-body">
          <div className="acct-identity">
            <span className="acct-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <div>
              <div className="acct-username">{user.username}</div>
              <div className="acct-sub">
                {user.plan?.name} plan
                {user.isAdmin && <span className="acct-tag">admin</span>}
              </div>
            </div>
          </div>

          {/* ── E-mail ───────────────────────────────────────────────────── */}
          <section className="acct-section">
            <h3>E-mail</h3>
            {!user.email ? (
              <p className="acct-hint">
                This account doesn't have an e-mail address yet — it was created when a
                username was all we asked for. Adding one lets us alert you when a scraper
                breaks, and lets you reset your password if you ever lose it.
              </p>
            ) : !user.emailVerified ? (
              <p className="acct-hint">
                <strong>Not confirmed yet.</strong> Until you click the link we sent,
                alerts won't be delivered and this address can't be used to reset your password.
              </p>
            ) : null}

            <form className="acct-form" onSubmit={saveEmail}>
              <div className="acct-row">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  aria-label="E-mail address"
                  required
                />
                <button type="submit" className="acct-btn" disabled={emailBusy || !emailChanged}>
                  {emailBusy ? "Saving…" : user.email ? "Change" : "Add e-mail"}
                </button>
              </div>
              {user.email && (
                <span className={`acct-chip ${user.emailVerified ? "is-ok" : "is-warn"}`}>
                  {user.emailVerified ? "Confirmed" : "Unconfirmed"}
                </span>
              )}
              {emailError && <div className="wf-error">{emailError}</div>}
            </form>

            {user.email && !user.emailVerified && (
              <div className="acct-resend">
                <button className="acct-btn ghost" onClick={resend} disabled={resendBusy}>
                  {resendBusy ? "Sending…" : "Resend confirmation"}
                </button>
                {resendNote && (
                  <span className={`acct-note is-${resendNote.kind}`}>{resendNote.text}</span>
                )}
              </div>
            )}
          </section>

          {/* ── Password ─────────────────────────────────────────────────── */}
          <section className="acct-section">
            <h3>{hasPassword ? "Change password" : "Set a password"}</h3>
            {!hasPassword && (
              <p className="acct-hint">
                You sign in with {linked.map((p) => PROVIDER_LABELS[p] || p).join(" or ") || "a provider"}.
                Setting a password gives you a second way in — and is required before you can
                disconnect your last provider.
              </p>
            )}
            <form className="acct-form" onSubmit={savePassword}>
              {hasPassword && (
                <input
                  type="password" autoComplete="current-password"
                  value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Current password" aria-label="Current password" required
                />
              )}
              <input
                type="password" autoComplete="new-password"
                value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New password (at least 8 characters)"
                aria-label="New password" minLength={8} required
              />
              <input
                type="password" autoComplete="new-password"
                value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                aria-label="Confirm new password" minLength={8} required
              />
              {pwError && <div className="wf-error">{pwError}</div>}
              <button type="submit" className="acct-btn" disabled={pwBusy}>
                {pwBusy ? "Saving…" : hasPassword ? "Change password" : "Set password"}
              </button>
            </form>
          </section>

          {/* ── Connected sign-in methods ────────────────────────────────── */}
          <section className="acct-section">
            <h3>Connected accounts</h3>
            {linked.length === 0 ? (
              <p className="acct-hint">
                Nothing connected. Sign out and use a provider button with this same
                e-mail address to link one.
              </p>
            ) : (
              <ul className="acct-providers">
                {linked.map((p) => (
                  <li key={p}>
                    <span>{PROVIDER_LABELS[p] || p}</span>
                    <button className="acct-btn ghost small" onClick={() => unlink(p)}>
                      Disconnect
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
