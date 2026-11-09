import { Link } from "../../map/kit";
import { explorationHref } from "../links";
import { Moon, Sun } from "../../map/kit/icons";
import { Chip } from "../../map/kit";
import { appearanceLabel, revisionLabel } from "./exploration";
import { fmtDate } from "../../map/kit";
import { cn } from "../../map/kit";
import type { ExplorationReportSummary } from "./types";
import { SeverityBar } from "./severity-bar";

/**
 * Every exploration of a project, newest first — the "which one do I open" view.
 *
 * Each row carries the four things that decide that: the version and revision, the
 * date, which appearances were actually walked (a report that never saw dark mode
 * cannot have cleared it), and the findings split by severity. "Needs a look" is
 * shown as its own number and never folded into the severity totals.
 */
export function ReportsList({
  summaries,
  selectedId,
}: {
  summaries: readonly ExplorationReportSummary[];
  selectedId: string | null;
}) {
  const hrefFor = explorationHref;

  return (
    <ul className="flex flex-col gap-2" data-exploration-list>
      {summaries.map((s) => {
        const on = s.report.id === selectedId;
        const confidentFindings = s.findings - s.needsLook;
        return (
          <li key={s.report.id}>
            <Link
              href={hrefFor(s.report.id)}
              replace
              scroll={false}
              aria-current={on ? "true" : undefined}
              data-exploration-row={s.report.id}
              className={cn(
                "flex flex-col gap-2 rounded-md border bg-panel p-3 transition-colors",
                on ? "border-accent" : "border-border hover:bg-hover",
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-base font-semibold tabular text-fg">
                    {revisionLabel(s.report)}
                  </span>
                  <span className="text-xs text-muted">
                    {fmtDate(s.report.created_at, { time: false })}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {s.report.appearances.map((a) => (
                    <Chip key={a} className="h-[18px] px-1.5 text-xs" title={`Walked in ${a}`}>
                      {a === "dark" ? (
                        <Moon className="size-2.5" aria-hidden />
                      ) : (
                        <Sun className="size-2.5" aria-hidden />
                      )}
                      {appearanceLabel(a)}
                    </Chip>
                  ))}
                </span>
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>
                  <span className="font-medium tabular text-fg">{s.report.screens_seen}</span> screens
                </span>
                <span>
                  <span className="font-medium tabular text-fg">{confidentFindings}</span> measured
                </span>
                {s.needsLook > 0 ? (
                  <span>
                    <span className="font-medium tabular text-fg">{s.needsLook}</span> needs a look
                  </span>
                ) : null}
                <span>
                  <span className="font-medium tabular text-fg">{s.judged}</span> judged
                </span>
                <span>
                  <span className="font-medium tabular text-fg">{s.notes}</span>{" "}
                  {s.notes === 1 ? "note" : "notes"}
                </span>
              </div>

              <SeverityBar counts={s.bySeverity} total={confidentFindings} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
