import { severityDot } from "../../map/kit";
import { sevOrder } from "../../map/kit";
import { cn } from "../../map/kit";
import type { Severity } from "./types";

/**
 * Findings by severity as one proportional bar plus labelled numbers.
 *
 * Deliberately not a recharts instance: this renders once per row in a list that
 * can hold forty explorations, has no axes, legend or tooltip, and is read as
 * "mostly major" at a glance rather than inspected — the same reasoning
 * `CardSparkline` documents for the projects grid.
 *
 * With `onToggle` it doubles as the severity filter: every segment and every
 * legend entry toggles that severity, the selected ones stay at full strength and
 * the rest fade, so the bar shows the whole picture *and* what is filtered.
 *
 * Confidence is not encoded here. A severity roll-up counts measured verdicts; an
 * unconfident finding has no verdict to count, and `needsLook` is reported
 * separately by the caller.
 */
export function SeverityBar({
  counts,
  total,
  className,
  selected,
  onToggle,
}: {
  counts: Record<Severity, number>;
  total: number;
  className?: string;
  /** Severities currently filtered to; empty means no severity filter. */
  selected?: readonly Severity[];
  onToggle?: (severity: Severity) => void;
}) {
  const present = sevOrder.filter((s) => (counts[s] ?? 0) > 0);
  const filtering = (selected?.length ?? 0) > 0;
  const isOn = (s: Severity) => selected?.includes(s) ?? false;
  const dim = (s: Severity) => filtering && !isOn(s);

  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-severity-bar>
      <div
        className={cn(
          "flex w-full overflow-hidden rounded-full bg-panel-2",
          onToggle ? "h-2 gap-px" : "h-1.5",
        )}
        role="img"
        aria-label={
          total === 0
            ? "No findings"
            : present.map((s) => `${counts[s]} ${s}`).join(", ")
        }
      >
        {present.map((s) => {
          const width = `${(counts[s] / Math.max(1, total)) * 100}%`;
          return onToggle ? (
            // A mouse shortcut only: the labelled buttons below are the
            // keyboard and screen-reader path to the same toggle.
            <span
              key={s}
              onClick={() => onToggle(s)}
              title={`${counts[s]} ${s}. Click to filter.`}
              data-severity-segment={s}
              className={cn(
                "h-full cursor-pointer transition-opacity hover:opacity-80",
                severityDot[s],
                dim(s) && "opacity-25",
              )}
              style={{ width }}
            />
          ) : (
            <span key={s} className={severityDot[s]} style={{ width }} />
          );
        })}
      </div>
      {present.length > 0 ? (
        <div className={cn("flex flex-wrap gap-y-0.5", onToggle ? "-ml-1.5 gap-x-0.5" : "gap-x-2.5")}>
          {present.map((s) =>
            onToggle ? (
              <button
                key={s}
                type="button"
                aria-pressed={isOn(s)}
                onClick={() => onToggle(s)}
                data-severity-filter={s}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted transition-colors hover:bg-hover hover:text-fg",
                  isOn(s) && "bg-selected text-fg",
                  dim(s) && "opacity-60",
                )}
              >
                <i aria-hidden className={cn("inline-block size-1.5 rounded-full", severityDot[s])} />
                <span className="font-medium tabular text-fg">{counts[s]}</span>
                {s}
              </button>
            ) : (
              <span key={s} className="inline-flex items-center gap-1 text-2xs text-muted">
                <i aria-hidden className={cn("inline-block size-1.5 rounded-full", severityDot[s])} />
                <span className="font-medium tabular text-fg">{counts[s]}</span>
                {s}
              </span>
            ),
          )}
        </div>
      ) : (
        <span className="text-2xs text-muted">No findings</span>
      )}
    </div>
  );
}
