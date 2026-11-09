import { useCallback, useState } from "react";

/**
 * The Map's detail panel frame: docked at the canvas's right edge (a bottom sheet on a narrow
 * window), full over the whole canvas, or collapsed to a slim rail (a bar on a narrow window).
 * The mode and which sections the reader folded are a per-viewer convenience kept in
 * localStorage; without storage (a private window, blocked site data) both simply start over.
 */
export type PanelMode = "docked" | "full" | "collapsed";

export const PANEL_MODE_KEY = "orcha:qa:map-panel-mode";
export const PANEL_SECTIONS_KEY = "orcha:qa:map-panel-sections";

const MODES: readonly PanelMode[] = ["docked", "full", "collapsed"];

export function readPanelMode(): PanelMode {
  try {
    const v = localStorage.getItem(PANEL_MODE_KEY);
    return MODES.includes(v as PanelMode) ? (v as PanelMode) : "docked";
  } catch {
    return "docked";
  }
}

export function writePanelMode(mode: PanelMode): void {
  try {
    localStorage.setItem(PANEL_MODE_KEY, mode);
  } catch {
    /* a convenience */
  }
}

/** The sections the reader closed, by section id. Every other section is open. */
export function readClosedSections(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PANEL_SECTIONS_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeClosedSections(closed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(PANEL_SECTIONS_KEY, JSON.stringify([...closed].sort()));
  } catch {
    /* a convenience */
  }
}

/** The panel's mode, remembered for this viewer. It outlives the panel (picking another node, or
 * closing and opening it again, keeps it), so the map view holds it: its Esc leaves full first. */
export function usePanelMode(): [PanelMode, (mode: PanelMode) => void] {
  // The panel only renders once something is picked, never on the server, so reading storage in
  // the initializer cannot mismatch hydration.
  const [mode, setMode] = useState<PanelMode>(() => (typeof window === "undefined" ? "docked" : readPanelMode()));
  const set = useCallback((next: PanelMode) => {
    setMode(next);
    writePanelMode(next);
  }, []);
  return [mode, set];
}

/** Which sections are open, remembered for this viewer. */
export function useSectionState(): { isOpen: (id: string) => boolean; toggle: (id: string) => void } {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => (typeof window === "undefined" ? new Set() : readClosedSections()));
  const isOpen = useCallback((id: string) => !closed.has(id), [closed]);
  const toggle = useCallback((id: string) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeClosedSections(next);
      return next;
    });
  }, []);
  return { isOpen, toggle };
}

export type Box = { left: number; top: number; width: number; height: number };

/**
 * Where a panel tooltip goes, so it never covers the panel's own rows: beside the docked panel
 * (over the canvas, level with its trigger) when there is room, else to the right of the trigger
 * when that row has room and the tip is no taller than the row's padding allows, else below it,
 * else above it. Always inside the viewport.
 */
export function placeTip(
  trigger: Box,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  panel: Box | null,
  gap = 8,
): { left: number; top: number; side: "beside-panel" | "right" | "below" | "above" } {
  const clampTop = (t: number) => Math.min(Math.max(gap, t), Math.max(gap, viewport.height - tip.height - gap));
  const clampLeft = (l: number) => Math.min(Math.max(gap, l), Math.max(gap, viewport.width - tip.width - gap));
  const midTop = trigger.top + trigger.height / 2 - tip.height / 2;
  if (panel && panel.left - tip.width - gap * 2 >= 0) return { left: panel.left - tip.width - gap, top: clampTop(midTop), side: "beside-panel" };
  const right = trigger.left + trigger.width + gap;
  const room = panel ? panel.left + panel.width : viewport.width;
  if (right + tip.width + gap <= room && tip.height <= trigger.height + 24) return { left: right, top: clampTop(midTop), side: "right" };
  const below = trigger.top + trigger.height + gap;
  if (below + tip.height + gap <= viewport.height) return { left: clampLeft(trigger.left), top: below, side: "below" };
  return { left: clampLeft(trigger.left), top: clampTop(trigger.top - gap - tip.height), side: "above" };
}
