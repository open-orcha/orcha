import { useState } from "react";
import { Compass, Sparkles } from "./kit/icons";
import { cn } from "./kit";
import type { ButtonVariant } from "./kit";
import { RunAction } from "./map-actions";
import { usePanelTip } from "./panel-frame";
import type { AppMap, AppMapNode } from "./types";

/** An area explored longer ago than this is explored again before drafting from it. */
export const STALE_EXPLORATION_DAYS = 7;
/** "Draft the gaps" crawls the whole app (Map the app) while less than this share is seen. */
const MOSTLY_UNSEEN = 0.5;
const DAY_MS = 86_400_000;

/** What the map's "Draft tests" does for an area (a node, a feature, the gaps). */
export interface DraftDecision {
  /** Only the paired start is offered (nothing on a device backs the area yet). */
  exploreOnly: boolean;
  /** The one offered first: "explore" (Explore and draft) or "draft" (Draft from what we've seen). */
  primary: "explore" | "draft";
}

/**
 * The rule: an area nothing has reached (no node of it seen, or no run's evidence of it) can
 * only be drafted together with an exploration that goes there, so the drafter has real screens
 * to check. An area explored before offers both, the paired start first when its newest
 * evidence is older than `STALE_EXPLORATION_DAYS`.
 */
export function draftDecision(nodes: readonly Pick<AppMapNode, "state" | "evidence">[], now: number): DraftDecision {
  const seenAt = nodes
    .filter((n) => n.state === "seen")
    .map((n) => Date.parse(n.evidence.live?.last_seen_at ?? ""))
    .filter((t) => Number.isFinite(t));
  if (seenAt.length === 0) return { exploreOnly: true, primary: "explore" };
  const newest = Math.max(...seenAt);
  return { exploreOnly: false, primary: now - newest > STALE_EXPLORATION_DAYS * DAY_MS ? "explore" : "draft" };
}

export type DraftArea =
  | { kind: "node"; node: AppMapNode }
  | { kind: "feature"; key: string }
  | { kind: "gaps" };

/** The nodes an area's decision reads. */
export function areaNodes(map: Pick<AppMap, "nodes">, area: DraftArea): AppMapNode[] {
  if (area.kind === "node") return [area.node];
  if (area.kind === "feature") return map.nodes.filter((n) => n.kind === "screen" && n.feature === area.key);
  return map.nodes.filter((n) => n.kind === "screen");
}

/** What the session is told to look at first: the screen's route or name, the feature's name. */
export function areaFocus(map: Pick<AppMap, "features">, area: DraftArea): string | null {
  if (area.kind === "node") return area.node.detail.route ?? area.node.label;
  if (area.kind === "feature") return map.features.find((f) => f.key === area.key)?.name ?? area.key;
  return null;
}

/** "Explore and draft": a session that goes to the area; "Draft the gaps" crawls the whole app
 * (Map the app) while most of the map is unseen. */
export function exploreKind(map: Pick<AppMap, "nodes">, area: DraftArea): "map" | "explore" {
  if (area.kind !== "gaps") return "explore";
  const screens = areaNodes(map, area);
  const seen = screens.filter((n) => n.state === "seen").length;
  return screens.length === 0 || seen / screens.length < MOSTLY_UNSEEN ? "map" : "explore";
}

/**
 * The map's "Draft tests" (a node), "Draft scenarios for this feature" and "Draft the gaps":
 * labelled by what will happen. Nothing reached yet: "Explore and draft" only. Explored: both,
 * the one `draftDecision` prefers first.
 */
export function DraftTestsAction({
  map,
  area,
  draftLabel = "Draft tests",
  variant = "default",
  now,
  className,
}: {
  map: Pick<AppMap, "project_id" | "features" | "nodes">;
  area: DraftArea;
  /** The label of the drafting from what was seen ("Draft the gaps", "Draft scenarios for this feature"). */
  draftLabel?: string;
  variant?: ButtonVariant;
  /** "Now" for the staleness rule (tests); read once on mount otherwise. */
  now?: number;
  className?: string;
}) {
  const [mountedAt] = useState(() => Date.now());
  const decision = draftDecision(areaNodes(map, area), now ?? mountedAt);
  const focus = areaFocus(map, area);
  // Placed tooltips (`usePanelTip`), not native ones that cover the panel's rows above.
  const exploreTip = usePanelTip("An explorer goes there while a drafter writes scenarios and asks it to confirm each screen");
  const draftTip = usePanelTip("Drafting reads what is known here: the code, the map and the explorations so far");
  const explore = (
    <RunAction key="explore" kind={exploreKind(map, area)} focus={focus} variant={decision.primary === "explore" ? variant : "ghost"} size="md" {...exploreTip.trigger} data-map-explore-and-draft={area.kind}>
      <Compass /> Explore and draft
    </RunAction>
  );
  const draft = decision.exploreOnly ? null : (
    <RunAction key="draft" kind="draft" focus={focus} variant={decision.primary === "draft" ? variant : "ghost"} size="md" {...draftTip.trigger} data-map-draft-from-seen={area.kind}>
      <Sparkles /> {draftLabel === "Draft tests" ? "Draft from what we've seen" : draftLabel}
    </RunAction>
  );
  return (
    <span className={cn("inline-flex flex-wrap gap-2", className)} data-map-draft-action={decision.exploreOnly ? "explore" : decision.primary}>
      {decision.primary === "explore" ? [explore, draft] : [draft, explore]}
      {exploreTip.tip}
      {draftTip.tip}
    </span>
  );
}
