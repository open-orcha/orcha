import { ChevronRight } from "./kit/icons";
import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "./kit";
import styles from "./app-map.module.css";
import { placeTip, type Box } from "./panel-state";

/**
 * The pieces of the Map's detail panel frame that its sections share: the foldable `Section`
 * (header with a chevron, height animated, open state remembered per viewer) and `usePanelTip`,
 * a tooltip placed so it never covers the panel's own rows.
 */

type PanelContextValue = { isOpen: (name: string) => boolean; toggle: (name: string) => void; full: boolean };

/** Given by the panel: which sections are open, and whether it is full screen (long lists get
 * more room). A section rendered outside a panel keeps its own open state. */
export const PanelContext = createContext<PanelContextValue | null>(null);

/** Whether the panel is full screen. */
export function usePanelFull(): boolean {
  return useContext(PanelContext)?.full ?? false;
}

/** One foldable section of the panel. `name` is what its open state is remembered under. */
export function Section({ name, title, i = 0, className, children, ...rest }: { name: string; title: ReactNode; i?: number; children: ReactNode } & Omit<HTMLAttributes<HTMLElement>, "title" | "id" | "children">) {
  const ctx = useContext(PanelContext);
  const [localOpen, setLocalOpen] = useState(true);
  const open = ctx ? ctx.isOpen(name) : localOpen;
  const bodyId = useId();
  return (
    <section className={cn("border-t border-border px-4 py-2.5", styles.rise, className)} style={{ "--d": `${i * 50}ms` } as CSSProperties} data-map-section={name} data-open={open} {...rest}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => (ctx ? ctx.toggle(name) : setLocalOpen((v) => !v))}
          className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-2xs font-semibold uppercase tracking-[0.1em] text-muted transition-colors hover:bg-hover hover:text-fg-2"
          data-map-section-toggle={name}
        >
          <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </button>
      </h3>
      <div id={bodyId} className={styles.fold} data-open={open} {...(open ? {} : { inert: "" })}>
        <div className="min-h-0 overflow-hidden">
          <div className="pb-0.5 pt-2">{children}</div>
        </div>
      </div>
    </section>
  );
}

const box = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/**
 * A tooltip for a control in the panel, shown on hover and on focus. It is placed by `placeTip`:
 * beside the docked panel over the canvas, else beside or below its trigger, never over the rows
 * above it. Spread `trigger` on the control and render `tip` anywhere (it is portalled).
 */
export function usePanelTip(text: string): {
  trigger: {
    onMouseEnter: (e: SyntheticEvent<HTMLElement>) => void;
    onMouseLeave: () => void;
    onFocus: (e: SyntheticEvent<HTMLElement>) => void;
    onBlur: () => void;
    onPointerDown: () => void;
    onKeyDown: () => void;
    "aria-describedby"?: string;
  };
  tip: ReactNode;
} {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tip = ref.current;
    if (!anchor || !tip) return;
    const panel = anchor.closest<HTMLElement>("[data-map-panel-mode='docked'], [data-map-panel-mode='collapsed']");
    const at = placeTip(
      box(anchor.getBoundingClientRect()),
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      panel ? box(panel.getBoundingClientRect()) : null,
    );
    tip.style.left = `${at.left}px`;
    tip.style.top = `${at.top}px`;
    tip.style.visibility = "visible";
    tip.dataset.side = at.side;
  }, [anchor]);
  const show = (e: SyntheticEvent<HTMLElement>) => setAnchor(e.currentTarget);
  const hide = () => setAnchor(null);
  return {
    // A click or a key changes the panel under the tip: it goes, and comes back on the next hover.
    trigger: { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide, onPointerDown: hide, onKeyDown: hide, "aria-describedby": anchor ? id : undefined },
    tip:
      anchor && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={ref}
              id={id}
              role="tooltip"
              style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
              className="qa-port pointer-events-none z-[70] max-w-[300px] rounded-md border border-border bg-raised px-2 py-1 text-xs leading-4 text-fg shadow-[var(--shadow-md)]"
              data-map-tip
            >
              {text}
            </div>,
            document.body,
          )
        : null,
  };
}

/** A square icon control in the panel's header, with its tooltip (`tip`, else the label) and
 * aria-label. */
export function PanelIconButton({
  label,
  tip: text,
  onClick,
  children,
  className,
  ...rest
}: { label: string; tip?: string; onClick: () => void; children: ReactNode; className?: string } & Omit<HTMLAttributes<HTMLButtonElement>, "onClick" | "children">) {
  const { trigger, tip } = usePanelTip(text ?? label);
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4", className)}
        {...rest}
        {...trigger}
      >
        {children}
      </button>
      {tip}
    </>
  );
}
