import type { CSSProperties, ReactNode } from "react";
import { StatusGlyph, cn, type GlyphStatus } from "../../map/kit";

/** Titled card around one chart, with an optional legend row. Consumers and e2e
 * depend on this shape (`data-health-chart` + a title/subtitle/legend row).
 *
 * Linear: a calm `bg-panel` box with a hairline, a `text-sm font-semibold` title with ONE
 * muted line under it, and the legend right-aligned (wrapping under the title when narrow). */
export function ChartCard({
  title,
  subtitle,
  legend,
  children,
  testId,
}: {
  title: string;
  subtitle?: string;
  legend?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-panel p-4" data-health-chart={testId}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
        </div>
        {legend ? <div className="pt-0.5">{legend}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <i aria-hidden className="inline-block size-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/**
 * All-zero-series empty state, sized to exactly match the chart it replaces (no
 * layout shift when a series has no data) — unlike `ui/empty.tsx`'s `min-h-[240px]`,
 * which is sized for a whole pane, not a chart slot.
 *
 * Instead of a flat grey box it shows the chart's ghost: faint gridlines with a dashed
 * line drifting across them, and the message rising in over it, so a quiet window reads as
 * "nothing happened yet" rather than as a chart that failed to draw.
 */
export function ChartEmpty({ height, message }: { height: number; message: string }) {
  return (
    <div
      className="relative flex w-full items-center justify-center overflow-hidden rounded-md bg-panel-2/40"
      style={{ height }}
      data-chart-empty
    >
      <svg
        aria-hidden
        className="v-fade absolute inset-0 size-full text-muted"
        viewBox="0 0 400 180"
        preserveAspectRatio="none"
      >
        {[36, 72, 108, 144].map((y) => (
          <line key={y} x1="0" x2="400" y1={y} y2={y} stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        <path
          d="M0 128 C 50 120, 70 96, 110 102 S 170 132, 210 110 S 280 64, 320 78 S 380 96, 400 84"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.28"
          strokeWidth="1.5"
          strokeDasharray="4 5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        className="v-rise relative rounded-md border border-border bg-panel px-2.5 py-1 text-xs text-muted shadow-[var(--shadow-sm)]"
        style={{ "--d": "120ms" } as CSSProperties}
      >
        {message}
      </span>
    </div>
  );
}

export const SEVERITY = {
  blocker: "var(--color-sev-blocker)",
  major: "var(--color-sev-major)",
  minor: "var(--color-sev-minor)",
  cosmetic: "var(--color-sev-cosmetic)",
  info: "var(--color-sev-info)",
} as const;

export function StatusLine({ status, children, className }: { status: GlyphStatus; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-8 items-center gap-2.5 text-sm text-fg", className)} data-status-line={status}>
      <StatusGlyph status={status} size={14} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
