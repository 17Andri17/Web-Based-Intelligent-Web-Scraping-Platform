import React, { useEffect, useState, useCallback } from "react";
import { adminApi } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useConfirm } from "../components/ConfirmDialog";
import useDialog from "../components/useDialog";
import "../styles/AdminPanel.css";

/*
  Operator panel.

  Scanned, not read: the list surfaces who is near their limit, who is
  suspended and who is paying, so the row that needs attention is visible
  without opening anything. Detail opens in place.

  Every control here is mirrored by a server-side check — the UI hides what
  you can't do (demote yourself, delete the last admin), the server refuses it
  regardless. Hiding is a courtesy; the refusal is the boundary.
*/

const PLANS = ["free", "pro", "business"];

function relative(iso) {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export default function AdminPanel({ open, onClose, showToast }) {
  const { overlayProps, dialogProps } = useDialog({ open, onClose });
  const { user: me } = useAuth();
  const confirm = useConfirm();

  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState(null);   // detail payload
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.users({
        search: search || undefined,
        plan: planFilter || undefined,
        status: statusFilter || undefined,
        limit: 50,
      });
      setRows(data.users);
      setTotal(data.total);
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setLoading(false); }
  }, [search, planFilter, statusFilter]);

  useEffect(() => {
    if (!open) return;
    adminApi.stats().then(setStats).catch(() => {});
  }, [open]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(loadList, 220);
    return () => clearTimeout(t);
  }, [open, loadList]);

  useEffect(() => {
    if (!open) { setSelected(null); setSearch(""); setPlanFilter(""); setStatusFilter(""); }
  }, [open]);

  if (!open) return null;

  const openUser = async (id) => {
    setBusy(true);
    try { setSelected(await adminApi.user(id)); }
    catch (err) { setError(err?.response?.data?.error || err.message); }
    finally { setBusy(false); }
  };

  const act = async (fn, successMessage) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await loadList();
      if (selected) setSelected(await adminApi.user(selected.user.id));
      if (successMessage) showToast?.(successMessage);
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const changePlan = (u, plan) =>
    act(() => adminApi.setPlan(u.id, { plan }), `${u.username} moved to ${plan}.`);

  const toggleSuspend = (u) => act(async () => {
    const suspending = u.status !== "suspended";
    if (suspending) {
      const okd = await confirm({
        title: `Suspend ${u.username}?`,
        message: "They'll be signed out and blocked from running anything. Their workflows and data are kept.",
        confirmLabel: "Suspend", danger: true,
      });
      if (!okd) return;
    }
    await adminApi.setStatus(u.id, { status: suspending ? "suspended" : "active" });
  }, "Account updated.");

  const toggleAdmin = (u) =>
    act(() => adminApi.setAdmin(u.id, { isAdmin: !u.isAdmin }), "Admin access updated.");

  const removeUser = async (u) => {
    // Deletion cascades through every table this account owns, so it takes
    // the username typed back — an id in a row is far too easy to misclick.
    const typed = window.prompt(
      `Delete ${u.username} and everything they own? This cannot be undone.\n\nType "${u.username}" to confirm:`);
    if (typed !== u.username) return;
    await act(async () => {
      await adminApi.remove(u.id);
      setSelected(null);
    }, `${u.username} deleted.`);
  };

  return (
    <div className="wf-overlay" {...overlayProps}>
      <div className="wf-modal adm-modal" {...dialogProps}>
        <div className="wf-header">
          <h2>Admin</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="wf-body">
          {error && <div className="wf-error">{error}</div>}

          {stats && (
            <div className="adm-stats">
              <div className="adm-stat"><span>{stats.totalUsers}</span><label>Users</label></div>
              <div className="adm-stat"><span>{stats.paidUsers}</span><label>Paying</label></div>
              <div className="adm-stat"><span>{stats.newUsers30d}</span><label>New (30d)</label></div>
              <div className="adm-stat"><span>{stats.totalWorkflows}</span><label>Workflows</label></div>
              <div className="adm-stat"><span>{stats.runsThisPeriod}</span><label>Runs ({stats.period})</label></div>
              {stats.suspendedUsers > 0 && (
                <div className="adm-stat is-warn"><span>{stats.suspendedUsers}</span><label>Suspended</label></div>
              )}
            </div>
          )}

          {stats?.billingStubbed && (
            <div className="adm-banner">
              Billing is stubbed — plan changes here take effect immediately and nothing is charged.
            </div>
          )}

          <div className="adm-filters">
            <input
              type="search"
              placeholder="Search username or e-mail…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search users"
            />
            <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value)} aria-label="Filter by plan">
              <option value="">All plans</option>
              {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
            <span className="adm-count">{loading ? "…" : `${rows.length} of ${total}`}</span>
          </div>

          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Plan</th>
                  <th className="num">Runs</th>
                  <th className="num">Flows</th>
                  <th>Last seen</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  return (
                    <tr
                      key={u.id}
                      className={`${u.status === "suspended" ? "is-suspended" : ""}${selected?.user?.id === u.id ? " is-open" : ""}`}
                      onClick={() => openUser(u.id)}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter") openUser(u.id); }}
                    >
                      <td>
                        <div className="adm-user">
                          <span className="adm-username">{u.username}</span>
                          {u.isAdmin && <span className="adm-tag is-admin">admin</span>}
                          {u.status === "suspended" && <span className="adm-tag is-susp">suspended</span>}
                          {u.overrides && <span className="adm-tag is-comp">comped</span>}
                        </div>
                        <div className="adm-email">{u.email || <em>no e-mail</em>}</div>
                      </td>
                      <td>
                        <span className={`adm-plan is-${u.plan}`}>{u.plan}</span>
                        {u.planStatus !== "active" && (
                          <span className="adm-tag is-susp">{u.planStatus}</span>
                        )}
                      </td>
                      <td className="num">{(u.usage?.runsUsed ?? 0).toLocaleString()}</td>
                      <td className="num">{u.usage?.workflowCount ?? 0}</td>
                      <td className="adm-dim">{relative(u.lastLoginAt)}</td>
                      <td className="adm-row-actions" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={u.plan}
                          disabled={busy}
                          onChange={(e) => changePlan(u, e.target.value)}
                          aria-label={`Plan for ${u.username}`}
                        >
                          {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={6} className="adm-empty">No accounts match.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {selected && (
            <section className="adm-detail">
              <header>
                <h3>{selected.user.username}</h3>
                <button className="wf-close" onClick={() => setSelected(null)} aria-label="Close details">×</button>
              </header>

              <div className="adm-detail-grid">
                <div>
                  <span className="adm-label">E-mail</span>
                  <p>{selected.user.email || "—"} {selected.user.emailVerified && <span className="adm-tag">verified</span>}</p>
                </div>
                <div>
                  <span className="adm-label">Signed up</span>
                  <p>{relative(selected.user.createdAt)}</p>
                </div>
                <div>
                  <span className="adm-label">Effective plan</span>
                  <p>
                    {selected.user.entitlements.effectivePlan}
                    {selected.user.entitlements.lapsed && <span className="adm-tag is-susp">lapsed</span>}
                  </p>
                </div>
                <div>
                  <span className="adm-label">Sign-in</span>
                  <p>{selected.linkedProviders.length
                    ? selected.linkedProviders.map((l) => l.provider).join(", ")
                    : "password"}</p>
                </div>
              </div>

              {selected.usageHistory.length > 0 && (
                <>
                  <span className="adm-label">Usage by month</span>
                  <div className="adm-table-wrap">
                    <table className="adm-table adm-mini">
                      <thead><tr><th>Period</th><th className="num">Runs</th><th className="num">Pages</th></tr></thead>
                      <tbody>
                        {selected.usageHistory.map((h) => (
                          <tr key={h.period}>
                            <td>{h.period}</td>
                            <td className="num">{h.runs_used.toLocaleString()}</td>
                            <td className="num">{h.pages_used.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="adm-actions">
                <button
                  className="bill-btn"
                  disabled={busy || selected.user.id === me?.id}
                  onClick={() => toggleSuspend(selected.user)}
                  title={selected.user.id === me?.id ? "You cannot suspend your own account" : undefined}
                >
                  {selected.user.status === "suspended" ? "Restore account" : "Suspend account"}
                </button>
                <button
                  className="bill-btn"
                  disabled={busy || selected.user.id === me?.id}
                  onClick={() => toggleAdmin(selected.user)}
                  title={selected.user.id === me?.id ? "You cannot change your own admin access" : undefined}
                >
                  {selected.user.isAdmin ? "Remove admin" : "Make admin"}
                </button>
                <button
                  className="bill-btn danger"
                  disabled={busy || selected.user.id === me?.id}
                  onClick={() => removeUser(selected.user)}
                >
                  Delete account
                </button>
              </div>

              {selected.audit.length > 0 && (
                <>
                  <span className="adm-label">History</span>
                  <ul className="adm-audit">
                    {selected.audit.map((a) => (
                      <li key={a.id}>
                        <code>{a.action}</code> by {a.adminUsername || "?"}
                        <span className="adm-dim"> · {relative(a.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
