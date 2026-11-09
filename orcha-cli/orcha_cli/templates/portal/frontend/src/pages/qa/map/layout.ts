/**
 * The app map's geometry, in canvas units. Deterministic for the same map, pure (no React, no
 * DOM), so it is tested alone.
 *
 * Screens layer: one region per feature, packed in shelves biggest first, none smaller than two
 * cards so its name reads from afar, each as tall as its cards. On a big app the features with one
 * or two screens share one "Other areas" region, and a long list of screens no feature claims
 * ("Other screens") is a summary card; both open on demand. Inside a region the screens stand in
 * columns by navigation depth from the feature's entry, the way a user walks in: a seen screen as
 * a frame card, one no run reached as a compact ghost. Navigation inside a region runs orthogonally
 * in the gutters between cards, never under one; navigation to another region ends at that
 * region's port on the border ("→ Settings · 3"), so no line leaves its region. Which lines show
 * at a time (summed region links from afar, a region's own lines closer in, the lines of what is
 * hovered or picked) and where their labels fit are decided here too (`screenEdgePlan`,
 * `linkPlan`, `edgeLabels`).
 *
 * Data-flow layer: three bands, screens on top, endpoints in the middle (grouped by path prefix)
 * and entities below, each band ordered by where its neighbours sit so edges cross as little as
 * a simple ordering can make them.
 */
import { endpointPrefix, quoteLabel, truncate } from "./model";
import type { AppMap, AppMapEdge, AppMapNode, EndpointSide, FeatureCoverage } from "./types";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = "left" | "right" | "top" | "bottom";

/** An edge's path: its points in order and the card side it leaves and enters by. */
export interface Route {
  points: Point[];
  sides: [Side, Side];
}

/** A seen screen's card: room for its frame, its name, a line of marks and a line of actions. */
export const CARD = { w: 196, h: 176 } as const;
/** A screen no run has reached (declared or blocked): a compact ghost card, about half as tall. */
export const GHOST = { w: 196, h: 84 } as const;
/** The gutter between columns: room for a few parallel lanes of edges and a short label. */
export const GAP_X = 104;
const GAP_Y = 24;
const PAD = 24;
/** Under the cards: the lane routes to other features run along, then the ports on the border. */
export const PAD_BOTTOM = 48;
/** Room for the region's name and "4 of 6 screens seen" above its cards. */
export const REGION_HEAD = 72;
/** The gutter between regions. */
export const REGION_GAP = 80;
/** A column holds at most four frame cards' height; a longer level wraps into another column. */
const MAX_COL_H = 4 * CARD.h + 3 * GAP_Y;
/** No region is narrower than two cards, so its name has room from afar. */
export const MIN_REGION_W = 2 * PAD + 2 * CARD.w + GAP_X;
/** No region is shorter than one row of frame cards. */
export const MIN_REGION_H = REGION_HEAD + CARD.h + PAD_BOTTOM;
/** Screens no feature claims. */
export const OTHER_REGION = "~other";
/** The features with `SMALL_FEATURE` screens or fewer, together, on a map of many features. */
export const AREAS_REGION = "~areas";
export const SMALL_FEATURE = 2;
/** Small features share a region once a map has more features than this; the biggest this many
 * always keep their own. */
export const GROUP_FROM = 12;
/** "Other screens" opens as a summary card once it holds more screens than this. */
export const OTHER_OPEN_UPTO = 6;

export type RegionKind = "feature" | "areas" | "other";

export interface Region extends Rect {
  key: string;
  kind: RegionKind;
  label: string;
  summary: string | null;
  /** The feature keys whose screens it holds (`OTHER_REGION` for screens no feature claims). */
  members: string[];
  /** A summary card: its screens are counted, not drawn, until it is opened. */
  collapsed: boolean;
  /** The group that folds it back up (`AREAS_REGION` or `OTHER_REGION`) when it is open, else null. */
  fold: string | null;
  screens: number;
  seen: number;
  declared: number;
  blocked: number;
  coverage: FeatureCoverage;
  shelf: number;
}

export interface Card extends Rect {
  id: string;
  region: string;
  depth: number;
  col: number;
  row: number;
  /** No run has reached it: a compact ghost card rather than a frame. */
  ghost: boolean;
}

export interface Shelf {
  y: number;
  h: number;
}

/** Navigation between two regions, both ways summed: what the zoomed-out map draws. `from` is
 * the way most taken; `both` when users also go the other way. */
export interface RegionLink {
  id: string;
  from: string;
  to: string;
  count: number;
  both: boolean;
  route: Route;
}

/** Every move between the same two screens in the same direction ("Tap Add", "Tap Add a
 * routine"), drawn as one line. */
export interface EdgeBundle {
  /** `nav:<from>><to>`. */
  id: string;
  from: string;
  to: string;
  /** Its edges, the busiest first. */
  edges: string[];
  /** Times taken, all moves summed. */
  count: number;
  /** The busiest move's label, and how many other labelled moves share the line. */
  label: string | null;
  more: number;
  /** Only the code says it exists: no run or test has taken it (drawn dashed). */
  fromCode: boolean;
}

/** Where a region's navigation to one other region leaves and arrives: a badge on its bottom
 * border ("→ Settings · 3"). The routes between its cards and the other region's run to it, so
 * no line ever crosses into another region. "+N more" (`to` null) holds the neighbours past the
 * ones that fit. */
export interface Port extends Rect {
  /** `port:<region>><neighbour>`. */
  id: string;
  region: string;
  to: string | null;
  label: string;
  /** How many screen-to-screen lines it stands for. */
  count: number;
  out: boolean;
  in: boolean;
  bundles: string[];
  /** Where the routes meet it: the middle of its top edge. */
  anchor: Point;
}

/** A line between regions as the zoomed-in map draws it: from its screen to that region's port,
 * and from the other region's port to the screen it reaches. Either is null when that screen has
 * no card (folded into a summary card). */
export interface CrossRoute {
  out: Route | null;
  in: Route | null;
  ports: [string | null, string | null];
}

export interface ScreensLayout {
  width: number;
  height: number;
  regions: Region[];
  cards: Map<string, Card>;
  /** Every screen's region, drawn or not (a collapsed region's screens have no card). */
  regionOf: Map<string, string>;
  shelves: Shelf[];
  /** Every navigation line between two screens (parallel moves bundled), by bundle id. */
  bundles: Map<string, EdgeBundle>;
  /** A navigation edge's bundle, by edge id. */
  bundleOf: Map<string, string>;
  /** The route of each bundle inside one region, by bundle id: orthogonal, in the gutters. */
  routes: Map<string, Route>;
  /** Bundles between regions, by bundle id: to and from the regions' ports. */
  crossRoutes: Map<string, CrossRoute>;
  ports: Port[];
  /** Navigation between regions, the busiest pairs first. */
  links: RegionLink[];
}

export interface ScreensOptions {
  /** The groups opened by the reader: `AREAS_REGION`, `OTHER_REGION`. */
  expanded?: ReadonlySet<string>;
}

function humanize(key: string): string {
  const s = key.replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** A screen's card size: a frame once a run has seen it, a compact ghost until then. */
export function cardSize(state: AppMapNode["state"] | undefined): { w: number; h: number } {
  return state === "seen" ? CARD : GHOST;
}

/**
 * The screens of a region in walking order, each with its depth from the entry. The entry is the
 * screen other features lead to most, else the one with the fewest screens leading to it (parallel
 * moves count once); the walk goes breadth first, the busiest way first. A screen the entry's walk
 * does not reach starts a walk of its own, one column in (beside the entry, not in its column),
 * unless other features lead to it too, which makes it an entry as well.
 */
export function depthOrder(ids: readonly string[], edges: readonly AppMapEdge[], crossIn: ReadonlyMap<string, number> = new Map()): { id: string; depth: number }[] {
  const prev = new Map(ids.map((i) => [i, new Set<string>()]));
  const next = new Map(ids.map((i) => [i, new Map<string, number>()]));
  for (const e of edges) {
    if (e.from === e.to || !prev.has(e.from) || !prev.has(e.to)) continue;
    prev.get(e.to)!.add(e.from);
    const out = next.get(e.from)!;
    out.set(e.to, (out.get(e.to) ?? 0) + Math.max(0, e.count));
  }
  const ways = new Map([...next.entries()].map(([id, m]) => [id, [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([to]) => to)]));
  const roots = [...ids].sort(
    (a, b) =>
      (crossIn.get(b) ?? 0) - (crossIn.get(a) ?? 0) ||
      prev.get(a)!.size - prev.get(b)!.size ||
      ways.get(b)!.length - ways.get(a)!.length ||
      a.localeCompare(b),
  );
  const depth = new Map<string, number>();
  const out: { id: string; depth: number }[] = [];
  roots.forEach((root, i) => {
    if (depth.has(root)) return;
    depth.set(root, i === 0 || (crossIn.get(root) ?? 0) > 0 ? 0 : 1);
    const queue = [root];
    while (queue.length > 0) {
      const id = queue.shift()!;
      out.push({ id, depth: depth.get(id)! });
      for (const to of ways.get(id)!) {
        if (depth.has(to)) continue;
        depth.set(to, depth.get(id)! + 1);
        queue.push(to);
      }
    }
  });
  return out;
}

interface Cell extends Rect {
  id: string;
  depth: number;
  col: number;
  row: number;
  ghost: boolean;
}

interface RegionPlan {
  key: string;
  kind: RegionKind;
  label: string;
  summary: string | null;
  members: string[];
  collapsed: boolean;
  fold: string | null;
  /** 0 a feature, 1 a small feature or the small ones together, 2 the screens no feature claims. */
  rank: number;
  coverage: FeatureCoverage;
  nodes: AppMapNode[];
  /** Relative to the region's corner. */
  cells: Cell[];
  w: number;
  h: number;
}

type PlanHead = Pick<RegionPlan, "key" | "kind" | "label" | "summary" | "members" | "fold" | "rank" | "coverage">;

/** A summary card: no cards inside, just its name, counts and the way to open it. */
function planCollapsed(head: PlanHead, nodes: AppMapNode[]): RegionPlan {
  return { ...head, collapsed: true, nodes, cells: [], w: MIN_REGION_W, h: MIN_REGION_H };
}

/**
 * A region's cards: a column per level of depth from the entry (a long level wraps into more
 * columns), each column centred on the tallest so a screen sits level with the ones it leads to,
 * and the columns centred in a region wider than them. The region is as tall as its cards: no
 * empty band under a short feature.
 */
function planRegion(head: PlanHead, nodes: AppMapNode[], navigates: AppMapEdge[], crossIn: Map<string, number>): RegionPlan {
  const ids = nodes.map((n) => n.id).sort();
  const ghost = new Set(nodes.filter((n) => n.state !== "seen").map((n) => n.id));
  const height = (id: string) => (ghost.has(id) ? GHOST.h : CARD.h);
  const byDepth = new Map<number, string[]>();
  for (const o of depthOrder(ids, navigates, crossIn)) byDepth.set(o.depth, [...(byDepth.get(o.depth) ?? []), o.id]);
  const columns: { depth: number; ids: string[]; h: number }[] = [];
  for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
    let col = { depth: d, ids: [] as string[], h: 0 };
    for (const id of byDepth.get(d)!) {
      if (col.ids.length > 0 && col.h + GAP_Y + height(id) > MAX_COL_H) {
        columns.push(col);
        col = { depth: d, ids: [], h: 0 };
      }
      col.h += (col.ids.length ? GAP_Y : 0) + height(id);
      col.ids.push(id);
    }
    columns.push(col);
  }
  const cols = Math.max(1, columns.length);
  const contentW = cols * CARD.w + (cols - 1) * GAP_X;
  const contentH = Math.max(CARD.h, ...columns.map((c) => c.h));
  const w = Math.max(MIN_REGION_W, 2 * PAD + contentW);
  const left = Math.round((w - contentW) / 2);
  const cells: Cell[] = [];
  columns.forEach((c, col) => {
    let y = REGION_HEAD + Math.round((contentH - c.h) / 2);
    c.ids.forEach((id, row) => {
      cells.push({ id, depth: c.depth, col, row, x: left + col * (CARD.w + GAP_X), y, w: CARD.w, h: height(id), ghost: ghost.has(id) });
      y += height(id) + GAP_Y;
    });
  });
  return { ...head, collapsed: false, nodes, cells, w, h: REGION_HEAD + contentH + PAD_BOTTOM };
}

const COVERAGE_RANK: Record<FeatureCoverage, number> = { failing: 0, untested: 1, thin: 2, covered: 3, strong: 4 };

/** The map's regions: every feature (in the builder's order) and any feature a screen names that
 * the list left out; on a map of many features the small ones together as "Other areas"; and
 * "Other screens" for screens no feature claims. */
function regionPlans(map: AppMap, expanded: ReadonlySet<string>): RegionPlan[] {
  const screens = map.nodes.filter((n) => n.kind === "screen");
  const screenIds = new Set(screens.map((n) => n.id));
  const navigates = map.edges.filter((e) => e.kind === "navigates" && screenIds.has(e.from) && screenIds.has(e.to));
  const featureOf = new Map(screens.map((n) => [n.id, n.feature ?? OTHER_REGION]));
  const crossIn = new Map<string, number>();
  for (const e of navigates) if (featureOf.get(e.from) !== featureOf.get(e.to)) crossIn.set(e.to, (crossIn.get(e.to) ?? 0) + Math.max(1, e.count));
  const keys = [...map.features.map((f) => f.key)];
  for (const n of screens) if (!keys.includes(n.feature ?? OTHER_REGION)) keys.push(n.feature ?? OTHER_REGION);
  const nodesOf = new Map<string, AppMapNode[]>(keys.map((k) => [k, []]));
  for (const n of screens) nodesOf.get(n.feature ?? OTHER_REGION)!.push(n);
  const features = keys.filter((k) => k !== OTHER_REGION);
  // The `GROUP_FROM` biggest features always keep their own region (on one platform of a big app
  // every feature may be small); past them, the small ones share one.
  const biggest = new Set([...features].sort((a, b) => nodesOf.get(b)!.length - nodesOf.get(a)!.length).slice(0, GROUP_FROM));
  const small = features.filter((k) => !biggest.has(k) && nodesOf.get(k)!.length <= SMALL_FEATURE);
  const grouped = small.length >= 2 ? new Set(small) : new Set<string>();

  const plans: RegionPlan[] = [];
  for (const key of features) {
    if (grouped.has(key) && !expanded.has(AREAS_REGION)) continue;
    const f = map.features.find((x) => x.key === key);
    const nodes = nodesOf.get(key)!;
    const inner = navigates.filter((e) => featureOf.get(e.from) === key && featureOf.get(e.to) === key);
    const head: PlanHead = {
      key,
      kind: "feature",
      label: f?.name ?? humanize(key),
      summary: f?.summary ?? null,
      members: [key],
      fold: grouped.has(key) ? AREAS_REGION : null,
      rank: grouped.has(key) ? 1 : 0,
      coverage: f?.coverage ?? "untested",
    };
    plans.push(planRegion(head, nodes, inner, crossIn));
  }
  if (grouped.size > 0 && !expanded.has(AREAS_REGION)) {
    const members = features.filter((k) => grouped.has(k));
    const nodes = members.flatMap((k) => nodesOf.get(k)!);
    // The group reads as its weakest member: a failing or untested small feature is not hidden.
    const coverage = members
      .map((k) => map.features.find((x) => x.key === k)?.coverage ?? "untested")
      .reduce<FeatureCoverage>((worst, c) => (COVERAGE_RANK[c] < COVERAGE_RANK[worst] ? c : worst), "strong");
    const names = members.map((k) => map.features.find((x) => x.key === k)?.name ?? humanize(k)).join(", ");
    plans.push(planCollapsed({ key: AREAS_REGION, kind: "areas", label: "Other areas", summary: names, members, fold: null, rank: 1, coverage }, nodes));
  }
  const other = nodesOf.get(OTHER_REGION) ?? [];
  if (other.length > 0) {
    const big = other.length > OTHER_OPEN_UPTO;
    const head: PlanHead = { key: OTHER_REGION, kind: "other", label: "Other screens", summary: null, members: [OTHER_REGION], fold: big ? OTHER_REGION : null, rank: 2, coverage: "untested" };
    if (big && !expanded.has(OTHER_REGION)) plans.push(planCollapsed({ ...head, fold: null }, other));
    else plans.push(planRegion(head, other, navigates.filter((e) => featureOf.get(e.from) === OTHER_REGION && featureOf.get(e.to) === OTHER_REGION), crossIn));
  }
  return plans;
}

function sideAnchor(r: Rect, side: Side): Point {
  switch (side) {
    case "left":
      return { x: r.x, y: r.y + r.h / 2 };
    case "right":
      return { x: r.x + r.w, y: r.y + r.h / 2 };
    case "top":
      return { x: r.x + r.w / 2, y: r.y };
    case "bottom":
      return { x: r.x + r.w / 2, y: r.y + r.h };
  }
}

/** Where the line from `r`'s centre toward `p` leaves `r`, and by which side. */
export function borderPoint(r: Rect, p: Point): { point: Point; side: Side } {
  const c = center(r);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (dx === 0 && dy === 0) return { point: sideAnchor(r, "right"), side: "right" };
  const sx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  const side: Side = sx <= sy ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
  return { point: { x: c.x + dx * s, y: c.y + dy * s }, side };
}

// Routing inside a region ---------------------------------------------------------------------

/** Parallel lines in one gutter stand this far apart. */
const LANE = 8;
/** Ports on a card side stand at most this far apart, and keep this far from its corners. */
const PORT_STEP = 14;
const PORT_MARGIN = 14;

/** The sides a line between two cards of one region leaves and enters by: forward (to a later
 * column) right to left, back left to right, to the next card of the same column down or up, to
 * one further along the column out and back in on the right. */
function innerSides(s: Card, t: Card): [Side, Side] {
  if (t.col > s.col) return ["right", "left"];
  if (t.col < s.col) return ["left", "right"];
  if (t.row === s.row + 1) return ["bottom", "top"];
  if (t.row === s.row - 1) return ["top", "bottom"];
  return ["right", "right"];
}

/** The middle of the gutter beside a card's side, inside its region. */
function gutterX(card: Card, side: Side, region: Rect): number {
  const room = side === "right" ? Math.min(GAP_X, region.x + region.w - (card.x + card.w)) : Math.min(GAP_X, card.x - region.x);
  return side === "right" ? card.x + card.w + room / 2 : card.x - room / 2;
}

/** How many lanes either side of a gutter's middle fit in it. */
function lanesIn(card: Card, side: Side, region: Rect): number {
  const room = side === "right" ? Math.min(GAP_X, region.x + region.w - (card.x + card.w)) : Math.min(GAP_X, card.x - region.x);
  return Math.max(0, Math.floor((room / 2 - 6) / LANE));
}

/** `n` ports along a side `length` long, centred, at most `PORT_STEP` apart. */
function spread(n: number, length: number): number[] {
  const step = n > 1 ? Math.min(PORT_STEP, (length - 2 * PORT_MARGIN) / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => length / 2 + (i - (n - 1) / 2) * step);
}

/** Drops repeated points and the middle of three in a line. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const q = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - q.x) < 0.5 && Math.abs(last.y - q.y) < 0.5) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      if ((Math.abs(a.x - last.x) < 0.5 && Math.abs(last.x - q.x) < 0.5) || (Math.abs(a.y - last.y) < 0.5 && Math.abs(last.y - q.y) < 0.5)) out.pop();
    }
    out.push(q);
  }
  return out;
}

const segmentHits = (a: Point, b: Point, r: Rect, inset = 0.5): boolean => {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return x2 > r.x + inset && x1 < r.x + r.w - inset && y2 > r.y + inset && y1 < r.y + r.h - inset;
};

/** Whether an axis-aligned route passes through the inside of any of `rects`. */
export function routeHits(route: Route, rects: readonly Rect[]): boolean {
  for (let i = 1; i < route.points.length; i++) for (const r of rects) if (segmentHits(route.points[i - 1], route.points[i], r)) return true;
  return false;
}

/** The free row a line that skips columns runs along, from gutter `x0` to gutter `x1`: the one
 * nearest both ends among the ports' own rows, the gaps between cards and the lane under them. */
function laneRow(x0: number, x1: number, y0: number, y1: number, cards: readonly Card[], bottomLane: number): number {
  const between = cards.filter((c) => c.x + c.w > Math.min(x0, x1) && c.x < Math.max(x0, x1));
  const free = (y: number) => between.every((c) => y < c.y - 6 || y > c.y + c.h + 6);
  const rows = [y0, y1, ...between.flatMap((c) => [c.y - GAP_Y / 2, c.y + c.h + GAP_Y / 2])];
  let best = bottomLane;
  let cost = Math.abs(bottomLane - y0) + Math.abs(bottomLane - y1);
  for (const y of rows) {
    const c = Math.abs(y - y0) + Math.abs(y - y1);
    if (c < cost && free(y)) {
      best = y;
      cost = c;
    }
  }
  return best;
}

/** The lane under a region's cards, where lines to its ports run. */
function bottomLane(region: Rect): number {
  return region.y + region.h - PAD_BOTTOM + 18;
}

interface Draft {
  id: string;
  points: Point[];
  sides: [Side, Side];
  /** Vertical runs in a gutter: the index of the run's first point, and the gutter. */
  runs: { i: number; gutter: string; x: number; lanes: number }[];
}

/**
 * Every line inside one region, orthogonal with rounded elbows: out of a card side at its own
 * port (the ports on a side ordered by where their other ends sit, so lines do not cross at the
 * card), along the gutter between columns in a lane of its own, and in at the other card's port.
 * A line that skips a column crosses on a free row between cards (or the lane under them); none
 * goes under or through a card.
 */
function innerRoutes(region: Region, cards: readonly Card[], bundles: readonly EdgeBundle[]): Map<string, Route> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const items = bundles.flatMap((b) => {
    const s = byId.get(b.from);
    const t = byId.get(b.to);
    return s && t ? [{ b, s, t, sides: innerSides(s, t) }] : [];
  });
  // Ports: each card side's lines in order of where their other ends are; a pair's two directions
  // in the same order at both ends, so they run side by side.
  const sideLists = new Map<string, { id: string; end: 0 | 1; card: Card; side: Side; other: Card; order: string }[]>();
  for (const it of items) {
    const dir = it.b.from < it.b.to ? 0 : 1;
    const pair = [it.b.from, it.b.to].sort().join("|");
    for (const end of [0, 1] as const) {
      const card = end === 0 ? it.s : it.t;
      const side = it.sides[end];
      const key = `${card.id}|${side}`;
      sideLists.set(key, [...(sideLists.get(key) ?? []), { id: it.b.id, end, card, side, other: end === 0 ? it.t : it.s, order: `${pair}|${dir}` }]);
    }
  }
  const ports = new Map<string, [Point, Point]>();
  for (const list of sideLists.values()) {
    const { card, side } = list[0];
    const vertical = side === "left" || side === "right";
    list.sort((a, b) => (vertical ? a.other.y + a.other.h / 2 - (b.other.y + b.other.h / 2) : a.other.x - b.other.x) || a.order.localeCompare(b.order));
    const at = spread(list.length, vertical ? card.h : card.w);
    list.forEach((p, i) => {
      const pt = vertical ? { x: side === "left" ? card.x : card.x + card.w, y: card.y + at[i] } : { x: card.x + at[i], y: side === "top" ? card.y : card.y + card.h };
      const both = ports.get(p.id) ?? [pt, pt];
      both[p.end] = pt;
      ports.set(p.id, both);
    });
  }
  const lane = bottomLane(region);
  const drafts: Draft[] = items.map(({ b, s, t, sides }) => {
    const [p0, p3] = ports.get(b.id)!;
    if (sides[0] === "top" || sides[0] === "bottom") {
      const mid = (p0.y + p3.y) / 2;
      return { id: b.id, sides, points: [p0, { x: p0.x, y: mid }, { x: p3.x, y: mid }, p3], runs: [] };
    }
    const g0 = gutterX(s, sides[0], region);
    const g3 = gutterX(t, sides[1], region);
    const k0 = `${Math.round(g0)}`;
    if (Math.abs(g0 - g3) < 1) {
      return { id: b.id, sides, points: [p0, { x: g0, y: p0.y }, { x: g0, y: p3.y }, p3], runs: [{ i: 1, gutter: k0, x: g0, lanes: lanesIn(s, sides[0], region) }] };
    }
    const y = laneRow(g0, g3, p0.y, p3.y, cards, lane);
    return {
      id: b.id,
      sides,
      points: [p0, { x: g0, y: p0.y }, { x: g0, y }, { x: g3, y }, { x: g3, y: p3.y }, p3],
      runs: [
        { i: 1, gutter: k0, x: g0, lanes: lanesIn(s, sides[0], region) },
        { i: 3, gutter: `${Math.round(g3)}`, x: g3, lanes: lanesIn(t, sides[1], region) },
      ],
    };
  });
  // Lanes: a gutter's vertical runs that overlap go side by side, the middle lane first.
  const byGutter = new Map<string, { d: Draft; run: Draft["runs"][number]; y0: number; y1: number }[]>();
  for (const d of drafts)
    for (const run of d.runs) {
      const y0 = Math.min(d.points[run.i].y, d.points[run.i + 1].y);
      const y1 = Math.max(d.points[run.i].y, d.points[run.i + 1].y);
      if (y1 - y0 < 1) continue;
      byGutter.set(run.gutter, [...(byGutter.get(run.gutter) ?? []), { d, run, y0, y1 }]);
    }
  for (const list of byGutter.values()) {
    list.sort((a, b) => a.y0 - b.y0 || b.y1 - b.y0 - (a.y1 - a.y0) || a.d.id.localeCompare(b.d.id));
    const taken: { lane: number; y0: number; y1: number }[] = [];
    for (const it of list) {
      const max = it.run.lanes;
      const order = [0, ...Array.from({ length: max }, (_, k) => [k + 1, -(k + 1)]).flat()];
      const lane = order.find((l) => !taken.some((t) => t.lane === l && it.y0 < t.y1 + 10 && t.y0 < it.y1 + 10)) ?? 0;
      taken.push({ lane, y0: it.y0, y1: it.y1 });
      const x = it.run.x + lane * LANE;
      it.d.points[it.run.i] = { ...it.d.points[it.run.i], x };
      it.d.points[it.run.i + 1] = { ...it.d.points[it.run.i + 1], x };
    }
  }
  return new Map(drafts.map((d) => [d.id, { points: simplify(d.points), sides: d.sides }]));
}

/** A line from a card to a port on its region's bottom border: straight down from the last card
 * of a column, else out of the side facing the port, down the gutter, along the lane under the
 * cards and down into the port. `inbound` reverses it (the port to the card). */
function portRoute(card: Card, region: Region, column: readonly Card[], anchor: Point, inbound: boolean): Route {
  const lane = bottomLane(region);
  const last = column.every((c) => c.y <= card.y);
  let points: Point[];
  let first: Side;
  if (last) {
    const x = card.x + card.w / 2 + (inbound ? -10 : 10);
    points = [{ x, y: card.y + card.h }, { x, y: lane }, { x: anchor.x, y: lane }, anchor];
    first = "bottom";
  } else {
    first = anchor.x >= card.x + card.w / 2 ? "right" : "left";
    const y = card.y + card.h - 16;
    const g = gutterX(card, first, region) + (inbound ? -LANE / 2 : LANE / 2);
    points = [{ x: first === "right" ? card.x + card.w : card.x, y }, { x: g, y }, { x: g, y: lane }, { x: anchor.x, y: lane }, anchor];
  }
  const route: Route = { points: simplify(points), sides: [first, "top"] };
  return inbound ? { points: [...route.points].reverse(), sides: ["top", first] } : route;
}

// Ports ---------------------------------------------------------------------------------------

/** A port badge: the UI font at 11, an arrow, the other region's name and the count. */
export const PORT = { h: 22, glyph: 6.7, pad: 10, icon: 12, gap: 8, maxChars: 18 } as const;

export function portText(label: string, count: number): string {
  return `${truncate(label, PORT.maxChars)} · ${count}`;
}

export function portWidth(text: string): number {
  return Math.round(2 * PORT.pad + PORT.icon + 5 + text.length * PORT.glyph);
}

/**
 * One port per neighbouring region on each region's bottom border, the busiest first, left to
 * right as far as they fit; the rest share "+N more". Each says which way users go ("→" out, "←"
 * in, "↔" both) and how many screen-to-screen lines it stands for.
 */
function regionPorts(region: Region, cross: readonly EdgeBundle[], regionOf: ReadonlyMap<string, string>, regions: ReadonlyMap<string, Region>): Port[] {
  const by = new Map<string, { out: boolean; in: boolean; bundles: string[] }>();
  for (const b of cross) {
    const from = regionOf.get(b.from)!;
    const to = regionOf.get(b.to)!;
    if (from !== region.key && to !== region.key) continue;
    const other = from === region.key ? to : from;
    const p = by.get(other) ?? { out: false, in: false, bundles: [] };
    if (from === region.key) p.out = true;
    else p.in = true;
    p.bundles.push(b.id);
    by.set(other, p);
  }
  const rows = [...by.entries()]
    .map(([to, p]) => ({ to, ...p, label: regions.get(to)?.label ?? humanize(to) }))
    .sort((a, b) => b.bundles.length - a.bundles.length || a.label.localeCompare(b.label));
  const y = region.y + region.h - PORT.h / 2;
  const right = region.x + region.w - PAD;
  const out: Port[] = [];
  let x = region.x + PAD;
  let i = 0;
  for (; i < rows.length; i++) {
    const r = rows[i];
    const w = portWidth(portText(r.label, r.bundles.length));
    const rest = rows.length - i - 1;
    const moreW = rest ? portWidth(`+${rest} more`) + PORT.gap : 0;
    if (out.length > 0 && x + w + moreW > right) break;
    out.push({ id: `port:${region.key}>${r.to}`, region: region.key, to: r.to, label: r.label, count: r.bundles.length, out: r.out, in: r.in, bundles: r.bundles, x, y, w, h: PORT.h, anchor: { x: x + w / 2, y } });
    x += w + PORT.gap;
  }
  if (i < rows.length) {
    const rest = rows.slice(i);
    const label = `+${rest.length} more`;
    const w = portWidth(label);
    const bundles = rest.flatMap((r) => r.bundles);
    out.push({ id: `port:${region.key}>~more`, region: region.key, to: null, label, count: bundles.length, out: rest.some((r) => r.out), in: rest.some((r) => r.in), bundles, x, y, w, h: PORT.h, anchor: { x: x + w / 2, y } });
  }
  return out;
}

/** A route between regions for a test's flow: one curve from the facing sides of the two cards,
 * drawn under the regions (see-through tints, names on top), so it never covers a name. */
function crossCurve(s: Rect, t: Rect): Route {
  const a = center(s);
  const b = center(t);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sides: [Side, Side] = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? ["right", "left"] : ["left", "right"]) : dy > 0 ? ["bottom", "top"] : ["top", "bottom"];
  return { points: [sideAnchor(s, sides[0]), sideAnchor(t, sides[1])], sides };
}

/** Every move between the same two screens in the same direction as one line, its moves busiest
 * first. Self-loops are left out (a screen that reloads itself says nothing about the way). */
export function bundleEdges(edges: readonly AppMapEdge[]): EdgeBundle[] {
  const by = new Map<string, AppMapEdge[]>();
  for (const e of edges) {
    if (e.kind !== "navigates" || e.from === e.to) continue;
    const k = `${e.from}>${e.to}`;
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  return [...by.entries()]
    .map(([k, list]): EdgeBundle => {
      const sorted = [...list].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
      const labelled = sorted.filter((e) => e.label?.trim());
      return {
        id: `nav:${k}`,
        from: list[0].from,
        to: list[0].to,
        edges: sorted.map((e) => e.id),
        count: list.reduce((a, e) => a + Math.max(0, e.count), 0),
        label: labelled[0]?.label ?? null,
        more: Math.max(0, labelled.length - 1),
        // A map from an older builder names no sources: no claim either way, so drawn solid.
        fromCode: list.every((e) => e.sources.length > 0 && e.sources.every((s) => s === "code")),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The screens layer of `map`. */
export function layoutScreens(map: AppMap, options: ScreensOptions = {}): ScreensLayout {
  const plans = regionPlans(map, options.expanded ?? new Set())
    // Biggest regions first, taller before shorter so a shelf holds regions of a height; small
    // features after them, screens no feature claims last.
    .sort((a, b) => a.rank - b.rank || b.h - a.h || b.w - a.w || a.key.localeCompare(b.key));
  const area = plans.reduce((sum, p) => sum + (p.w + REGION_GAP) * (p.h + REGION_GAP), 0);
  const widest = plans.reduce((m, p) => Math.max(m, p.w), 0);
  // Landscape: about 1.6 times as wide as tall.
  const maxW = Math.max(widest, Math.sqrt(area * 1.6));

  const regions: Region[] = [];
  const shelves: Shelf[] = [];
  const regionOf = new Map<string, string>();
  let x = 0;
  let y = 0;
  for (const p of plans) {
    if (x > 0 && x + p.w > maxW) {
      y += shelves[shelves.length - 1].h + REGION_GAP;
      x = 0;
    }
    if (x === 0) shelves.push({ y, h: 0 });
    const shelf = shelves.length - 1;
    shelves[shelf].h = Math.max(shelves[shelf].h, p.h);
    const seen = p.nodes.filter((n) => n.state === "seen").length;
    const blocked = p.nodes.filter((n) => n.state === "blocked").length;
    for (const n of p.nodes) regionOf.set(n.id, p.key);
    regions.push({
      key: p.key,
      kind: p.kind,
      label: p.label,
      summary: p.summary,
      members: p.members,
      collapsed: p.collapsed,
      fold: p.fold,
      coverage: p.coverage,
      screens: p.nodes.length,
      seen,
      blocked,
      declared: p.nodes.length - seen - blocked,
      shelf,
      x,
      y,
      w: p.w,
      h: p.h,
    });
    x += p.w + REGION_GAP;
  }

  const cards = new Map<string, Card>();
  regions.forEach((r, i) => {
    for (const c of plans[i].cells) cards.set(c.id, { id: c.id, region: r.key, depth: c.depth, col: c.col, row: c.row, ghost: c.ghost, x: r.x + c.x, y: r.y + c.y, w: c.w, h: c.h });
  });

  const byKey = new Map(regions.map((r) => [r.key, r]));
  const drawnIn = new Map<string, Card[]>();
  for (const c of cards.values()) drawnIn.set(c.region, [...(drawnIn.get(c.region) ?? []), c]);
  const bundles = bundleEdges(map.edges.filter((e) => regionOf.has(e.from) && regionOf.has(e.to)));
  const bundleOf = new Map<string, string>();
  for (const b of bundles) for (const id of b.edges) bundleOf.set(id, b.id);
  const inner = bundles.filter((b) => regionOf.get(b.from) === regionOf.get(b.to));
  const cross = bundles.filter((b) => regionOf.get(b.from) !== regionOf.get(b.to));

  const routes = new Map<string, Route>();
  for (const r of regions) {
    const mine = drawnIn.get(r.key) ?? [];
    if (mine.length === 0) continue;
    for (const [id, route] of innerRoutes(r, mine, inner.filter((b) => regionOf.get(b.from) === r.key))) routes.set(id, route);
  }

  const ports = regions.flatMap((r) => (drawnIn.has(r.key) ? regionPorts(r, cross, regionOf, byKey) : []));
  const portOf = new Map<string, Port>();
  for (const p of ports) for (const b of p.bundles) portOf.set(`${p.region}|${b}`, p);
  const columnOf = (c: Card) => (drawnIn.get(c.region) ?? []).filter((x) => x.col === c.col);
  const crossRoutes = new Map<string, CrossRoute>();
  for (const b of cross) {
    const s = cards.get(b.from);
    const t = cards.get(b.to);
    const ps = s ? (portOf.get(`${s.region}|${b.id}`) ?? null) : null;
    const pt = t ? (portOf.get(`${t.region}|${b.id}`) ?? null) : null;
    crossRoutes.set(b.id, {
      out: s && ps ? portRoute(s, byKey.get(s.region)!, columnOf(s), ps.anchor, false) : null,
      in: t && pt ? portRoute(t, byKey.get(t.region)!, columnOf(t), pt.anchor, true) : null,
      ports: [ps?.id ?? null, pt?.id ?? null],
    });
  }

  // Region links count every screen, drawn or folded into a summary card.
  const pairs = new Map<string, { a: string; b: string; ab: number; ba: number }>();
  for (const e of map.edges) {
    if (e.kind !== "navigates" || e.from === e.to || !regionOf.has(e.from) || !regionOf.has(e.to)) continue;
    const from = regionOf.get(e.from)!;
    const to = regionOf.get(e.to)!;
    if (from === to) continue;
    const [a, b] = from < to ? [from, to] : [to, from];
    const id = `${a}~${b}`;
    const pair = pairs.get(id) ?? { a, b, ab: 0, ba: 0 };
    const n = Math.max(1, e.count);
    if (from === a) pair.ab += n;
    else pair.ba += n;
    pairs.set(id, pair);
  }
  const links: RegionLink[] = [...pairs.entries()]
    .map(([id, p]) => {
      const [from, to] = p.ab >= p.ba ? [p.a, p.b] : [p.b, p.a];
      const s = byKey.get(from)!;
      const t = byKey.get(to)!;
      const out = borderPoint(s, center(t));
      const into = borderPoint(t, center(s));
      return { id, from, to, count: p.ab + p.ba, both: p.ab > 0 && p.ba > 0, route: { points: [out.point, into.point], sides: [out.side, into.side] } as Route };
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const last = shelves[shelves.length - 1];
  return {
    width: regions.reduce((m, r) => Math.max(m, r.x + r.w), 0),
    height: last ? last.y + last.h : 0,
    regions,
    cards,
    regionOf,
    shelves,
    bundles: new Map(bundles.map((b) => [b.id, b])),
    bundleOf,
    routes,
    crossRoutes,
    ports,
    links,
  };
}

/** The way from one card to another for two steps of a test's flow: the line between them when
 * there is one, else the way such a line would go (between regions, one curve under them); null
 * when either screen is not drawn. */
export function routeBetween(layout: ScreensLayout, from: string, to: string): Route | null {
  const a = layout.cards.get(from);
  const b = layout.cards.get(to);
  if (!a || !b || from === to) return null;
  if (a.region !== b.region) return crossCurve(a, b);
  const own = layout.routes.get(`nav:${from}>${to}`);
  if (own) return own;
  const region = layout.regions.find((r) => r.key === a.region)!;
  const cards = [...layout.cards.values()].filter((c) => c.region === a.region);
  const one: EdgeBundle = { id: "flow", from, to, edges: [], count: 0, label: null, more: 0, fromCode: false };
  return innerRoutes(region, cards, [one]).get("flow") ?? null;
}

/** The screens in the order the screens layer shows them: region by region, column by column. */
export function screenOrder(layout: ScreensLayout): string[] {
  const rank = new Map(layout.regions.map((r, i) => [r.key, i]));
  return [...layout.cards.values()]
    .sort((a, b) => rank.get(a.region)! - rank.get(b.region)! || a.col - b.col || a.row - b.row)
    .map((c) => c.id);
}

/** The summary card ("Other areas", a long "Other screens") a screen is folded into, or null when
 * the screen has a card of its own or is not on the layer. */
export function foldedInto(layout: ScreensLayout, screenId: string): string | null {
  if (layout.cards.has(screenId)) return null;
  const key = layout.regionOf.get(screenId);
  const r = key ? layout.regions.find((x) => x.key === key) : undefined;
  return r?.collapsed ? r.key : null;
}

/** Where `?feature=<key>` points: the feature's only screen (its panel opens), else its region.
 * `open` is the summary card to open first when the feature is folded into one; null when the
 * map has no such feature. */
export type FeatureFocus = { kind: "screen"; id: string; open: string | null } | { kind: "region"; key: string; open: string | null };

export function featureFocus(map: AppMap, layout: ScreensLayout, feature: string): FeatureFocus | null {
  const screens = map.nodes.filter((n) => n.kind === "screen" && n.feature === feature);
  if (screens.length === 1) return { kind: "screen", id: screens[0].id, open: foldedInto(layout, screens[0].id) };
  if (layout.regions.some((r) => r.key === feature && !r.collapsed)) return { kind: "region", key: feature, open: null };
  const card = layout.regions.find((r) => r.collapsed && r.members.includes(feature));
  if (card) return { kind: "region", key: feature, open: card.key };
  return null;
}

// Which edges show ---------------------------------------------------------------------------

/** At most this many screen-to-screen lines at a time; the rest are "+N more links". */
export const EDGE_CAP = 160;
/** At most this many region links on the zoomed-out map, the busiest. */
export const LINK_CAP = 24;

/** What the reader is looking at: a screen hovered or picked lights its lines in and out and dims
 * the rest; a port hovered lights the lines it stands for; a feature hovered or picked (or the
 * one that screen is in) dims the other features' lines. */
export interface EdgeFocus {
  node: string | null;
  region: string | null;
  port?: string | null;
}

export type EdgeLook = "normal" | "active" | "dim";

export interface ShownEdge {
  /** The bundle's id, with `:out` / `:in` for the two halves of a line between regions. */
  id: string;
  bundle: string;
  /** Inside one region, or the half of a line between regions in the region it leaves or enters. */
  part: "inner" | "out" | "in";
  /** Between two regions. */
  cross: boolean;
  route: Route;
  look: EdgeLook;
}

export interface EdgePlan<T> {
  shown: T[];
  /** Edges left out: between features nobody is looking at, or past the cap. */
  hidden: number;
}

const LOOK_RANK: Record<EdgeLook, number> = { active: 0, normal: 1, dim: 2 };

/**
 * The screen-to-screen lines to draw closer in. A region's own lines always show, thin and calm.
 * A line between regions is its region's port at rest; it is drawn (to and from the ports, each
 * half inside its own region) only for the screen in focus or the port hovered. In focus, those
 * lines are active and everything else dims; a feature in focus dims the other features' lines.
 * The busiest win when there are more than `cap`.
 */
export function screenEdgePlan(layout: ScreensLayout, focus: EdgeFocus, cap = EDGE_CAP): EdgePlan<ShownEdge> {
  const candidates: { count: number; shown: ShownEdge }[] = [];
  for (const b of layout.bundles.values()) {
    const touches = focus.node !== null && (b.from === focus.node || b.to === focus.node);
    const own = layout.routes.get(b.id);
    if (own) {
      const region = layout.cards.get(b.from)!.region;
      const look: EdgeLook = focus.node !== null ? (touches ? "active" : "dim") : focus.port ? "dim" : focus.region !== null ? (region === focus.region ? "normal" : "dim") : "normal";
      candidates.push({ count: b.count, shown: { id: b.id, bundle: b.id, part: "inner", cross: false, route: own, look } });
      continue;
    }
    const cross = layout.crossRoutes.get(b.id);
    if (!cross) continue;
    const viaPort = Boolean(focus.port) && cross.ports.includes(focus.port!);
    if (!touches && !viaPort) continue;
    if (cross.out) candidates.push({ count: b.count, shown: { id: `${b.id}:out`, bundle: b.id, part: "out", cross: true, route: cross.out, look: "active" } });
    if (cross.in) candidates.push({ count: b.count, shown: { id: `${b.id}:in`, bundle: b.id, part: "in", cross: true, route: cross.in, look: "active" } });
  }
  candidates.sort((x, y) => LOOK_RANK[x.shown.look] - LOOK_RANK[y.shown.look] || y.count - x.count || x.shown.id.localeCompare(y.shown.id));
  const shown = candidates.slice(0, Math.max(0, cap)).map((c) => c.shown);
  return { shown, hidden: candidates.length - shown.length };
}

/** The region links to draw from afar: the `cap` busiest, the focused region's first (active, the
 * others dim). */
export function linkPlan(links: readonly RegionLink[], focusRegion: string | null, cap = LINK_CAP): EdgePlan<{ link: RegionLink; look: EdgeLook }> {
  const rows = links.map((link) => ({
    link,
    look: (focusRegion === null ? "normal" : link.from === focusRegion || link.to === focusRegion ? "active" : "dim") as EdgeLook,
  }));
  rows.sort((x, y) => LOOK_RANK[x.look] - LOOK_RANK[y.look] || y.link.count - x.link.count || x.link.id.localeCompare(y.link.id));
  const shown = rows.slice(0, Math.max(0, cap));
  return { shown, hidden: links.length - shown.length };
}

// Edge labels -----------------------------------------------------------------------------------

/** Edge labels in canvas units: the UI font at 12, an average glyph and the pill's height. */
export const LABEL = { size: 12, glyph: 6.6, h: 20, pad: 7, minChars: 6, maxChars: 30 } as const;

export interface LabelCandidate {
  id: string;
  text: string;
  /** Where it may sit, best first (a route's middle, then the middles of its runs). */
  at: Point | readonly Point[];
  /** Lower goes first: the hovered edge, then the busiest. */
  priority: number;
}

export interface PlacedLabel {
  text: string;
  x: number;
  y: number;
  w: number;
}

const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where edge labels fit: at the first of their points with room for the most of the text, cut
 * to the room between the obstacles (cards, region names, ports) and the labels already placed,
 * and left out when fewer than `LABEL.minChars` characters would fit. No two placed labels
 * overlap and none lies on an obstacle.
 */
export function placeLabels(candidates: readonly LabelCandidate[], obstacles: readonly Rect[]): Map<string, PlacedLabel> {
  const placed = new Map<string, PlacedLabel>();
  const taken: Rect[] = [];
  const sorted = [...candidates].filter((c) => c.text.trim()).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const fit = (text: string, at: Point): { label: PlacedLabel; box: Rect } | null => {
    const top = at.y - LABEL.h / 2;
    let left = -Infinity;
    let right = Infinity;
    for (const r of [...obstacles, ...taken]) {
      if (!(r.y < top + LABEL.h && top < r.y + r.h)) continue;
      if (r.x <= at.x && at.x <= r.x + r.w) return null;
      if (r.x + r.w < at.x) left = Math.max(left, r.x + r.w);
      else right = Math.min(right, r.x);
    }
    const room = 2 * Math.min(at.x - left, right - at.x) - 2 * LABEL.pad;
    const chars = Math.min(LABEL.maxChars, Math.floor(room / LABEL.glyph));
    if (chars < LABEL.minChars) return null;
    const cut = truncate(text, chars);
    const w = cut.length * LABEL.glyph + 2 * LABEL.pad;
    const box = { x: at.x - w / 2, y: top, w, h: LABEL.h };
    if (taken.some((t) => hits(t, box))) return null;
    return { label: { text: cut, x: at.x, y: at.y, w }, box };
  };
  for (const c of sorted) {
    const text = c.text.trim();
    const points = Array.isArray(c.at) ? (c.at as readonly Point[]) : [c.at as Point];
    let best: { label: PlacedLabel; box: Rect } | null = null;
    for (const p of points) {
      const f = fit(text, p);
      if (f && (!best || f.label.text.length > best.label.text.length)) best = f;
      if (best && best.label.text === text) break;
    }
    if (!best) continue;
    taken.push(best.box);
    placed.set(c.id, best.label);
  }
  return placed;
}

/** What edge labels must not cover on the screens layer: the cards, each region's name and the
 * ports. */
export function labelObstacles(layout: ScreensLayout): Rect[] {
  return [...layout.cards.values(), ...layout.regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: REGION_HEAD })), ...layout.ports];
}

/** Where a route's label may sit: its middle, then the middles of its runs from the longest. */
export function labelPoints(route: Route): Point[] {
  const p = route.points;
  const runs = p
    .slice(1)
    .map((q, i) => ({ at: { x: (q.x + p[i].x) / 2, y: (q.y + p[i].y) / 2 }, len: Math.hypot(q.x - p[i].x, q.y - p[i].y) }))
    .filter((r) => r.len >= 16)
    .sort((a, b) => b.len - a.len);
  return [routeMidpoint(route), ...runs.map((r) => r.at)];
}

/** "Tap “Add a routine”", or "Tap “Add a routine” +2" when two more moves share the line. */
export function bundleLabel(b: Pick<EdgeBundle, "label" | "more">): string | null {
  if (!b.label) return null;
  const text = quoteLabel(b.label);
  return b.more > 0 ? `${text} +${b.more}` : text;
}

/**
 * The labels to draw: only for the lines in focus (a screen hovered or picked, a port hovered)
 * and the line hovered itself; at rest none, so nothing floats free of its line. Placed by
 * `placeLabels`, the hovered line's first.
 */
export function edgeLabels(layout: ScreensLayout, plan: readonly ShownEdge[], hovered: string | null, obstacles: readonly Rect[] = labelObstacles(layout)): Map<string, PlacedLabel> {
  const candidates: LabelCandidate[] = plan.flatMap((s) => {
    const b = layout.bundles.get(s.bundle);
    const text = b ? bundleLabel(b) : null;
    if (!b || !text || (s.look !== "active" && s.id !== hovered && s.bundle !== hovered)) return [];
    // A line between regions is labelled once, on the half the reader is looking from.
    if (s.part === "in" && plan.some((o) => o.id === `${s.bundle}:out`)) return [];
    return [{ id: s.id, text, at: labelPoints(s.route), priority: s.id === hovered || s.bundle === hovered ? -1 : 1 / (1 + b.count) }];
  });
  return placeLabels(candidates, obstacles);
}

// Data flow --------------------------------------------------------------------------------

export const PILL = { w: 188, h: 48 } as const;
/** A folded group of the data-flow layer: one feature's screens, or the endpoints under one path
 * prefix, as one box with its counts. */
export const GROUP_BOX = { w: 232, h: 84 } as const;
const PILL_GAP = 20;
const ROW_MAX = 12;
const BAND_PAD = 40;
const BAND_GAP = 150;
const GROUP_PAD = 14;
const GROUP_HEAD = 28;
const GROUP_GAP = 34;
const GROUP_COLS = 4;
/** More screens (or endpoints) than this and their band folds into groups: a feature's screens,
 * an endpoint path prefix's endpoints. At or under it every node shows on its own. */
export const DATA_GROUP_FROM = 40;
/** The folded endpoints band's box for the path prefixes with one endpoint each. */
export const OTHER_PATHS = "~paths";
/** How many folded groups a folded band's row holds. */
const GROUPS_PER_ROW = 8;

export type BandKey = "screens" | "endpoints" | "entities";

export interface Band extends Rect {
  key: BandKey;
}

/** A group of the data-flow layer: the endpoints under one path prefix, or (in a folded screens
 * band) one feature's screens. Folded, it is one box with its counts; open, a frame its members
 * stand in. */
export interface DataGroup extends Rect {
  /** Its node id on the canvas: `group:endpoints:/api/listings`, `group:screens:listings`. */
  id: string;
  band: "screens" | "endpoints";
  /** The path prefix or the feature key. */
  key: string;
  label: string;
  count: number;
  /** The node ids it holds. */
  members: string[];
  collapsed: boolean;
  /** In a folded band: it opens and folds back. On a small map the groups are always open. */
  foldable: boolean;
  /** Endpoints: how many of each method, most first, and where they are called and served. */
  methods: [string, number][];
  sides: [EndpointSide, number][];
  /** Screens: how many a run has seen. */
  seen: number;
}

/** One line of the data-flow layer: an edge, or every edge between two groups (or a group and a
 * node) summed. */
export interface DataLink {
  /** The edge's own id when it stands for one edge between its own ends, else `agg:…`. */
  id: string;
  from: string;
  to: string;
  kind: "calls" | "reads" | "writes";
  /** How many edges it stands for, and how often they were taken in all. */
  count: number;
  weight: number;
  edges: string[];
}

export interface DataLayout {
  width: number;
  height: number;
  bands: Band[];
  /** Every node drawn on its own (not folded into a group), by id. */
  pills: Map<string, Rect>;
  groups: DataGroup[];
  /** An app no run or file shows calling a backend: the endpoints band is a slim strip with this
   * note in it, and screens read and write their data straight below. */
  note: Rect | null;
  links: DataLink[];
  /** Each link's route, by link id. */
  routes: Map<string, Route>;
  /** A node folded into a group -> the group's id. */
  holder: Map<string, string>;
  /** Which bands fold into groups (more than `DATA_GROUP_FROM` nodes). */
  folded: { screens: boolean; endpoints: boolean };
}

export interface DataOptions {
  /** The folded groups the reader opened, by group id. */
  expanded?: ReadonlySet<string>;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity;
}

/** Pills in rows of at most `ROW_MAX`, from (0, `top`). Returns the content width and height. */
function rowsOf(ids: readonly string[], top: number, pills: Map<string, Rect>): { w: number; h: number } {
  const perRow = Math.min(ROW_MAX, Math.max(1, ids.length));
  ids.forEach((id, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    pills.set(id, { x: col * (PILL.w + PILL_GAP), y: top + row * (PILL.h + PILL_GAP), w: PILL.w, h: PILL.h });
  });
  const rows = Math.max(1, Math.ceil(ids.length / perRow));
  return { w: perRow * PILL.w + (perRow - 1) * PILL_GAP, h: rows * PILL.h + (rows - 1) * PILL_GAP };
}

/** Something a band packs in rows: a pill, a folded group's box or an open group's frame. */
interface Packed {
  w: number;
  h: number;
  place: (x: number, y: number) => void;
}

/** `items` left to right from (0, `top`), a new row past `maxRow`. Returns the content's size. */
function pack(items: readonly Packed[], top: number, maxRow: number, gap: number): { w: number; h: number } {
  let x = 0;
  let y = top;
  let rowH = 0;
  let w = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > maxRow) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    it.place(x, y);
    x += it.w + gap;
    w = Math.max(w, x - gap);
    rowH = Math.max(rowH, it.h);
  }
  return { w, h: items.length ? y + rowH - top : 0 };
}

/** A group's frame with its members in up to `GROUP_COLS` columns, or its folded box. */
function groupItem(group: DataGroup, pills: Map<string, Rect>, holder: Map<string, string>): Packed {
  if (group.collapsed) {
    for (const id of group.members) holder.set(id, group.id);
    return { w: GROUP_BOX.w, h: GROUP_BOX.h, place: (x, y) => Object.assign(group, { x, y, w: GROUP_BOX.w, h: GROUP_BOX.h }) };
  }
  const cols = Math.max(1, Math.min(GROUP_COLS, group.members.length));
  const rows = Math.ceil(group.members.length / cols);
  const w = 2 * GROUP_PAD + cols * PILL.w + (cols - 1) * PILL_GAP;
  const h = GROUP_HEAD + GROUP_PAD + rows * PILL.h + (rows - 1) * PILL_GAP;
  return {
    w,
    h,
    place: (x, y) => {
      Object.assign(group, { x, y, w, h });
      group.members.forEach((id, i) => {
        pills.set(id, { x: x + GROUP_PAD + (i % cols) * (PILL.w + PILL_GAP), y: y + GROUP_HEAD + Math.floor(i / cols) * (PILL.h + PILL_GAP), w: PILL.w, h: PILL.h });
      });
    },
  };
}

function pillItem(id: string, pills: Map<string, Rect>): Packed {
  return { w: PILL.w, h: PILL.h, place: (x, y) => pills.set(id, { x, y, w: PILL.w, h: PILL.h }) };
}

const VERBS = new Set(["get", "add", "create", "update", "edit", "delete", "remove", "set", "check", "change", "post", "put", "send", "fetch", "list", "assign", "apply", "block", "unblock", "save", "upload", "verify", "manage", "submit", "toggle", "make", "do", "all", "my", "new"]);

/** What a one-segment RPC-style path acts on: `/get_chats` and `/delete_chat_message` -> `chat`,
 * `/change-property-status` -> `property`; null when it names nothing past its verb. */
export function endpointTopic(pattern: string): string | null {
  const seg = pattern.split(/[/?#]/).find((x) => x && x !== "*" && !x.startsWith(":") && !/^\{.*\}$/.test(x));
  if (!seg) return null;
  const words = seg.split(/[-_.]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
  const noun = words.find((w) => !VERBS.has(w) && w.length > 2);
  if (!noun) return null;
  if (noun.length > 4 && noun.endsWith("ies")) return `${noun.slice(0, -3)}y`;
  return noun.length > 3 && noun.endsWith("s") && !noun.endsWith("ss") ? noun.slice(0, -1) : noun;
}

/** `[key, n]` most first, then by key. */
function tally<T extends string>(values: readonly T[]): [T, number][] {
  const m = new Map<T, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const NOTE = { w: 560, h: 40 } as const;
/** The gap between bands when there is no backend to show: the edges only pass through. */
const SLIM_GAP = 72;

/**
 * The data-flow layer: `order` is the screens' order (`screenOrder`), so the top band reads
 * feature by feature like the screens layer. On a big app (more than `DATA_GROUP_FROM` screens or
 * endpoints) that band folds: each feature's screens are one box, each path prefix's endpoints
 * another, with their counts, and the edges between them are summed into one link per pair. A
 * group the reader opens (`expanded`) shows its members in place; the others stay folded.
 */
export function layoutDataFlow(map: AppMap, order: readonly string[], options: DataOptions = {}): DataLayout {
  const expanded = options.expanded ?? new Set<string>();
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const flowEdges = map.edges.filter((e) => e.kind === "calls" || e.kind === "reads" || e.kind === "writes");
  // Screens with no data edge stay out: this layer is about the data.
  const touched = new Set(flowEdges.flatMap((e) => [e.from, e.to]));
  const rank = new Map(order.map((id, i) => [id, i]));
  const screens = map.nodes
    .filter((n) => n.kind === "screen" && touched.has(n.id))
    .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.id.localeCompare(b.id))
    .map((n) => n.id);
  const endpoints = map.nodes.filter((n) => n.kind === "endpoint");
  const folded = { screens: screens.length > DATA_GROUP_FROM, endpoints: endpoints.length > DATA_GROUP_FROM };
  const pills = new Map<string, Rect>();
  const holder = new Map<string, string>();
  const groups: DataGroup[] = [];
  const newGroup = (band: DataGroup["band"], key: string, label: string, members: string[], foldable: boolean): DataGroup => {
    const id = `group:${band}:${key}`;
    const nodes = members.flatMap((m) => byId.get(m) ?? []);
    const group: DataGroup = {
      id,
      band,
      key,
      label,
      count: members.length,
      members,
      collapsed: foldable && !expanded.has(id),
      foldable,
      methods: band === "endpoints" ? tally(nodes.map((n) => n.detail.method ?? "API")) : [],
      sides: band === "endpoints" ? tally(nodes.flatMap((n) => n.detail.side ?? [])) : [],
      seen: nodes.filter((n) => n.state === "seen").length,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    };
    groups.push(group);
    return group;
  };

  // Screens: feature by feature; folded, a feature of two or more screens is one box.
  const topGroups: DataGroup[] = [];
  let top: { w: number; h: number };
  if (!folded.screens) top = rowsOf(screens, BAND_PAD, pills);
  else {
    const byFeature = new Map<string, string[]>();
    for (const id of screens) {
      const f = byId.get(id)?.feature ?? OTHER_REGION;
      byFeature.set(f, [...(byFeature.get(f) ?? []), id]);
    }
    const items: Packed[] = [];
    // Features with one screen here share an "Other areas" box, as on the screens layer.
    const singles = [...byFeature.values()].filter((ids) => ids.length < 2).flat();
    const pool = singles.length >= 2;
    for (const [f, ids] of byFeature) {
      if (ids.length < 2) {
        if (!pool) items.push(pillItem(ids[0], pills));
        continue;
      }
      const name = f === OTHER_REGION ? "Other screens" : (map.features.find((x) => x.key === f)?.name ?? humanize(f));
      const g = newGroup("screens", f, name, ids, true);
      topGroups.push(g);
      items.push(groupItem(g, pills, holder));
    }
    if (pool) {
      const g = newGroup("screens", AREAS_REGION, "Other areas", singles, true);
      topGroups.push(g);
      items.push(groupItem(g, pills, holder));
    }
    top = pack(items, BAND_PAD, GROUPS_PER_ROW * (GROUP_BOX.w + PILL_GAP), PILL_GAP);
  }

  /** Where a node or a folded group is drawn: its pill, else the folded group holding it. */
  const rectOf = (id: string): Rect | undefined => {
    const own = pills.get(id);
    if (own) return own;
    const gid = holder.get(id) ?? id;
    return groups.find((g) => g.id === gid && g.collapsed);
  };
  const xOf = (id: string) => {
    const p = rectOf(id);
    return p ? p.x + p.w / 2 : undefined;
  };
  const neighbourX = (id: string, kinds: readonly string[]) =>
    mean(
      flowEdges
        .flatMap((e) => (e.to === id ? [e.from] : e.from === id ? [e.to] : []))
        .filter((other) => kinds.includes(byId.get(other)?.kind ?? ""))
        .flatMap((other) => xOf(other) ?? []),
    );

  // Endpoints: grouped by path prefix, groups and members ordered under their screens.
  const bary = new Map(endpoints.map((n) => [n.id, neighbourX(n.id, ["screen"])]));
  const byPrefix = new Map<string, AppMapNode[]>();
  for (const n of endpoints) {
    const k = endpointPrefix(n);
    byPrefix.set(k, [...(byPrefix.get(k) ?? []), n]);
  }
  const prefixes = [...byPrefix.entries()]
    .map(([key, list]) => ({
      key,
      list: [...list].sort((a, b) => bary.get(a.id)! - bary.get(b.id)! || a.key.localeCompare(b.key)),
      at: mean(list.map((n) => bary.get(n.id)!).filter(Number.isFinite)),
    }))
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const noBackend = endpoints.length === 0;
  const gap = noBackend ? SLIM_GAP : BAND_GAP;
  const midTop = BAND_PAD + top.h + gap;
  const midItems: Packed[] = [];
  const midGroups: DataGroup[] = [];
  // Folded, the prefixes with one endpoint (an RPC-style API: `/get_chats`, `/delete_chat_message`)
  // gather by the thing they act on ("chat"), and what is still alone shares an "Other paths" box.
  const loneNodes = folded.endpoints ? prefixes.filter((p) => p.list.length < 2).flatMap((p) => p.list) : [];
  const byTopic = new Map<string, string[]>();
  for (const n of loneNodes) {
    const t = endpointTopic(n.detail.pattern ?? n.key.replace(/^[A-Z]+\s+/, ""));
    if (t) byTopic.set(t, [...(byTopic.get(t) ?? []), n.id]);
  }
  const topical = new Set([...byTopic.values()].filter((ids) => ids.length >= 2).flat());
  const lone = loneNodes.map((n) => n.id).filter((id) => !topical.has(id));
  for (const p of prefixes) {
    const ids = p.list.map((n) => n.id);
    if (folded.endpoints && ids.length < 2) {
      if (lone.length < 2 && !topical.has(ids[0])) midItems.push(pillItem(ids[0], pills));
      continue;
    }
    const g = newGroup("endpoints", p.key, p.key === "/" ? "/" : `${p.key}/*`, ids, folded.endpoints);
    midGroups.push(g);
    midItems.push(groupItem(g, pills, holder));
  }
  for (const [topic, ids] of [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (ids.length < 2) continue;
    const g = newGroup("endpoints", `~${topic}`, `*${topic}*`, ids, true);
    midGroups.push(g);
    midItems.push(groupItem(g, pills, holder));
  }
  if (lone.length >= 2) {
    const g = newGroup("endpoints", OTHER_PATHS, "Other paths", lone, true);
    midGroups.push(g);
    midItems.push(groupItem(g, pills, holder));
  }
  const maxRow = folded.endpoints
    ? Math.max(top.w, GROUPS_PER_ROW * (GROUP_BOX.w + GROUP_GAP))
    : Math.max(top.w, GROUP_COLS * (PILL.w + PILL_GAP) + 2 * GROUP_PAD);
  const mid = pack(midItems, midTop + BAND_PAD, maxRow, GROUP_GAP);
  const midH = midItems.length ? mid.h : noBackend ? NOTE.h - 2 * BAND_PAD + 2 * 14 : PILL.h;

  // Entities: under the endpoints and screens that read and write them.
  const entities = map.nodes
    .filter((n) => n.kind === "entity")
    .map((n) => ({ id: n.id, at: neighbourX(n.id, ["endpoint", "screen"]) }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map((e) => e.id);
  const lowTop = midTop + BAND_PAD + midH + BAND_PAD + gap;
  const low = rowsOf(entities, lowTop + BAND_PAD, pills);

  // Centre each band's content on the widest one.
  const width = Math.max(top.w, mid.w, low.w, PILL.w, noBackend ? NOTE.w + 2 * BAND_PAD : 0);
  const shift = (ids: readonly string[], bandGroups: readonly DataGroup[], content: number) => {
    const dx = (width - content) / 2;
    for (const id of ids) {
      const p = pills.get(id);
      if (p) pills.set(id, { ...p, x: p.x + dx });
    }
    for (const g of bandGroups) g.x += dx;
  };
  shift(screens, topGroups, top.w);
  shift(
    endpoints.map((n) => n.id),
    midGroups,
    mid.w,
  );
  shift(entities, [], low.w);

  const bands: Band[] = [
    { key: "screens", x: 0, y: 0, w: width, h: top.h + 2 * BAND_PAD },
    { key: "endpoints", x: 0, y: midTop, w: width, h: midH + 2 * BAND_PAD },
    { key: "entities", x: 0, y: lowTop, w: width, h: low.h + 2 * BAND_PAD },
  ];

  // Links: an edge between two nodes drawn on their own is itself; any end folded into a group
  // stands for the group, and the edges between the same two ends are summed into one.
  const links = new Map<string, DataLink>();
  for (const e of flowEdges) {
    const a = holder.get(e.from) ?? e.from;
    const b = holder.get(e.to) ?? e.to;
    if (a === b || !rectOf(e.from) || !rectOf(e.to)) continue;
    const kind = e.kind as DataLink["kind"];
    const key = `${kind}|${a}|${b}`;
    const link = links.get(key) ?? { id: `agg:${kind}:${a}>${b}`, from: a, to: b, kind, count: 0, weight: 0, edges: [] };
    link.count++;
    link.weight += Math.max(1, e.count);
    link.edges.push(e.id);
    links.set(key, link);
  }
  const out = [...links.values()];
  const edgeById = new Map(flowEdges.map((e) => [e.id, e]));
  const routes = new Map<string, Route>();
  for (const l of out) {
    const only = l.count === 1 ? edgeById.get(l.edges[0]) : undefined;
    if (only && only.from === l.from && only.to === l.to) l.id = only.id;
    const ra = rectOf(l.from)!;
    const rb = rectOf(l.to)!;
    const down = ra.y + ra.h / 2 <= rb.y + rb.h / 2;
    const sides: [Side, Side] = down ? ["bottom", "top"] : ["top", "bottom"];
    routes.set(l.id, { points: [sideAnchor(ra, sides[0]), sideAnchor(rb, sides[1])], sides });
  }
  const midBand = bands[1];
  const note = noBackend ? { x: (width - NOTE.w) / 2, y: midBand.y + (midBand.h - NOTE.h) / 2, w: NOTE.w, h: NOTE.h } : null;
  const last = bands[bands.length - 1];
  return { width, height: last.y + last.h, bands, pills, groups, note, links: out, routes, holder, folded };
}

/** The data links that touch `id` (a node or a group) and the ends on their other side. */
export function dataNeighbours(links: readonly DataLink[], id: string): { links: Set<string>; ends: Set<string> } {
  const out = { links: new Set<string>(), ends: new Set<string>([id]) };
  for (const l of links) {
    if (l.from !== id && l.to !== id) continue;
    out.links.add(l.id);
    out.ends.add(l.from === id ? l.to : l.from);
  }
  return out;
}

// Drawing helpers -----------------------------------------------------------------------------

const NORMAL: Record<Side, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };

/** The SVG path of a route: a curve for two points, else a polyline with rounded corners. */
export function routePath(route: Route): string {
  const p = route.points;
  if (p.length < 2) return "";
  const r = (n: number) => Math.round(n * 10) / 10;
  if (p.length === 2) {
    const [a, b] = p;
    const k = Math.max(36, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
    const na = NORMAL[route.sides[0]];
    const nb = NORMAL[route.sides[1]];
    return `M${r(a.x)},${r(a.y)} C${r(a.x + na.x * k)},${r(a.y + na.y * k)} ${r(b.x + nb.x * k)},${r(b.y + nb.y * k)} ${r(b.x)},${r(b.y)}`;
  }
  let d = `M${r(p[0].x)},${r(p[0].y)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const prev = p[i - 1];
    const cur = p[i];
    const nxt = p[i + 1];
    const lin = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const lout = Math.hypot(nxt.x - cur.x, nxt.y - cur.y);
    const rad = Math.min(16, lin / 2, lout / 2);
    if (rad <= 0.5) {
      d += ` L${r(cur.x)},${r(cur.y)}`;
      continue;
    }
    const a = { x: cur.x - ((cur.x - prev.x) / lin) * rad, y: cur.y - ((cur.y - prev.y) / lin) * rad };
    const b = { x: cur.x + ((nxt.x - cur.x) / lout) * rad, y: cur.y + ((nxt.y - cur.y) / lout) * rad };
    d += ` L${r(a.x)},${r(a.y)} Q${r(cur.x)},${r(cur.y)} ${r(b.x)},${r(b.y)}`;
  }
  const end = p[p.length - 1];
  return `${d} L${r(end.x)},${r(end.y)}`;
}

/** A route's length along its points (the curve of a two-point route is a little longer). */
export function routeLength(route: Route): number {
  return route.points.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - route.points[i].x, q.y - route.points[i].y), 0);
}

/** Halfway along a route, for its label. */
export function routeMidpoint(route: Route): Point {
  const p = route.points;
  if (p.length === 0) return { x: 0, y: 0 };
  const lengths = p.slice(1).map((q, i) => Math.hypot(q.x - p[i].x, q.y - p[i].y));
  let left = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] && lengths[i] > 0) {
      const t = left / lengths[i];
      return { x: p[i].x + (p[i + 1].x - p[i].x) * t, y: p[i].y + (p[i + 1].y - p[i].y) * t };
    }
    left -= lengths[i];
  }
  return p[p.length - 1];
}

/** How thick a navigation edge is for how often it was taken: 1.4 for once, up to 5. */
export function edgeWidth(count: number): number {
  return Math.round(Math.min(5, 1.4 + Math.log2(Math.max(1, count)) * 0.8) * 10) / 10;
}

/** A navigation line's width on the screens layer: thin at rest (1 to 1.6 by how often it was
 * taken), 2 to 2.5 in focus. Subtle on purpose: the count is in the panel, the line is the way. */
export function navWidth(count: number, active: boolean): number {
  const extra = Math.min(1, Math.log2(1 + Math.max(0, count)) / 6);
  return Math.round(((active ? 2 : 1) + extra * (active ? 0.5 : 0.6)) * 100) / 100;
}

/** One rectangle of fog over what no run has reached: a declared screen thick, a blocked one
 * thinner, a region with no screen at all whole. */
export interface FogPatch extends Rect {
  fog: number;
}

export function fogPatches(layout: ScreensLayout, nodes: ReadonlyMap<string, AppMapNode>): FogPatch[] {
  const out: FogPatch[] = [];
  for (const r of layout.regions) if (r.screens === 0) out.push({ x: r.x, y: r.y, w: r.w, h: r.h, fog: 1 });
  for (const c of layout.cards.values()) {
    const state = nodes.get(c.id)?.state;
    if (state === "seen") continue;
    out.push({ x: c.x - 14, y: c.y - 14, w: c.w + 28, h: c.h + 28, fog: state === "blocked" ? 0.65 : 1 });
  }
  return out;
}

/** A stop of the Play tour: a region, then the first screens a user walks to in it. */
export interface TourStop {
  kind: "region" | "screen";
  id: string;
  label: string;
  rect: Rect;
}

export function tourStops(layout: ScreensLayout, nodes: ReadonlyMap<string, AppMapNode>, perRegion = 3): TourStop[] {
  const out: TourStop[] = [];
  for (const r of layout.regions) {
    if (r.screens === 0) continue;
    out.push({ kind: "region", id: r.key, label: r.label, rect: r });
    const cards = [...layout.cards.values()].filter((c) => c.region === r.key).sort((a, b) => a.col - b.col || a.row - b.row);
    for (const c of cards.slice(0, perRegion)) out.push({ kind: "screen", id: c.id, label: nodes.get(c.id)?.label ?? c.id, rect: c });
  }
  return out;
}
