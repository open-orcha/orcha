import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, FileCode2, Loader } from "../../map/kit/icons";
import { cn } from "../../map/kit";
import { shortPath } from "./words";
import styles from "./work.module.css";

/**
 * The live view of every job, in two columns on a wide screen and stacked on a narrow
 * one. Left, what Orcha sees: the screens wall (the device, the files it reads), the activity
 * log under it and the facts of the job. Right, what it is producing, in one list style:
 * drafts, findings, suites or screens, depending on the job.
 */
export function WorkLive({
  sees,
  produces,
  className,
  sticky = true,
  ...rest
}: {
  sees: ReactNode;
  produces: ReactNode;
  className?: string;
  /** The left column stays in view while the right one scrolls (wide screens). */
  sticky?: boolean;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div
      className={cn("grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-6", className)}
      data-work-live
      {...rest}
    >
      <section
        aria-label="What Embodent sees"
        className={cn("v-rise flex min-w-0 flex-col gap-4", sticky && "lg:sticky lg:top-0 lg:self-start")}
        data-work-sees
      >
        {sees}
      </section>
      <section aria-label="What Embodent is producing" className="v-rise flex min-w-0 flex-col gap-4" style={{ "--d": "90ms" } as CSSProperties} data-work-produces>
        {produces}
      </section>
    </div>
  );
}

/** A heading for one of the columns' lists: its title, a count, and a quiet action at the right. */
export function WorkHeading({ title, count, action, id }: { title: ReactNode; count?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="flex min-h-6 items-center gap-2" data-work-heading>
      <h2 id={id} className="text-sm font-semibold text-fg">
        {title}
      </h2>
      {count != null && count !== "" ? <span className="font-mono text-xs tabular text-muted">{count}</span> : null}
      {action ? <span className="ml-auto flex items-center gap-1.5">{action}</span> : null}
    </div>
  );
}

/** One block of a column, the same card everywhere. */
export function WorkPanel({ children, className, ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className={cn("rounded-lg border border-border bg-panel", className)} {...rest}>
      {children}
    </div>
  );
}

/** The skeletons of what is about to land in the right column: the same shape for drafts,
 * findings, suites and screens. */
export function WorkSkeletons({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <ul className={cn("flex flex-col gap-2", className)} aria-hidden data-work-skeletons data-draft-skeletons>
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="flex gap-3 rounded-md border border-border bg-panel px-3 py-2.5" style={{ opacity: 1 - i * 0.22 }}>
          <span className="mt-1 size-3.5 shrink-0 rounded-sm bg-hover" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="h-3 w-2/5 rounded-sm animate-shimmer" />
            <span className="h-2.5 w-4/5 rounded-sm animate-shimmer" />
            <span className="h-2.5 w-3/5 rounded-sm animate-shimmer" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** "Nothing yet" for a list, with skeletons under it while the job runs. */
export function WorkEmpty({ children, live, skeletons = 3 }: { children: ReactNode; live: boolean; skeletons?: number }) {
  return (
    <div className="flex flex-col gap-2.5" data-work-empty>
      <p className="text-sm text-muted">{children}</p>
      {live ? <WorkSkeletons count={skeletons} /> : null}
    </div>
  );
}

/**
 * The calm line of a live job, so a quiet minute never reads as stuck: what is normal right
 * now ("Reading 84 files: the first drafts usually land within a few minutes") and, under it, the
 * file Orcha is reading this moment, with a soft sweep across it.
 */
export function WorkCalm({ line, file, className }: { line: string | null; file?: string | null; className?: string }) {
  if (!line && !file) return null;
  const f = file ? shortPath(file) : null;
  return (
    <div className={cn("flex flex-col gap-1.5", className)} aria-live="polite" data-work-calm>
      {line ? (
        <p className="flex items-start gap-2 text-sm text-fg-2">
          <Loader aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted [animation-duration:2.4s] motion-reduce:animate-none" />
          <span>{line}</span>
        </p>
      ) : null}
      {f ? (
        <p
          key={file}
          className={cn("flex min-w-0 items-center gap-2 rounded-md border border-border bg-panel-2 px-2.5 py-1.5", styles.reading, styles.land)}
          title={file ?? undefined}
          data-work-newest-file
        >
          <FileCode2 aria-hidden className="size-3.5 shrink-0 text-muted" strokeWidth={1.75} />
          <span className="shrink-0 whitespace-nowrap text-2xs text-muted">Now reading</span>
          <span className="min-w-0 max-w-[60%] shrink-0 truncate font-mono text-xs text-fg">{f.name}</span>
          {f.dir ? (
            <span className="hidden min-w-0 truncate font-mono text-2xs text-muted sm:inline" style={{ direction: "rtl", textAlign: "left" }}>
              <bdi>{f.dir}</bdi>
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The activity log of every job: the newest lines, the newest one in ink, each new one rising
 * in. Its header carries counters that keep moving (files read, searches, drafted), never the
 * size of the window it shows (the worker keeps the last twelve lines, so a count of them stood
 * at 12 for the whole run).
 */
export function WorkLog({
  lines,
  counters,
  live,
  open = true,
  max = 8,
  className,
}: {
  lines: readonly string[];
  counters?: string | null;
  live: boolean;
  open?: boolean;
  max?: number;
  className?: string;
}) {
  if (lines.length === 0 && !counters) return null;
  const shown = lines.slice(-max);
  const seen = new Map<string, number>();
  return (
    <details className={cn("group rounded-lg border border-border bg-panel", className)} open={open} data-work-log data-activity-log>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2 text-xs text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        <span className="font-medium text-fg-2">Activity</span>
        {live ? <span aria-hidden className={cn("size-1.5 rounded-full bg-primary", styles.pulse)} /> : null}
        {counters ? (
          <span className="ml-auto truncate font-mono tabular" data-work-log-counters>
            {counters}
          </span>
        ) : null}
      </summary>
      {shown.length > 0 ? (
        <ol className="flex select-text flex-col gap-0.5 border-t border-border px-3.5 py-2 font-mono text-xs" aria-live={live ? "polite" : undefined}>
          {shown.map((line, i) => {
            const n = (seen.get(line) ?? 0) + 1;
            seen.set(line, n);
            const newest = i === shown.length - 1;
            return (
              <li
                key={`${line}#${n}`}
                className={cn("truncate", newest ? "text-fg" : "text-muted", newest && live && styles.land)}
                title={line}
                data-work-log-line
              >
                {line}
              </li>
            );
          })}
        </ol>
      ) : null}
    </details>
  );
}

/**
 * The facts of a job, in one place and one shape on every page and in every state: a quiet row
 * under the title (what it reads, from where, where it runs, its recipe and lenses). Each fact
 * is a label and a value, so a screen reader hears "Repository: …".
 */
export function WorkFacts({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <dl className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)} data-work-facts>
      {children}
    </dl>
  );
}

export function WorkFact({ label, children, title, mono = false, hideLabel = false }: { label: string; children?: ReactNode; title?: string; mono?: boolean; hideLabel?: boolean }) {
  return (
    <div
      className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-panel px-2 text-xs sm:max-w-[26rem]"
      title={title}
      data-work-fact={label}
    >
      <dt className={cn("shrink-0 text-muted", hideLabel && "sr-only")}>{label}</dt>
      <dd className={cn("flex min-w-0 items-center gap-1 truncate text-fg-2 [&_svg]:size-3 [&_svg]:shrink-0", mono && "font-mono")}>{children}</dd>
    </div>
  );
}
