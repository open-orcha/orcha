import type { KeyboardEvent } from "react";

/**
 * The WAI-ARIA tablist keyboard pattern, shared by every `role="tablist"` in the site: the
 * arrow keys move to the previous or next tab (wrapping), Home and End to the first and last,
 * and the tab reached is focused and selected at once (automatic activation, by clicking it,
 * so each tablist keeps its own `onClick` as the one place that switches).
 *
 * Both arrow pairs work whatever the orientation: a vertical list still answers Left/Right
 * and a horizontal one Up/Down, which costs nothing and spares people guessing which way a
 * list that wraps at phone width is meant to run.
 *
 * Usage: `<div role="tablist" onKeyDown={onTablistKeyDown}>`, with each tab carrying
 * `tabIndex={selected ? 0 : -1}` so Tab enters the list once, on the selected tab.
 */
export function onTablistKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const list = e.currentTarget;
  const from = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
  // Keys typed into something inside a tab panel nested in the list are not ours.
  if (!from || from.closest('[role="tablist"]') !== list) return;
  const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (t) => t.closest('[role="tablist"]') === list && !t.hasAttribute("disabled") && t.getAttribute("aria-disabled") !== "true",
  );
  const i = tabs.indexOf(from);
  const j = nextTabIndex(e.key, i, tabs.length);
  if (j === null) return;
  e.preventDefault();
  const to = tabs[j];
  to.focus();
  if (to.getAttribute("aria-selected") !== "true") to.click();
}

/** Where `key` moves from tab `i` of `count`, or null for a key the pattern ignores. */
export function nextTabIndex(key: string, i: number, count: number): number | null {
  if (count === 0 || i < 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (i + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (i - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
