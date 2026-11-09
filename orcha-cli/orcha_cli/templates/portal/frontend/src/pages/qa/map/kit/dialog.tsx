
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
  useId,
} from "react";
import { X } from "./icons";
import { cn } from "./cn";
import { Button } from "./button";

export interface DialogProps {
  open: boolean;
  /** Called on ESC, backdrop click, the close button, or `form method="dialog"`. */
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Right-aligned footer row (buttons). */
  footer?: ReactNode;
  className?: string;
  /** Hide the top-right close button. */
  hideClose?: boolean;
  /** `side`: a full-height sheet docked to the right edge that slides in (a detail panel). */
  placement?: "center" | "side";
  /** Controls beside the close button, top right (an Expand toggle). */
  actions?: ReactNode;
  /** Escape goes here first; return true when it was handled and the dialog stays open (a panel
   * that collapses from full window before it closes). */
  onEscape?: () => boolean;
}

/**
 * Native `<dialog>` wrapper (modal, top layer, focus trap by the browser).
 * Controlled: pass `open` and `onClose`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  hideClose = false,
  placement = "center",
  actions,
  onEscape,
}: DialogProps) {
  const side = placement === "side";
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);

  // Re-synced after every render, not only when `open` flips (D32): when the element closed
  // without React hearing of it (the close event missed, the element re-attached), `open`
  // stayed true, so the next "open" request changed nothing and the dialog never came back
  // until a reload. Every open request re-renders the dialog, which now shows it again.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open && el.isConnected) {
      // A field React already focused (autoFocus) is inside the dialog before it opens.
      const before = document.activeElement;
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
      // The browser then focuses the first focusable control, which is our close button, and
      // paints a focus ring on it although nobody pressed a key. Give an autoFocus field its
      // focus back; otherwise start on the dialog itself. Tab still reaches the close button.
      // A control in the title that should not take the first focus (a badge that explains
      // itself on focus) says so with `data-dialog-skip-focus`.
      const now = document.activeElement;
      if (now instanceof HTMLElement && (now.hasAttribute("data-dialog-close") || now.hasAttribute("data-dialog-skip-focus"))) {
        if (before instanceof HTMLElement && before !== el && el.contains(before)) before.focus();
        else el.focus();
      }
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  });

  function handleCancel(e: SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault(); // keep React in control
    if (onEscape?.()) return;
    onClose();
  }

  function handleClose() {
    // Fired after the element closes for any reason (ESC handled above,
    // `form method="dialog"`, or `el.close()` from the effect). Idempotent.
    if (open) onClose();
  }

  // Escape closes it even when the browser sends no `cancel` event (Chrome's close watcher
  // skips it without a recent user activation, and a key sent by automation has none), so the
  // History and YAML drawers always close on Escape (#157). A child that handled Escape itself
  // (a select's open list) calls preventDefault and keeps the dialog open.
  function handleKeyDown(e: KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (onEscape?.()) return;
    onClose();
  }

  function handleBackdropClick(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === ref.current) onClose();
  }

  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClose={handleClose}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      // Explicit, though a modal <dialog> implies them: some assistive tech and test tools only
      // read the attributes, and a drawer without them was reported as not a dialog (#157).
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      aria-labelledby={title ? titleId : undefined}
      className={cn(
        // Orcha `.v2-dialog`: raised surface, control-strength outline, 10px panel radius, pop
        // shadow. Header 16/20/8, body 8/20, footer 12/20/16 with no divider (§3). Text wraps
        // even when the dialog is mounted in a `whitespace-nowrap` row (the topbar's Record).
        "m-auto w-[calc(100%-32px)] max-w-md rounded-panel border border-border-strong bg-raised p-0 text-fg shadow-md whitespace-normal",
        "max-h-[calc(100dvh-64px)] overflow-hidden focus-visible:outline-none",
        !side && "open:animate-fade-in",
        side &&
          "mr-0 ml-auto h-dvh max-h-dvh w-full max-w-[min(100vw,960px)] rounded-none border-y-0 border-r-0 animate-sheet-in sm:rounded-l-panel",
        className,
      )}
      data-dialog-placement={placement}
    >
      <div className={cn("flex max-h-[calc(100dvh-64px)] flex-col", side && "h-dvh max-h-dvh")}>
        {title || !hideClose || actions ? (
          <div className="flex items-start gap-3 px-5 pt-4 pb-2">
            <div className="min-w-0 flex-1">
              {title ? (
                <h2
                  id={titleId}
                  className="text-lg font-semibold leading-6 text-fg"
                >
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p className="mt-1 text-base text-fg-2">{description}</p>
              ) : null}
            </div>
            {actions ? <div className="-mt-0.5 flex shrink-0 items-center gap-1">{actions}</div> : null}
            {!hideClose ? (
              <Button
                variant="ghost"
                size="sm"
                icon
                aria-label="Close"
                data-dialog-close=""
                onClick={onClose}
                className="-mr-2 -mt-0.5"
              >
                <X />
              </Button>
            ) : null}
          </div>
        ) : null}
        {children ? (
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto px-5 py-2",
              !(title || !hideClose) && "pt-5",
              !footer && "pb-5",
            )}
          >
            {children}
          </div>
        ) : null}
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-4 pt-3">
            {footer}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
