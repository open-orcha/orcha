/**
 * Learn — the inline lens: selecting code in the read view floats a small pill
 * above the selection with "Teach · Why" (start a lesson on exactly those lines)
 * and "Ask" (the existing thread composer, pre-anchored to the range). It is the
 * text-selection counterpart of the gutter's click-a-line-number affordance.
 *
 * Lines come from the selection's endpoints' closest `[data-cs-line]` rows, so the
 * lens works on the hand-rolled read view (CodeSpacePage `.cs-line`). It hides on
 * collapse, Escape, and scroll (the pill is position:fixed at the selection rect).
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/ui";

export interface LensRange {
  start: number;
  end: number;
}

export interface SelectionLensProps {
  /** Element whose descendants carry `data-cs-line` (the code body). */
  root: HTMLElement | null;
  disabled?: boolean;
  busy?: boolean;
  onTeach: (r: LensRange) => void;
  onWhy: (r: LensRange) => void;
  onAsk: (r: LensRange) => void;
  /** The latest text-selection line range (sticky: a collapse doesn't clear it), for the Learn quick starts. */
  onRangeChange?: (r: LensRange) => void;
}

function lineOf(node: Node | null): number | null {
  const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
  const row = el?.closest?.("[data-cs-line]") as HTMLElement | null;
  const n = row ? Number(row.getAttribute("data-cs-line")) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/** Pure-ish: the line range a DOM Selection covers inside `root` (null = none / outside). */
export function selectionLines(sel: Selection | null, root: HTMLElement | null): LensRange | null {
  if (!sel || !root || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!sel.toString().trim()) return null;
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const a = lineOf(sel.anchorNode);
  const b = lineOf(sel.focusNode);
  if (a == null || b == null) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export function SelectionLens({ root, disabled, busy, onTeach, onWhy, onAsk, onRangeChange }: SelectionLensProps) {
  const [state, setState] = useState<{ range: LensRange; top: number; left: number; below: boolean } | null>(null);
  const onRangeRef = useRef(onRangeChange);
  onRangeRef.current = onRangeChange;
  const lastKey = useRef("");

  useEffect(() => {
    if (!root || disabled) { setState(null); return; }
    const report = (r: LensRange) => {
      const key = r.start + "-" + r.end;
      if (key !== lastKey.current) { lastKey.current = key; onRangeRef.current?.(r); }
    };
    const measure = () => {
      const sel = window.getSelection();
      const range = selectionLines(sel, root);
      if (range) report(range);
      if (!range || !sel) { setState(null); return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      // clamp inside the code pane (never over the tree or the rail)
      const pane = (root.closest(".cs-code-scroll") as HTMLElement | null)?.getBoundingClientRect();
      const lo = (pane ? pane.left : 0) + 110, hi = (pane ? pane.right : window.innerWidth || 1024) - 110;
      const below = rect.top - (pane ? pane.top : 0) < 48;
      const left = hi > lo ? Math.min(Math.max(rect.left + rect.width / 2, lo), hi) : rect.left + rect.width / 2;
      setState({ range, top: below ? rect.bottom + 8 : rect.top - 8, left, below });
    };
    const onUp = () => requestAnimationFrame(measure);
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setState(null);
    };
    const hide = () => setState(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setState(null);
      else if (e.shiftKey && e.key.startsWith("Arrow")) requestAnimationFrame(measure);
    };
    root.addEventListener("mouseup", onUp);
    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("keyup", onKey);
    const scroller = root.closest(".cs-code-scroll");
    scroller?.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("resize", hide);
    return () => {
      root.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("keyup", onKey);
      scroller?.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
    };
  }, [root, disabled]);

  if (!state) return null;
  const { range } = state;
  const where = range.start === range.end ? "line " + range.start : "lines " + range.start + "–" + range.end;
  const act = (fn: (r: LensRange) => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    fn(range);
    setState(null);
    try { window.getSelection()?.removeAllRanges(); } catch { /* jsdom */ }
  };

  return (
    <div
      className={"cs-lens" + (state.below ? " is-below" : "")}
      style={{ top: state.top, left: state.left }}
      role="toolbar"
      aria-label={"Learn about " + where}
      // keep the text selection alive while clicking the pill
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="cs-lens-btn is-teach" disabled={busy} onClick={act(onTeach)} title={"Teach me the concept in " + where}>
        <Icon name="spark" cls="v2-ico" /> Teach
      </button>
      <span className="cs-lens-sep" aria-hidden="true">·</span>
      <button type="button" className="cs-lens-btn" disabled={busy} onClick={act(onWhy)} title={"Why is " + where + " written this way?"}>
        Why
      </button>
      <span className="cs-lens-div" aria-hidden="true" />
      <button type="button" className="cs-lens-btn is-ask" onClick={act(onAsk)} title={"Ask about " + where}>
        Ask…
      </button>
    </div>
  );
}
