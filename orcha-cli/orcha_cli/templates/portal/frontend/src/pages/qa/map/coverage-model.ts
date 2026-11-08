/**
 * Coverage on the map: which scenarios cover a node, the "Uncovered" filter, and what the map
 * opens on (a feature or a node). Pure: no React, no DOM.
 */
import type { AppMap, AppMapNode, CoverLink, CoverVia } from "./types";

export const VIA_LABEL: Record<CoverVia, string> = {
  run: "Its runs go here",
  trace: "Its recorded steps go here",
  migration: "Converted from a test that walks it",
};

/** The scenarios that cover a node (none for a map from an older builder). */
export function coverOf(node: Pick<AppMapNode, "covered_by">): CoverLink[] {
  return node.covered_by ?? [];
}

export function isCovered(node: Pick<AppMapNode, "covered_by">): boolean {
  return coverOf(node).length > 0;
}

/** The lit nodes with every covered one dimmed: the "Uncovered" filter. */
export function dropCovered(lit: ReadonlySet<string>, map: AppMap): Set<string> {
  const covered = new Set(map.nodes.filter(isCovered).map((n) => n.id));
  return new Set([...lit].filter((id) => !covered.has(id)));
}

/** How many screens a scenario covers, of all the screens on the map. */
export function screenCoverage(map: AppMap): { covered: number; total: number } {
  const screens = map.nodes.filter((n) => n.kind === "screen");
  return { covered: screens.filter(isCovered).length, total: screens.length };
}

/** "Covered by 2", "Not covered": a screen card's mark. */
export function coverMark(node: Pick<AppMapNode, "covered_by">): string {
  const n = coverOf(node).length;
  return n ? `Covered by ${n}` : "Not covered";
}

/** What the Map opens on: `?feature=<key>` flies to that feature's region, `?screen=<node id>`
 * selects one node and opens its panel. */
export interface MapFocus {
  feature: string | null;
  node: string | null;
}

const FEATURE_KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const NODE_ID = /^[^\u0000-\u001f]{1,400}$/;

type SearchLike = URLSearchParams | Record<string, string | string[] | undefined> | null | undefined;

function one(sp: SearchLike, key: string): string | null {
  if (!sp) return null;
  const raw = sp instanceof URLSearchParams ? sp.get(key) : sp[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value ? value : null;
}

/** The Map page's focus from its query; anything malformed is ignored. */
export function parseMapFocus(sp: SearchLike): MapFocus {
  const feature = one(sp, "feature");
  const node = one(sp, "screen");
  return { feature: feature && FEATURE_KEY.test(feature) ? feature : null, node: node && NODE_ID.test(node) ? node : null };
}
