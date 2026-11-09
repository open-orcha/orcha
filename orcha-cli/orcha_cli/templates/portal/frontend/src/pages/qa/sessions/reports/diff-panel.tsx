import { useMemo } from "react";
import { ArrowRight, Minus, TrendingDown, TrendingUp } from "../../map/kit/icons";
import { auditKindLabel, countByKind, diffFindings, kindDeltas, revisionLabel } from "./exploration";
import { fmtDate } from "../../map/kit";
import { cn } from "../../map/kit";
import type { ExplorationReportDetail, ExplorationReportSummary } from "./types";
import type { FindingFilter, ListSection } from "./exploration-list";
import { FindingsExplorer } from "./findings-explorer";

/**
 * One check's count moving between two explorations.
 *
 * The sign convention is `diff_counts` in `src/orcha/audit/report.py`: **positive
 * is worse, negative is better**. The arrow and the colour both follow that, so a
 * reader never has to work out which direction is good — the number that went down
 * is green whether the check counts failures or pixels, because every check in this
 * audit counts things you want fewer of.
 */
export function DeltaRow({
  label,
  previous,
  current,
  delta,
}: {
  label: string;
  previous: number;
  current: number;
  delta: number;
}) {
  const worse = delta > 0;
  const better = delta < 0;
  const Icon = worse ? TrendingUp : better ? TrendingDown : Minus;

  return (
    <li
      data-kind-delta={label}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border py-2 last:border-b-0"
    >
      <span className="min-w-0 truncate text-sm text-fg">{label}</span>
      <span className="flex items-center gap-2">
        <span className="flex items-baseline gap-1.5 font-mono text-sm tabular">
          <span className="text-muted">{previous}</span>
          <ArrowRight className="size-3 shrink-0 self-center text-muted" aria-hidden />
          <span className="font-semibold text-fg">{current}</span>
        </span>
        <span
          className={cn(
            "inline-flex h-[18px] min-w-[46px] items-center justify-center gap-1 rounded-full px-1.5 font-mono text-xs font-medium tabular",
            worse && "bg-danger/15 text-danger",
            better && "bg-success/15 text-success",
            !worse && !better && "bg-panel-2 text-muted",
          )}
          title={
            worse
              ? `${delta} more than the previous exploration`
              : better
                ? `${Math.abs(delta)} fewer than the previous exploration`
                : "unchanged"
          }
        >
          <Icon className="size-2.5" aria-hidden />
          {delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : "0"}
        </span>
      </span>
    </li>
  );
}

/**
 * This exploration against the one before it: what is new, what is gone, what is
 * unchanged, and how every check's count moved.
 *
 * The count table comes first on purpose. Individual findings answer "what is
 * wrong"; the counts answer "is this getting better", which is the question a
 * version-to-version comparison exists for. The findings below it are the same
 * merged, grouped, windowed list as the Measured tab, in three sections.
 */
export function DiffPanel({
  current,
  previous,
  filter,
  onFilterChange,
}: {
  current: ExplorationReportDetail;
  previous: { summary: ExplorationReportSummary; detail: ExplorationReportDetail } | null;
  filter: FindingFilter;
  onFilterChange: (next: FindingFilter) => void;
}) {
  const diff = useMemo(
    () => (previous ? diffFindings(previous.detail.findings, current.findings) : null),
    [previous, current.findings],
  );
  const sections = useMemo<ListSection[]>(
    () =>
      diff
        ? [
            { key: "added", title: "New", description: "found this time, absent last time", tone: "worse", findings: diff.added },
            { key: "removed", title: "Gone", description: "found last time, absent this time", tone: "better", findings: diff.removed },
            {
              key: "unchanged",
              title: "Unchanged",
              description: "found in both, showing this exploration's measurement",
              tone: "same",
              findings: diff.unchanged,
            },
          ]
        : [],
    [diff],
  );

  if (!previous || !diff) {
    return (
      <div
        className="rounded-lg border border-border bg-panel px-3 py-6 text-center text-sm text-muted"
        data-exploration-diff-empty
      >
        This is the first exploration of this project. There is nothing to compare it against yet.
        The next one will diff against this.
      </div>
    );
  }

  const deltas = kindDeltas(previous.summary.byKind, countByKind(current.findings));

  const netDelta = current.findings.length - previous.detail.findings.length;

  return (
    <div className="flex flex-col gap-4" data-exploration-diff>
      <div className="flex flex-col gap-2 rounded-md border border-border bg-panel p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-medium text-fg">
            Against{" "}
            <span className="font-medium tabular">{revisionLabel(previous.summary.report)}</span>
          </h3>
          <span className="text-xs text-muted">
            explored {fmtDate(previous.summary.report.created_at, { time: false })}
          </span>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <span className="tabular text-muted">{previous.detail.findings.length}</span>
          <ArrowRight className="size-3 self-center text-muted" aria-hidden />
          <span className="font-mono text-base font-semibold tabular text-fg">
            {current.findings.length}
          </span>
          <span className="text-xs text-muted">findings total</span>
          <span
            className={cn(
              "ml-1 inline-flex h-[18px] items-center rounded-full px-1.5 font-mono text-xs font-medium tabular",
              netDelta > 0 && "bg-danger/15 text-danger",
              netDelta < 0 && "bg-success/15 text-success",
              netDelta === 0 && "bg-panel-2 text-muted",
            )}
          >
            {netDelta > 0 ? `+${netDelta}` : netDelta < 0 ? String(netDelta) : "no change"}
          </span>
        </div>

        {deltas.length > 0 ? (
          <ul className="mt-1 flex flex-col" data-kind-deltas>
            {deltas.map((d) => (
              <DeltaRow
                key={d.kind}
                label={auditKindLabel(d.kind)}
                previous={d.previous}
                current={d.current}
                delta={d.delta}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Neither exploration found anything.</p>
        )}
      </div>

      {diff.added.length + diff.removed.length + diff.unchanged.length > 0 ? (
        <FindingsExplorer
          key={current.report.id}
          sections={sections}
          filter={filter}
          onFilterChange={onFilterChange}
          testId="diff"
        />
      ) : null}

      {diff.added.length === 0 && diff.removed.length === 0 && diff.unchanged.length === 0 ? (
        <div className="rounded-lg border border-border bg-panel px-3 py-6 text-center text-sm text-muted">
          Neither exploration found anything to compare.
        </div>
      ) : null}
    </div>
  );
}
