/**
 * D8 metadata chips (Linear labels): rounded-full, 1 px border, 12 px text,
 * optional small coloured dot or leading icon. `PrChip` is the "⟟ #55234"
 * pull-request chip — the icon colour carries the PR state AND the state word
 * is in the accessible name/tooltip (never colour-only). Render a PrChip only
 * when a real PR number exists (truthful data, brief §3).
 *
 * Interactive when given `onClick` (button), `to` (router Link) or `href`
 * (anchor); otherwise a span. `disabled` applies to the button form.
 */
import type { MouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { hue } from "../../lib/format";

export type ChipTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

export interface ChipProps {
  children: ReactNode;
  /** Small leading dot: a semantic tone, or `"auto"` = a stable hue hashed from `dotKey`/text. */
  dot?: ChipTone | "auto";
  /** Hash key for `dot="auto"` (defaults to the string children). */
  dotKey?: string;
  /** Leading icon (e.g. <Icon name="git" cls="" />); replaces the dot. */
  icon?: ReactNode;
  /** Trailing content (a count, a ×). */
  trailing?: ReactNode;
  title?: string;
  /** Selected/filled state (filter pills). */
  selected?: boolean;
  size?: "sm" | "md";
  href?: string;
  /** In-app route (react-router Link) — e.g. "/tasks?task=…". */
  to?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  /** Button form only: not actionable (keeps the pressed state visible). */
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** Stable label-dot colour from a name — tone from theme tokens (--v2-hue-mark-*), so it reads on dark and light. */
export function labelDotColor(key: string): string {
  return `hsl(${hue(key)} var(--v2-hue-mark-s, 62%) var(--v2-hue-mark-l, 62%))`;
}

export function Chip({ children, dot, dotKey, icon, trailing, title, selected, size = "md", href, to, onClick, disabled, className, ...rest }: ChipProps) {
  const cls = [
    "v2-chip",
    size === "sm" ? "v2-chip-sm" : "",
    selected ? "is-selected" : "",
    onClick || href || to ? "is-interactive" : "",
    className || "",
  ].filter(Boolean).join(" ");
  const key = dotKey ?? (typeof children === "string" ? children : "");
  const lead = icon ? (
    <span className="v2-chip-ico" aria-hidden="true">{icon}</span>
  ) : dot ? (
    <span
      className={`v2-chip-dot${dot !== "auto" ? " v2-tone-" + dot : ""}`}
      style={dot === "auto" ? { background: labelDotColor(key) } : undefined}
      aria-hidden="true"
    />
  ) : null;
  const body = (
    <>
      {lead}
      <span className="v2-chip-text">{children}</span>
      {trailing != null ? <span className="v2-chip-trail">{trailing}</span> : null}
    </>
  );
  if (to) {
    return (
      <Link className={cls} to={to} title={title} onClick={onClick} aria-label={rest["aria-label"]}>
        {body}
      </Link>
    );
  }
  if (href) {
    return (
      <a className={cls} href={href} title={title} onClick={onClick} aria-label={rest["aria-label"]}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls} title={title} onClick={onClick} disabled={disabled} aria-pressed={selected ?? undefined} aria-label={rest["aria-label"]}>
        {body}
      </button>
    );
  }
  return (
    <span className={cls} title={title} aria-label={rest["aria-label"]}>
      {body}
    </span>
  );
}

export type PrState = "open" | "draft" | "merged" | "closed";

function PrGlyph() {
  return (
    <svg viewBox="0 0 14 14" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx={3.8} cy={3.4} r={1.45} />
      <circle cx={3.8} cy={10.6} r={1.45} />
      <circle cx={10.2} cy={10.6} r={1.45} />
      <path d="M3.8 4.85v4.3M10.2 9.15V5.6a1.6 1.6 0 0 0-1.6-1.6H6.6M7.9 2.7 6.6 4l1.3 1.3" />
    </svg>
  );
}

export interface PrChipProps {
  number: number | string;
  state?: PrState | string | null;
  href?: string;
  title?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  size?: "sm" | "md";
}

export function PrChip({ number, state, href, title, onClick, size }: PrChipProps) {
  const st = (["open", "draft", "merged", "closed"] as const).find((s) => s === state) ?? null;
  const n = String(number).replace(/^#/, "");
  const name = `Pull request #${n}${st ? ` (${st})` : ""}`;
  return (
    <Chip
      className={`v2-prchip${st ? " is-" + st : ""}`}
      icon={<PrGlyph />}
      href={href}
      onClick={onClick}
      size={size}
      title={title ?? name}
      aria-label={name}
    >
      #{n}
    </Chip>
  );
}
