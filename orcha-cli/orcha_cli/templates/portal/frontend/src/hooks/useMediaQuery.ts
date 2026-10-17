/**
 * useNarrow — true below the V2 list/detail breakpoint (900 px), where the
 * inspector becomes a full view (design system §3 SplitPane). Pages use it to
 * PUSH (not replace) when opening a detail so Back returns to the list.
 * jsdom / no matchMedia ⇒ false (wide).
 */
import { useEffect, useState } from "react";

export const NARROW_QUERY = "(max-width: 899px)";

function matches(q: string): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q).matches : false;
  } catch {
    return false;
  }
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => matches(q));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(q);
    } catch {
      return;
    }
    const on = () => setM(mql.matches);
    on();
    mql.addEventListener?.("change", on);
    return () => mql.removeEventListener?.("change", on);
  }, [q]);
  return m;
}

export function useNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}
