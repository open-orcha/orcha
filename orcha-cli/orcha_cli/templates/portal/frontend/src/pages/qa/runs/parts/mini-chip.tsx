import type { HTMLAttributes, ReactNode } from "react";
import { StatusGlyph, cn } from "../../map/kit";

/** The small quiet pill the run page's rows carry. */
export function MiniChip({
  dot,
  glyph,
  size = "sm",
  className,
  children,
  ...rest
}: {
  dot?: string;
  glyph?: string;
  size?: "sm" | "xs";
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border leading-none text-muted",
        size === "xs" ? "h-4 px-1.5 text-2xs" : "h-5 px-2 text-xs",
        className,
      )}
      {...rest}
    >
      {glyph ? (
        <StatusGlyph status={glyph} decorative className={size === "xs" ? "size-2.5" : "size-3"} />
      ) : dot ? (
        <i aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", dot)} />
      ) : null}
      {children}
    </span>
  );
}
