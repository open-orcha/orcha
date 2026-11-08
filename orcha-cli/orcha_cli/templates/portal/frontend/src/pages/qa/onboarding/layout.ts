/**
 * The map's geometry, worked out once per snapshot shape and viewport (never per frame): the
 * file tree on the left, the screens grouped into areas in the middle, the API endpoints on the
 * right, and every curve the cinematic draws. Areas are shelf-packed at the width that gives
 * the screens the most room, so 12 screens read as cards and 250 as a calm field of chips.
 */
import { areaOf } from "./coverage";
import type { MapScreen, OnboardingMap } from "./contract";

export type Lod = "card" | "chip" | "dot";

export interface NodeBox {
  id: string;
  area: string;
  /** Order in reading order (area by area): keyboard navigation follows it. */
  order: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AreaBox {
  key: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  /** The height of the band the area's name sits in (screens start below it). */
  head: number;
}

export interface Row {
  key: string;
  label: string;
  kind: "dir" | "file" | "more";
  depth: number;
  y: number;
  /** The file paths this row stands for (a folder row stands for every file in it when the
   * tree is folded). */
  paths: string[];
}

export interface Column {
  x: number;
  y: number;
  w: number;
  h: number;
  rowH: number;
  rows: Row[];
  /** File path (tree) or endpoint (rail) to its row index. */
  rowOf: Map<string, number>;
}

export interface EdgeGeom {
  from: string;
  to: string;
  kind: string;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  x2: number;
  y2: number;
}

export interface MapLayout {
  width: number;
  height: number;
  graph: { x: number; y: number; w: number; h: number };
  /** Screen pixels per layout unit (a 72-unit-wide screen is `72 * scale` px). */
  scale: number;
  lod: Lod;
  nodes: Map<string, NodeBox>;
  order: string[];
  areas: AreaBox[];
  tree: Column | null;
  rail: Column | null;
  edges: EdgeGeom[];
}

const AREA_PAD = 14;
const AREA_HEAD = 26;
const AREA_GAP = 18;
const ROW_H = 18;
/** Where the graph starts: under the column heads ("Screens"), which sit at the stage's top. */
const GRAPH_TOP = 36;

/** A screen card's size and the cell it sits in (the cell leaves room for the name below). */
export interface NodeShape {
  nodeW: number;
  nodeH: number;
  cellW: number;
  cellH: number;
}

/** Width over height of the device the screens come from: a phone is tall, a web page wide. */
const PHONE_ASPECT = 402 / 874;
const WEB_ASPECT = 1280 / 800;
/** Every card keeps the area of the old 72 x 104 card, so the same number of screens fits. */
const NODE_AREA = 72 * 104;

/** The aspect of the screens' device: the platform most screens are on, else the repo's. */
export function screenAspect(input: Pick<LayoutInput, "screens" | "found">): number {
  const counts = new Map<string, number>();
  for (const s of input.screens) if (s.platform) counts.set(s.platform, (counts.get(s.platform) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? input.found?.platforms[0]?.kind;
  return top === "web" ? WEB_ASPECT : PHONE_ASPECT;
}

export function nodeShape(aspect: number): NodeShape {
  const nodeH = Math.round(Math.sqrt(NODE_AREA / aspect));
  const nodeW = Math.round(nodeH * aspect);
  return { nodeW, nodeH, cellW: nodeW + 20, cellH: nodeH + 28 };
}

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The map's height for a number of screens: small maps stay compact, big ones get room. */
export function stageHeight(screens: number, viewportH = 900): number {
  const want = screens <= 16 ? 460 : screens <= 60 ? 560 : 660;
  return Math.max(360, Math.min(want, Math.round(viewportH * 0.72)));
}

interface AreaPlan {
  key: string;
  label: string;
  screens: MapScreen[];
  cols: number;
  rows: number;
  w: number;
  h: number;
}

/** Areas shaped from tall (few columns) to wide (many): the packer tries each. */
const SHAPES = [0.6, 1, 1.7, 2.6, 4];

function planAreas(screens: readonly MapScreen[], shape: number, node: NodeShape, labels?: Map<string, string>): AreaPlan[] {
  const groups = new Map<string, MapScreen[]>();
  for (const s of screens) {
    const key = areaOf(s);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  // Many one-screen areas read as noise (and their names never fit): they share "Other".
  if (groups.size > 8) {
    const other = groups.get("other") ?? [];
    for (const [key, list] of [...groups]) {
      if (key !== "other" && list.length === 1) {
        other.push(...list);
        groups.delete(key);
      }
    }
    if (other.length) {
      groups.delete("other");
      groups.set("other", other);
    }
  }
  return [...groups.entries()].map(([key, list]) => {
    const cols = Math.max(1, Math.min(list.length, Math.ceil(Math.sqrt(list.length * shape))));
    const rows = Math.ceil(list.length / cols);
    return {
      key,
      label: labels?.get(key) ?? titleCase(key),
      screens: list,
      cols,
      rows,
      w: cols * node.cellW + AREA_PAD * 2 - (node.cellW - node.nodeW),
      h: rows * node.cellH + AREA_HEAD + AREA_PAD - (node.cellH - node.nodeH) + 18,
    };
  });
}

/** Shelf-pack the areas at `maxW`; returns each area's world position and the bounding box. */
function shelf(areas: AreaPlan[], maxW: number) {
  const pos: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let shelfH = 0;
  let w = 0;
  for (const a of areas) {
    if (x > 0 && x + a.w > maxW) {
      x = 0;
      y += shelfH + AREA_GAP;
      shelfH = 0;
    }
    pos.push({ x, y });
    x += a.w + AREA_GAP;
    shelfH = Math.max(shelfH, a.h);
    w = Math.max(w, x - AREA_GAP);
  }
  return { pos, w, h: y + shelfH };
}

function commonDir(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const split = paths.map((p) => p.split("/").slice(0, -1));
  const first = split[0];
  let n = first.length;
  for (const s of split) {
    let k = 0;
    while (k < n && k < s.length && s[k] === first[k]) k++;
    n = k;
  }
  return first.slice(0, n).join("/");
}

/** A folder's label that fits: its last two segments when the path is long. */
function dirLabel(dir: string): string {
  if (dir === ".") return "./";
  const parts = dir.split("/");
  return parts.length > 2 && dir.length > 28 ? `…/${parts.slice(-2).join("/")}/` : `${dir}/`;
}

/** The file tree as rows: folders with their files, folded to folders when it does not fit. */
export function treeRows(paths: readonly string[], maxRows: number): { rows: Row[]; rowOf: Map<string, number>; root: string } {
  const root = commonDir(paths);
  const strip = (p: string) => (root ? p.slice(root.length + 1) : p);
  const dirs = new Map<string, string[]>();
  for (const p of [...paths].sort()) {
    const rel = strip(p);
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
    const list = dirs.get(dir) ?? [];
    list.push(p);
    dirs.set(dir, list);
  }
  const rows: Row[] = [];
  const rowOf = new Map<string, number>();
  const full = dirs.size + paths.length;
  if (full > maxRows && dirs.size <= maxRows) {
    // Every folder, and the files of as many folders as the room allows (in order): a folded
    // folder's files light up its row.
    let room = maxRows - dirs.size;
    for (const [dir, files] of dirs) {
      const open = files.length <= room;
      if (open) room -= files.length;
      if (!open || dir !== ".") {
        for (const f of files) rowOf.set(f, rows.length);
        rows.push({ key: `d:${dir}`, label: dirLabel(dir), kind: "dir", depth: 0, y: 0, paths: files });
      }
      if (open) {
        for (const f of files) {
          rowOf.set(f, rows.length);
          rows.push({ key: `f:${f}`, label: f.slice(f.lastIndexOf("/") + 1), kind: "file", depth: dir === "." ? 0 : 1, y: 0, paths: [f] });
        }
      }
    }
    return { rows, rowOf, root };
  }
  if (full <= maxRows) {
    for (const [dir, files] of dirs) {
      if (dir !== ".") rows.push({ key: `d:${dir}`, label: dirLabel(dir), kind: "dir", depth: 0, y: 0, paths: files });
      for (const f of files) {
        rowOf.set(f, rows.length);
        rows.push({ key: `f:${f}`, label: f.slice(f.lastIndexOf("/") + 1), kind: "file", depth: dir === "." ? 0 : 1, y: 0, paths: [f] });
      }
    }
  } else {
    // Folded: one row per folder (its files light it up), the last row gathers what is left.
    const list = [...dirs.entries()];
    const room = Math.max(1, maxRows);
    const shown = list.length <= room ? list : list.slice(0, room - 1);
    for (const [dir, files] of shown) {
      for (const f of files) rowOf.set(f, rows.length);
      rows.push({ key: `d:${dir}`, label: dirLabel(dir), kind: "dir", depth: 0, y: 0, paths: files });
    }
    if (shown.length < list.length) {
      const rest = list.slice(shown.length);
      const files = rest.flatMap(([, f]) => f);
      for (const f of files) rowOf.set(f, rows.length);
      rows.push({ key: "more", label: `${rest.length} more folders`, kind: "more", depth: 0, y: 0, paths: files });
    }
  }
  return { rows, rowOf, root };
}

function railRows(endpoints: readonly string[], maxRows: number): { rows: Row[]; rowOf: Map<string, number> } {
  const rows: Row[] = [];
  const rowOf = new Map<string, number>();
  const room = Math.max(1, maxRows);
  const shown = endpoints.length <= room ? endpoints : endpoints.slice(0, room - 1);
  for (const e of shown) {
    rowOf.set(e, rows.length);
    rows.push({ key: `e:${e}`, label: e, kind: "file", depth: 0, y: 0, paths: [e] });
  }
  if (shown.length < endpoints.length) {
    const rest = endpoints.slice(shown.length);
    for (const e of rest) rowOf.set(e, rows.length);
    rows.push({ key: "more", label: `${rest.length} more endpoints`, kind: "more", depth: 0, y: 0, paths: rest });
  }
  return { rows, rowOf };
}

export interface LayoutInput {
  screens: readonly MapScreen[];
  files: OnboardingMap["files"];
  edges: OnboardingMap["edges"];
  /** Area keys to display names (from the gaps' `flow`, when the server names them). */
  areaLabels?: Map<string, string>;
  /** The repo's platforms: the cards' shape when no screen says which platform it is on. */
  found?: Pick<OnboardingMap["found"], "platforms">;
}

/** The largest a screen is ever drawn (layout units to pixels). */
export const MAX_SCALE = 1.6;

/** The whole map's geometry for a `width` x `height` canvas. `maxScale` keeps a growing map
 * from zooming back in as it fills: the stage passes the last scale it drew at. */
export function computeLayout(input: LayoutInput, width: number, height: number, maxScale = MAX_SCALE): MapLayout {
  const narrow = width < 640;
  const treeW = narrow ? 0 : Math.round(Math.max(170, Math.min(250, width * 0.2)));
  const endpoints = [...new Set(input.screens.flatMap((s) => s.endpoints))];
  const railW = width >= 1080 && endpoints.length > 0 ? 176 : 0;
  const gap = narrow ? 8 : 28;
  const graph = { x: treeW ? treeW + gap : gap, y: GRAPH_TOP, w: width - (treeW ? treeW + gap : gap) - (railW ? railW + gap : gap), h: height - GRAPH_TOP - 16 };
  const node = nodeShape(screenAspect(input));

  // Every area shape at every shelf width: the packing that gives the screens the most room.
  let plans: AreaPlan[] = [];
  let best = { pos: [] as { x: number; y: number }[], w: 1, h: 1 };
  let bestScale = 0;
  for (const shape of SHAPES) {
    const candidate = planAreas(input.screens, shape, node, input.areaLabels);
    const totalW = candidate.reduce((n, a) => n + a.w + AREA_GAP, 0);
    const widest = candidate.reduce((n, a) => Math.max(n, a.w), 0);
    for (let k = 0; k <= 24 && candidate.length > 0; k++) {
      const packed = shelf(candidate, widest + ((totalW - widest) * k) / 24);
      const sc = Math.min(graph.w / packed.w, graph.h / packed.h);
      if (sc > bestScale + 1e-6) {
        bestScale = sc;
        best = packed;
        plans = candidate;
      }
    }
  }
  const scale = Math.min(bestScale || 1, maxScale);
  const ox = graph.x + (graph.w - best.w * scale) / 2;
  const oy = graph.y + (graph.h - best.h * scale) / 2;

  const nodes = new Map<string, NodeBox>();
  const order: string[] = [];
  const areas: AreaBox[] = [];
  plans.forEach((a, i) => {
    const p = best.pos[i];
    const ax = ox + p.x * scale;
    const ay = oy + p.y * scale;
    areas.push({ key: a.key, label: a.label, x: ax, y: ay, w: a.w * scale, h: a.h * scale, count: a.screens.length, head: AREA_HEAD * scale });
    a.screens.forEach((s, k) => {
      const col = k % a.cols;
      const row = Math.floor(k / a.cols);
      nodes.set(s.id, {
        id: s.id,
        area: a.key,
        order: order.length,
        x: ax + (AREA_PAD + col * node.cellW) * scale,
        y: ay + (AREA_HEAD + row * node.cellH) * scale,
        w: node.nodeW * scale,
        h: node.nodeH * scale,
      });
      order.push(s.id);
    });
  });
  // By the card's size, not its width, so a tall phone card and a wide web card switch alike.
  const size = Math.sqrt(NODE_AREA) * scale;
  const lod: Lod = size >= 0.75 * Math.sqrt(NODE_AREA) ? "card" : size >= 0.25 * Math.sqrt(NODE_AREA) ? "chip" : "dot";

  let tree: Column | null = null;
  if (treeW > 0) {
    const top = 40;
    const maxRows = Math.floor((height - top - 12) / ROW_H);
    const { rows, rowOf } = treeRows(
      input.files.map((f) => f.path),
      maxRows,
    );
    rows.forEach((r, i) => (r.y = top + i * ROW_H));
    tree = { x: 12, y: top, w: treeW - 12, h: rows.length * ROW_H, rowH: ROW_H, rows, rowOf };
  }
  let rail: Column | null = null;
  if (railW > 0) {
    const top = 40;
    const maxRows = Math.floor((height - top - 12) / ROW_H);
    const { rows, rowOf } = railRows(endpoints, maxRows);
    rows.forEach((r, i) => (r.y = top + i * ROW_H));
    rail = { x: width - railW, y: top, w: railW - 12, h: rows.length * ROW_H, rowH: ROW_H, rows, rowOf };
  }

  const edges: EdgeGeom[] = [];
  for (const e of input.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h / 2;
    const x2 = b.x + b.w / 2;
    const y2 = b.y + b.h / 2;
    // A gentle bow, always to the same side, so parallel links fan out instead of overlapping.
    const dx = x2 - x1;
    const dy = y2 - y1;
    const bow = Math.min(60, Math.hypot(dx, dy) * 0.18);
    const len = Math.hypot(dx, dy) || 1;
    edges.push({ from: e.from, to: e.to, kind: e.kind, x1, y1, x2, y2, cx: (x1 + x2) / 2 - (dy / len) * bow, cy: (y1 + y2) / 2 + (dx / len) * bow });
  }

  return { width, height, graph, scale, lod, nodes, order, areas, tree, rail, edges };
}

/** The node under a point, if any (a small margin makes tiny chips easy to hit). */
export function nodeAt(layout: MapLayout, x: number, y: number): string | null {
  const m = layout.lod === "card" ? 0 : 3;
  for (const n of layout.nodes.values()) {
    if (x >= n.x - m && x <= n.x + n.w + m && y >= n.y - m && y <= n.y + n.h + m) return n.id;
  }
  return null;
}

/** The next node from `id` in a direction (arrow keys): the nearest one that way. */
export function neighbour(layout: MapLayout, id: string | null, dir: "left" | "right" | "up" | "down" | "home" | "end"): string | null {
  const order = layout.order;
  if (order.length === 0) return null;
  if (!id || !layout.nodes.has(id)) return order[0];
  if (dir === "home") return order[0];
  if (dir === "end") return order[order.length - 1];
  const from = layout.nodes.get(id)!;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of layout.nodes.values()) {
    if (n.id === id) continue;
    const dx = n.x + n.w / 2 - cx;
    const dy = n.y + n.h / 2 - cy;
    const ahead = dir === "right" ? dx > 1 : dir === "left" ? dx < -1 : dir === "down" ? dy > 1 : dy < -1;
    if (!ahead) continue;
    // Along the axis counts once, across it three times: arrows stay in their row or column.
    const along = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const d = along + across * 3;
    if (d < bestD) {
      bestD = d;
      best = n.id;
    }
  }
  return best ?? id;
}
