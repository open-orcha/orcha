import { StatusGlyph } from "../../map/kit";
import { MiniChip } from "../parts/mini-chip";
import type { CriterionEventRow } from "../types";
import { cn } from "../../map/kit";

/**
 * The expectations of a tracking-events criterion, each with whether it fired and the step it
 * fired at (a raw `steps.seq`, which `onSeekToStepSeq` jumps the replay to).
 */
export function TrackingEventsList({
  rows,
  onSeekToStepSeq,
  className,
}: {
  rows: readonly CriterionEventRow[];
  onSeekToStepSeq?: (seq: number) => void;
  className?: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted">No expectations were checked.</p>;
  return (
    <ul className={cn("flex flex-col gap-1.5", className)} data-tracking-events>
      {rows.map((r, i) => (
        <li key={i} className="flex min-w-0 items-start gap-2 text-sm" data-event-matched={r.matched}>
          <StatusGlyph
            status={r.matched ? "pass" : r.warning ? "warning" : "fail"}
            label={r.matched ? "fired" : "missing"}
            className="mt-[3px] size-3.5"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="break-words font-mono text-xs text-fg">{r.expectation}</span>
            {r.matched && r.event ? <span className="truncate text-xs text-muted" title={r.event}>{r.event}</span> : null}
            {!r.matched ? <span className="text-xs text-muted">never fired</span> : null}
          </div>
          {r.warning ? <MiniChip>non-critical</MiniChip> : null}
          {r.at != null ? (
            <button
              type="button"
              disabled={!onSeekToStepSeq}
              onClick={() => onSeekToStepSeq?.(r.at as number)}
              className="shrink-0 font-mono text-xs tabular text-muted hover:text-fg disabled:pointer-events-none"
              title="Jump to the step it fired at"
            >
              step {r.at}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
