/**
 * V2 Tooltip — a real, styled tooltip (never the native `title` alone).
 *
 *   <Tooltip label="Tasks · 40 open" placement="right"><Link …/></Tooltip>
 *
 * - role="tooltip", wired to the trigger with aria-describedby (the trigger
 *   keeps its own accessible name; the tooltip only describes).
 * - Shows on pointer hover (short delay; instant while another tooltip was
 *   just visible — Linear-style "warm" scrubbing along a rail) and on
 *   KEYBOARD focus (:focus-visible), hides on leave / blur / Escape / press.
 * - Placement: right | left | top | bottom, flipped when it would leave the
 *   viewport, clamped to an 8 px margin. Rendered in a portal with fixed
 *   positioning so sidebars / overflow containers never clip it.
 * - Self-styled (inline, from the --v2-* tokens) so it works wherever it is
 *   imported, with no stylesheet dependency. Class `v2-tooltip` for overrides.
 * - `shortcut` appends a keycap after the label (Linear style:
 *   `<Tooltip label="Search" shortcut="⌘K">`); it is also exposed to AT as
 *   part of the description ("Search, shortcut ⌘K").
 * - `disabled` renders the child untouched (e.g. an expanded sidebar row whose
 *   label is already visible).
 * The child must be a single element that accepts ref + event props (a DOM
 * element or a forwardRef component such as react-router's <Link>).
 */
import {
  cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement, type ReactNode, type Ref,
} from "react";
import { createPortal } from "react-dom";

export type TooltipPlacement = "right" | "left" | "top" | "bottom";

export interface TooltipProps {
  label: ReactNode;
  placement?: TooltipPlacement;
  /** hover delay in ms before the first tooltip shows (default 350) */
  delay?: number;
  disabled?: boolean;
  /** pixel gap between trigger and tooltip (default 8) */
  offset?: number;
  /** keyboard shortcut shown as a keycap after the label, e.g. "⌘K" or "[" */
  shortcut?: string;
  children: ReactElement;
}

/** a tooltip hidden less than this long ago makes the next one instant */
const WARM_MS = 600;
let lastHiddenAt = 0;
/** only ONE tooltip is ever visible (hover on one row + keyboard focus on another) */
let activeHide: (() => void) | null = null;

const MARGIN = 8;

const BASE_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 80, // above the palette (70) — tooltips are transient and pointer-less
  maxWidth: 280,
  padding: "5px 8px",
  borderRadius: 6,
  background: "var(--v2-raised, #202126)",
  border: "1px solid var(--v2-border-strong, #3A3D45)",
  boxShadow: "var(--v2-shadow-pop, 0 8px 24px rgba(0,0,0,.45))",
  color: "var(--v2-text, #EEEFF2)",
  font: "500 12px/1.35 var(--v2-font-sans, Inter, system-ui, sans-serif)",
  letterSpacing: 0,
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  pointerEvents: "none",
  userSelect: "none",
};

/** Pure placement math (exported for unit tests). */
export function placeTooltip(
  anchor: { top: number; left: number; right: number; bottom: number; width: number; height: number },
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: TooltipPlacement,
  offset = 8,
): { top: number; left: number; placement: TooltipPlacement } {
  const fits = (p: TooltipPlacement) =>
    p === "right" ? anchor.right + offset + tip.width <= viewport.width - MARGIN
      : p === "left" ? anchor.left - offset - tip.width >= MARGIN
        : p === "top" ? anchor.top - offset - tip.height >= MARGIN
          : anchor.bottom + offset + tip.height <= viewport.height - MARGIN;
  const opposite: Record<TooltipPlacement, TooltipPlacement> = { right: "left", left: "right", top: "bottom", bottom: "top" };
  const p = fits(placement) || !fits(opposite[placement]) ? placement : opposite[placement];
  let top: number;
  let left: number;
  if (p === "right" || p === "left") {
    top = anchor.top + anchor.height / 2 - tip.height / 2;
    left = p === "right" ? anchor.right + offset : anchor.left - offset - tip.width;
  } else {
    left = anchor.left + anchor.width / 2 - tip.width / 2;
    top = p === "bottom" ? anchor.bottom + offset : anchor.top - offset - tip.height;
  }
  const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, Math.max(MARGIN, max - MARGIN)));
  return { top: Math.round(clamp(top, viewport.height - tip.height)), left: Math.round(clamp(left, viewport.width - tip.width)), placement: p };
}

function setRef<T>(ref: Ref<T> | undefined, value: T) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as { current: T }).current = value;
}

function focusVisible(el: Element): boolean {
  try { return el.matches(":focus-visible"); } catch { return true; }
}

type ChildProps = {
  ref?: Ref<HTMLElement>;
  "aria-describedby"?: string;
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  onMouseDown?: (e: MouseEvent<HTMLElement>) => void;
};

const KBD_STYLE: CSSProperties = {
  display: "inline-block", marginLeft: 8, minWidth: 18, padding: "0 5px", borderRadius: 4, textAlign: "center",
  border: "1px solid var(--v2-border-strong, #33353A)", color: "var(--v2-text-2, #AAADB7)",
  font: "500 11px/16px var(--v2-font-sans, Inter, system-ui, sans-serif)", verticalAlign: "baseline",
};

export function Tooltip({ label, placement = "right", delay = 350, disabled, offset = 8, shortcut, children }: TooltipProps) {
  const id = useId();
  const tipId = `v2-tip-${id.replace(/:/g, "")}`;
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const hide = useCallback(() => {
    clear();
    if (activeHide === hideRef.current) activeHide = null;
    setOpen((was) => { if (was) lastHiddenAt = Date.now(); return false; });
  }, []);
  const hideRef = useRef(hide);
  hideRef.current = hide;
  const reveal = useCallback(() => {
    if (activeHide && activeHide !== hideRef.current) activeHide();
    activeHide = hideRef.current;
    setOpen(true);
  }, []);
  const show = useCallback((immediate: boolean) => {
    clear();
    if (immediate || Date.now() - lastHiddenAt < WARM_MS || delay <= 0) reveal();
    else timer.current = setTimeout(reveal, delay);
  }, [delay, reveal]);

  useEffect(() => () => { clear(); if (activeHide === hideRef.current) activeHide = null; }, []);
  useEffect(() => { if (disabled) hide(); }, [disabled, hide]);

  // position after the tooltip mounts (measure → place), and keep it glued on scroll/resize
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const a = anchorRef.current;
      const t = tipRef.current;
      if (!a || !t) return;
      const r = a.getBoundingClientRect();
      const res = placeTooltip(r, { width: t.offsetWidth, height: t.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, placement, offset);
      setPos({ top: res.top, left: res.left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, placement, offset, label]);

  // Escape anywhere dismisses (WCAG 1.4.13 dismissible)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") hide(); };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, hide]);

  if (!isValidElement(children)) return children ?? null;
  if (disabled || label == null || label === "") return children;

  const child = children as ReactElement<ChildProps> & { ref?: Ref<HTMLElement> };
  const p = child.props;
  const describedBy = [p["aria-describedby"], open ? tipId : null].filter(Boolean).join(" ") || undefined;

  const trigger = cloneElement(child, {
    ref: (el: HTMLElement | null) => { anchorRef.current = el; setRef(child.ref, el); },
    "aria-describedby": describedBy,
    onPointerEnter: (e: PointerEvent<HTMLElement>) => { p.onPointerEnter?.(e); if (e.pointerType !== "touch") show(false); },
    onPointerLeave: (e: PointerEvent<HTMLElement>) => { p.onPointerLeave?.(e); if (!(anchorRef.current && anchorRef.current.contains(document.activeElement) && focusVisible(anchorRef.current))) hide(); },
    onFocus: (e: FocusEvent<HTMLElement>) => { p.onFocus?.(e); if (focusVisible(e.currentTarget)) show(true); },
    onBlur: (e: FocusEvent<HTMLElement>) => { p.onBlur?.(e); hide(); },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => { p.onKeyDown?.(e); if (e.key === "Escape" && open) hide(); },
    onMouseDown: (e: MouseEvent<HTMLElement>) => { p.onMouseDown?.(e); hide(); },
  } as Partial<ChildProps>);

  return (
    <>
      {trigger}
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={tipRef}
          id={tipId}
          role="tooltip"
          className="v2-tooltip"
          style={{ ...BASE_STYLE, top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}
        >
          {label}
          {shortcut ? <><span className="v2-sr">, shortcut </span><kbd className="v2-tooltip-kbd" style={KBD_STYLE}>{shortcut}</kbd></> : null}
        </div>,
        document.body,
      )}
    </>
  );
}
