/**
 * The coverage map's layout: feature areas as a territory, grouped the way the code groups them
 * (the first folder after the paths every area shares, else the route prefix), drawn as a
 * squarified treemap: groups first, then the areas inside each group. Deterministic for the
 * same input, no overlaps, every tile inside the map. Pure; works for 1..200+ areas.
 */

export interface LayoutArea {
  key: string;
  name: string;
  paths: readonly string[];
  entry: string | null;
  source: string;
  importance: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutGroup extends Rect {
  key: string;
  label: string;
  count: number;
}

export interface LayoutTile extends Rect {
  key: string;
  group: string;
}

export interface MapLayout {
  width: number;
  height: number;
  groups: LayoutGroup[];
  tiles: LayoutTile[];
}

const OTHER = "~other";
const EXPLORED = "~explored";
const MANUAL = "~manual";

function segments(path: string): string[] {
  return path.split("/").filter((s) => s && s !== ".");
}

function commonPrefix(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const seg = lists[0][i];
    if (seg === undefined || lists.some((l) => l[i] !== seg)) return out;
    out.push(seg);
  }
}

/** "SnugLogWidget" -> "Snug Log Widget", "(app)" -> "App", "sign-in" -> "Sign in". */
export function humanize(seg: string): string {
  const s = seg
    .replace(/^[([]+|[)\]]+$/g, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : seg;
}

const GROUP_LABELS: Record<string, string> = { [OTHER]: "Other", [EXPLORED]: "Found exploring", [MANUAL]: "Added by hand" };

/**
 * Each area's group key and the groups' labels. Areas with paths group by the first folder
 * after the prefix all of them share (when the area's own path goes deeper than that folder);
 * route-only areas group by their first route segment when two or more share it; the rest go
 * to "Found exploring", "Added by hand" or "Other". Single-area groups fold into "Other" once
 * there are more than eight groups.
 */
export function groupAreas(areas: readonly LayoutArea[]): { groupOf: Map<string, string>; labels: Map<string, string> } {
  const withPaths = areas.filter((a) => a.paths.length > 0);
  const prefix = commonPrefix(withPaths.map((a) => segments(a.paths[0])));
  const groupOf = new Map<string, string>();
  const labels = new Map<string, string>(Object.entries(GROUP_LABELS));
  const routeSeg = (a: LayoutArea) => (a.entry && a.entry.startsWith("/") ? (segments(a.entry)[0] ?? null) : null);
  const routeCounts = new Map<string, number>();
  for (const a of areas) {
    if (a.paths.length > 0) continue;
    const r = routeSeg(a);
    if (r) routeCounts.set(r, (routeCounts.get(r) ?? 0) + 1);
  }
  for (const a of areas) {
    let g: string;
    if (a.paths.length > 0) {
      const rest = segments(a.paths[0]).slice(prefix.length);
      if (rest.length > 1) {
        g = `p:${rest[0]}`;
        labels.set(g, humanize(rest[0]));
      } else {
        const root = prefix[prefix.length - 1];
        g = "p:";
        labels.set(g, root ? humanize(root) : "App");
      }
    } else {
      const r = routeSeg(a);
      if (r && (routeCounts.get(r) ?? 0) >= 2) {
        g = `r:${r}`;
        labels.set(g, `/${r}`);
      } else {
        g = a.source === "manual" ? MANUAL : a.source === "exploration" ? EXPLORED : OTHER;
      }
    }
    groupOf.set(a.key, g);
  }
  const sizes = new Map<string, number>();
  for (const g of groupOf.values()) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  if (sizes.size > 8) {
    for (const [key, g] of groupOf) if ((sizes.get(g) ?? 0) === 1 && !g.startsWith("~")) groupOf.set(key, OTHER);
  }
  return { groupOf, labels };
}

// Squarified treemap (Bruls, Huizing, van Wijk) ---------------------------------------------

interface Weighted<T> {
  item: T;
  weight: number;
}

function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  if (sum <= 0 || side <= 0) return Infinity;
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = side * side;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

/** Lay `items` out in `rect`, areas proportional to their weights. */
export function squarify<T>(items: readonly Weighted<T>[], rect: Rect): { item: T; rect: Rect }[] {
  const total = items.reduce((a, b) => a + Math.max(b.weight, 0), 0);
  if (items.length === 0 || total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const queue = items.map((i) => ({ item: i.item, area: Math.max(i.weight, 0) * scale }));
  const out: { item: T; rect: Rect }[] = [];
  let { x, y, w, h } = rect;
  while (queue.length > 0) {
    const side = Math.min(w, h);
    const row: typeof queue = [queue.shift()!];
    while (queue.length > 0) {
      const next = queue[0];
      if (worst([...row, next].map((r) => r.area), side) <= worst(row.map((r) => r.area), side)) row.push(queue.shift()!);
      else break;
    }
    const sum = row.reduce((a, b) => a + b.area, 0);
    if (w >= h) {
      // A column on the left.
      const cw = queue.length === 0 ? w : sum / h;
      let cy = y;
      row.forEach((r, i) => {
        const rh = i === row.length - 1 ? y + h - cy : r.area / cw;
        out.push({ item: r.item, rect: { x, y: cy, w: cw, h: rh } });
        cy += rh;
      });
      x += cw;
      w -= cw;
    } else {
      // A row on top.
      const rh = queue.length === 0 ? h : sum / w;
      let cx = x;
      row.forEach((r, i) => {
        const rw = i === row.length - 1 ? x + w - cx : r.area / rh;
        out.push({ item: r.item, rect: { x: cx, y, w: rw, h: rh } });
        cx += rw;
      });
      y += rh;
      h -= rh;
    }
  }
  return out;
}

function inset(r: Rect, dx: number, dy = dx): Rect {
  return { x: r.x + dx, y: r.y + dy, w: Math.max(0, r.w - 2 * dx), h: Math.max(0, r.h - 2 * dy) };
}

export interface LayoutOptions {
  /** Space between groups and between tiles. */
  gap?: number;
  /** Room for a group's label above its tiles (dropped when the group is too small). */
  header?: number;
}

/** The whole map for areas in a `width` x `height` box. */
export function layoutMap(areas: readonly LayoutArea[], width: number, height: number, opts: LayoutOptions = {}): MapLayout {
  const gap = opts.gap ?? 6;
  const header = opts.header ?? 22;
  const { groupOf, labels } = groupAreas(areas);
  const byGroup = new Map<string, LayoutArea[]>();
  for (const a of areas) {
    const g = groupOf.get(a.key)!;
    byGroup.set(g, [...(byGroup.get(g) ?? []), a]);
  }
  const weight = (a: LayoutArea) => Math.max(1, a.importance);
  const groups = [...byGroup.entries()]
    .map(([key, list]) => ({
      key,
      list: [...list].sort((a, b) => weight(b) - weight(a) || a.key.localeCompare(b.key)),
      weight: list.reduce((s, a) => s + weight(a), 0),
    }))
    // Biggest territories first; the catch-all groups last.
    .sort((a, b) => Number(a.key.startsWith("~")) - Number(b.key.startsWith("~")) || b.weight - a.weight || a.key.localeCompare(b.key));
  const outer = squarify(
    groups.map((g) => ({ item: g, weight: g.weight })),
    { x: 0, y: 0, w: width, h: height },
  );
  const outGroups: LayoutGroup[] = [];
  const tiles: LayoutTile[] = [];
  const labelled = groups.length > 1;
  for (const { item: g, rect } of outer) {
    const box = inset(rect, gap / 2);
    const head = labelled && box.h > header * 2.4 && box.w > 72 ? header : 0;
    outGroups.push({ key: g.key, label: labels.get(g.key) ?? humanize(g.key), count: g.list.length, ...box });
    const inner: Rect = { x: box.x, y: box.y + head, w: box.w, h: Math.max(0, box.h - head) };
    for (const { item: a, rect: r } of squarify(g.list.map((a) => ({ item: a, weight: weight(a) })), inner)) {
      tiles.push({ key: a.key, group: g.key, ...inset(r, gap / 2) });
    }
  }
  return { width, height, groups: outGroups, tiles };
}

/** The map's height for a width and an area count: wide on desktop, tall on a phone. */
export function mapHeight(width: number, count: number): number {
  if (width < 640) return Math.round(Math.max(420, Math.min(1100, 300 + count * 34)));
  const base = width * 0.5;
  return Math.round(Math.max(380, Math.min(720, base + Math.max(0, count - 24) * 4)));
}
