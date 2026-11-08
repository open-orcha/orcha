
import Link from "./link";
import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import { X } from "./icons";
import { cn } from "./cn";

export type TagPillSize = "sm" | "md";

/**
 * The tag pill's look, for a pill that is not a `TagPill` (a suite's category rule beside its
 * tag rules): rounded-full, hairline border, the recessed panel-2 fill, secondary text.
 * Neutral on purpose: colour in this app means status (green met, amber missing), so a hued
 * tag would read as one.
 */
export function tagPillClass(size: TagPillSize = "sm", className?: string): string {
  return cn(
    "inline-flex min-w-0 max-w-full shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-panel-2 font-medium leading-none text-fg-2",
    size === "sm" ? "h-5 gap-1 px-2 text-xs [&_svg]:size-3" : "h-6 gap-1.5 px-2.5 text-sm [&_svg]:size-3.5",
    "[&_svg]:shrink-0",
    className,
  );
}

export interface TagPillProps extends Omit<HTMLAttributes<HTMLSpanElement>, "onClick"> {
  tag: string;
  size?: TagPillSize;
  /** A leading icon (a suite's tag rule shows the Tag glyph). */
  icon?: ReactNode;
  /** Shows a × that removes the tag; labelled "Remove tag X". */
  onRemove?: () => void;
  /** The tag links somewhere (a list filtered by it). */
  href?: string;
  /** The tag acts (filter by it); rendered as a button. Ignored when `href` is set. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Accessible name of the link or button (default "Filter by tag X"). */
  actionLabel?: string;
  /** Extra text after the tag (a count). */
  trailing?: ReactNode;
}

/**
 * One tag as a pill: `<TagPill tag="smoke" />`, removable in an editor
 * (`onRemove`), or a link / button that filters by it (`href` / `onClick`).
 */
export function TagPill({
  tag,
  size = "sm",
  icon,
  onRemove,
  href,
  onClick,
  actionLabel,
  trailing,
  className,
  title,
  ...rest
}: TagPillProps) {
  const label = (
    <>
      {icon}
      <span className="truncate">{tag}</span>
      {trailing}
    </>
  );
  const actionClass = "-mx-1 inline-flex min-w-0 items-center gap-[inherit] rounded-full px-1 hover:text-fg";
  return (
    <span data-tag-pill={tag} title={title ?? tag} className={tagPillClass(size, cn(onRemove && "pr-1", className))} {...rest}>
      {href ? (
        <Link href={href} className={actionClass} aria-label={actionLabel ?? `Filter by tag ${tag}`}>
          {label}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={actionClass} aria-label={actionLabel ?? `Filter by tag ${tag}`}>
          {label}
        </button>
      ) : (
        label
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove tag ${tag}`}
          title={`Remove ${tag}`}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg"
          data-tag-remove={tag}
        >
          <X aria-hidden className={size === "sm" ? "!size-2.5" : "!size-3"} />
        </button>
      ) : null}
    </span>
  );
}

/**
 * A wrapping row of tag pills. `max` keeps a tight spot (a table row, a card) to that many
 * pills plus a "+N" whose tooltip names the rest.
 */
export function TagList({
  tags,
  max,
  size = "sm",
  icon,
  tagHref,
  onTagClick,
  className,
  label = "Tags",
  ...rest
}: {
  tags: readonly string[];
  max?: number;
  size?: TagPillSize;
  icon?: ReactNode;
  /** Each tag links here (filter by it). */
  tagHref?: (tag: string) => string;
  /** Each tag is a button (filter by it). */
  onTagClick?: (tag: string) => void;
  className?: string;
  /** The list's accessible name. */
  label?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  if (tags.length === 0) return null;
  const shown = max !== undefined && tags.length > max ? tags.slice(0, Math.max(0, max)) : tags;
  const hidden = tags.slice(shown.length);
  return (
    <ul className={cn("flex min-w-0 flex-wrap items-center gap-1", className)} aria-label={label} data-tag-list {...rest}>
      {shown.map((t, i) => (
        <li key={`${i}:${t}`} className="flex min-w-0 max-w-full">
          <TagPill
            tag={t}
            size={size}
            icon={icon}
            href={tagHref?.(t)}
            onClick={onTagClick ? () => onTagClick(t) : undefined}
          />
        </li>
      ))}
      {hidden.length > 0 ? (
        <li className="flex">
          <span
            className={tagPillClass(size, "bg-transparent text-muted tabular")}
            title={hidden.join(", ")}
            data-tag-overflow={hidden.length}
          >
            <span aria-hidden>+{hidden.length}</span>
            <span className="sr-only">
              and {hidden.length} more: {hidden.join(", ")}
            </span>
          </span>
        </li>
      ) : null}
    </ul>
  );
}
