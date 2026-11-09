/**
 * Full screen for a page element, with a fallback (#288). The Fullscreen API is used when the
 * document allows it; when it does not (a WKWebView without element full screen, an iframe
 * without `allowfullscreen`) or the request is refused, the element is "expanded" instead: it
 * fills the window in the page's top layer and Escape leaves. `useFullscreen` wires this to React.
 */

/** Off, the browser's own full screen, or the in-page fallback that fills the window. */
export type FullscreenMode = "off" | "native" | "expanded";

/** The slice of `document` the helpers read (a plain object in tests). */
export interface FullscreenDoc {
  fullscreenEnabled?: boolean;
  fullscreenElement?: unknown;
  exitFullscreen?: () => Promise<void>;
}

/** The slice of an element the helpers use. */
export interface FullscreenTarget {
  requestFullscreen?: () => Promise<void>;
  showPopover?: () => void;
  hidePopover?: () => void;
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
}

/**
 * The classes an expanded element takes: the whole window, above everything else. They also
 * undo a popover's own look (margin, border, padding, Canvas colours) when it is lifted; the
 * element supplies its background.
 */
export const EXPANDED_CLASS = "fixed inset-0 z-50 m-0 h-dvh max-h-none w-screen max-w-none border-0 p-0 text-fg";

export function fullscreenLabel(mode: FullscreenMode): string {
  return mode === "off" ? "Full screen" : "Exit full screen";
}

/**
 * Enter full screen: `"native"` when the document allows the Fullscreen API and the request
 * succeeds, `"expanded"` otherwise (not allowed, not supported, refused or thrown).
 */
export async function enterFullscreen(el: FullscreenTarget, doc: FullscreenDoc): Promise<"native" | "expanded"> {
  if (!doc.fullscreenEnabled || typeof el.requestFullscreen !== "function") return "expanded";
  try {
    await el.requestFullscreen();
    return "native";
  } catch {
    return "expanded";
  }
}

/** Leave the browser's full screen, if anything is in it. Never throws. */
export async function exitNativeFullscreen(doc: FullscreenDoc): Promise<void> {
  if (!doc.fullscreenElement || typeof doc.exitFullscreen !== "function") return;
  try {
    await doc.exitFullscreen();
  } catch {
    /* already left */
  }
}

/** The mode after a `fullscreenchange`: native while `el` is the full screen element. */
export function modeAfterChange(current: FullscreenMode, el: unknown, doc: FullscreenDoc): FullscreenMode {
  if (el != null && doc.fullscreenElement === el) return "native";
  return current === "native" ? "off" : current;
}

/**
 * Whether an Escape press leaves the expanded mode. Read after the event has gone to every
 * listener: a component that used Escape itself (closing an inspector, leaving a focus mode)
 * calls `preventDefault()`, and a dialog or menu open over the element keeps its own Escape.
 */
export function escapeLeavesExpanded(e: { key: string; defaultPrevented: boolean; target?: unknown }): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  const t = e.target as { closest?: (selector: string) => unknown } | null | undefined;
  return !(t && typeof t.closest === "function" && t.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']"));
}

/**
 * Lift an expanded element into the top layer (a manual popover), so no ancestor's transform,
 * overflow or stacking context can pin it inside the page. Returns whether it was lifted; when
 * popovers are not supported the `EXPANDED_CLASS` positioning alone fills the window.
 */
export function liftToTopLayer(el: FullscreenTarget): boolean {
  if (typeof el.showPopover !== "function" || typeof el.setAttribute !== "function") return false;
  try {
    el.setAttribute("popover", "manual");
    el.showPopover();
    return true;
  } catch {
    el.removeAttribute?.("popover");
    return false;
  }
}

export function dropFromTopLayer(el: FullscreenTarget): void {
  try {
    el.hidePopover?.();
  } catch {
    /* already hidden */
  }
  el.removeAttribute?.("popover");
}
