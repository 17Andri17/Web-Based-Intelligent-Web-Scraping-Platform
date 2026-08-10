import { useEffect, useState } from "react";

/* Subscribe to a CSS media query from React.

   The header collapses in stages as it runs out of room (full buttons → icons
   → an overflow menu). CSS alone can hide labels, but moving controls into a
   menu needs a different DOM, so the breakpoints have to be readable here too.
   Keep the values in sync with the --header breakpoints in app.css. */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(query).matches
      : false
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mql.matches);            // re-sync if the query itself changed
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

// The width below which the header's secondary actions collapse into a menu.
export const HEADER_COMPACT_QUERY = "(max-width: 1180px)";
