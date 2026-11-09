import { Chip } from "../../map/kit";
import { useNow } from "../lib/use-now";
import { fmtDuration, plural } from "../../map/kit";
import { elapsedSince, fmtClock, runClockStart, type RunCounters } from "../lib/run-counters";

/**
 * The run header's counters (#170): elapsed time, actions and screens, from the one source
 * every surface uses (`lib/run-counters`). While the run is live the clock ticks every second
 * and the counts follow the run's steps; afterwards it shows the stored duration. It used to
 * read "— · 0 actions" for the whole of a live run (no duration yet, no step count yet).
 */
export function RunDetailCounters({
  live,
  startedAt,
  durationS,
  initial,
}: {
  live: boolean;
  startedAt: string | null;
  durationS: number | null;
  /** Counters from the steps the server rendered with. */
  initial: RunCounters;
}) {
  const now = useNow(live);
  const counters = initial;
  // The clock starts at the session's first step (#200): the device session coming up is not run time.
  const clockStart = runClockStart(startedAt, initial.firstAtMs);
  const elapsed = live ? elapsedSince(clockStart, now) : null;
  const time = live ? fmtClock(elapsed) : durationS != null ? fmtDuration(durationS) : null;
  return (
    <Chip
      mono
      className="gap-1.5"
      title="Elapsed time, actions the agent took and distinct screens it saw. The Steps tab lists every one."
      data-run-header-actions
      data-live={live ? "" : undefined}
    >
      {live ? <span aria-hidden className="v-live size-1.5" /> : null}
      {time ? (
        <span data-run-header-elapsed suppressHydrationWarning>
          {time}
        </span>
      ) : null}
      {time ? <span aria-hidden className="text-muted">·</span> : null}
      <span data-run-header-action-count>{plural(counters.actions, "action")}</span>
      {counters.screens > 0 ? (
        <>
          <span aria-hidden className="text-muted">·</span>
          <span data-run-header-screens>{plural(counters.screens, "screen")}</span>
        </>
      ) : null}
    </Chip>
  );
}
