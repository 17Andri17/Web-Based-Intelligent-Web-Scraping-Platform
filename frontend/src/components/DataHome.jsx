import React, { useEffect, useState, useMemo } from "react";
import { workflowsApi } from "../api/client";
import DatasetPanel from "./DatasetPanel";
import "../styles/DataHome.css";

/* =====================================================================
   DataHome — every scraper's collected data in one place.

   Before this, extracted data had no home: you reached it through
   Header → Workflows → find the row → a 16px "Data" icon → a modal on
   top of a modal, one workflow at a time. There was no way to answer
   "how much have I actually collected?" without opening each one.

   This is the answer screen: one row per scraper, its accumulated row
   count, and a direct download. Opening a row still hands off to the
   existing DatasetPanel for the full table — this replaces the way IN,
   not the detail view itself.

   Props:
     open
     onClose()
     onOpenWorkflow(id)   load a workflow into the editor
     showToast(msg, type)
   ===================================================================== */

export default function DataHome({ open, onClose, onOpenWorkflow, showToast }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState(null);
  const [query, setQuery]     = useState("");
  const [detailFor, setDetailFor] = useState(null);   // { id, name } | null
  const [downloading, setDownloading] = useState(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true); setErr(null);
    workflowsApi.dataSummary()
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setErr(e?.response?.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  const items = data?.items || [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i => (i.name || "").toLowerCase().includes(q));
  }, [items, query]);

  // Scrapers that have collected something sort first — an empty one is
  // almost always "hasn't run yet", which is not what you opened this for.
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => (b.totalRows || 0) - (a.totalRows || 0)),
    [filtered]
  );

  const grandTotal = useMemo(
    () => items.reduce((n, i) => n + (i.totalRows || 0), 0),
    [items]
  );
  const withData = items.filter(i => (i.totalRows || 0) > 0).length;

  const download = async (item, fmt) => {
    setDownloading(`${item.workflowId}:${fmt}`);
    try {
      const blob = await workflowsApi.datasetDownloadBlob(item.workflowId, fmt, {});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeFileName(item.name)}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast?.(`✗ Download failed: ${e?.response?.data?.error || e.message}`, "error");
    } finally {
      setDownloading(null);
    }
  };

  if (!open) return null;

  return (
    <div className="dh">
      <div className="dh-inner">
        <div className="dh-head">
          <div>
            <h1 className="dh-title">Your data</h1>
            <p className="dh-subtitle">
              {loading
                ? "Adding up what each scraper has collected…"
                : items.length === 0
                  ? "Nothing collected yet."
                  : <>
                      <strong>{grandTotal.toLocaleString()}</strong> row{grandTotal === 1 ? "" : "s"} across{" "}
                      <strong>{withData}</strong> scraper{withData === 1 ? "" : "s"}
                      {data?.runsPerWorkflow ? <> · counted over each scraper's last {data.runsPerWorkflow} runs</> : null}
                    </>}
            </p>
          </div>
          <button className="dh-close" onClick={onClose}>
            Close
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {items.length > 8 && (
          <input
            className="dh-search"
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search scrapers…"
          />
        )}

        {loading ? (
          <div className="dh-empty">Loading…</div>
        ) : err ? (
          <div className="dh-empty dh-error">{err}</div>
        ) : items.length === 0 ? (
          <div className="dh-empty-state">
            <div className="dh-empty-illustration">📦</div>
            <h3>No data yet</h3>
            <p>Once a scraper runs successfully, everything it collects shows up here.</p>
          </div>
        ) : sorted.length === 0 ? (
          <div className="dh-empty">No scrapers match “{query}”.</div>
        ) : (
          <div className="dh-list">
            {sorted.map(item => {
              const empty = !(item.totalRows > 0);
              const busy = downloading && downloading.startsWith(`${item.workflowId}:`);
              return (
                <div key={item.workflowId} className={`dh-row ${empty ? "dh-row--empty" : ""}`}>
                  <div className="dh-row-main">
                    <span className="dh-name" title={item.name}>{item.name}</span>
                    <span className="dh-meta">
                      {item.error
                        ? <span className="dh-error">{item.error}</span>
                        : empty
                          ? <span className="dh-muted">
                              {item.runsConsidered === 0 ? "No successful runs yet" : "No list data captured"}
                            </span>
                          : <>
                              <strong>{item.totalRows.toLocaleString()}</strong> unique row{item.totalRows === 1 ? "" : "s"}
                              {item.primaryOutput ? <> · {item.primaryOutput}</> : null}
                              {item.outputs.length > 1 ? <> · +{item.outputs.length - 1} more table{item.outputs.length - 1 === 1 ? "" : "s"}</> : null}
                              <> · across {item.runsConsidered} run{item.runsConsidered === 1 ? "" : "s"}</>
                            </>}
                    </span>
                  </div>

                  <div className="dh-row-actions">
                    {!empty && (
                      <>
                        <button className="dh-btn" disabled={busy}
                          onClick={() => download(item, "csv")}>CSV</button>
                        <button className="dh-btn" disabled={busy}
                          onClick={() => download(item, "xlsx")}>Excel</button>
                        <button className="dh-btn dh-btn--primary"
                          onClick={() => setDetailFor({ id: item.workflowId, name: item.name })}>
                          View
                        </button>
                      </>
                    )}
                    <button className="dh-btn" onClick={() => onOpenWorkflow(item.workflowId)}>
                      Open scraper
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {data?.truncated && (
          <p className="dh-note">
            Showing the {items.length} most recently updated scrapers of {data.totalWorkflows}.
          </p>
        )}
      </div>

      {/* The full cross-run table: a full-height panel over this one, with
          its own filtering and sorting done server-side. This screen is the
          way in; that one is the detail view. */}
      <DatasetPanel
        open={!!detailFor}
        onClose={() => setDetailFor(null)}
        workflowId={detailFor?.id}
        workflowName={detailFor?.name}
        showToast={showToast}
      />
    </div>
  );
}

function safeFileName(name) {
  return String(name || "dataset").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "dataset";
}
