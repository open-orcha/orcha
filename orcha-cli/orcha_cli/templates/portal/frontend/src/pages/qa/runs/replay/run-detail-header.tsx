import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PlatformChip } from "../../map/kit";
import { Chip } from "../../map/kit";
import { RunVerdictGlyph } from "../parts/run-list-item";
import { FailureExplainer } from "../parts/failure-explainer";
import { nonZeroCounts } from "../../map/kit";
import type { RunCounters } from "../lib/run-counters";
import { verdictStyle, type runVerdict } from "../lib/run-list";
import type { FailureExplanation } from "../parts/failure-explainer";
import type { RunWithTarget } from "../types";
import { RunDetailCounters } from "./run-detail-counters";

export interface RunDetailHeaderProps {
  run: RunWithTarget;
  /** The run's name: project (or target) and when it started. Wraps, never truncates. */
  title: string;
  verdict: ReturnType<typeof runVerdict>;
  verdictResult: string | null;
  kind: "ios" | "android" | "web";
  modeLabel: string;
  counters: RunCounters;
  live: boolean;
  abandoned: boolean;
  /** Who ran it: the session's agent. */
  agent: string | null;
  /** The device or viewport it ran on, in words. */
  deviceLabel: string | null;
  /** The task it was started from. */
  task: string | null;
  taskId?: string | null;
  /** The way back, first on the line. */
  leading?: ReactNode;
  /** A failed or stopped run's one-sentence explanation. */
  failure: FailureExplanation | null;
  onRetry?: (() => void) | null;
  /** The theater's actions (Stop, Rerun, Freeze as golden, View as YAML, full screen), at the
   * end of the title line. */
  toolbar?: ReactNode;
  /** The failure sentence is shown elsewhere (the theater's Overview tab): not twice. */
  hideFailure?: boolean;
  /** `h2` inside the Runs tab's pane, where the page has its own `h1`. */
  headingLevel?: "h1" | "h2";
}

/**
 * The run page's header band, under the top bar (#187 Runs, #174 "cramped run header"). The
 * way back, the title, the verdict and status, then where and how it ran and its live counters
 * share one line that wraps, so the device and the steps start as high as they can. Chips wrap
 * instead of being clipped at the header's edge.
 */
/** Run statuses the verdict chip already names: no second chip for them. */
const VERDICT_SAYS_STATUS = new Set(["running", "queued", "cancelled"]);

export function RunDetailHeader(p: RunDetailHeaderProps) {
  const { run } = p;
  const style = verdictStyle(p.verdict);
  const Heading = p.headingLevel ?? "h1";
  return (
    <section
      aria-label="Run summary"
      className="flex flex-col gap-2 border-b border-border bg-bg px-4.5 py-2 max-[720px]:px-4"
      data-run-detail-header
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        {p.leading}
        <Heading className="min-w-0 break-words text-[15px] font-semibold leading-6 text-fg" data-run-title>
          {p.title}
        </Heading>
        <Chip data-run-header-verdict={p.verdict} title={style.label}>
          <RunVerdictGlyph verdict={p.verdict} size={12} />
          <span className={style.color}>{p.verdictResult ?? style.label.split(":")[0]}</span>
        </Chip>
        {p.abandoned ? (
          <Chip glyph="blocked" strong data-run-abandoned-chip>
            Stopped responding
          </Chip>
        ) : run.status !== "completed" && !VERDICT_SAYS_STATUS.has(run.status) ? (
          // Only a status the verdict chip does not already say ("Running" twice, #298 QA).
          <Chip glyph={run.status} strong data-run-header-status={run.status}>
            {run.status}
          </Chip>
        ) : null}
        {nonZeroCounts(run.counts).map(([sev, n]) => (
          <Chip key={sev} severity={sev}>
            {n} {sev}
          </Chip>
        ))}
        {p.deviceLabel ? (
          <Chip className="max-w-full" data-run-header-device>
            {p.deviceLabel}
          </Chip>
        ) : (
          <Chip className="max-w-full" data-run-header-placement={p.kind}>
            <PlatformChip kind={p.kind} />
          </Chip>
        )}
        {p.title.startsWith(p.modeLabel) ? null : <Chip>{p.modeLabel}</Chip>}
        <RunDetailCounters
          live={p.live}
          startedAt={run.started_at}
          durationS={run.duration_s}
          initial={p.counters}
        />
        {p.agent ? (
          <Chip mono data-run-profile title="The agent that ran it">
            {p.agent}
          </Chip>
        ) : null}
        {p.task ? (
          <Chip className="max-w-[320px] min-w-0" data-run-header-task title={p.task}>
            {p.taskId ? (
              <Link className="truncate hover:underline" to={`/tasks?task=${encodeURIComponent(p.taskId)}`}>{p.task}</Link>
            ) : (
              <span className="truncate">{p.task}</span>
            )}
          </Chip>
        ) : null}
        {p.toolbar ? (
          <div className="ml-auto flex flex-wrap items-center gap-1.5" data-run-header-toolbar>
            {p.toolbar}
          </div>
        ) : null}
      </div>

      {p.failure && !p.hideFailure ? <FailureExplainer failure={p.failure} onRetry={p.onRetry} /> : null}
    </section>
  );
}
