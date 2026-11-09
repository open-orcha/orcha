import { Fragment, useMemo } from "react";
import { ExplorationChip } from "../../sessions/exploration-way-back";
import { summarizeStep } from "../replay/model";
import type { RunDetailContext } from "../replay/run-detail";
import { cn } from "../../map/kit";
import { budgetShare, elapsedAgainstBudget, logTail, macroPhases, type MacroStatus } from "./theater-model";
import type { TheaterData } from "./types";
import motion from "./theater.module.css";

const DOT: Record<MacroStatus, string> = {
  pending: "border border-border bg-transparent",
  running: "bg-accent",
  done: "bg-success",
  failed: "bg-danger",
};

/**
 * The running run's band above the tabs (#188 "a running run streams"): the phase timeline
 * (claimed → prepare → testing → judging → syncing), elapsed against the budget, the step it is
 * on and the last log lines, each new line fading in. Stop sits in the theater's toolbar.
 */
export function TheaterLive({ data, ctx }: { data: TheaterData; ctx: RunDetailContext }) {
  const phases = macroPhases([], { live: true, hasSteps: ctx.steps.length > 0, finished: false });
  const current = phases.find((p) => p.status === "running") ?? null;
  const share = budgetShare(ctx.elapsedMs, data.budgetMinutes);
  const clock = elapsedAgainstBudget(ctx.elapsedMs, data.budgetMinutes);
  const lastStep = ctx.steps[ctx.steps.length - 1] ?? null;
  // The newest three, oldest of them first (the rows read at load come newest first); the run's
  // own log when the app logged nothing.
  const lastLines = useMemo(() => logTail(ctx.logs, []), [ctx.logs]);
  return (
    <section
      aria-label="Running now"
      className="flex flex-col gap-2 border-b border-border bg-panel/60 px-4.5 py-2.5 max-md:px-4"
      data-theater-live
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <ol className="flex min-w-0 items-center gap-1.5" aria-label="Phases" data-theater-phases>
          {phases.map((p, i) => (
            <Fragment key={p.key}>
              {i > 0 ? (
                <li aria-hidden className={cn("h-px w-4 shrink-0", p.status === "pending" ? "bg-border" : "bg-fg/30")} />
              ) : null}
              <li
                className={cn("flex shrink-0 items-center gap-1.5 text-xs", p.status === "pending" ? "text-muted" : "text-fg-2")}
                data-phase={p.key}
                data-phase-status={p.status}
                aria-current={p.status === "running" ? "step" : undefined}
                title={p.message ?? undefined}
              >
                <span aria-hidden className={cn("size-1.5 rounded-full", DOT[p.status], p.status === "running" && motion.breathe)} />
                <span className={cn(p.status === "running" && "font-medium text-fg")}>{p.label}</span>
              </li>
            </Fragment>
          ))}
        </ol>
        {/* An exploration's explorer (or drafter): the way to its mission control, beside the phases. */}
        {data.exploration ? <ExplorationChip exploration={data.exploration} /> : null}
        {clock ? (
          <span className="ml-auto flex min-w-[120px] items-center gap-2 text-xs tabular text-muted" data-theater-elapsed>
            {share != null ? (
              <span aria-hidden className="relative h-1 w-16 overflow-hidden rounded-full bg-border">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-700"
                  style={{ width: `${Math.round(share * 100)}%` }}
                  suppressHydrationWarning
                />
              </span>
            ) : (
              <span aria-hidden className="relative h-1 w-16 overflow-hidden rounded-full bg-border">
                <span className={cn("absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent/60", motion.sweep)} />
              </span>
            )}
            {/* Ticks from the client's clock: the server rendered an earlier second (#250). */}
            <span suppressHydrationWarning>{clock}</span>
          </span>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-x-4 gap-y-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <p className="min-w-0 truncate text-xs text-muted" data-theater-current>
          {lastStep ? (
            <button type="button" onClick={() => ctx.jumpToStepSeq(lastStep.seq)} className="hover:text-fg" key={lastStep.seq}>
              <span className="text-fg-2">Step {lastStep.seq}</span>{" "}
              <span className={cn("font-mono", motion.fadeIn)}>{summarizeStep(lastStep)}</span>
            </button>
          ) : (
            <span>{current?.message ?? "Getting ready"}</span>
          )}
        </p>
        <ul className="flex min-w-0 flex-col" aria-label="Latest log lines" data-theater-log-tail>
          {lastLines.length === 0 ? (
            <li className="text-xs text-muted">No log lines yet.</li>
          ) : (
            lastLines.map((l) => (
              <li key={l.key} className={cn("min-w-0 truncate font-mono text-[11px] leading-4 text-muted", motion.lineIn)}>
                <span className={cn(l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : "text-muted")}>
                  {l.label}
                </span>{" "}
                <span className="text-fg-2">{l.text}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </section>
  );
}
