/**
 * Pure line-selection helpers for the code viewer's gutter affordance — click
 * a line number to select it, shift-click (or drag) a range. No DOM/state:
 * CodeSpacePage owns the actual selection state and calls these.
 */
export interface LineSelection {
  start: number;
  end: number; // end >= start
}

export function singleLine(line: number): LineSelection {
  return { start: line, end: line };
}

// Range selection: clicking a second line (anchor already picked) extends to
// cover [min(anchor,line), max(anchor,line)] — a normal shift-click range.
export function rangeFrom(anchor: number, line: number): LineSelection {
  return { start: Math.min(anchor, line), end: Math.max(anchor, line) };
}

export function isLineSelected(sel: LineSelection | null, line: number): boolean {
  return !!sel && line >= sel.start && line <= sel.end;
}
