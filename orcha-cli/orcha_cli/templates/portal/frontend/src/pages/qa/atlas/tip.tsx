import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../map/kit";
import styles from "./atlas.module.css";

/** A hover waits this long before the tip shows (a pointer passing over does not flash it), and
 * this long before it goes (so the pointer can cross onto the tip and read it). */
const SHOW_MS = 220;
const HIDE_MS = 140;
const GAP = 6;
const EDGE = 8;

export interface Tip {
  /** For the trigger's `aria-describedby`: a hidden copy of the words, always in the page, so a
   * screen reader hears them whether or not the tip is shown. */
  describedBy: string;
  open: boolean;
  /** The element it points at, given by the last `show`. */
  anchorEl: HTMLElement | null;
  /** Where it renders: the open `<dialog>` its anchor sits in, else the body. */
  host: HTMLElement | null;
  /** Points at `el`: on hover after a beat, on focus `now`. */
  show: (el: Element | null, now?: boolean) => void;
  hide: (now?: boolean) => void;
}

/** When Tab was last pressed: a focus right after it is someone moving through the page. */
let tabbedAt = -Infinity;
function listenForTab() {
  if (typeof document === "undefined" || (listenForTab as { on?: boolean }).on) return;
  (listenForTab as { on?: boolean }).on = true;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab") tabbedAt = performance.now();
  }, true);
}

/**
 * A focus that came from moving through the page with Tab: not a click, and not a dialog handing
 * focus back after Escape (the tip would pop up as the panel closes).
 */
export function keyboardFocus(el: Element): boolean {
  listenForTab();
  try {
    return el.matches(":focus-visible") && performance.now() - tabbedAt < 1000;
  } catch {
    return false;
  }
}

/**
 * A tip that explains a small thing (a similarity badge, a count) on hover and on keyboard focus.
 * Pair it with `<TipBubble>`, rendered outside any button.
 */
export function useTip(): Tip {
  const id = useId();
  useEffect(listenForTab, []);
  const [open, setOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((el: Element | null, now = false) => {
    window.clearTimeout(timer.current);
    if (!(el instanceof HTMLElement)) return;
    const go = () => {
      if (!el.isConnected) return;
      setAnchorEl(el);
      setHost((el.closest("dialog[open]") as HTMLElement | null) ?? document.body);
      setOpen(true);
    };
    if (now) go();
    else timer.current = window.setTimeout(go, SHOW_MS);
  }, []);
  const hide = useCallback((now = false) => {
    window.clearTimeout(timer.current);
    if (now) setOpen(false);
    else timer.current = window.setTimeout(() => setOpen(false), HIDE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { describedBy: `${id}words`, open, anchorEl, host, show, hide };
}

/**
 * The tip itself, in a portal so nothing clips it (a card paints inside itself): into the open
 * `<dialog>` its anchor sits in (a modal dialog is in the top layer, above anything in the body),
 * else into `document.body`. Under its anchor (above when the window ends first), kept inside the
 * window. Escape hides it without closing a dialog around it, scrolling hides it, and the pointer
 * can cross onto it (WCAG 1.4.13). Its words are also always in the page, hidden, as the trigger's
 * description for a screen reader (`tip.describedBy`).
 */
export function TipBubble({ tip, words, children }: { tip: Tip; words: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const { open, host, anchorEl, show, hide } = tip;

  useLayoutEffect(() => {
    const el = box.current;
    if (!open || !el || !anchorEl) return;
    const a = anchorEl.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = a.bottom + GAP + h <= window.innerHeight - EDGE || a.top - GAP - h < EDGE;
    const left = Math.min(Math.max(EDGE, a.left + a.width / 2 - w / 2), window.innerWidth - EDGE - w);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(below ? a.bottom + GAP : a.top - GAP - h)}px`;
    el.style.setProperty("--tip-x", `${Math.round(a.left + a.width / 2 - left)}px`);
    el.dataset.side = below ? "below" : "above";
  }, [open, host, anchorEl]);

  useEffect(() => {
    if (!open) return;
    // Escape is the tip's first: it goes, and the dialog around it stays.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      hide(true);
    };
    const away = () => hide(true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [open, hide]);

  return (
    <>
      {/* Hidden, yet read as the trigger's description (aria-describedby reads a hidden element
          it names), so browsing the page does not read it a second time beside the trigger. */}
      <span id={tip.describedBy} hidden>
        {words}
      </span>
      {open && host
        ? createPortal(
            <div
              ref={box}
              aria-hidden
              className={cn("qa-port", styles.palette, styles.tip)}
              style={{ left: -9999, top: -9999 }}
              onMouseEnter={() => show(anchorEl, true)}
              onMouseLeave={() => hide()}
              data-atlas-tip
            >
              {children}
            </div>,
            host,
          )
        : null}
    </>
  );
}
