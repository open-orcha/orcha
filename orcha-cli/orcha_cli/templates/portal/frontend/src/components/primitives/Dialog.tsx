/**
 * V2 Dialog — modal with focus trap, Escape, backdrop click, aria-labelledby,
 * and focus restored to the opener on close. Portaled to <body> (a transformed
 * ancestor would otherwise clip position:fixed). In desktop embedded mode it
 * only covers the portal's own view — host dialogs are the host's job (arch §7.4).
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { trapTab, useFocusReturn } from "./focus";
import { Button } from "./Button";

export interface DialogProps {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** element to focus first (default: first focusable) */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  closeOnBackdrop?: boolean;
}

export function Dialog({ title, description, onClose, children, footer, size = "md", initialFocus, className, closeOnBackdrop = true }: DialogProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descId = useId();
  useFocusReturn(ref, initialFocus);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Focus can fall out of the dialog to <body> — e.g. the focused submit
  // button turns disabled while busy and a failed submit leaves it there — and
  // then the dialog's own onKeyDown never sees Escape. While focus is nowhere,
  // the TOPMOST dialog still closes on Escape (parity: Close request 422 path).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && a !== document.body && a !== document.documentElement) return; // focus is somewhere: its owner handles it
      const dialogs = document.querySelectorAll('.v2-overlay > [role="dialog"]');
      if (dialogs[dialogs.length - 1] !== ref.current) return; // only the topmost dialog
      e.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return createPortal(
    <div
      className="v2-overlay"
      onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`v2-dialog v2-dialog-${size}${className ? " " + className : ""}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
          trapTab(e, ref.current);
        }}
      >
        <div className="v2-dialog-h">
          <h2 id={titleId} className="v2-dialog-title">{title}</h2>
          {description ? <div id={descId} className="v2-dialog-desc">{description}</div> : null}
        </div>
        {children != null && <div className="v2-dialog-b">{children}</div>}
        {footer != null && <div className="v2-dialog-f">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Confirm dialog: exact consequence copy in `description`, danger styling opt-in. */
export function ConfirmDialog({ title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", danger, busy, onConfirm, onClose, children }: {
  title: string; description?: ReactNode; confirmLabel?: string; cancelLabel?: string;
  danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void; children?: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      size="sm"
      initialFocus={danger ? cancelRef : undefined}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={onClose}>{cancelLabel}</Button>
          <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
