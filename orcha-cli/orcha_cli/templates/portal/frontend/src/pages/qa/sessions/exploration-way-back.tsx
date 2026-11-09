import { Link } from "../map/kit";
import { useRouter } from "../map/kit";
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowLeft, Compass } from "../map/kit/icons";
import { getSession } from "../qaApi";
import { explorationOf } from "./adapt";
import { useNow } from "./detail/phase-timeline";
import { LIVE_POLL_MS } from "./detail/use-session-live";
import { explorationHref, explorationPhaseLabel, isExplorationLive, toRunExploration, type RunExploration } from "./exploration-link";
import { cn } from "../map/kit";

/**
 * The exploration a run belongs to, kept current while it moves: its row is read again every few
 * seconds, and the clock ticks each second while it is live.
 */
export function useLiveExploration(initial: RunExploration): { exploration: RunExploration; phase: string; live: boolean } {
  const [row, setRow] = useState(initial);
  // A server refresh brings a newer row: adopt it.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setRow(initial);
  }
  const live = isExplorationLive(row.status);
  const now = useNow(live);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      void getSession(row.id).then(
        (d) => setRow(toRunExploration({ ...explorationOf(d.session, { findings: d.findings, walks: d.walks, drafted: d.drafts.length }) }, initial.role)),
        () => {},
      );
    }, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [live, row.id, initial.role]);
  return { exploration: row, phase: explorationPhaseLabel(row, now), live };
}

/** A small pulsing dot while the exploration is live. */
function LiveDot({ live, className }: { live: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", live ? "bg-accent motion-safe:animate-pulse" : "bg-muted/60", className)}
      data-exploration-live={live ? "" : undefined}
    />
  );
}

/**
 * "← Back to exploration · Exploring · 4:12 left" at the far left of a run's header, in place of
 * "← Runs", when the run is an exploration's (an explorer on any platform, or the drafter of a
 * paired one). A plain link (a push), so browser Back still returns here.
 */
export function ExplorationBackLink({ exploration: initial }: { exploration: RunExploration }) {
  const { exploration: e, phase, live } = useLiveExploration(initial);
  const noun = e.recipe === "map" ? "mapping" : "exploration";
  const role = e.role === "drafter" ? "This run drafts scenarios for" : e.recipe === "map" ? "This run maps for" : "This run explores for";
  return (
    <>
      <Link
        href={explorationHref(e.id)}
        className="group/back flex h-7 min-w-0 shrink items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-panel px-2 text-sm text-fg transition-colors hover:bg-hover"
        title={`${role} ${e.name}: ${phase}. Back to the ${noun}.`}
        aria-label={`Back to ${noun} ${e.name}, ${phase}`}
        data-exploration-back={e.id}
        data-exploration-status={e.status}
      >
        <ArrowLeft aria-hidden className="size-4 shrink-0 text-muted transition-colors group-hover/back:text-fg" strokeWidth={1.75} />
        <span className="font-medium max-sm:hidden">Back to {noun}</span>
        <span className="font-medium capitalize sm:hidden">{noun}</span>
        <span aria-hidden className="h-3.5 w-px shrink-0 bg-border max-[480px]:hidden" />
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-2 max-[480px]:hidden" data-exploration-phase>
          <LiveDot live={live} />
          <span className="truncate tabular-nums" suppressHydrationWarning>
            {phase}
          </span>
        </span>
      </Link>
      <span aria-hidden className="hidden h-4 w-px bg-border md:block" />
    </>
  );
}

const CHIP =
  "inline-flex min-w-0 max-w-[16rem] shrink items-center gap-1 rounded-full border border-border bg-panel px-1.5 py-px text-2xs font-medium text-fg-2 transition-colors hover:border-border-strong hover:text-fg";

/**
 * The exploration's name as a link chip ("◎ Deep dive · Properties"), for the places a run
 * shows up outside its own page: the run theater's live band and the live wall. Pulses while
 * the exploration is live.
 */
export function ExplorationChip({ exploration: e, className }: { exploration: RunExploration; className?: string }) {
  const live = isExplorationLive(e.status);
  return (
    <Link
      href={explorationHref(e.id)}
      className={cn(CHIP, className)}
      title={`Open the exploration ${e.name}`}
      data-exploration-chip={e.id}
    >
      <Compass aria-hidden className="size-3 shrink-0 text-primary" />
      <span className="min-w-0 truncate">{e.name}</span>
      {live ? <LiveDot live className="ml-0.5" /> : null}
    </Link>
  );
}

/**
 * The same chip inside a runs list row, which is itself a link to the run: a link can hold no
 * other link, so this is a link by role that opens the exploration (a modified click in a new
 * tab) and keeps the row's own click from opening the run.
 */
export function ExplorationRowChip({ exploration: e }: { exploration: RunExploration }) {
  const router = useRouter();
  const href = explorationHref(e.id);
  const live = isExplorationLive(e.status);
  const open = (ev: MouseEvent | KeyboardEvent, newTab: boolean) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (newTab) window.open(href, "_blank", "noopener");
    else router.push(href);
  };
  return (
    <span
      role="link"
      tabIndex={0}
      className={cn(CHIP, "cursor-pointer focus-visible:outline-2 focus-visible:outline-accent")}
      title={`Open the exploration ${e.name}`}
      aria-label={`Exploration ${e.name}`}
      data-run-row-exploration={e.id}
      data-href={href}
      onClick={(ev) => open(ev, ev.metaKey || ev.ctrlKey || ev.shiftKey)}
      onAuxClick={(ev) => {
        if (ev.button === 1) open(ev, true);
      }}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") open(ev, ev.metaKey || ev.ctrlKey);
      }}
    >
      <Compass aria-hidden className="size-3 shrink-0 text-primary" />
      <span className="min-w-0 truncate">{e.name}</span>
      {live ? <LiveDot live className="ml-0.5" /> : null}
    </span>
  );
}
