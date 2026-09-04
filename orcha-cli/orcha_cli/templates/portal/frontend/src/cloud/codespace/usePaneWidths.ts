/**
 * Pure width-state for the three resizable Code Space panes (tree | code |
 * rail — the code pane is the flexible middle, never persisted directly:
 * its width falls out of the container minus tree/rail). Persists to
 * localStorage under "orcha:cs:panes", namespaced GLOBALLY (not per-project)
 * since a human's preferred pane widths are a UI preference, not per-repo
 * data — matches shell/Shell.tsx's theme-persistence convention (global key,
 * try/catch private-mode guard).
 *
 * No DOM/pointer-event code here — CodeSpacePage.tsx owns the actual
 * pointerdown/move/up wiring and calls dragTree/dragRail with the delta
 * since the last event; this hook only clamps + persists the resulting
 * widths. Keeping the two separate makes the width math trivially unit-
 * testable without mounting anything or faking PointerEvent.
 */
import { useCallback, useState } from "react";

export interface PaneWidths {
  tree: number;
  rail: number;
}

export const DEFAULT_WIDTHS: PaneWidths = { tree: 280, rail: 340 };
export const MIN_WIDTHS: PaneWidths = { tree: 160, rail: 240 };
// The code pane's own min-width (320px per spec) is enforced by the CALLER
// (CodeSpacePage.tsx), which knows the container's total width and can
// clamp tree/rail deltas against how much room the code pane has left —
// this hook has no way to know the container width on its own.
export const CODE_MIN_WIDTH = 320;

const STORAGE_KEY = "orcha:cs:panes";

function loadPersisted(): PaneWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTHS;
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed === "object" &&
      typeof parsed.tree === "number" && typeof parsed.rail === "number"
    ) {
      return { tree: parsed.tree, rail: parsed.rail };
    }
    return DEFAULT_WIDTHS;
  } catch {
    return DEFAULT_WIDTHS; // private mode / corrupt JSON — degrade to defaults, never throw
  }
}

function persist(widths: PaneWidths): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    /* private mode — in-memory state still lets the current session resize */
  }
}

export interface UsePaneWidthsResult {
  widths: PaneWidths;
  // delta is raw screen-space pointer movement (positive = moved right).
  // Each pane's own drag handler applies it in ITS natural growth direction
  // — dragTree grows on a rightward delta (its divider sits on its RIGHT
  // edge), dragRail grows on a LEFTWARD delta (its divider sits on its LEFT
  // edge) — callers always pass the raw pointer delta unmodified; the sign
  // flip for the rail lives HERE, not in the caller.
  dragTree: (delta: number) => void;
  dragRail: (delta: number) => void;
  resetTree: () => void;
  resetRail: () => void;
}

export function usePaneWidths(): UsePaneWidthsResult {
  const [widths, setWidths] = useState<PaneWidths>(loadPersisted);

  const dragTree = useCallback((delta: number) => {
    setWidths((prev) => {
      const next = { ...prev, tree: Math.max(MIN_WIDTHS.tree, prev.tree + delta) };
      persist(next);
      return next;
    });
  }, []);

  const dragRail = useCallback((delta: number) => {
    setWidths((prev) => {
      const next = { ...prev, rail: Math.max(MIN_WIDTHS.rail, prev.rail - delta) };
      persist(next);
      return next;
    });
  }, []);

  const resetTree = useCallback(() => {
    setWidths((prev) => {
      const next = { ...prev, tree: DEFAULT_WIDTHS.tree };
      persist(next);
      return next;
    });
  }, []);

  const resetRail = useCallback(() => {
    setWidths((prev) => {
      const next = { ...prev, rail: DEFAULT_WIDTHS.rail };
      persist(next);
      return next;
    });
  }, []);

  return { widths, dragTree, dragRail, resetTree, resetRail };
}
