import { StepsList, type StepsListProps } from "../replay/steps-list";
import { StatusGlyph } from "../../map/kit";
import type { TimelineGroup } from "./theater-model";

/** A charter mission's status in the glyph set's words. */
const MISSION_GLYPH: Record<string, string> = {
  covered: "pass",
  bug: "fail",
  partial: "mixed",
  blocked: "blocked",
  planned: "queued",
  active: "running",
};

/**
 * The Steps timeline grouped (#188): a scenario run's steps under the scenario and criterion
 * they served, an exploration's under the charter mission it was on. Each group is the plain
 * step list with a sticky heading; only the newest group is live (its last step is the one
 * happening now). Clicking a step jumps the player, as in the flat list.
 */
export function TimelineGroups({
  groups,
  live = false,
  ...list
}: Omit<StepsListProps, "steps"> & { groups: readonly TimelineGroup[] }) {
  return (
    <div className="flex flex-col gap-1" data-timeline-groups>
      {groups.map((g, i) => (
        <section key={g.key} aria-label={g.subtitle ? `${g.title}: ${g.subtitle}` : g.title} data-timeline-group>
          <header className="sticky top-0 z-[1] flex min-w-0 flex-col gap-0.5 bg-bg/95 px-2 pb-1 pt-2 backdrop-blur-sm">
            {g.leads ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-fg-2" data-timeline-title>
                {g.outcome && !g.subtitle ? (
                  <StatusGlyph status={MISSION_GLYPH[g.outcome] ?? g.outcome} size={12} decorative />
                ) : null}
                <span className="truncate">{g.title}</span>
              </span>
            ) : null}
            {g.subtitle ? (
              <span className="flex min-w-0 items-center gap-1.5 pl-3 text-xs text-muted" data-timeline-criterion>
                {g.outcome ? <StatusGlyph status={g.outcome} size={12} decorative /> : null}
                <span className="truncate" title={g.subtitle}>
                  {g.subtitle}
                </span>
              </span>
            ) : null}
          </header>
          <StepsList steps={g.steps} live={live && i === groups.length - 1} {...list} />
        </section>
      ))}
    </div>
  );
}
