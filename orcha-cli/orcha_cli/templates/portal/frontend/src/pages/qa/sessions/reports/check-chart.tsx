import { ArrowDown, ArrowUp } from "../../map/kit/icons";
import { ChartCard, ChartEmpty, LegendItem, SEVERITY } from "./charts";
import { checkBars, checkTrends, sparklinePoints, type CheckBar, type CheckTrend } from "./exploration-list";
import { sevOrder } from "../../map/kit";
import { cn } from "../../map/kit";
import type { ExplorationFinding, ExplorationReportSummary, Severity } from "./types";

const EMPTY = "No measured check failed yet. What the agent judged is under each exploration's Judged tab.";

/**
 * One exploration: a ranked bar per check, stacked by severity.
 *
 * With a single exploration there is no trend to draw — a line chart put every
 * check on one x position and looked broken — so the question becomes "which check
 * is the problem, and how bad", which a sorted bar answers at a glance. Each bar is
 * a toggle that filters the findings list to that check.
 *
 * Plain HTML rather than recharts: a dozen labelled bars need no axes or tooltip
 * machinery, and divs keep the labels at the app's real text size.
 */
function CheckBars({
  bars,
  selectedKind,
  onSelect,
}: {
  bars: CheckBar[];
  selectedKind: string | null;
  onSelect: (kind: string) => void;
}) {
  const max = Math.max(1, ...bars.map((b) => b.total));
  return (
    <ul className="flex flex-col gap-0.5" data-check-bars>
      {bars.map((b) => {
        const on = selectedKind === b.kind;
        const faded = selectedKind != null && !on;
        return (
          <li key={b.kind}>
            <button
              type="button"
              onClick={() => onSelect(b.kind)}
              aria-pressed={on}
              data-check-bar={b.kind}
              title={`${b.label}: ${sevOrder
                .filter((s) => b.bySeverity[s] > 0)
                .map((s) => `${b.bySeverity[s]} ${s}`)
                .join(", ")}. Click to filter the list.`}
              className={cn(
                "grid h-7 w-full grid-cols-[min(40%,200px)_minmax(0,1fr)_40px] items-center gap-3 rounded-md px-2 text-left transition-colors duration-[90ms]",
                on ? "bg-selected" : "hover:bg-hover",
                faded && "opacity-50",
              )}
            >
              <span className="truncate text-sm text-fg-2">{b.label}</span>
              <span className="flex h-2.5 overflow-hidden rounded-[3px]" style={{ width: `${(b.total / max) * 100}%` }}>
                {sevOrder.map((s) =>
                  b.bySeverity[s] > 0 ? (
                    <span
                      key={s}
                      className="h-full border-r border-panel last:border-r-0"
                      style={{ width: `${(b.bySeverity[s] / b.total) * 100}%`, background: SEVERITY[s] }}
                    />
                  ) : null,
                )}
              </span>
              <span className="text-right font-mono text-sm font-medium tabular text-fg">{b.total}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Two or more explorations: one small sparkline per check with its latest count
 * and the change against the exploration before — "Low contrast 368 ↓12%".
 *
 * Small multiples instead of one many-line chart: each check gets its own y-scale,
 * so a check going 4 → 1 is as visible as one going 400 → 380, and nothing has to
 * be told apart by colour. Down is green and up is red, because every check here
 * counts things you want fewer of.
 */
function CheckSparklines({
  trends,
  selectedKind,
  onSelect,
}: {
  trends: CheckTrend[];
  selectedKind: string | null;
  onSelect: (kind: string) => void;
}) {
  const W = 120;
  const H = 28;
  return (
    <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3" data-check-sparklines>
      {trends.map((t) => {
        const on = selectedKind === t.kind;
        const worse = t.delta > 0;
        const better = t.delta < 0;
        const points = sparklinePoints(t.values, W, H, 3);
        const last = points.split(" ").pop()?.split(",").map(Number) ?? [W, H];
        const tone = worse ? "var(--color-danger)" : better ? "var(--color-success)" : "var(--color-muted)";
        return (
          <li key={t.kind}>
            <button
              type="button"
              onClick={() => onSelect(t.kind)}
              aria-pressed={on}
              data-check-trend={t.kind}
              className={cn(
                "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-[90ms]",
                on ? "border-border-strong bg-selected" : "border-border hover:bg-hover",
                selectedKind != null && !on && "opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-xs text-muted">{t.label}</span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-base font-semibold tabular text-fg">{t.latest}</span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5 font-mono text-xs tabular",
                      worse && "text-danger",
                      better && "text-success",
                      !worse && !better && "text-muted",
                    )}
                    title={`${t.previous} in the exploration before`}
                    data-check-delta={t.delta}
                  >
                    {worse ? <ArrowUp className="size-3" aria-hidden /> : better ? <ArrowDown className="size-3" aria-hidden /> : null}
                    {t.delta === 0
                      ? "no change"
                      : t.deltaPct == null
                        ? "new"
                        : Math.abs(t.deltaPct) < 1
                          ? "<1%"
                          : `${Math.abs(t.deltaPct)}%`}
                  </span>
                </span>
              </span>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                width={W}
                height={H}
                className="shrink-0 overflow-visible"
                role="img"
                aria-label={`${t.label}: ${t.values.join(", ")}, oldest to newest`}
              >
                <polyline
                  points={points}
                  fill="none"
                  stroke="var(--color-muted)"
                  strokeOpacity={0.7}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <circle cx={last[0]} cy={last[1]} r={2.5} fill={tone} />
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Findings per check — the chart at the top of the exploration tab. One
 * exploration gets ranked severity bars (`CheckBars`); two or more get a sparkline
 * per check (`CheckSparklines`). Either way, clicking a check filters the selected
 * exploration's findings list to it.
 */
export function CheckChart({
  summaries,
  selectedFindings,
  selectedKind,
  onSelectKind,
}: {
  summaries: readonly ExplorationReportSummary[];
  /** The selected exploration's findings, for the one-exploration bars. */
  selectedFindings: readonly ExplorationFinding[];
  selectedKind: string | null;
  onSelectKind: (kind: string) => void;
}) {
  const single = summaries.length <= 1;
  const bars = single ? checkBars(selectedFindings) : [];
  const trends = single ? [] : checkTrends(summaries);
  const present: Severity[] = single ? sevOrder.filter((s) => bars.some((b) => b.bySeverity[s] > 0)) : [];
  const total = bars.reduce((n, b) => n + b.total, 0);

  return (
    <ChartCard
      title="Findings per check"
      subtitle={
        single
          ? `${total} ${total === 1 ? "finding" : "findings"} across ${bars.length} ${bars.length === 1 ? "check" : "checks"} · click a check to filter`
          : `latest of ${summaries.length} explorations, change against the one before · click to filter`
      }
      testId="exploration-trend"
      legend={
        present.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {present.map((s) => (
              <LegendItem key={s} color={SEVERITY[s]} label={s} />
            ))}
          </div>
        ) : undefined
      }
    >
      {single ? (
        bars.length > 0 ? (
          <CheckBars bars={bars} selectedKind={selectedKind} onSelect={onSelectKind} />
        ) : (
          <ChartEmpty height={120} message={EMPTY} />
        )
      ) : trends.length > 0 ? (
        <CheckSparklines trends={trends} selectedKind={selectedKind} onSelect={onSelectKind} />
      ) : (
        <ChartEmpty height={120} message={EMPTY} />
      )}
    </ChartCard>
  );
}
