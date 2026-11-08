import { useState } from "react";
import { History, List } from "../../map/kit/icons";
import { cn } from "../../map/kit";
import type { ExplorationReportDetail, ExplorationReportSummary } from "./types";
import { EMPTY_FILTER, type FindingFilter } from "./exploration-list";
import { CheckChart } from "./check-chart";
import { ReportDetail } from "./report-detail";
import { ReportsList } from "./reports-list";
import { VersionRail } from "./version-rail";

/**
 * The measured-report reader's layout.
 *
 * Wide (≥1024px): the version rail is a persistent left column, so every revision
 * of every version stays one click away while reading a report — that permanence is
 * what makes "revisions tied to app versions" navigable rather than merely stored.
 *
 * Narrow (<1024px): a 240px rail would leave ~160px for a report, so it collapses
 * into a disclosure above the report instead. The rail is in the DOM either way and
 * the toggle only changes its visibility, so nothing reflows when it opens and the
 * same URL renders the same content at both widths.
 *
 * The findings-per-check chart sits at the top at every width because it answers the question a
 * reader arrives with ("is this getting better?") before they pick a report.
 */
export function ExplorationBrowser({
  summaries,
  selected,
  detail,
  previous,
}: {
  summaries: readonly ExplorationReportSummary[];
  selected: ExplorationReportSummary;
  detail: ExplorationReportDetail;
  previous: { summary: ExplorationReportSummary; detail: ExplorationReportDetail } | null;
}) {
  const [showHistory, setShowHistory] = useState(false);
  // The findings filter lives here, not in the list, because the chart above the
  // report sets its check. It belongs to one exploration: picking another starts clean.
  const [filter, setFilter] = useState<FindingFilter>(EMPTY_FILTER);
  const [filterFor, setFilterFor] = useState(selected.report.id);
  if (filterFor !== selected.report.id) {
    setFilterFor(selected.report.id);
    setFilter(EMPTY_FILTER);
  }

  const selectKind = (kind: string) => {
    setFilter((f) => ({ ...f, kind: f.kind === kind ? null : kind }));
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-exploration-report="${CSS.escape(selected.report.id)}"] [role=tablist]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <section className="flex flex-col gap-4" data-exploration-section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-fg">Exploration</h2>
        <span className="text-xs text-muted">
          <span className="font-normal tabular text-muted">{summaries.length}</span>{" "}
          {summaries.length === 1 ? "exploration" : "explorations"}
        </span>
      </div>

      <CheckChart
        summaries={summaries}
        selectedFindings={detail.findings}
        selectedKind={filter.kind}
        onSelectKind={selectKind}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[232px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            data-exploration-history-toggle
            className="flex items-center justify-between gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm text-fg transition-colors hover:bg-hover lg:hidden"
          >
            <span className="flex items-center gap-2">
              <History className="size-3.5 text-muted" strokeWidth={1.75} aria-hidden />
              Version history
            </span>
            <span className="text-xs text-muted">{showHistory ? "Hide" : "Show"}</span>
          </button>

          <div
            data-exploration-rail-wrap
            className={cn(
              "min-w-0 flex-col gap-4 lg:flex",
              showHistory ? "flex" : "hidden",
            )}
          >
            <VersionRail summaries={summaries} selectedId={selected.report.id} />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <ReportDetail
            detail={detail}
            previous={previous}
            filter={filter}
            onFilterChange={setFilter}
          />

          <details className="group flex flex-col gap-2" data-exploration-all>
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-fg transition-colors hover:text-fg-2">
              <List className="size-3" strokeWidth={1.75} aria-hidden />
              All explorations
              <span className="font-normal tabular text-muted">{summaries.length}</span>
            </summary>
            <div className="pt-2">
              <ReportsList summaries={summaries} selectedId={selected.report.id} />
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
