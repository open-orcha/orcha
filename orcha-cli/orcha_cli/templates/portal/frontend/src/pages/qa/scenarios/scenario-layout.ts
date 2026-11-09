/**
 * Auto-layout for the scenario canvas (spec §3).
 *
 * Two strategies, chosen automatically:
 *  - No scenario has a `depends_on` edge anywhere in the set: the original
 *    category-column layout (left→right by category, first-seen order,
 *    stacked vertically within each column).
 *  - At least one scenario has a dependency: a layered left→right layout by
 *    dependency depth — depth 0 (no deps, or deps outside the set) in the
 *    first column, its dependents in the next column, etc. Nodes within a
 *    column are ordered by category then name and stacked with a small gap.
 *    Cycles are tolerated by breaking the back edge (a node already on the
 *    current DFS path is treated as depth 0 for that edge, so it never waits
 *    on a descendant to settle its own depth). Scenarios with no edges at all
 *    (isolated — no depends_on and nothing depends on them) are grouped in a
 *    trailing column, ordered by category then name.
 *
 * Scenarios that already have a saved `position` always keep it, in both
 * strategies — this function only fills in positions for the rest.
 *
 * No column grows past `maxRows` (about the square root of the set, never
 * fewer than 6): a taller column wraps into side-by-side sub-columns, so a
 * project of 50 scenarios with 30 roots is a block a screen can fit at a
 * legible zoom rather than one column thirty nodes tall.
 *
 * Pure function — no React/xyflow dependency, so it's unit-testable.
 */

export interface LayoutInput {
  id: string;
  category: string | null;
  name?: string;
  position: { x: number; y: number } | null;
  depends_on?: readonly string[];
}

const COLUMN_WIDTH = 300;
const ROW_HEIGHT = 130;
const COLUMN_X_GAP = 40;
const ROW_Y_GAP = 24;

/** Layered layout: columns are ~320px apart (300px node + ~20-40px gap) per spec. */
const LAYER_X_GAP = 320;
/** ~24px vertical gap between stacked nodes within a column, per spec. */
const LAYER_Y_GAP = 24;

/** A column never gets fewer rows than this before it wraps. */
const MIN_ROWS = 6;

/** Rows a column may hold before wrapping: ~sqrt(1.2n), so the whole map comes out a
 * little wider than tall (a landscape screen), and small sets never wrap at all. */
export function maxRows(total: number): number {
  return Math.max(MIN_ROWS, Math.ceil(Math.sqrt(total * 1.2)));
}

function categoryOf(s: LayoutInput): string {
  return s.category ?? "General";
}

function byCategoryThenName(a: LayoutInput, b: LayoutInput): number {
  const ca = categoryOf(a);
  const cb = categoryOf(b);
  if (ca !== cb) return ca < cb ? -1 : 1;
  const na = a.name ?? a.id;
  const nb = b.name ?? b.id;
  if (na !== nb) return na < nb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** True if any scenario in the set declares a dependency (on any id, even one outside the set). */
function hasAnyDependency(scenarios: readonly LayoutInput[]): boolean {
  return scenarios.some((s) => (s.depends_on?.length ?? 0) > 0);
}

/**
 * Depth of each scenario = 1 + max(depth of its in-set dependencies), 0 when
 * it has none in-set. Cycles are broken by tracking the current DFS path: a
 * dependency already being visited (an ancestor in the recursion) is
 * ignored, so recursion always terminates.
 */
function computeDepths(scenarios: readonly LayoutInput[]): Map<string, number> {
  const byId = new Map(scenarios.map((s) => [s.id, s] as const));
  const depths = new Map<string, number>();
  const inProgress = new Set<string>();

  function depthOf(id: string): number {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const s = byId.get(id);
    if (!s) return 0;
    if (inProgress.has(id)) {
      // Back edge (cycle): treat this occurrence as having no further
      // dependency depth so the cycle doesn't recurse forever.
      return 0;
    }
    inProgress.add(id);
    let maxDepDepth = -1;
    for (const dep of s.depends_on ?? []) {
      if (!byId.has(dep) || dep === id) continue;
      maxDepDepth = Math.max(maxDepDepth, depthOf(dep));
    }
    inProgress.delete(id);
    const depth = maxDepDepth + 1;
    depths.set(id, depth);
    return depth;
  }

  for (const s of scenarios) depthOf(s.id);
  return depths;
}

/** True if a scenario has no dependency edges touching it at all (isolated node). */
function isIsolated(s: LayoutInput, dependedOn: Set<string>): boolean {
  return (s.depends_on?.length ?? 0) === 0 && !dependedOn.has(s.id);
}

function layoutByCategoryColumns<T extends LayoutInput>(
  scenarios: readonly T[],
  positions: Map<string, { x: number; y: number }>,
  needsLayout: readonly T[],
): void {
  const columns = new Map<string, T[]>();
  for (const s of needsLayout) {
    const category = categoryOf(s);
    const list = columns.get(category) ?? [];
    list.push(s);
    columns.set(category, list);
  }
  const rows = maxRows(scenarios.length);
  let col = 0;
  for (const list of columns.values()) {
    col += placeWrapped(list, col, rows, COLUMN_WIDTH + COLUMN_X_GAP, ROW_HEIGHT + ROW_Y_GAP, positions);
  }
}

/** Stacks `list` down from column `col`, wrapping into the next column every `rows` nodes;
 * returns how many columns it used. */
function placeWrapped(
  list: readonly LayoutInput[],
  col: number,
  rows: number,
  xStep: number,
  yStep: number,
  positions: Map<string, { x: number; y: number }>,
): number {
  list.forEach((s, i) => {
    positions.set(s.id, { x: (col + Math.floor(i / rows)) * xStep, y: (i % rows) * yStep });
  });
  return Math.max(1, Math.ceil(list.length / rows));
}

function layoutByDependencyDepth<T extends LayoutInput>(
  scenarios: readonly T[],
  positions: Map<string, { x: number; y: number }>,
  needsLayout: readonly T[],
): void {
  const dependedOn = new Set<string>();
  for (const s of scenarios) {
    for (const dep of s.depends_on ?? []) dependedOn.add(dep);
  }

  const depths = computeDepths(needsLayout);
  const connected = needsLayout.filter((s) => !isIsolated(s, dependedOn));
  const disconnected = needsLayout.filter((s) => isIsolated(s, dependedOn));

  // Group connected nodes by depth (their column index).
  const byDepth = new Map<number, T[]>();
  for (const s of connected) {
    const d = depths.get(s.id) ?? 0;
    const list = byDepth.get(d) ?? [];
    list.push(s);
    byDepth.set(d, list);
  }
  // Depth columns left to right, each wrapped into sub-columns when tall; the
  // disconnected nodes trail in one more block after the deepest layer, grouped/ordered
  // by category then name.
  const rows = maxRows(scenarios.length);
  const yStep = ROW_HEIGHT + LAYER_Y_GAP;
  let col = 0;
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const ordered = [...byDepth.get(depth)!].sort(byCategoryThenName);
    col += placeWrapped(ordered, col, rows, LAYER_X_GAP, yStep, positions);
  }
  if (disconnected.length > 0) {
    placeWrapped([...disconnected].sort(byCategoryThenName), col, rows, LAYER_X_GAP, yStep, positions);
  }
}

export function layoutScenarios<T extends LayoutInput>(
  scenarios: readonly T[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const needsLayout: T[] = [];

  for (const s of scenarios) {
    if (s.position) {
      positions.set(s.id, s.position);
    } else {
      needsLayout.push(s);
    }
  }

  if (needsLayout.length === 0) return positions;

  const saved = [...positions.values()];
  if (hasAnyDependency(scenarios)) {
    layoutByDependencyDepth(scenarios, positions, needsLayout);
  } else {
    layoutByCategoryColumns(scenarios, positions, needsLayout);
  }
  avoidSavedOverlaps(positions, needsLayout, saved);

  return positions;
}

/**
 * Auto-positioned nodes are laid out on a fresh grid that knows nothing about
 * where the user dragged the others, so one can land on top of a saved node.
 * Push any such node straight down, one row at a time, until it neither
 * overlaps a saved position nor another auto-positioned node already settled
 * in this pass. Saved positions are never moved.
 */
function avoidSavedOverlaps(
  positions: Map<string, { x: number; y: number }>,
  needsLayout: readonly LayoutInput[],
  saved: readonly { x: number; y: number }[],
): void {
  if (saved.length === 0) return;
  const occupied = [...saved];
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) < COLUMN_WIDTH && Math.abs(a.y - b.y) < ROW_HEIGHT;
  for (const s of needsLayout) {
    const pos = positions.get(s.id);
    if (!pos) continue;
    let next = { ...pos };
    let guard = 0;
    while (occupied.some((o) => overlaps(next, o)) && guard++ < 1000) {
      next = { x: next.x, y: next.y + ROW_HEIGHT + ROW_Y_GAP };
    }
    positions.set(s.id, next);
    occupied.push(next);
  }
}

/**
 * Recompute positions for ALL scenarios (ignoring any saved `position`),
 * using the same strategy selection as `layoutScenarios`. Used by the
 * "Auto-arrange" action, which explicitly clears saved positions before
 * persisting the recomputed ones.
 */
export function autoArrangeScenarios<T extends LayoutInput>(
  scenarios: readonly T[],
): Map<string, { x: number; y: number }> {
  const stripped = scenarios.map((s) => ({ ...s, position: null }));
  return layoutScenarios(stripped);
}

/**
 * The lowest zoom at which a node card still reads: its 14px name renders near 12px and its
 * 12px meta line near 10px. The first cut (#140) used 0.45, which let a 50-scenario project
 * "fit" the screen with names at 6px, a map of grey bars; below this zoom the first view
 * shows part of the map instead, and Fit view or the minimap is one click away for the rest.
 */
export const LEGIBLE_ZOOM = 0.85;

/** The first view of a map: fit it all when that keeps nodes legible (zoom >= `minZoom`),
 * centred; otherwise sit at `minZoom` anchored on the top-left node, where reading starts
 * (the first category column, or the dependency roots), and let the person pan (a phone,
 * or a project too big to show whole). Node size is the nominal card (260 x 130), so this
 * needs no DOM measurement and is testable. */
export function initialViewport(
  points: Iterable<{ x: number; y: number }>,
  width: number,
  height: number,
  { minZoom = LEGIBLE_ZOOM, maxZoom = 1, padding = 24, nodeWidth = 260, nodeHeight = ROW_HEIGHT } = {},
): { x: number; y: number; zoom: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + nodeWidth);
    maxY = Math.max(maxY, p.y + nodeHeight);
  }
  if (!Number.isFinite(minX) || width <= 0 || height <= 0) return null;
  const w = maxX - minX;
  const h = maxY - minY;
  const fit = Math.min((width - 2 * padding) / w, (height - 2 * padding) / h, maxZoom);
  if (fit >= minZoom) {
    return { x: (width - w * fit) / 2 - minX * fit, y: (height - h * fit) / 2 - minY * fit, zoom: fit };
  }
  return { x: padding - minX * minZoom, y: padding - minY * minZoom, zoom: minZoom };
}

/** Category → column index, in first-seen order (for headers above the canvas columns). */
export function categoryColumns(scenarios: readonly LayoutInput[]): string[] {
  const seen: string[] = [];
  for (const s of scenarios) {
    const category = categoryOf(s);
    if (!seen.includes(category)) seen.push(category);
  }
  return seen;
}
