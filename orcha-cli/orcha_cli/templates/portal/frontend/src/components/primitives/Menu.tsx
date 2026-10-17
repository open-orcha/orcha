/**
 * Popover + Menu. Popover: anchored floating panel (portaled, fixed position
 * computed from the anchor, clamped to the viewport), closes on outside
 * pointer-down and Escape, and returns focus to the anchor. Menu: a Popover
 * with role="menu" whose items are roving-focus menuitems (↑/↓/Home/End,
 * Enter/Space activates, Escape closes + returns focus). Every hover action in
 * V2 should also be reachable through a Menu (keyboard + touch).
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useInRouterContext, useNavigate, type NavigateFunction } from "react-router-dom";
import { focusables, trapTab } from "./focus";
import { Icon } from "../ui";

export interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: "bottom-start" | "bottom-end" | "right-start";
  role?: string;
  label?: string;
  className?: string;
  id?: string;
  /** keep focus inside (dialog-like popovers such as Execution controls) */
  trap?: boolean;
  /** move focus into the popover on open (default true) */
  autoFocus?: boolean;
}

function place(anchor: HTMLElement | null, placement: PopoverProps["placement"], w: number, h: number) {
  const r = anchor?.getBoundingClientRect() ?? { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  let top = r.bottom + 6;
  let left = r.left;
  if (placement === "bottom-end") left = r.right - w;
  if (placement === "right-start") { top = r.top; left = r.right + 6; }
  left = Math.max(8, Math.min(left, vw - w - 8));
  if (top + h > vh - 8) top = Math.max(8, (placement === "right-start" ? r.bottom : r.top) - h - 6);
  return { top: Math.round(top), left: Math.round(left) };
}

export function Popover({ anchor, open, onClose, children, placement = "bottom-start", role, label, className, id, trap, autoFocus = true }: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const el = ref.current;
    setPos(place(anchor.current, placement, el?.offsetWidth || 240, el?.offsetHeight || 200));
  }, [open, anchor, placement]);

  useEffect(() => {
    if (!open) return;
    if (autoFocus) {
      const first = ref.current && (ref.current.querySelector<HTMLElement>('[role="menuitem"],[role="menuitemradio"]') || focusables(ref.current)[0]);
      (first || ref.current)?.focus();
    }
    const onDown = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      // a confirm dialog opened FROM this popover sits above it — clicks there
      // must not close (and unmount) the popover that owns the dialog.
      if (t instanceof Element && t.closest('.overlay, .v2-overlay, [role="dialog"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.querySelector(".overlay.show, .v2-overlay")) return; // the dialog above handles Escape
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    const onResize = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, onClose, anchor, autoFocus]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={`v2-popover${className ? " " + className : ""}`}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
      onKeyDown={(e) => {
        // Escape inside the popover is the popover's: close it, return focus to
        // the anchor, and STOP it here — the popover is portaled but React
        // events still bubble through the component tree, so an unhandled Esc
        // would reach a Dialog that owns the anchor and close the whole dialog.
        if (e.key === "Escape") {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation?.();
          onClose();
          anchor.current?.focus();
          return;
        }
        if (trap) trapTab(e, ref.current);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItemSpec {
  label: string;
  icon?: string;
  href?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  hint?: string;
  /** Radio-style choice: when set (true OR false) the item is a
   *  `menuitemradio` with `aria-checked`, so the current value is announced. */
  checked?: boolean;
}

/** Router navigate when rendered inside a Router, else null (Menu is also used
 *  outside the router in isolated tests / host overlays). The router context
 *  never appears or disappears during a mount, so the hook order is stable. */
function useOptionalNavigate(): NavigateFunction | null {
  const inRouter = useInRouterContext();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return inRouter ? useNavigate() : null;
}

/** An in-app link a Menu may route client-side: same origin, and not a project
 *  switch (a different `cid` needs the full navigation that drops per-project
 *  state — lib/scope switchProject). */
export function inAppHref(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  let u: URL;
  try { u = new URL(href, window.location.href); } catch { return null; }
  if (u.origin !== window.location.origin) return null;
  const cid = u.searchParams.get("cid");
  const cur = new URLSearchParams(window.location.search).get("cid");
  if (cid && cur && cid !== cur) return null;
  if (cid && !cur) return null;
  return u.pathname + u.search + u.hash;
}

/** Roving-focus keyboard handling for [role=menuitem] children. */
function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]),[role="menuitemradio"]:not([aria-disabled="true"])'));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let j = -1;
  if (e.key === "ArrowDown") j = (i + 1) % items.length;
  else if (e.key === "ArrowUp") j = (i - 1 + items.length) % items.length;
  else if (e.key === "Home") j = 0;
  else if (e.key === "End") j = items.length - 1;
  if (j >= 0) { e.preventDefault(); items[j].focus(); }
}

export function Menu({ anchor, open, onClose, items, label, placement, id }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void;
  items: (MenuItemSpec | "separator")[]; label: string; placement?: PopoverProps["placement"]; id?: string;
}) {
  const navigate = useOptionalNavigate();
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} role="menu" label={label} placement={placement} id={id} className="v2-menu">
      <div onKeyDown={onMenuKey} className="v2-menu-inner">
        {items.map((it, i) => {
          if (it === "separator") return <div key={"s" + i} role="separator" className="v2-menu-sep" />;
          const cls = "v2-menu-item" + (it.danger ? " danger" : "");
          const radio = it.checked !== undefined;
          const role = radio ? "menuitemradio" : "menuitem";
          const checkedAttr = radio ? { "aria-checked": !!it.checked } : {};
          const inner = (
            <>
              {it.icon ? <Icon name={it.icon} cls="v2-ico" /> : <span className="v2-ico-spacer" />}
              <span className="v2-menu-label">{it.label}</span>
              {it.checked ? <Icon name="check" cls="v2-ico v2-menu-check" /> : null}
              {it.hint ? <span className="v2-menu-hint">{it.hint}</span> : null}
            </>
          );
          if (it.href && !it.disabled) {
            return (
              <a key={i} role={role} {...checkedAttr} tabIndex={-1} className={cls} href={it.href}
                onClick={(e) => {
                  onClose();
                  it.onSelect?.();
                  // in-app links route client-side (no reload); modified clicks,
                  // external links and project switches keep the browser default
                  const to = navigate && !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey ? inAppHref(it.href!) : null;
                  if (to != null) { e.preventDefault(); navigate!(to); }
                }}
                onKeyDown={(e) => {
                  if (e.key === " ") { e.preventDefault(); e.currentTarget.click(); }
                }}>
                {inner}
              </a>
            );
          }
          return (
            <div
              key={i} role={role} {...checkedAttr} tabIndex={-1} className={cls}
              aria-disabled={it.disabled || undefined}
              title={it.disabled ? it.disabledReason : undefined}
              onClick={() => { if (it.disabled) return; onClose(); it.onSelect?.(); }}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !it.disabled) { e.preventDefault(); onClose(); it.onSelect?.(); }
              }}
            >
              {inner}
            </div>
          );
        })}
      </div>
    </Popover>
  );
}

/**
 * MenuButton — compact (28 px) button that opens a Menu; the replacement for
 * native <select>s and ad-hoc filter chips in toolbars. Sized to content.
 * Shows `label` (e.g. "Sort") and the current `value` text; `items` mark the
 * current choice with `checked`.
 */
export function MenuButton({ label, value, items, icon, menuLabel, variant = "secondary", size = "md", placement = "bottom-start", className, disabled, title }: {
  label?: ReactNode; value?: ReactNode; items: (MenuItemSpec | "separator")[]; icon?: string; menuLabel: string;
  variant?: "secondary" | "ghost"; size?: "sm" | "md"; placement?: PopoverProps["placement"]; className?: string;
  disabled?: boolean; title?: string;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        className={`v2-btn v2-btn-${variant} v2-btn-${size} v2-menubtn${className ? " " + className : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        {icon ? <Icon name={icon} cls="v2-ico v2-btn-ico" /> : null}
        <span className="v2-btn-label">
          {label != null && value != null ? <><span className="v2-menubtn-k">{label}</span> {value}</> : (value ?? label)}
        </span>
        <Icon name="chev" cls="v2-ico v2-btn-ico v2-btn-ico-r" />
      </button>
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} items={items} label={menuLabel} placement={placement} />
    </>
  );
}
