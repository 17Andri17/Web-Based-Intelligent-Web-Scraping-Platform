import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeClipboard } from "../utils/clipboard";

// Void / self-closing elements — rendered as a single tag with no
// expand arrow and no children, mirroring how Chrome DevTools shows them.
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

let _idSeq = 0;
function nextId() { return ++_idSeq; }

// Build a lightweight tree (element / text / comment nodes) from a parsed
// DOM node. `path` is the chain of child-indices from <html> down — the
// same addressing scheme `__selectByPath__` / `__highlightByPath__` use on
// the live page, so a click here can resolve straight back to the real
// element without needing a CSS selector.
function buildTree(domNode, path) {
  if (domNode.nodeType === Node.ELEMENT_NODE) {
    const tag = domNode.tagName.toLowerCase();
    const attrs = Array.from(domNode.attributes || []).map(a => [a.name, a.value]);
    const isVoid = VOID_TAGS.has(tag);
    // Child paths use only ELEMENT child indices (matches how the injected
    // page script walks `el.children`, which is element-only) — text/comment
    // siblings don't get their own path segment.
    const children = [];
    if (!isVoid) {
      let elIdx = 0;
      Array.from(domNode.childNodes).forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const built = buildTree(child, [...path, elIdx]);
          if (built) children.push(built);
          elIdx++;
        } else {
          const built = buildTree(child, path);
          if (built) children.push(built);
        }
      });
    }
    // Keep a reference to the parsed DOM element — powers the DevTools-style
    // copy actions (outerHTML / CSS selector / XPath / text) without having
    // to reconstruct markup from the lightweight tree.
    return { id: nextId(), type: "element", tag, attrs, path, isVoid, children, el: domNode };
  }
  if (domNode.nodeType === Node.TEXT_NODE) {
    const text = domNode.textContent.replace(/\s+/g, " ").trim();
    if (!text) return null; // skip whitespace-only text nodes, like DevTools
    return { id: nextId(), type: "text", text, path };
  }
  if (domNode.nodeType === Node.COMMENT_NODE) {
    return { id: nextId(), type: "comment", text: domNode.textContent, path };
  }
  return null;
}

function flatten(node, out) {
  out.push(node);
  if (node.children) node.children.forEach(c => flatten(c, out));
  return out;
}

function nodeMatches(node, query) {
  if (node.type === "element") {
    if (node.tag.includes(query)) return true;
    return node.attrs.some(([k, v]) => k.toLowerCase().includes(query) || v.toLowerCase().includes(query));
  }
  return (node.text || "").toLowerCase().includes(query);
}

/* ── DevTools-style locators, computed from the parsed DOM element ────── */

// Unique-ish CSS selector: nearest #id anchor, then tag:nth-child steps —
// same shape Chrome's "Copy selector" produces.
function cssPath(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    if (cur.id) {
      parts.unshift(`#${window.CSS?.escape ? CSS.escape(cur.id) : cur.id}`);
      break;
    }
    let selector = cur.nodeName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(c => c.nodeName === cur.nodeName);
      if (sameTag.length > 1) {
        selector += `:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`;
      }
    }
    parts.unshift(selector);
    cur = parent;
  }
  return parts.join(" > ");
}

// XPath anchored on the nearest #id ancestor (like Chrome's "Copy XPath"),
// falling back to an absolute /html/... path.
function xPath(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    if (cur.id && cur !== el) {
      parts.unshift(`/*[@id="${cur.id}"]`);
      return "/" + parts.join("/");
    }
    let idx = 1;
    let sib = cur.previousElementSibling;
    while (sib) { if (sib.nodeName === cur.nodeName) idx++; sib = sib.previousElementSibling; }
    let needsIndex = idx > 1;
    if (!needsIndex) {
      sib = cur.nextElementSibling;
      while (sib) { if (sib.nodeName === cur.nodeName) { needsIndex = true; break; } sib = sib.nextElementSibling; }
    }
    const tag = cur.nodeName.toLowerCase();
    parts.unshift(needsIndex ? `${tag}[${idx}]` : tag);
    cur = cur.parentElement;
  }
  return "/" + parts.join("/");
}

function AttrSpan({ name, value }) {
  return (
    <span className="hi-attr">
      {" "}<span className="hi-attr-name">{name}</span>="<span className="hi-attr-value">{value}</span>"
    </span>
  );
}

function HtmlNode({ node, depth, collapsed, onToggle, onSelect, onHover, onUnhover, activeId, matchIds }) {
  const isCollapsed = collapsed.has(node.id);
  const isActive = activeId === node.id;
  const isMatch = matchIds && matchIds.has(node.id);

  if (node.type === "text") {
    return (
      <div
        data-node-id={node.id}
        className={`hi-line hi-text-line${isMatch ? " hi-match" : ""}`}
        style={{ paddingLeft: depth * 14 + 18 }}
      >
        {node.text}
      </div>
    );
  }
  if (node.type === "comment") {
    return (
      <div data-node-id={node.id} className="hi-line hi-comment-line" style={{ paddingLeft: depth * 14 + 18 }}>
        {"<!--"}{node.text}{"-->"}
      </div>
    );
  }

  const hasChildren = node.children && node.children.length > 0;
  const indent = depth * 14;

  return (
    <div className="hi-node">
      <div
        data-node-id={node.id}
        className={`hi-line hi-tag-line${isActive ? " hi-active" : ""}${isMatch ? " hi-match" : ""}`}
        style={{ paddingLeft: indent }}
        onClick={(e) => onSelect(node, e)}
        onContextMenu={(e) => { e.preventDefault(); onSelect(node, e); }}
        onMouseEnter={() => onHover(node)}
        onMouseLeave={onUnhover}
      >
        {(hasChildren) ? (
          <button
            className={`hi-toggle${isCollapsed ? " hi-collapsed" : ""}`}
            onClick={(e) => { e.stopPropagation(); onToggle(node.id); }}
          >
            ▾
          </button>
        ) : <span className="hi-toggle-spacer" />}
        <span className="hi-tag">
          {"<"}<span className="hi-tag-name">{node.tag}</span>
          {node.attrs.map(([k, v]) => <AttrSpan key={k} name={k} value={v} />)}
          {node.isVoid ? " />" : (hasChildren && !isCollapsed ? ">" : (hasChildren ? "…>" : ">"))}
        </span>
        {!hasChildren && !node.isVoid && (
          <span className="hi-tag">{"</"}<span className="hi-tag-name">{node.tag}</span>{">"}</span>
        )}
        {hasChildren && isCollapsed && (
          <span className="hi-tag hi-collapsed-close">{"</"}<span className="hi-tag-name">{node.tag}</span>{">"}</span>
        )}
      </div>
      {hasChildren && !isCollapsed && (
        <>
          {node.children.map(child => (
            <HtmlNode
              key={child.id} node={child} depth={depth + 1}
              collapsed={collapsed} onToggle={onToggle}
              onSelect={onSelect} onHover={onHover} onUnhover={onUnhover}
              activeId={activeId} matchIds={matchIds}
            />
          ))}
          <div className="hi-line hi-close-line" style={{ paddingLeft: indent }}>
            <span className="hi-toggle-spacer" />
            <span className="hi-tag">{"</"}<span className="hi-tag-name">{node.tag}</span>{">"}</span>
          </div>
        </>
      )}
    </div>
  );
}

/* `html` turns the panel into a pure renderer of markup somebody else fetched.
   The builder passes no `html` and the panel asks the live preview for the page
   it is showing; the debug window passes the HTML of the page its run is parked
   on, which arrives over a different channel entirely. Everything below —
   the tree, the search, the copy-as-selector actions — is the same either way,
   which is the reason to share the component rather than clone it. */
export default function HtmlInspectorPanel({ socket, active, refreshKey, selectedPath, onBeforeSelect, maximized, onToggleMaximize, html: htmlProp }) {
  const controlled = htmlProp !== undefined;
  const [html, setHtml] = useState("");
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [activeId, setActiveId] = useState(null);
  const containerRef = useRef(null);
  const lastFetchedKeyRef = useRef(null);

  const fetchHtml = useCallback(() => {
    if (!socket || controlled) return;
    setLoading(true);
    setError("");
    socket.emit("getPageHtml");
  }, [socket, controlled]);

  useEffect(() => {
    if (!socket || controlled) return;
    const onHtml = ({ html: h, error: err }) => {
      setLoading(false);
      if (err) { setError(err); return; }
      setHtml(h || "");
    };
    socket.on("pageHtml", onHtml);
    return () => socket.off("pageHtml", onHtml);
  }, [socket, controlled]);

  // Supplied markup: adopt it as it changes, and never ask for any.
  useEffect(() => { if (controlled) setHtml(htmlProp || ""); }, [controlled, htmlProp]);

  // Fetch once when the tab becomes active, and again whenever the page
  // navigates/reloads (refreshKey bump) while the tab is open.
  useEffect(() => {
    if (!active || controlled) return;
    const key = refreshKey;
    if (lastFetchedKeyRef.current === key) return;
    lastFetchedKeyRef.current = key;
    fetchHtml();
  }, [active, controlled, refreshKey, fetchHtml]);

  useEffect(() => {
    if (!html) { setTree(null); return; }
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const root = buildTree(doc.documentElement, []);
      setTree(root);
      // Fully collapsed by default — only <html> is visible until a
      // selection (or search) reveals a specific path.
      const initialCollapsed = new Set();
      flatten(root, []).forEach(n => {
        if (n.type === "element" && n.children?.length) initialCollapsed.add(n.id);
      });
      setCollapsed(initialCollapsed);
    } catch (e) {
      setError("Failed to parse HTML: " + e.message);
    }
  }, [html]);

  const allNodes = useMemo(() => (tree ? flatten(tree, []) : []), [tree]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allNodes.filter(n => nodeMatches(n, q));
  }, [allNodes, query]);
  const matchIds = useMemo(() => new Set(matches.map(m => m.id)), [matches]);

  // Ancestor lookup so search can auto-expand the path to a match.
  const parentOf = useMemo(() => {
    const map = new Map();
    const walk = (node) => {
      (node.children || []).forEach(c => { map.set(c.id, node); walk(c); });
    };
    if (tree) walk(tree);
    return map;
  }, [tree]);

  const revealMatch = useCallback((node) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      let p = parentOf.get(node.id);
      while (p) { next.delete(p.id); p = parentOf.get(p.id); }
      return next;
    });
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector(`[data-node-id="${node.id}"]`);
      el?.scrollIntoView({ block: "center" });
    });
  }, [parentOf]);

  useEffect(() => {
    if (matches.length === 0) return;
    setMatchIndex(0);
    revealMatch(matches[0]);
  }, [matches, revealMatch]);

  // Mirror the app-wide element selection: collapse everything except the
  // ancestor chain leading to the selected element, so the tree always
  // opens straight to "here's what's currently selected" instead of a
  // wall of unrelated markup.
  const selectedPathKey = selectedPath ? JSON.stringify(selectedPath) : null;
  const lastSyncedPathKeyRef = useRef(null);
  useEffect(() => {
    // A fresh tree (new page / refresh) should re-apply the current
    // selection's reveal even if the path string is unchanged; clearing the
    // selection should let the same path re-sync if it's picked again.
    lastSyncedPathKeyRef.current = null;
  }, [tree]);
  useEffect(() => {
    if (!selectedPathKey) { lastSyncedPathKeyRef.current = null; return; }
    if (!tree || lastSyncedPathKeyRef.current === selectedPathKey) return;
    lastSyncedPathKeyRef.current = selectedPathKey;
    const target = allNodes.find(n => n.type === "element" && JSON.stringify(n.path) === selectedPathKey);
    if (!target) return;

    const keepExpanded = new Set();
    let p = parentOf.get(target.id);
    while (p) { keepExpanded.add(p.id); p = parentOf.get(p.id); }

    const nextCollapsed = new Set();
    allNodes.forEach(n => {
      if (n.type === "element" && n.children?.length && !keepExpanded.has(n.id)) {
        nextCollapsed.add(n.id);
      }
    });
    setCollapsed(nextCollapsed);
    setActiveId(target.id);
    requestAnimationFrame(() => {
      containerRef.current?.querySelector(`[data-node-id="${target.id}"]`)?.scrollIntoView({ block: "center" });
    });
  }, [tree, selectedPathKey, allNodes, parentOf]);

  const goToMatch = (dir) => {
    if (matches.length === 0) return;
    const next = (matchIndex + dir + matches.length) % matches.length;
    setMatchIndex(next);
    revealMatch(matches[next]);
  };

  const onToggle = (id) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const collapseAll = () => {
    const ids = new Set();
    allNodes.forEach(n => { if (n.type === "element" && n.children?.length) ids.add(n.id); });
    setCollapsed(ids);
  };
  const expandAll = () => setCollapsed(new Set());

  // DevTools-style copy menu — opened by clicking an element line.
  // { node, x, y } | null. Closes on outside click / Escape / tree scroll.
  const [copyMenu, setCopyMenu] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);
  const copyCloseTimerRef = useRef(null);

  const onSelect = (node, e) => {
    setActiveId(node.id);
    onBeforeSelect?.();
    socket?.emit("selectElementByPath", { path: node.path });
    // Offer the copy actions right where the user clicked.
    if (e && node.el) {
      const panel = containerRef.current?.closest(".hi-panel");
      const rect = panel?.getBoundingClientRect();
      setCopiedKey(null);
      setCopyMenu({
        node,
        x: rect ? e.clientX - rect.left : e.clientX,
        y: rect ? e.clientY - rect.top : e.clientY,
      });
    }
  };
  const onHover = (node) => socket?.emit("highlightElementByPath", { path: node.path });
  const onUnhover = () => socket?.emit("unhoverPickerChild");

  // mouseleave never fires when a hovered line is unmounted with this panel
  // (tab switch, sidebar close) — clear any hover highlight left on the page.
  const socketRef2 = useRef(socket);
  useEffect(() => { socketRef2.current = socket; }, [socket]);
  useEffect(() => () => { socketRef2.current?.emit("unhoverPickerChild"); }, []);

  const closeCopyMenu = useCallback(() => {
    clearTimeout(copyCloseTimerRef.current);
    setCopyMenu(null);
    setCopiedKey(null);
  }, []);
  useEffect(() => () => clearTimeout(copyCloseTimerRef.current), []);

  useEffect(() => {
    if (!copyMenu) return;
    const onKey = (e) => { if (e.key === "Escape") closeCopyMenu(); };
    const onDocPointer = (e) => {
      if (!e.target.closest?.(".hi-copy-menu")) closeCopyMenu();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDocPointer, true);
    const tree = containerRef.current;
    tree?.addEventListener("scroll", closeCopyMenu, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDocPointer, true);
      tree?.removeEventListener("scroll", closeCopyMenu);
    };
  }, [copyMenu, closeCopyMenu]);

  const handleCopy = async (key, text) => {
    const ok = await writeClipboard(text ?? "");
    setCopiedKey(ok ? key : null);
    clearTimeout(copyCloseTimerRef.current);
    copyCloseTimerRef.current = setTimeout(closeCopyMenu, 650);
  };

  const copyMenuItems = copyMenu ? [
    { key: "element",  label: "Copy element",  hint: "outerHTML", value: () => copyMenu.node.el.outerHTML },
    { key: "selector", label: "Copy selector", hint: "CSS",       value: () => cssPath(copyMenu.node.el) },
    { key: "xpath",    label: "Copy XPath",    hint: "",          value: () => xPath(copyMenu.node.el) },
    { key: "text",     label: "Copy text",     hint: "",          value: () => (copyMenu.node.el.textContent || "").trim() },
  ] : [];

  return (
    <div className="hi-panel">
      <div className="hi-toolbar">
        <div className="hi-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search tags, attrs, text…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") goToMatch(e.shiftKey ? -1 : 1);
            }}
          />
          {query && (
            <span className="hi-match-count">
              {matches.length ? `${matchIndex + 1}/${matches.length}` : "0/0"}
            </span>
          )}
          {query && (
            <>
              <button className="hi-icon-btn" title="Previous match" onClick={() => goToMatch(-1)}>↑</button>
              <button className="hi-icon-btn" title="Next match" onClick={() => goToMatch(1)}>↓</button>
            </>
          )}
        </div>
        <button className="hi-icon-btn" title="Collapse all" onClick={collapseAll}>⊟</button>
        <button className="hi-icon-btn" title="Expand all" onClick={expandAll}>⊞</button>
        <button className="hi-icon-btn" title="Refresh from page" onClick={fetchHtml}>⟳</button>
        {onToggleMaximize && (
          <button
            className={`hi-icon-btn${maximized ? " hi-icon-btn--active" : ""}`}
            title={maximized ? "Restore" : "Maximize (hide the page preview)"}
            onClick={onToggleMaximize}
          >
            {maximized ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 3v4a1 1 0 0 1-1 1H4M15 3v4a1 1 0 0 0 1 1h4M9 21v-4a1 1 0 0 0-1-1H4M15 21v-4a1 1 0 0 1 1-1h4" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4" />
              </svg>
            )}
          </button>
        )}
      </div>

      <div className="hi-tree" ref={containerRef}>
        {loading && <div className="hi-empty">Loading HTML…</div>}
        {!loading && error && <div className="hi-empty hi-error">{error}</div>}
        {!loading && !error && !tree && <div className="hi-empty">No page loaded yet.</div>}
        {!loading && !error && tree && (
          <HtmlNode
            node={tree} depth={0} collapsed={collapsed} onToggle={onToggle}
            onSelect={onSelect} onHover={onHover} onUnhover={onUnhover}
            activeId={activeId} matchIds={query ? matchIds : null}
          />
        )}
      </div>

      {/* DevTools-style copy menu */}
      {copyMenu && (
        <div
          className="hi-copy-menu"
          // Clamp inside the panel so the menu never spills out of view.
          style={{
            left: Math.max(8, Math.min(copyMenu.x, (containerRef.current?.closest(".hi-panel")?.clientWidth || 360) - 198)),
            top:  Math.max(8, Math.min(copyMenu.y, (containerRef.current?.closest(".hi-panel")?.clientHeight || 500) - 158)),
          }}
        >
          <div className="hi-copy-menu-title">
            &lt;{copyMenu.node.tag}&gt;
          </div>
          {copyMenuItems.map(item => (
            <button
              key={item.key}
              className={`hi-copy-menu-item${copiedKey === item.key ? " is-copied" : ""}`}
              onClick={() => handleCopy(item.key, item.value())}
            >
              <span>{copiedKey === item.key ? "✓ Copied!" : item.label}</span>
              {item.hint && copiedKey !== item.key && <span className="hi-copy-menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
