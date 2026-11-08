import { Link } from "../../map/kit";
import { Play } from "../../map/kit/icons";
import { buttonVariants } from "../../map/kit";
import { PLATFORM_LABELS, PlatformIcon } from "../../map/kit";
import type { TargetKind } from "../explorations";
import { runHref } from "../links";
import { cn } from "../../map/kit";

export interface ExplorationRunLink {
  explorationId: string;
  requestId: string | null;
  runId: string;
  kind: TargetKind | null;
  live: boolean;
}

/**
 * The explorer runs the header links to, kept current with the live row: the own run as soon as
 * the row names it (the page may have loaded before the run started), live while the
 * exploration's face is still running.
 */
export function currentRunLinks(
  links: readonly ExplorationRunLink[],
  own: { explorationId: string; runId: string | null; kind: ExplorationRunLink["kind"]; running: boolean },
): ExplorationRunLink[] {
  const list = links.map((l) => (l.explorationId === own.explorationId ? { ...l, live: own.running } : l));
  if (own.runId && !list.some((l) => l.runId === own.runId)) {
    list.unshift({ explorationId: own.explorationId, requestId: null, runId: own.runId, kind: own.kind, live: own.running });
  }
  return list;
}

/** What a run link says: one run, "Watch the live run" or "Open the run"; several, per platform. */
export function runLinkLabel(link: Pick<ExplorationRunLink, "kind" | "live">, several: boolean): string {
  if (!several) return link.live ? "Watch the live run" : "Open the run";
  const platform = link.kind ? (PLATFORM_LABELS[link.kind] ?? link.kind) : "Run";
  return `${platform} · ${link.live ? "Watch live" : "Open run"}`;
}

/**
 * The way from the exploration to its run, in the header on every face: "Watch the live run"
 * with a pulse while it runs, "Open the run" once it is done, one per platform when several
 * explored together. The run page's "Back to exploration" makes it a round trip.
 */
export function ExplorationRunLinks({ links }: { links: readonly ExplorationRunLink[] }) {
  if (links.length === 0) return null;
  const several = links.length > 1;
  return (
    <>
      {links.map((l) => (
        <Link
          key={l.runId}
          href={runHref(l.runId)}
          className={cn(buttonVariants({ variant: l.live && !several ? "primary" : "default" }), "gap-1.5")}
          title={l.live ? "Watch the explorer's run live: its device, steps and logs" : "Every step of the explorer's run"}
          data-exploration-run-link={l.runId}
          data-run-live={l.live ? "" : undefined}
        >
          {l.live ? (
            <span aria-hidden className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full rounded-full bg-current opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex size-2 rounded-full bg-current" />
            </span>
          ) : several && l.kind ? null : (
            <Play />
          )}
          {several && l.kind ? <PlatformIcon kind={l.kind} className="size-3.5 shrink-0" /> : null}
          {runLinkLabel(l, several)}
        </Link>
      ))}
    </>
  );
}
