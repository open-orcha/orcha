import type { ComponentType, CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "./icons";
import { cn } from "./cn";

export interface EmptyProps {
  title: ReactNode;
  description?: ReactNode;
  /** A Lucide icon, or a brand mark taking the same props (`GitHubIcon`). */
  icon?: LucideIcon | ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Optional call to action (e.g. a Button). */
  action?: ReactNode;
  className?: string;
}

/**
 * Centred empty state for lists and panes (Orcha `.v2-empty`): one glyph, one line, one action.
 *
 * The glyph sits on a small raised tile that floats while two hairline rings ripple out behind
 * it, and the copy rises in under it (`v-float`, `v-ripple`, `v-rise` in globals.css). Under
 * reduced motion it is the same composition, still.
 */
export function Empty({
  title,
  description,
  icon: Icon,
  action,
  className,
}: EmptyProps) {
  return (
    <div
      className={cn(
        "flex min-h-[240px] w-full flex-1 flex-col items-center justify-center gap-1 px-6 py-10 text-center",
        className,
      )}
    >
      {Icon ? (
        <div aria-hidden className="v-pop relative mb-3 flex size-16 items-center justify-center">
          <span className="v-ripple absolute inset-1 rounded-2xl border border-border-strong" />
          <span className="v-ripple absolute inset-1 rounded-2xl border border-border-strong" style={{ "--d": "1800ms" } as CSSProperties} />
          <span className="v-float relative flex size-11 items-center justify-center rounded-xl border border-border bg-panel text-fg-2 shadow-[var(--shadow-md)]">
            <Icon className="size-5" strokeWidth={1.75} />
          </span>
        </div>
      ) : null}
      <h2 className="v-rise max-w-[520px] text-[14px] font-semibold leading-5 text-fg" style={{ "--d": "60ms" } as CSSProperties}>
        {title}
      </h2>
      {description ? (
        <p className="v-rise max-w-[440px] text-base text-fg-2" style={{ "--d": "110ms" } as CSSProperties}>
          {description}
        </p>
      ) : null}
      {action ? (
        <div className="v-rise mt-3 flex justify-center gap-2" style={{ "--d": "160ms" } as CSSProperties}>
          {action}
        </div>
      ) : null}
    </div>
  );
}
