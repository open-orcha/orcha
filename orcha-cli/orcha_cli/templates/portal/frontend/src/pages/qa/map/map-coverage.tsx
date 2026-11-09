import { cn, Link, useSearchParams } from "./kit";
import { ShieldCheck, ShieldOff } from "./kit/icons";
import { useEffect, useMemo, useRef } from "react";
import { DraftTestsAction } from "./draft-action";
import { coverMark, coverOf, parseMapFocus, VIA_LABEL, type MapFocus } from "./coverage-model";
import { useMapHrefs } from "./map-actions";
import { plural } from "./model";
import { Section } from "./panel-frame";
import type { AppMap, AppMapNode } from "./types";

/**
 * Coverage on the Map page, kept apart from the canvas and the panel: a screen card's "Covered by
 * N" mark, the panel's "Covered by" section with "Draft tests", the "Uncovered" filter chip, and
 * the `?feature=` / `?screen=` focus.
 */

/** A screen card's mark: how many scenarios cover it, or that none does. */
export function CoverMark({ node, className }: { node: AppMapNode; className?: string }) {
  const n = coverOf(node).length;
  const Icon = n ? ShieldCheck : ShieldOff;
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap", n ? "text-[var(--cov-strong)]" : "text-muted", className)}
      title={n ? coverOf(node).map((l) => l.title).join("\n") : "No scenario covers this screen yet"}
      data-map-cover={n}
    >
      <Icon className="size-3" aria-hidden />
      {coverMark(node)}
    </span>
  );
}

const RESULT_CHIP = {
  pass: "border-[color-mix(in_srgb,var(--color-success)_40%,transparent)] text-success",
  fail: "border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] text-danger",
  none: "border-border text-muted",
} as const;

/** The panel's "Covered by": each scenario with its newest result, linking to it, and "Draft
 * tests" for this node. */
export function CoveredBy({ node, i, map }: { node: AppMapNode; i: number; map: Pick<AppMap, "project_id" | "features" | "nodes"> }) {
  const links = coverOf(node);
  const hrefs = useMapHrefs();
  // An unseen screen offers "Draft tests" at the top of the panel already.
  const draftable = (node.kind === "screen" && node.state === "seen") || node.kind === "flow" || node.kind === "endpoint";
  // Placed beside the panel (or the button), never over the rows above it.
  return (
    <Section name="covered" title="Covered by" i={i} data-map-covered-by={links.length}>
      {links.length ? (
        <ul className="grid gap-1">
          {links.map((l) => (
            <li key={l.scenario_id}>
              <Link href={hrefs.scenario(l.scenario_id)} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-hover" title={VIA_LABEL[l.via]} data-map-cover-link={l.via}>
                <span className="min-w-0 flex-1 truncate text-fg">{l.title}</span>
                <span className={cn("shrink-0 rounded-full border px-1.5 text-2xs leading-4", RESULT_CHIP[l.result ?? "none"])} data-result={l.result ?? "none"}>
                  {l.result === "pass" ? "Passing" : l.result === "fail" ? "Failing" : "Not run"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          {node.kind === "flow" ? "No scenario walks this test's flow yet." : "No scenario reaches this yet."}
        </p>
      )}
      {draftable ? (
        <DraftTestsAction map={map} area={{ kind: "node", node }} variant={links.length ? "ghost" : "default"} className="mt-2" />
      ) : null}
    </Section>
  );
}

/** A region's line in the panel: how many of its screens a scenario covers. */
export function RegionCoverLine({ screens }: { screens: readonly AppMapNode[] }) {
  if (screens.length === 0) return null;
  const covered = screens.filter((s) => coverOf(s).length > 0).length;
  return (
    <p className="mt-1 text-sm text-fg-2" data-map-region-covered={covered}>
      {covered === 0 ? "No scenario covers its screens yet." : `${covered} of ${plural(screens.length, "screen")} covered by a scenario.`}
    </p>
  );
}

/** The toolbar's "Uncovered" chip: dims everything a scenario already covers. */
export function UncoveredChip({ on, onToggle, count }: { on: boolean; onToggle: () => void; count: number }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      title={on ? "Show everything again" : "Dim what a scenario already covers"}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-raised px-2 text-sm shadow-[var(--shadow-sm)] transition-colors",
        on ? "bg-selected text-fg" : "text-fg-2 hover:text-fg",
      )}
      data-map-uncovered-chip
    >
      <ShieldOff className="size-3.5" aria-hidden />
      Uncovered
      <span className="tabular-nums text-muted">{count}</span>
    </button>
  );
}

/** "Draft the gaps": the journeys no scenario walks, most important first. While little of the
 * map has been reached, only together with an exploration (Map the app) that goes there. */
export function DraftGapsLink({ map, className }: { map: Pick<AppMap, "project_id" | "features" | "nodes">; className?: string }) {
  return <DraftTestsAction map={map} area={{ kind: "gaps" }} draftLabel="Draft the gaps" className={className} />;
}

/** The Map page's `?feature=` / `?screen=` focus, read once from the URL. */
export function useMapUrlFocus(): MapFocus {
  const sp = useSearchParams();
  // Read once: the page's own camera and panel take over after that.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => parseMapFocus(sp), []);
}

/** Opens the URL's focus once, when the canvas is `ready` (React Flow has the nodes and the canvas
 * its size): the node's panel, else the feature (`onFeature`). */
export function useApplyUrlFocus(focus: MapFocus, ready: boolean, onNode: (id: string) => void, onFeature: (key: string) => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready || (!focus.node && !focus.feature)) return;
    done.current = true;
    if (focus.node) onNode(focus.node);
    else if (focus.feature) onFeature(focus.feature);
  }, [ready, focus, onNode, onFeature]);
}
