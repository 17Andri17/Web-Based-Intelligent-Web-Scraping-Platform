import React, { useState, useEffect, useCallback, createContext, useContext } from "react";

/* ===========================================================================
   A ~50-line router.

   The app needs exactly four public paths (landing, pricing, sign-in, the
   OAuth landing) plus /app. React Router would add a dependency and a
   component vocabulary to express five routes that a switch statement covers,
   in a codebase that has done without one until now.

   Path-based rather than hash-based because the marketing pages need to be
   crawlable and shareable, and because backend/app.js already returns
   index.html for any non-/api GET, so a deep link or a refresh on /pricing
   resolves without extra server work.
   ========================================================================= */

const RouterContext = createContext(null);

function currentPath() {
  if (typeof window === "undefined") return "/";
  // Trailing slashes are normalised away so /pricing and /pricing/ are the
  // same route rather than one of them silently 404ing to the catch-all.
  const p = window.location.pathname.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

export function RouterProvider({ children }) {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    // Back/forward buttons.
    const onPop = () => setPath(currentPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to, { replace = false } = {}) => {
    if (to === currentPath()) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", to);
    setPath(currentPath());
    // Browsers restore scroll on popstate but not on pushState, so a
    // navigation would otherwise land halfway down the new page.
    window.scrollTo(0, 0);
  }, []);

  return (
    <RouterContext.Provider value={{ path, navigate }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter() {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used inside RouterProvider");
  return ctx;
}

/* An anchor that navigates client-side but is still a real <a href>, so it
   can be opened in a new tab, copied, and read by crawlers. Modified clicks
   and anything but the primary button fall through to the browser. */
export function Link({ to, children, ...rest }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
