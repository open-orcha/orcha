import { ArrowUpRight, ScrollText } from "../../map/kit/icons";
import { Button, Link, buttonVariants, cn } from "../../map/kit";
import { qaHref } from "../../parts";
import type { Platform, QaScenario } from "../../qaApi";

/** How the session page shows its drafts on a face: the live panel while it runs, the Debrief line
 * once it is done, nothing for a session without drafts. */
export function draftsPanelMode(count: number, face: string): "live" | "debrief" | null {
  if (count <= 0) return null;
  if (face === "queued" || face === "study" || face === "explore" || face === "check") return "live";
  if (face === "report" || face === "ended") return "debrief";
  return null;
}

/** "3 drafts to review", "1 draft to review", or null with none yet. */
export function draftsToReviewLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} draft${count === 1 ? "" : "s"} to review`;
}

/**
 * Draft scenarios on the session's own page: the drafts as they land and the way into the review
 * in Scenarios. The Debrief shows the count and the link, not the list.
 */
export function DraftsPanel({ drafts, platform, compact = false, onRunCheck }: { drafts: readonly Pick<QaScenario, "id" | "name" | "status">[]; onRunCheck?: () => void; platform: Platform; compact?: boolean }) {
  const count = drafts.length;
  const accepted = drafts.filter((d) => d.status === "validated").length;
  const runBar = accepted > 0 && onRunCheck ? (
    <Button size="sm" onClick={onRunCheck} data-run-accepted>
      Run what you accepted ({accepted})
    </Button>
  ) : null;
  const review = (
    <Link href={qaHref({ view: "scenarios", platform: platform === "ios" ? null : platform })} className={cn(buttonVariants({ variant: compact ? "primary" : "default", size: "sm" }), "shrink-0")} data-drafts-review>
      Review drafts <ArrowUpRight aria-hidden />
    </Link>
  );
  if (compact) {
    return (
      <section className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-panel px-4 py-3" aria-label="Draft scenarios" data-drafts-debrief={count}>
        <ScrollText aria-hidden className="size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-sm text-fg">{draftsToReviewLine(count)}</p>
        {review}
        {runBar}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4" aria-labelledby="drafts-panel-title" data-drafts-panel>
      <div className="flex flex-wrap items-center gap-2">
        <ScrollText aria-hidden className="size-4 shrink-0 text-primary" />
        <h2 id="drafts-panel-title" className="text-sm font-semibold text-fg">
          Drafts
        </h2>
        <span className="text-xs tabular text-muted" data-drafts-count={count}>
          {`${count} drafted`}
        </span>
        <span className="flex-1" />
        {review}
        {runBar}
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border" data-drafts-list>
        {drafts.slice(-8).map((r) => (
          <li key={r.id} className="v-rise flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm" data-drafts-item={r.id}>
            <span className="min-w-0 flex-1 truncate text-fg">{r.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
