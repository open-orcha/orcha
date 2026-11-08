import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import type { Severity } from "./types";
import { StatusGlyph } from "./status-glyph";

/** Background utility for a severity dot / bar. */
export const severityDot: Record<Severity, string> = {
  blocker: "bg-sev-blocker",
  major: "bg-sev-major",
  minor: "bg-sev-minor",
  cosmetic: "bg-sev-cosmetic",
  info: "bg-sev-info",
};

/** Text utility for a severity. */
export const severityText: Record<Severity, string> = {
  blocker: "text-sev-blocker",
  major: "text-sev-major",
  minor: "text-sev-minor",
  cosmetic: "text-sev-cosmetic",
  info: "text-sev-info",
};

/** Tinted tag styles (14% tint background + coloured text), as in the mockup's finding cards. */
export const severityTag: Record<Severity, string> = {
  blocker: "bg-sev-blocker/15 text-sev-blocker",
  major: "bg-sev-major/15 text-sev-major",
  minor: "bg-sev-minor/15 text-sev-minor",
  cosmetic: "bg-sev-cosmetic/20 text-sev-cosmetic",
  info: "bg-sev-info/15 text-sev-info",
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Adds a coloured dot in the severity colour. */
  severity?: Severity;
  /** Custom dot class (e.g. `bg-success`), when not severity-based. */
  dot?: string;
  /** Pulse the dot (queued / running states). */
  pulse?: boolean;
  /** Lead with the Linear status glyph for this status (`running`, `completed`, `failed`, …)
   * instead of a colour dot — shape + colour, so status is never colour-only. */
  glyph?: string;
  /** Use the mono font (ids, commits, durations). */
  mono?: boolean;
  /** Emphasised (primary) text colour instead of the secondary tone. */
  strong?: boolean;
  /** Height: `md` 22px (default, Orcha `--v2-chip-h`) or `sm` 20px for dense rows. */
  size?: "sm" | "md";
  children?: ReactNode;
}

/**
 * Small outlined metadata chip (Orcha V2 D8 `.v2-chip`): rounded-full, 1px hairline, 12px
 * medium text in the secondary tone, optional 7px dot or status glyph.
 * `<Chip severity="major">3 major</Chip>`, `<Chip mono>a3f9c21</Chip>`, `<Chip>exploratory</Chip>`.
 */
export function Chip({
  severity,
  dot,
  pulse = false,
  glyph,
  mono = false,
  strong = false,
  size = "md",
  className,
  children,
  ...rest
}: ChipProps) {
  const dotClass = severity ? severityDot[severity] : dot;
  return (
    <span
      data-chip
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-transparent font-medium leading-none",
        size === "sm" ? "h-5 gap-[5px] px-[7px] text-[11.5px]" : "h-[22px] gap-1.5 px-2 text-sm",
        strong ? "text-fg" : "text-fg-2",
        mono && "font-mono tabular",
        className,
      )}
      style={
        {
          fontFamily: "var(--chip-font)",
          textTransform: "var(--chip-transform)",
          letterSpacing: "var(--chip-tracking)",
        } as CSSProperties
      }
      {...rest}
    >
      {glyph ? (
        <StatusGlyph status={glyph} decorative className="size-3" />
      ) : dotClass ? (
        <i
          aria-hidden
          className={cn(
            "inline-block size-[7px] shrink-0 rounded-full",
            dotClass,
            pulse && "animate-pulse",
          )}
        />
      ) : null}
      {children}
    </span>
  );
}

/** Filled severity tag used in finding cards: `<SeverityTag severity="major" />`. */
export function SeverityTag({
  severity,
  className,
  children,
}: {
  severity: Severity;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-full px-[7px] text-xs font-medium leading-none",
        severityTag[severity],
        className,
      )}
    >
      {children ?? severity}
    </span>
  );
}

/**
 * Linear filter-pill classes (Orcha V2 `.v2-pill`): rounded-full, hairline border; selected =
 * a filled subtle tone + stronger border. Pair with `aria-pressed` / `aria-current` so the
 * selection is never conveyed by fill alone. Usable on `<button>` or `<Link>`.
 */
export function pillClass(selected: boolean, className?: string): string {
  return cn(
    "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-base font-medium leading-none transition-colors duration-[90ms] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
    selected
      ? "border-border-strong bg-selected text-fg"
      : "border-border bg-transparent text-fg-2 hover:bg-hover hover:text-fg",
    className,
  );
}
