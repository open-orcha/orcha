import type { CSSProperties } from "react";
import { Accessibility, Gauge, Hand, Palette, ShieldAlert, Type, Wrench, type LucideIcon } from "./../map/kit/icons";
import { LENS_META, type Lens, type LensGrade } from "./explorations";
import { cn } from "./../map/kit";

/** Each lens's glyph: shape first, so a lens is never told apart by colour alone. */
export const LENS_ICON: Readonly<Record<Lens, LucideIcon>> = {
  works: Wrench,
  usable: Hand,
  resilient: ShieldAlert,
  accessible: Accessibility,
  visual: Palette,
  copy: Type,
  fast: Gauge,
};

/** Each lens's tone (a CSS colour token) for chips, bars and the composer's picker. */
export const LENS_TONE: Readonly<Record<Lens, string>> = {
  works: "var(--color-chart-1)",
  usable: "var(--color-chart-2)",
  resilient: "var(--color-chart-3)",
  accessible: "var(--color-chart-4)",
  visual: "var(--color-chart-5)",
  copy: "var(--color-info)",
  fast: "var(--color-warning)",
};

const META = new Map(LENS_META.map((m) => [m.key, m]));

export function lensLabel(lens: Lens): string {
  return META.get(lens)?.label ?? lens;
}

export function lensHint(lens: Lens): string {
  return META.get(lens)?.hint ?? "";
}

export const GRADE_LABEL: Readonly<Record<LensGrade, string>> = {
  good: "good",
  fair: "fair",
  poor: "poor",
  unknown: "not covered",
};

export const GRADE_TEXT_CLASS: Readonly<Record<LensGrade, string>> = {
  good: "text-success",
  fair: "text-warning",
  poor: "text-danger",
  unknown: "text-muted",
};

/**
 * One lens as a small outlined chip: its glyph in the lens tone and its label, optionally
 * followed by a grade ("Accessible · fair"). Static; the composer's picker wraps the same look
 * in a checkbox. `<LensChip lens="accessible" grade="fair" />`.
 */
export function LensChip({
  lens,
  grade,
  size = "md",
  className,
}: {
  lens: Lens;
  grade?: LensGrade;
  size?: "sm" | "md";
  className?: string;
}) {
  const Icon = LENS_ICON[lens];
  return (
    <span
      data-lens-chip={lens}
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-border font-medium leading-none text-fg-2",
        size === "sm" ? "h-5 gap-1 px-[7px] text-[11.5px]" : "h-[22px] gap-1.5 px-2 text-sm",
        className,
      )}
      style={{ "--lens": LENS_TONE[lens] } as CSSProperties}
    >
      <Icon aria-hidden className={cn("shrink-0 text-[color:var(--lens)]", size === "sm" ? "size-3" : "size-3.5")} strokeWidth={2} />
      {lensLabel(lens)}
      {grade ? <span className={cn("font-normal", GRADE_TEXT_CLASS[grade])}>· {GRADE_LABEL[grade]}</span> : null}
    </span>
  );
}

/** A wrapping row of lens chips; `max` folds the rest into "+2". */
export function LensChips({
  lenses,
  max,
  size = "sm",
  className,
}: {
  lenses: readonly Lens[];
  max?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const shown = max != null ? lenses.slice(0, max) : lenses;
  const rest = lenses.length - shown.length;
  return (
    <span role="group" aria-label={`Lenses: ${lenses.map(lensLabel).join(", ")}`} className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((l) => (
        <LensChip key={l} lens={l} size={size} />
      ))}
      {rest > 0 ? (
        <span aria-hidden className="text-xs text-muted">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
