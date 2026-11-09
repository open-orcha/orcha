import { useEffect, useState, type ReactNode } from "react";
import { StatusGlyph, type GlyphStatus } from "../../map/kit";
import { fmtDate } from "../../map/kit";
import { cn } from "../../map/kit";
import { fmtClock, fmtTook, secondsBetween, statusLabel, type WorkStatus } from "./words";
import styles from "./work.module.css";

const GLYPH: Readonly<Record<WorkStatus, GlyphStatus>> = {
  idle: "pending",
  queued: "queued",
  preparing: "running",
  running: "running",
  done: "pass",
  failed: "fail",
  stopped: "cancelled",
};

/** Now, once a second while `on`. */
export function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** The status as a pill: its glyph (a shape, never colour alone) and its word. */
export function WorkStatusPill({
  status,
  doing,
  waiting,
  className,
}: {
  status: WorkStatus;
  doing?: string | null;
  /** What a queued job waits for, when it is not a worker. */
  waiting?: string | null;
  className?: string;
}) {
  const live = status === "running" || status === "preparing";
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium",
        live ? "border-primary/40 bg-primary/10 text-fg" : status === "failed" ? "border-danger/40 text-danger" : "border-border text-fg-2",
        className,
      )}
      data-work-status={status}
    >
      {live ? (
        <span aria-hidden className={cn("size-1.5 rounded-full bg-primary", styles.pulse)} />
      ) : (
        <StatusGlyph status={GLYPH[status]} size={12} decorative />
      )}
      {statusLabel(status, doing, waiting)}
    </span>
  );
}

/** "Running 4:26" while it runs (ticking), "Took 8m 44s" once it ended. */
export function WorkElapsed({
  status,
  startedAt,
  endedAt,
  durationS,
}: {
  status: WorkStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  /** A finished job's own count of its length, preferred over the timestamps. */
  durationS?: number | null;
}) {
  const live = status === "running" || status === "preparing";
  const now = useTick(live && Boolean(startedAt));
  if (live) {
    const s = secondsBetween(startedAt, now);
    return s == null ? null : (
      <span className="font-mono text-xs tabular text-muted" data-work-elapsed suppressHydrationWarning>
        {fmtClock(s)}
      </span>
    );
  }
  if (status === "queued" || status === "idle") return null;
  const took = fmtTook(durationS ?? secondsBetween(startedAt, endedAt));
  return took ? (
    <span className="text-xs text-muted" data-work-elapsed title="How long it took">
      Took <span className="font-mono tabular">{took}</span>
    </span>
  ) : null;
}

/**
 * The title row of every job page: the job's name, then one line of facts that are the
 * same everywhere (status, elapsed time, model, cost), and the actions in one order on every
 * page: Stop or Run again, What Orcha was told, Open the run, More. The facts follow in one
 * row, then `children` (what was asked).
 */
export function WorkTitle({
  name,
  kicker,
  status,
  doing,
  waiting,
  startedAt,
  endedAt,
  durationS,
  model,
  cost,
  costTitle,
  meta,
  primary,
  brief,
  openRun,
  more,
  facts,
  children,
  className,
}: {
  name: ReactNode;
  /** A small line above the name: the job kind when the name is the person's own. */
  kicker?: ReactNode;
  status: WorkStatus;
  /** The verb while it runs ("Reading", "Exploring", "Drafting"). */
  doing?: string | null;
  /** What it waits for while queued, when it is not a worker ("Waiting for a device"). */
  waiting?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationS?: number | null;
  /** The model chip(s). */
  model?: ReactNode;
  cost?: string | null;
  /** The cost's tooltip (default "Model cost"). */
  costTitle?: string;
  /** Extra facts at the end of the line (a focus chip). */
  meta?: ReactNode;
  /** Stop while it runs, Run again (or Generate again) once it ended. */
  primary?: ReactNode;
  /** The "What Orcha was told" button. */
  brief?: ReactNode;
  /** The way to the job's run(s). */
  openRun?: ReactNode;
  /** The overflow menu. */
  more?: ReactNode;
  /** The job's facts (`WorkFacts`): one quiet row under the title, the same on every job. */
  facts?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-2.5", className)} data-work-title data-detail-header>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {kicker ? <div className="text-xs text-muted" data-work-kicker>{kicker}</div> : null}
          {typeof name === "string" ? (
            <h1 className="min-w-0 break-words text-lg font-semibold leading-7 text-fg" data-work-name>
              {name}
            </h1>
          ) : (
            name
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5" data-work-meta>
            <WorkStatusPill status={status} doing={doing} waiting={waiting} />
            <WorkElapsed status={status} startedAt={startedAt} endedAt={endedAt} durationS={durationS} />
            {startedAt && status !== "queued" && status !== "idle" ? (
              <span className="text-xs text-muted" data-work-started suppressHydrationWarning>
                Started {fmtDate(startedAt)}
              </span>
            ) : null}
            {model ? <span className="flex min-w-0 flex-wrap items-center gap-1.5">{model}</span> : null}
            {cost ? (
              <span className="font-mono text-xs tabular text-muted" title={costTitle ?? "Model cost"} data-work-cost data-detail-cost>
                {cost}
              </span>
            ) : null}
            {meta}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" data-work-actions data-detail-actions>
          {primary}
          {brief}
          {openRun}
          {more}
        </div>
      </div>
      {facts}
      {children}
    </header>
  );
}
