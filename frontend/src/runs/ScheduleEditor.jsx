import React, { useEffect, useState } from "react";
import { schedulesApi } from "../api/client";

/* =====================================================================
   ScheduleEditor
   Modal for enabling/disabling automatic scheduled runs of a single
   workflow. Lets the user pick from common intervals or set a custom
   one (in minutes).

   Props:
     open, onClose
     workflowId          required
     workflowName        used in the header
     showToast(msg, type)
   ===================================================================== */

const PRESETS = [
  { minutes: 15,    label: "Every 15 min" },
  { minutes: 30,    label: "Every 30 min" },
  { minutes: 60,    label: "Hourly"       },
  { minutes: 180,   label: "Every 3 hr"   },
  { minutes: 360,   label: "Every 6 hr"   },
  { minutes: 720,   label: "Every 12 hr"  },
  { minutes: 1440,  label: "Daily"        },
  { minutes: 10080, label: "Weekly"       },
];

export default function ScheduleEditor({ open, onClose, workflowId, workflowName, showToast }) {
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState(null);

  // Form state
  const [enabled,  setEnabled]  = useState(false);
  const [minutes,  setMinutes]  = useState(60);
  const [customMode, setCustomMode] = useState(false);
  // Optional time-of-day anchor in HH:MM (24-hour, user-local). When set,
  // the first run is the next occurrence of this time in the user's local
  // tz, and subsequent runs land on anchor + k * interval.
  const [startTime, setStartTime] = useState('');

  const refresh = async () => {
    if (!workflowId) return;
    setLoading(true);
    setError(null);
    try {
      const s = await schedulesApi.getForWorkflow(workflowId);
      setSchedule(s);
      if (s) {
        setEnabled(s.isActive);
        setMinutes(s.intervalMinutes);
        setCustomMode(!PRESETS.some(p => p.minutes === s.intervalMinutes));
        // Render the anchor (stored as UTC ISO) back in the user's local tz
        // so the time picker shows what they originally chose.
        if (s.anchorAt) {
          const d = new Date(s.anchorAt);
          setStartTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
        } else {
          setStartTime('');
        }
      } else {
        setEnabled(false);
        setMinutes(60);
        setCustomMode(false);
        setStartTime('');
      }
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, workflowId]);

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = Number(minutes);
      if (!Number.isFinite(m) || m < 5) {
        throw new Error("Interval must be at least 5 minutes");
      }
      // Convert HH:MM (user-local) into the next UTC ISO occurrence so the
      // backend can treat it as the anchor for the recurring schedule.
      let startAtIso = null;
      if (startTime) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(startTime.trim());
        if (!match) throw new Error("Start time must be in HH:MM format");
        const h = Number(match[1]); const mm = Number(match[2]);
        if (h < 0 || h > 23 || mm < 0 || mm > 59) throw new Error("Start time is out of range");
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mm, 0, 0);
        if (target <= now) target.setDate(target.getDate() + 1); // already passed today → tomorrow
        startAtIso = target.toISOString();
      }
      const saved = await schedulesApi.upsertForWorkflow(workflowId, m, enabled, startAtIso);
      setSchedule(saved);
      const when = startTime ? `starting ${startTime} every ${prettyMin(m)}` : `every ${prettyMin(m)}`;
      showToast?.(enabled ? `✓ Schedule active — ${when}` : "✓ Schedule paused", "success");
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const clearAnchor = () => setStartTime('');

  const remove = async () => {
    if (!schedule) return;
    if (!confirm(`Remove the schedule for "${workflowName}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await schedulesApi.removeForWorkflow(workflowId);
      setSchedule(null);
      setEnabled(false);
      showToast?.("✓ Schedule removed", "success");
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="wf-header">
          <h2>Schedule "{workflowName}"</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="wf-body">
          {loading ? (
            <div className="wf-empty">Loading…</div>
          ) : (
            <>
              <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, fontSize: 14 }}>
                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
                <span>Run this workflow automatically on a schedule</span>
              </label>

              <div className="wf-section-title">Interval</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6, marginBottom: 10 }}>
                {PRESETS.map(p => (
                  <button
                    key={p.minutes}
                    type="button"
                    className="wf-save-btn"
                    style={{
                      background: (!customMode && minutes === p.minutes) ? "var(--accent-primary, #4f9cf9)" : undefined,
                      color:      (!customMode && minutes === p.minutes) ? "#fff" : undefined,
                    }}
                    onClick={() => { setMinutes(p.minutes); setCustomMode(false); }}
                    disabled={!enabled || busy}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={customMode}
                    onChange={e => setCustomMode(e.target.checked)}
                    disabled={!enabled}
                  />
                  Custom (minutes)
                </label>
                <input
                  type="number"
                  min={5}
                  max={10080}
                  value={minutes}
                  onChange={e => setMinutes(e.target.value)}
                  disabled={!enabled || !customMode || busy}
                  style={{ width: 100 }}
                />
              </div>

              <div className="wf-section-title">Start at (optional)</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <input
                  type="time"
                  value={startTime}
                  onChange={e => setStartTime(e.target.value)}
                  disabled={!enabled || busy}
                  step={60}
                />
                {startTime && (
                  <button type="button"
                          onClick={clearAnchor}
                          disabled={!enabled || busy}
                          className="wf-save-btn"
                          style={{ background: "transparent", color: "var(--text-secondary)", padding: "4px 8px" }}>
                    Clear
                  </button>
                )}
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {startTime
                    ? `Runs at ${startTime} ${tzLabel()} and every ${prettyMin(Number(minutes))} after`
                    : `Runs every ${prettyMin(Number(minutes))} starting when you save`}
                </span>
              </div>

              {schedule && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 14 }}>
                  {schedule.lastRunAt && <div>Last run: {formatDate(schedule.lastRunAt)}</div>}
                  {schedule.nextRunAt && schedule.isActive && (
                    <div>Next run: {formatDate(schedule.nextRunAt)}</div>
                  )}
                </div>
              )}

              {error && <div className="wf-error">{error}</div>}

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                {schedule && (
                  <button className="wf-save-btn" onClick={remove} disabled={busy}
                          style={{ background: "transparent", color: "var(--text-secondary)" }}>
                    Remove
                  </button>
                )}
                <button className="wf-save-btn" onClick={save} disabled={busy}>
                  {schedule ? "Update schedule" : "Create schedule"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(s) {
  if (!s) return "";
  const d = new Date(/T/.test(s) ? s : (s.replace(" ", "T") + "Z"));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

function pad(n) { return String(n).padStart(2, "0"); }

function prettyMin(m) {
  if (!Number.isFinite(m)) return `${m} min`;
  if (m % 1440 === 0) { const d = m / 1440; return d === 1 ? "day" : `${d} days`; }
  if (m % 60   === 0) { const h = m / 60;   return h === 1 ? "hour" : `${h} hr`; }
  return `${m} min`;
}

function tzLabel() {
  // Best-effort short timezone label, falls back to a numeric offset
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return `(${tz})`;
  } catch (_) {}
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `(UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`;
}
