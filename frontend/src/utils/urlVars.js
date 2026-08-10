/* =========================================================================
   Putting workflow variables BACK into a captured URL.

   Everything the browser reports — the address bar, a detected pagination
   template, the page a step was captured on — is a CONCRETE url, because that
   is what actually loaded. But a workflow parameterised on `{{targetUrl}}` must
   store the variable, not the one sample value it happened to be previewed
   with. Otherwise every captured navigation and every pagination pattern is
   silently pinned to that sample, and running the workflow with a different
   input scrapes the wrong site.

   `unresolveVars` is the inverse of main.jsx's `resolveVars`: it swaps a
   variable's sample value back for its `{{name}}` reference.
   ========================================================================= */

// Longest values first: if one variable's value is a prefix of another's
// (e.g. host = "https://site.com" and listUrl = "https://site.com/list"),
// substituting the short one first would leave the long one unmatchable.
function substitutable(vars) {
  return (vars || [])
    .filter(v => v && typeof v.name === "string" && v.name
                 && typeof v.value === "string" && v.value.trim().length >= 4)
    .sort((a, b) => b.value.length - a.value.length);
}

/**
 * Replace occurrences of each variable's sample value with `{{name}}`.
 *   unresolveVars("https://x.com/list?page=2", [{name:"site", value:"https://x.com"}])
 *     → "{{site}}/list?page=2"
 * Values shorter than 4 chars are ignored — substituting "2" or "pl" into a URL
 * would corrupt it far more often than it would help.
 */
export function unresolveVars(str, vars) {
  if (typeof str !== "string" || !str) return str;
  let out = str;
  for (const v of substitutable(vars)) {
    if (!out.includes(v.value)) continue;
    out = out.split(v.value).join(`{{${v.name}}}`);
  }
  return out;
}

/**
 * The raw (variable-preserving) URL a step should be based on.
 *
 * Prefers a workflow step whose RESOLVED url matches the page we are actually
 * on — that is the step that navigated here, so its raw url is the correct
 * base, variables and all. This is what makes a pagination pattern detected
 * halfway through a workflow attach to the right navigation rather than to the
 * start url. Falls back to reverse-substituting the concrete url.
 *
 *   steps       — the workflow step tree (top level is enough; NAVIGATE steps
 *                 that matter are not nested inside loops)
 *   currentUrl  — the concrete url currently loaded
 *   vars        — workflow variables ([{ name, value }])
 *   resolve     — main.jsx's resolveVars (passed in to avoid a circular import)
 */
export function rawUrlForCurrentPage(steps, currentUrl, vars, resolve) {
  const navs = [];
  const walk = (list) => {
    for (const s of list || []) {
      if (s && s.type === "NAVIGATE" && typeof s.params?.url === "string") navs.push(s.params.url);
      for (const key of ["body", "then", "else", "try", "catch"]) {
        if (Array.isArray(s?.[key])) walk(s[key]);
      }
    }
  };
  walk(steps);

  // Latest matching navigation wins: if the workflow navigated more than once,
  // the page we are on belongs to the most recent one.
  for (let i = navs.length - 1; i >= 0; i--) {
    const resolved = resolve(navs[i], vars);
    if (resolved && currentUrl && sameUrl(resolved, currentUrl)) return navs[i];
  }
  return unresolveVars(currentUrl, vars);
}

// Compare ignoring a trailing slash and the hash — neither changes which page
// was loaded, and the address bar routinely differs from the typed url in both.
function sameUrl(a, b) {
  const norm = (u) => {
    try {
      const p = new URL(u);
      p.hash = "";
      return p.href.replace(/\/$/, "");
    } catch (_) {
      return String(u).split("#")[0].replace(/\/$/, "");
    }
  };
  return norm(a) === norm(b);
}
