/**
 * Code Space responsive layout mode, derived from the page's OWN width (not
 * the viewport — the V2 sidebar may or may not be taking space beside it):
 *
 *   wide   — tree | code | rail, all inline (enough room for the persisted
 *            tree + rail widths AND a comfortable code column)
 *   medium — tree | code inline; the thread rail becomes an overlay drawer
 *   narrow — single-pane file view; the tree ("Files") and the rail
 *            ("Threads") are both overlay drawers toggled from the header
 *
 * Pure `layoutFor` is exported for unit tests. Environments without
 * ResizeObserver (jsdom) stay "wide", the historical three-pane layout.
 */
import { useEffect, useState } from "react";

export type CodeLayout = "wide" | "medium" | "narrow";

/** Minimum comfortable code column (≈ 60 mono chars + gutter). */
export const CODE_COMFORT_WIDTH = 480;

export function layoutFor(width: number, tree: number, rail: number): CodeLayout {
  if (!width || width >= tree + rail + CODE_COMFORT_WIDTH) return "wide";
  if (width >= tree + CODE_COMFORT_WIDTH) return "medium";
  return "narrow";
}

/** `el` is the observed element held in STATE (a callback ref), so the
 *  observer attaches whenever the element actually mounts. */
export function useCodeLayout(el: HTMLElement | null, tree: number, rail: number): CodeLayout {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.round(w));
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [el]);
  return layoutFor(width, tree, rail);
}
