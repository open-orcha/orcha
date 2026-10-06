/**
 * List / Row — dense, keyboard-navigable rows (32–40 px; 44 px on coarse
 * pointers). Selection is always shown with a marker (inset accent bar), never
 * color alone, and is exposed as aria-selected / aria-current.
 *
 * Keyboard (only while focus is ON a row — never hijacks text inputs,
 * CodeMirror or xterm): ↑/↓ (and j/k when `vimKeys`) move focus, Home/End jump,
 * Enter activates the focused row. Updates re-render rows in place, so focus
 * and selection survive live refreshes as long as `id`s are stable.
 */
import {
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { isEditingTarget } from "./focus";

export interface ListProps {
  label: string; // accessible name
  children: ReactNode;
  className?: string;
  vimKeys?: boolean;
  /** "listbox" for selectable lists, "list" for navigation lists */
  role?: "listbox" | "list";
}

/** Default row selector (rows rendered by `Row`). */
export const ROW_SELECTOR = "[data-v2-row]";

/** A row the user can currently reach: not inside a collapsed group
 *  (`ListGroup` body is `hidden`), not itself hidden / inert / disabled. */
function isReachableRow(el: HTMLElement, root: HTMLElement): boolean {
  const gone = el.closest<HTMLElement>("[hidden], [inert]");
  if (gone && root.contains(gone)) return false;
  if (el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-hidden") === "true") return false;
  return true;
}

/**
 * Roving row focus inside `container`. Moves focus between rows matching
 * `selector` (default `[data-v2-row]`), SKIPPING rows in collapsed groups.
 * Returns true when the key was handled (caller should preventDefault).
 */
export function moveRowFocus(container: HTMLElement, key: string, vimKeys = false, selector: string = ROW_SELECTOR): boolean {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter((r) => isReachableRow(r, container));
  if (!rows.length) return false;
  const active = document.activeElement as HTMLElement | null;
  // focus may sit on a control INSIDE a row (e.g. a row action) — count that row
  const i = rows.findIndex((r) => r === active || (!!active && r.contains(active)));
  let j = -1;
  if (key === "ArrowDown" || (vimKeys && key === "j")) j = i < 0 ? 0 : Math.min(rows.length - 1, i + 1);
  else if (key === "ArrowUp" || (vimKeys && key === "k")) j = i < 0 ? 0 : Math.max(0, i - 1);
  else if (key === "Home") j = 0;
  else if (key === "End") j = rows.length - 1;
  if (j < 0) return false;
  rows[j].focus();
  rows[j].scrollIntoView?.({ block: "nearest" });
  return true;
}

export interface RowNavOptions {
  /** Row selector (default `[data-v2-row]`); e.g. `[data-gh-row]`. */
  selector?: string;
  /** Also accept j / k. */
  vimKeys?: boolean;
}

/**
 * The shared roving-row keyboard handler (↑/↓, j/k, Home/End) for ANY list
 * container — including grouped lists whose rows are not `Row`s:
 *   <div className="gh-groups" onKeyDown={rowNavKeyDown({ selector: "[data-gh-row]", vimKeys: true })}>
 * Never hijacks typing: ignored with modifiers and inside inputs / editors,
 * unless the event target is itself a row. Enter stays with the row.
 */
export function rowNavKeyDown({ selector = ROW_SELECTOR, vimKeys = false }: RowNavOptions = {}) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (!t.matches?.(selector) && isEditingTarget(t)) return;
    // a popup opened from a row (menu / listbox — portalled, but React still
    // bubbles its keys here) owns its own arrows
    const pop = t.closest?.('[role="menu"], [role="listbox"]');
    if (pop && pop !== e.currentTarget) return;
    if (moveRowFocus(e.currentTarget, e.key, vimKeys, selector)) e.preventDefault();
  };
}

export function List({ label, children, className, vimKeys, role = "listbox" }: ListProps) {
  const onKeyDown = rowNavKeyDown({ vimKeys });
  return (
    <div role={role} aria-label={label} className={`v2-list${className ? " " + className : ""}`} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export interface RowProps {
  id?: string;
  selected?: boolean;
  onActivate?: (e: ReactMouseEvent | ReactKeyboardEvent) => void;
  href?: string;
  children: ReactNode;
  className?: string;
  title?: string;
  /** "option" inside a listbox, "listitem"/"link" for nav lists */
  role?: "option" | "listitem";
  dim?: boolean; // de-emphasized (e.g. someone else's review)
}

export const Row = forwardRef<HTMLElement, RowProps>(function Row(
  { id, selected, onActivate, href, children, className, title, role = "option", dim },
  ref,
) {
  const cls = `v2-row${selected ? " is-selected" : ""}${dim ? " is-dim" : ""}${className ? " " + className : ""}`;
  const common = {
    "data-v2-row": "",
    "data-id": id,
    title,
    className: cls,
    role,
    "aria-selected": role === "option" ? !!selected : undefined,
    "aria-current": role !== "option" && selected ? ("true" as const) : undefined,
  };
  if (href) {
    return (
      <a ref={ref as Ref<HTMLAnchorElement>} href={href} {...common} tabIndex={0}
        onClick={onActivate ? (e) => onActivate(e) : undefined}>
        {children}
      </a>
    );
  }
  return (
    <div
      ref={ref as Ref<HTMLDivElement>}
      {...common}
      tabIndex={0}
      onClick={onActivate ? (e) => onActivate(e) : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if ((e.key === "Enter" || e.key === " ") && onActivate) { e.preventDefault(); onActivate(e); }
      }}
    >
      {children}
    </div>
  );
});
