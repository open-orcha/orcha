import type { CSSProperties } from "react";
import { cn } from "./cn";

/**
 * A placeholder block with a light band sweeping across it (`.v-skeleton` in globals.css,
 * transform only; still under reduced motion). Size it with classes; `delay` offsets the sweep
 * so a column of skeletons ripples instead of flashing in unison.
 */
export function Skeleton({ className, delay, style }: { className?: string; delay?: number; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      className={cn("v-skeleton block h-3", className)}
      style={delay ? ({ ...style, "--d": `${delay}ms` } as CSSProperties) : style}
    />
  );
}

/** A bordered panel of skeleton rows: an avatar-sized glyph, a title and a muted line. */
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col divide-y divide-border rounded-lg border border-border bg-panel", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3.5 py-3">
          <Skeleton className="size-4 shrink-0 rounded-full" delay={i * 70} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3" style={{ width: `${62 - ((i * 13) % 28)}%` }} delay={i * 70} />
            <Skeleton className="h-2.5 opacity-70" style={{ width: `${38 - ((i * 7) % 16)}%` }} delay={i * 70 + 40} />
          </div>
          <Skeleton className="h-2.5 w-12 shrink-0" delay={i * 70} />
        </div>
      ))}
    </div>
  );
}

/** One stat column: label, number, hint, sized like `SnapshotTile` / the health tiles. */
export function SkeletonStat({ delay = 0 }: { delay?: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 px-2.5 py-2" aria-hidden>
      <Skeleton className="h-2.5 w-16" delay={delay} />
      <Skeleton className="h-5 w-12" delay={delay} />
      <Skeleton className="h-2.5 w-24 opacity-70" delay={delay + 40} />
    </div>
  );
}

/** A chart card's frame: title, one muted line, and a plot of bars rising out of the grid. */
export function SkeletonChart({ delay = 0 }: { delay?: number }) {
  const bars = [38, 62, 30, 74, 52, 86, 44];
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-panel p-4" aria-hidden>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-3 w-24" delay={delay} />
        <Skeleton className="h-2.5 w-32 opacity-70" delay={delay + 40} />
      </div>
      <div className="flex h-[180px] items-end gap-[6%] border-b border-border/60 px-[6%] pb-px">
        {bars.map((h, i) => (
          <Skeleton key={i} className="h-full flex-1 rounded-b-none rounded-t-[3px] opacity-80" style={{ height: `${h}%` }} delay={delay + i * 60} />
        ))}
      </div>
    </div>
  );
}
