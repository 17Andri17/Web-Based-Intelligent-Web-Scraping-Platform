import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
    return { id: nextId(), type: "element", tag, attrs, path, isVoid, children };
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
        onClick={() => onSelect(node)}
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

export default function HtmlInspectorPanel({ socket, active, refreshKey }) {
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
    if (!socket) return;
    setLoading(true);
    setError("");
    socket.emit("getPageHtml");
  }, [socket]);

  useEffect(() => {
    if (!socket) return;
    const onHtml = ({ html: h, error: err }) => {
      setLoading(false);
      if (err) { setError(err); return; }
      setHtml(h || "");
    };
    socket.on("pageHtml", onHtml);
    return () => socket.off("pageHtml", onHtml);
  }, [socket]);

  // Fetch once when the tab becomes active, and again whenever the page
  // navigates/reloads (refreshKey bump) while the tab is open.
  useEffect(() => {
    if (!active) return;
    const key = refreshKey;
    if (lastFetchedKeyRef.current === key) return;
    lastFetchedKeyRef.current = key;
    fetchHtml();
  }, [active, refreshKey, fetchHtml]);

  useEffect(() => {
    if (!html) { setTree(null); return; }
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const root = buildTree(doc.documentElement, []);
      setTree(root);
      // Collapse everything below depth 2 by default so the tree opens to
      // something navigable instead of a huge unrolled dump.
      const initialCollapsed = new Set();
      const walk = (node, depth) => {
        if (node.type === "element" && node.children?.length && depth >= 2) {
          initialCollapsed.add(node.id);
        } else if (node.children) {
          node.children.forEach(c => walk(c, depth + 1));
        }
      };
      walk(root, 0);
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

  const onSelect = (node) => {
    setActiveId(node.id);
    socket?.emit("selectElementByPath", { path: node.path });
  };
  const onHover = (node) => socket?.emit("highlightElementByPath", { path: node.path });
  const onUnhover = () => socket?.emit("unhoverPickerChild");

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
    </div>
  );
}
