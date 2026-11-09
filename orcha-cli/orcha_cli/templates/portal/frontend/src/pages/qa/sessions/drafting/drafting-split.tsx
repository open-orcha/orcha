import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import motion from "../motion.module.css";
import { cn } from "../../map/kit";

/** From this width up, a drafting run with a new exploration reviews side by side. */
export const SPLIT_QUERY = "(min-width: 1100px)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(SPLIT_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Whether the window is wide enough for the side-by-side review (false on the server). */
export function useWideDrafting(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === "function" && window.matchMedia(SPLIT_QUERY).matches,
    () => false,
  );
}

/** The shape the split's left column is sized for. */
export type SplitFrame = "phone" | "tablet" | "browser";

/** The frame the exploration is drawn in: a browser window for web / desktop, else the run's
 * device: a tablet when its name says so (iPad, Galaxy Tab, Pixel Tablet), a phone otherwise. */
export function splitFrame(
  kind: string | null | undefined,
  run: { deviceName?: string | null; device?: unknown } = {},
): SplitFrame {
  if (kind === "web" || kind === "desktop") return "browser";
  return /ipad|\btab\b|tablet/i.test(run.deviceName ?? (typeof run.device === "string" ? run.device : "")) ? "tablet" : "phone";
}

/** The split's columns per frame shape: a phone is tall and narrow (a narrow column); a
 * tablet is near-square, so it gets about half the width — the frame itself is then contained
 * within the column's height by `FrameView`'s `fit`; a browser window wants the width. */
export const SPLIT_COLUMNS: Record<SplitFrame, string> = {
  phone: "grid-cols-[minmax(300px,4fr)_minmax(0,7fr)]",
  tablet: "grid-cols-[minmax(420px,6fr)_minmax(0,5fr)]",
  browser: "grid-cols-[minmax(360px,1fr)_minmax(0,1fr)]",
};


/**
 * The side-by-side review on wide screens: the exploration's device on the left, sized to fit
 * the column's height so the whole frame is always in view, and the drafts on the right,
 * scrolling on their own. The split fills the rest of its flex-column parent (which must have
 * a definite height: the drafting page between its status bar and footer, or the onboarding
 * wizard filling the window).
 */
export function DraftingSplit({
  left,
  children,
  frame = "phone",
  leftLabel = "New exploration",
  rightLabel = "Drafts",
  className,
}: {
  left: ReactNode;
  children: ReactNode;
  /** The shape on the left: a phone or tablet (iOS / Android) or a browser window (web). */
  frame?: SplitFrame;
  leftLabel?: string;
  rightLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-6",
        "transition-[grid-template-columns] duration-300 ease-out motion-reduce:transition-none",
        SPLIT_COLUMNS[frame],
        className,
      )}
      data-drafting-split={frame}
    >
      <section
        aria-label={leftLabel}
        className={cn("flex min-h-0 min-w-0 flex-col", motion.rise)}
        data-drafting-split-left
      >
        {left}
      </section>
      <section
        aria-label={rightLabel}
        className={cn(
          "-mr-2 flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain pr-2 [scrollbar-gutter:stable]",
          motion.rise,
        )}
        style={{ "--d": "90ms" } as CSSProperties}
        data-drafting-split-right
      >
        {children}
      </section>
    </div>
  );
}
