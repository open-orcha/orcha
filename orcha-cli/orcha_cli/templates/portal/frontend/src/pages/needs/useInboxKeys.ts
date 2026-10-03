/**
 * Linear-Inbox keyboard for a list | detail page (Needs you, Requests):
 * - j/k and ↑/↓ move the SELECTION (not just focus) through `keys`;
 *   ↑/↓ only while focus is inside the list (the List primitive moves focus
 *   and this follows it), j/k anywhere outside a text field.
 * - Escape goes to `onEscape` (never while a dialog / popover / menu is open);
 *   the page decides what it closes and returns true when it handled it.
 * Rows are found by `[data-v2-row][data-id]` inside `listSelector`.
 */
import { useEffect, useRef } from "react";
import { isEditingTarget } from "../../components/primitives";

export interface InboxKeysOptions {
  /** listen at all (e.g. only in the queue view) */
  enabled: boolean;
  /** navigable row keys, in display order */
  keys: string[];
  selected: string | null;
  select: (key: string) => void;
  /** CSS selector of the list element holding the `[data-v2-row]` rows */
  listSelector: string;
  /** j/k and arrows off (e.g. the narrow single-column layout) */
  navDisabled?: boolean;
  /** Escape handler; return true when it consumed the key */
  onEscape?: (e: KeyboardEvent) => boolean | void;
}

/** A dialog, popover or menu is open — keys belong to it. */
export function inboxOverlayOpen(): boolean {
  return !!document.querySelector(".v2-overlay, .overlay.show, .v2-popover, .v2-menu");
}

/** Next key for a j/k step from `selected` (first row when nothing is selected). */
export function stepKey(keys: string[], selected: string | null, down: boolean): string | null {
  if (!keys.length) return null;
  const i = selected ? keys.indexOf(selected) : -1;
  if (i < 0) return keys[0];
  return keys[down ? Math.min(keys.length - 1, i + 1) : Math.max(0, i - 1)];
}

export function useInboxKeys(opts: InboxKeysOptions): void {
  // the handler reads the latest options without re-binding every render
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    if (!opts.enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const o = ref.current;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement as HTMLElement | null;
      if (e.key === "Escape") {
        if (inboxOverlayOpen()) return;
        if (o.onEscape?.(e)) e.preventDefault();
        return;
      }
      const down = e.key === "j" || e.key === "ArrowDown";
      const up = e.key === "k" || e.key === "ArrowUp";
      if ((!down && !up) || o.navDisabled || inboxOverlayOpen()) return;
      const listEl = document.querySelector<HTMLElement>(o.listSelector);
      if (!listEl) return;
      if (active && listEl.contains(active)) {
        // the List already moved focus (and prevented default): follow it
        const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-v2-row]")?.dataset.id;
        if (id && id !== o.selected && o.keys.includes(id)) o.select(id);
        return;
      }
      if (e.key.startsWith("Arrow") || isEditingTarget(active) || e.defaultPrevented) return;
      const next = stepKey(o.keys, o.selected, down);
      if (!next) return;
      e.preventDefault();
      if (next !== o.selected) o.select(next);
      const row = Array.from(listEl.querySelectorAll<HTMLElement>("[data-v2-row]")).find((r) => r.dataset.id === next);
      row?.scrollIntoView?.({ block: "nearest" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [opts.enabled]);
}
