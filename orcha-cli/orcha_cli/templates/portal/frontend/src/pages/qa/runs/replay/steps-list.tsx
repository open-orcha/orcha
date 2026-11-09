import { useEffect, useRef } from "react";
import { Camera } from "../../map/kit/icons";
import { StatusGlyph } from "../../map/kit";
import { fmtMs } from "../../map/kit";
import type { Step } from "../types";
import { cn } from "../../map/kit";
import { isStepError, summarizeStep, truncate } from "./model";

export interface StepsListProps {
  steps: readonly Step[];
  /** `seq` of the highlighted step (the current frame's step, or a clicked row). */
  currentSeq: number | null;
  onSelect: (step: Step) => void;
  /** `steps.seq -> count of level=error run_logs` (see `logs-model.errorCountsByStep`).
   * Renders a small red count badge so scanning the step list reveals where things went
   * wrong (runtime-logs spec §5, the two-way log/step correlation). */
  errorLogCounts?: ReadonlyMap<number, number>;
  /** True while the run is still executing. Turns the list into live progress: the newest step
   * is the one happening now (a spinner), everything before it is done (a check). Without this
   * a running list and a finished one looked identical, so there was no way to tell what the
   * agent was doing *right now* — only that six steps existed. */
  live?: boolean;
}

function scrollBehavior(): ScrollBehavior {
  const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduce ? "auto" : "smooth";
}

/** Dense step rows: seq, time, kind + args summary, result, error dot, log-error badge. */
export function StepsList({ steps, currentSeq, onSelect, errorLogCounts, live = false }: StepsListProps) {
  const rows = useRef(new Map<number, HTMLButtonElement>());
  // The agent appends steps as it goes, so the last one is the one in flight. It is the newest
  // `seq` rather than the array tail, because a late-arriving realtime row can land out of
  // order and would otherwise make an earlier step look current.
  const liveSeq = live && steps.length ? Math.max(...steps.map((s) => s.seq)) : null;
  // The timeline glides to the step the player shows, and while live to the step happening now
  // (#188). Reduced motion jumps.
  useEffect(() => {
    if (currentSeq == null) return;
    rows.current.get(currentSeq)?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, [currentSeq]);
  useEffect(() => {
    if (liveSeq == null) return;
    rows.current.get(liveSeq)?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, [liveSeq]);

  if (steps.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No steps recorded.</p>;
  }

  return (
    <div role="list" data-steps-list className="flex flex-col">
      {steps.map((s) => {
        const summary = summarizeStep(s);
        const result = (s.result ?? "").trim();
        const err = isStepError(s);
        const current = s.seq === currentSeq;
        const isLive = s.seq === liveSeq;
        const isDone = liveSeq != null && s.seq < liveSeq;
        const logErrN = errorLogCounts?.get(s.seq) ?? 0;
        return (
          <div key={s.seq} className="group/step relative">
          <button
            type="button"
            role="listitem"
            ref={(el) => {
              if (el) rows.current.set(s.seq, el);
              else rows.current.delete(s.seq);
            }}
            onClick={() => onSelect(s)}
            aria-current={current ? "step" : undefined}
            data-step-row
            data-seq={s.seq}
            data-live-step={isLive ? "" : undefined}
            className={cn(
              "grid min-h-8 w-full grid-cols-[32px_40px_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-hover max-sm:grid-cols-[32px_minmax(0,1fr)_auto] max-sm:gap-2",
              current && "bg-selected hover:bg-selected",
            )}
          >
            <span className="flex items-center justify-end gap-1 font-mono text-xs tabular text-muted">
              {isLive ? (
                <StatusGlyph status="running" label="running now" className="size-3" />
              ) : isDone && !err ? (
                <StatusGlyph status="pass" decorative className="size-3" />
              ) : null}
              {s.seq}
            </span>
            <span className="font-mono text-xs tabular text-muted max-sm:hidden">{fmtMs(s.at_ms)}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="select-text truncate" title={summary}>
                <span className={cn("text-sm font-medium text-fg", s.kind === "screen" && "text-muted")}>
                  {s.kind}
                </span>
                {summary.length > s.kind.length ? (
                  <span className="font-mono text-xs text-muted">
                    {" "}
                    {summary.slice(s.kind.length).trim()}
                  </span>
                ) : null}
              </span>
              {s.frame_path ? (
                <Camera
                  aria-label="has frame"
                  className="size-3 shrink-0 text-muted/70"
                  strokeWidth={1.75}
                />
              ) : null}
            </span>
            <span
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted max-sm:hidden"
              title={result || undefined}
            >
              {err ? <StatusGlyph status="fail" label="error" className="size-3" /> : null}
              <span className={cn("select-text truncate", err && "text-fg")}>{truncate(result)}</span>
            </span>
            {logErrN > 0 ? (
              <span className="flex shrink-0 items-center gap-2">
                {logErrN > 0 ? (
                  <span
                    data-step-log-error-badge
                    title={`${logErrN} error log${logErrN === 1 ? "" : "s"} during this step`}
                    className="inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular text-muted"
                  >
                    <StatusGlyph status="fail" decorative className="size-3" />
                    {logErrN}
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
          </div>
        );
      })}
    </div>
  );
}
