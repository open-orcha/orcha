/**
 * Focus utilities shared by Dialog, Menu/Popover and the command palette:
 * focusable discovery, a Tab-cycling trap, and "restore focus to whoever
 * opened me" on close (brief §7: restore focus on dialog close).
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
}

/** Keep Tab / Shift+Tab inside `ref` while `active`. */
export function trapTab(e: KeyboardEvent | ReactKeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const els = focusables(root);
  if (!els.length) { e.preventDefault(); root.focus(); return; }
  const first = els[0];
  const last = els[els.length - 1];
  const ae = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (ae === first || !root.contains(ae))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (ae === last || !root.contains(ae))) { e.preventDefault(); first.focus(); }
}

/**
 * On mount: remember the previously focused element and move focus into
 * `ref` (the `initial` element, else the first focusable, else the root).
 * On unmount: restore focus to the remembered element if it is still in the
 * document.
 */
export function useFocusReturn(ref: RefObject<HTMLElement | null>, initial?: RefObject<HTMLElement | null>): void {
  // Capture the opener during the FIRST RENDER, not in the effect: React
  // applies `autoFocus` on dialog content during commit, before effects run,
  // so reading activeElement in the effect recorded the dialog's own input
  // (removed on close) and focus fell to <body> (QA: New task dialog).
  const prev = useRef<HTMLElement | null>(null);
  const captured = useRef(false);
  if (!captured.current) {
    captured.current = true;
    prev.current = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  }
  useEffect(() => {
    // Content that already took focus (autoFocus) keeps it, unless an
    // explicit `initial` target was requested.
    const root = ref.current;
    const ae = document.activeElement;
    const alreadyInside = !!(root && ae && ae !== root && root.contains(ae));
    if (initial?.current || !alreadyInside) {
      const target = initial?.current || focusables(root)[0] || root;
      target?.focus?.();
    }
    return () => {
      const p = prev.current;
      if (p && document.contains(p) && typeof p.focus === "function") p.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Is focus inside a code editor / terminal / text entry that owns its keys? */
export function isEditingTarget(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  if (h.isContentEditable) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(h.tagName || "")) return true;
  return !!(h.closest && h.closest(".cm-editor, .xterm"));
}

/** Inside CodeMirror or xterm (they may bind Cmd/Ctrl+K themselves). */
export function isEditorOrTerminal(el: Element | null): boolean {
  return !!(el && (el as HTMLElement).closest && (el as HTMLElement).closest(".cm-editor, .xterm"));
}
