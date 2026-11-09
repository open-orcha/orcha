import { Link } from "../../map/kit";
import { explorationHref } from "../links";
import { fmtDate } from "../../map/kit";
import { groupByVersion } from "./exploration";
import { cn } from "../../map/kit";
import type { ExplorationReportSummary, Severity } from "./types";
import { severityDot } from "../../map/kit";
import { sevOrder } from "../../map/kit";

/**
 * The version rail: every exploration of the project, grouped by app version,
 * newest first, with each revision under its version.
 *
 * This is the spec's "revisions tied to app versions and dates" made navigable.
 * Revisions are append-only — exploring `1.4` a second time produces revision 2,
 * never an overwrite — so the rail has to make both reachable, or a fix could
 * never be shown against the exploration that found the problem.
 *
 * Selection lives in a `report` search param, alongside the `tab` param the project
 * page already uses, so a specific exploration is a linkable URL rather than
 * client state that dies on refresh.
 */
export function VersionRail({
  summaries,
  selectedId,
  className,
}: {
  summaries: readonly ExplorationReportSummary[];
  selectedId: string | null;
  className?: string;
}) {
  const hrefFor = explorationHref;

  const groups = groupByVersion(summaries);

  return (
    <nav className={cn("flex flex-col gap-4", className)} aria-label="Explorations" data-version-rail>
      {groups.map((group) => (
        <div key={group.version ?? "__none__"} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <h3 className="truncate text-sm font-medium tabular text-fg">
              {group.version ?? "unversioned"}
            </h3>
            <span className="shrink-0 text-2xs text-muted">
              {group.reports.length} {group.reports.length === 1 ? "run" : "runs"}
            </span>
          </div>

          <ul className="flex flex-col">
            {group.reports.map((s, i) => {
              const on = s.report.id === selectedId;
              const worst = sevOrder.find(
                (sev: Severity) => (s.bySeverity[sev] ?? 0) + (s.judgedBySeverity[sev] ?? 0) > 0,
              );
              const last = i === group.reports.length - 1;
              return (
                <li key={s.report.id} className="relative flex">
                  {/* The spine: a continuous line down the version's revisions, cut
                      short on the last one so the group visibly ends. */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-[7px] top-0 w-px bg-border",
                      last ? "h-[18px]" : "h-full",
                    )}
                  />
                  <Link
                    href={hrefFor(s.report.id)}
                    scroll={false}
                    replace
                    aria-current={on ? "true" : undefined}
                    data-rail-report={s.report.id}
                    data-rail-selected={on ? "yes" : undefined}
                    className={cn(
                      "group relative z-10 flex min-w-0 flex-1 items-start gap-2 rounded-md py-1.5 pl-0.5 pr-2 transition-colors",
                      on ? "bg-hover" : "hover:bg-hover",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-[5px] size-[9px] shrink-0 rounded-full border-2 border-bg",
                        on
                          ? "bg-accent"
                          : worst
                            ? severityDot[worst]
                            : "bg-muted/50",
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span
                        className={cn(
                          "truncate text-xs leading-4",
                          on ? "font-medium text-fg" : "text-fg",
                        )}
                      >
                        revision {s.report.revision}
                      </span>
                      <span className="truncate text-2xs leading-4 text-muted">
                        {fmtDate(s.report.created_at, { time: false })} ·{" "}
                        <span className="font-medium tabular">{s.findings}</span> measured ·{" "}
                        <span className="font-medium tabular">{s.judged}</span> judged
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
