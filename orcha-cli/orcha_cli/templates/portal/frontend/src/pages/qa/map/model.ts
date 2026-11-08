/**
 * What the Map page asks of an `AppMap` besides geometry (`layout.ts`): the level of detail for a
 * zoom, which sources back a node or an edge (the evidence filter), a node's connections and the
 * flows the existing tests walk. Pure: no React, no DOM.
 */
import { blockedText, type AppMap, type AppMapEdge, type AppMapNode, type EdgeKind, type EvidenceSource } from "./types";

export type Layer = "screens" | "data" | "tests";
export type Lod = "far" | "mid" | "near";

/** Below this zoom only regions show; at or above `NEAR_ZOOM` cards show their frame and actions. */
export const FAR_ZOOM = 0.4;
export const NEAR_ZOOM = 0.85;

/** The level of detail for a React Flow zoom. */
export function lodFor(zoom: number): Lod {
  if (!Number.isFinite(zoom) || zoom < FAR_ZOOM) return "far";
  return zoom < NEAR_ZOOM ? "mid" : "near";
}

/** The sources that back a node: code (a file and line), tests (a test that touches it) and live
 * (a run that reached it). */
export function nodeSources(node: AppMapNode): EvidenceSource[] {
  const out: EvidenceSource[] = [];
  if (node.evidence.code.length > 0) out.push("code");
  if (node.evidence.tests.length > 0) out.push("tests");
  if (node.evidence.live || node.state === "seen") out.push("live");
  return out;
}

/** Whether `sources` meets the filter: any chosen source backs it. All three chosen is no filter,
 * so a node no source claims (an older builder) still shows. */
export function passesEvidence(sources: readonly EvidenceSource[], chosen: ReadonlySet<EvidenceSource>): boolean {
  if (chosen.size >= 3) return true;
  return sources.some((s) => chosen.has(s));
}

/** Whether an edge stays lit under the filter. An edge that names no source is as good as its
 * two ends. */
export function edgePasses(edge: AppMapEdge, ends: { from: boolean; to: boolean }, chosen: ReadonlySet<EvidenceSource>): boolean {
  if (chosen.size >= 3) return true;
  if (edge.sources.length === 0) return ends.from && ends.to;
  return passesEvidence(edge.sources, chosen);
}

/** The node ids the filter keeps lit. */
export function litNodes(map: AppMap, chosen: ReadonlySet<EvidenceSource>): Set<string> {
  return new Set(map.nodes.filter((n) => passesEvidence(nodeSources(n), chosen)).map((n) => n.id));
}

export interface Connection {
  node: AppMapNode;
  edge: AppMapEdge;
}

export interface Connections {
  /** Screens this one leads to, and the ones that lead here. */
  to: Connection[];
  from: Connection[];
  /** Endpoints a screen calls, or screens that call an endpoint. */
  calls: Connection[];
  calledBy: Connection[];
  reads: Connection[];
  writes: Connection[];
  /** Endpoints and screens that read or write an entity. */
  readBy: Connection[];
  writtenBy: Connection[];
  /** Flows (existing tests) that walk through a screen. */
  flows: Connection[];
}

/** Everything one edge away from `id`, grouped the way the detail panel lists it. */
export function connectionsOf(map: AppMap, id: string): Connections {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const out: Connections = { to: [], from: [], calls: [], calledBy: [], reads: [], writes: [], readBy: [], writtenBy: [], flows: [] };
  const add = (list: Connection[], nodeId: string, edge: AppMapEdge) => {
    const node = byId.get(nodeId);
    if (node && !list.some((c) => c.node.id === node.id)) list.push({ node, edge });
  };
  const outgoing: Record<EdgeKind, keyof Connections> = { navigates: "to", calls: "calls", reads: "reads", writes: "writes", steps: "flows" };
  const incoming: Record<EdgeKind, keyof Connections> = { navigates: "from", calls: "calledBy", reads: "readBy", writes: "writtenBy", steps: "flows" };
  for (const e of map.edges) {
    // A flow's steps are listed on the flow itself (`flowSteps`), not as connections.
    if (e.from === id && e.kind !== "steps") add(out[outgoing[e.kind]], e.to, e);
    if (e.to === id) add(out[incoming[e.kind]], e.from, e);
  }
  for (const list of Object.values(out) as Connection[][]) list.sort((a, b) => b.edge.count - a.edge.count || a.node.label.localeCompare(b.node.label));
  return out;
}

/** The screens a flow walks, in order (its `steps` edges by `order`). */
export function flowSteps(map: AppMap, flowId: string): AppMapNode[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  return map.edges
    .filter((e) => e.kind === "steps" && e.from === flowId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .flatMap((e) => byId.get(e.to) ?? []);
}

export interface FlowEntry {
  flow: AppMapNode;
  steps: AppMapNode[];
}

/** The flows on the map: the ones that walk screens first, longest first (the ones worth picking
 * in the Tests layer), then the ones tied to no screen yet, by name. */
export function flowsOf(map: AppMap): FlowEntry[] {
  return map.nodes
    .filter((n) => n.kind === "flow")
    .map((flow) => ({ flow, steps: flowSteps(map, flow.id) }))
    .sort((a, b) => b.steps.length - a.steps.length || Number(a.flow.detail.skipped) - Number(b.flow.detail.skipped) || a.flow.label.localeCompare(b.flow.label));
}

/** The Tests layer's list: flows that walk screens, and the ones not tied to a screen yet. */
export function splitFlows(flows: readonly FlowEntry[]): { linked: FlowEntry[]; unlinked: FlowEntry[] } {
  return { linked: flows.filter((f) => f.steps.length > 0), unlinked: flows.filter((f) => f.steps.length === 0) };
}

/** Why a flow walks no screen on the map: the builder's reason, else what can be said from here. */
export function unlinkedReason(flow: AppMapNode): string {
  const d = flow.detail;
  if (d.unlinked) return d.unlinked;
  if (d.skipped) return d.skip_reason ? `Skipped: ${d.skip_reason}` : "The test is skipped.";
  return "None of the screens it opens, taps or checks is on the map yet.";
}

/** An edge's label with typographic quotes and no space inside them: `Tap " Add"` -> `Tap “Add”`. */
export function quoteLabel(label: string): string {
  return label.replace(/"\s*([^"]*?)\s*"/g, "\u201c$1\u201d");
}

/** A feature's summary as the region panel shows it. The feature scan writes a count of screens
 * ("1 screen", "4 screens: overview, detail"), which the panel already says: the count goes, and
 * the kinds of screen it lists stay, labelled. */
export function featureSummaryLine(summary: string | null): string | null {
  const s = summary?.trim();
  if (!s) return null;
  const m = /^\d+\s+screens?\s*(?::\s*(.*))?$/i.exec(s);
  if (!m) return s;
  return m[1]?.trim() ? `Kinds of screen in the code: ${m[1].trim()}` : null;
}

/** Why a screen is not on the map as seen, or null when a run has seen it. */
export function whyNotSeen(node: AppMapNode): string | null {
  if (node.state === "seen") return null;
  if (node.state === "blocked") return blockedText(node) ?? "A run tried to reach it and could not.";
  const known = [node.evidence.code.length ? "the code" : null, node.evidence.tests.length ? "the existing tests" : null].filter(Boolean).join(" and ");
  return `No run has reached it yet${known ? `; it is known from ${known}` : ""}.`;
}

/** An endpoint's path prefix for grouping in the data-flow layer: `/api/listings/*` and
 * `/api/listings` both group under `/api/listings`; a leading `api` or version segment is kept
 * with the next one. */
export function endpointPrefix(node: Pick<AppMapNode, "key" | "detail">): string {
  const pattern = node.detail.pattern ?? node.key.replace(/^[A-Z]+\s+/, "");
  const segs = pattern.split(/[/?#]/).filter((s) => s && s !== "*" && !s.startsWith(":") && !/^\{.*\}$/.test(s));
  if (segs.length === 0) return "/";
  const lead = /^(api|v\d+|rest|graphql)$/i;
  let n = 1;
  while (n < segs.length && lead.test(segs[n - 1])) n++;
  return `/${segs.slice(0, n).join("/")}`;
}

/** "GET /api/listings" from an endpoint's detail, else its key. */
export function endpointTitle(node: AppMapNode): string {
  const { method, pattern } = node.detail;
  return method && pattern ? `${method} ${pattern}` : node.label;
}

/** "3 runs", "1 screen". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The frame's address, as the map gives it. */
export function frameSrc(frame: string | null): string | null {
  return frame || null;
}

// Platforms ----------------------------------------------------------------------------------

const PLATFORM_ORDER = ["web", "ios", "android", "desktop"];

/** The platforms the map's screens are on (`detail.platform`), web, iOS, Android, then any other. */
export function mapPlatforms(map: AppMap): string[] {
  const seen = new Set<string>();
  for (const n of map.nodes) if (n.kind === "screen" && n.detail.platform) seen.add(n.detail.platform);
  const rank = (p: string) => (PLATFORM_ORDER.includes(p) ? PLATFORM_ORDER.indexOf(p) : PLATFORM_ORDER.length);
  return [...seen].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Whether `map` (as one platform shows it) has what a `?feature=` / `?node=` focus names; true
 * when there is no focus. */
export function focusShows(map: AppMap, focus: { feature: string | null; node: string | null }): boolean {
  if (focus.node) return map.nodes.some((n) => n.id === focus.node);
  if (focus.feature) return map.nodes.some((n) => n.kind === "screen" && n.feature === focus.feature);
  return true;
}

/** The platform the map opens on: the sidebar's (`scope`) when the map has screens there and more
 * than one platform to choose from, else all of them (null). */
export function initialPlatform(platforms: readonly string[], scope: string | null | undefined): string | null {
  return scope && platforms.length > 1 && platforms.includes(scope) ? scope : null;
}

/**
 * The map as one platform shows it. A screen stays when it is on `platform` or says no platform
 * (an Expo screen no run has seen). An endpoint, entity or flow stays unless everything it is tied
 * to is gone: an endpoint only the dropped screens call, an entity only they (or their endpoints)
 * read and write, a flow whose steps are all elsewhere. A feature left with no screen goes too.
 * `null` is every platform: the map as it is.
 */
export function filterByPlatform(map: AppMap, platform: string | null): AppMap {
  if (!platform) return map;
  const keep = new Set<string>();
  const screens = map.nodes.filter((n) => n.kind === "screen");
  for (const n of screens) if (!n.detail.platform || n.detail.platform === platform) keep.add(n.id);
  const kindOf = new Map(map.nodes.map((n) => [n.id, n.kind]));
  /** Whether `id` is tied (by `kinds` edges, to nodes of a kind in `among`) to nothing, or to
   * something kept. */
  const tiedKept = (id: string, kinds: readonly EdgeKind[], among: readonly string[]) => {
    let tied = false;
    for (const e of map.edges) {
      if (!kinds.includes(e.kind)) continue;
      const other = e.to === id ? e.from : e.from === id ? e.to : null;
      if (!other || !among.includes(kindOf.get(other) ?? "")) continue;
      if (keep.has(other)) return true;
      tied = true;
    }
    return !tied;
  };
  for (const n of map.nodes) if (n.kind === "endpoint" && tiedKept(n.id, ["calls"], ["screen"])) keep.add(n.id);
  for (const n of map.nodes) if (n.kind === "entity" && tiedKept(n.id, ["reads", "writes"], ["screen", "endpoint"])) keep.add(n.id);
  for (const n of map.nodes) if (n.kind === "flow" && tiedKept(n.id, ["steps"], ["screen"])) keep.add(n.id);
  const nodes = map.nodes.filter((n) => keep.has(n.id));
  const edges = map.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  const kept = nodes.filter((n) => n.kind === "screen");
  const had = new Set(screens.map((n) => n.feature));
  const has = new Set(kept.map((n) => n.feature));
  const features = map.features.filter((f) => has.has(f.key) || !had.has(f.key));
  const count = (kind: string, state?: string) => nodes.filter((n) => n.kind === kind && (!state || n.state === state)).length;
  return {
    ...map,
    features,
    nodes,
    edges,
    counts: {
      features: features.length,
      screens: kept.length,
      seen: count("screen", "seen"),
      declared: count("screen", "declared"),
      blocked: count("screen", "blocked"),
      // One platform's map: nothing to split.
      platforms: {},
      endpoints: count("endpoint"),
      entities: count("entity"),
      flows: count("flow"),
      edges: edges.length,
    },
  };
}

// Reading at a distance ------------------------------------------------------------------------

/** The zoom in quarter steps of a doubling, so text that follows the zoom re-renders a few times
 * per doubling rather than on every frame of a pinch. */
export function zoomStep(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.round(2 ** (Math.round(Math.log2(zoom) * 4) / 4) * 1000) / 1000;
}

/** An average glyph of the UI font, in ems: what the sizing below plans with. */
const GLYPH_EM = 0.6;
const FAR_TITLE_PX = 17;
const FAR_PAD_X = 40;
const FAR_PAD_Y = 28;
const FAR_TITLE_LINES = 3;

export interface FarTitle {
  /** The title's size in canvas units; the meta line is about half of it. */
  size: number;
  /** How many lines the title wraps to at that size (never more than three). */
  lines: number;
}

/** How many lines `label` wraps to at `size` in `room` canvas units, word by word. */
export function titleLines(label: string, size: number, room: number): number {
  const words = label.split(/\s+/).filter(Boolean);
  const glyph = size * GLYPH_EM;
  let lines = 1;
  let used = 0;
  for (const w of words) {
    const len = w.length * glyph;
    const need = used === 0 ? len : used + glyph + len;
    if (need <= room || used === 0) used = need;
    else {
      lines++;
      used = len;
    }
  }
  return lines;
}

/**
 * A region's zoomed-out title, sized the way a map labels a country: about 17 px on screen
 * whatever the zoom, smaller only where the region is too small for that, and never cut: the
 * longest word fits a line, the title wraps to three lines at most, and title, meta line and bar
 * fit the region's height.
 */
export function farTitle(label: string, w: number, h: number, zoom: number): FarTitle {
  const room = Math.max(40, w - 2 * FAR_PAD_X);
  const longest = Math.max(3, ...label.split(/\s+/).map((s) => s.length));
  let size = Math.min(FAR_TITLE_PX / Math.max(zoom, 0.01), 220, room / (longest * GLYPH_EM));
  size = Math.max(size, 12);
  for (let i = 0; i < 60; i++) {
    const lines = titleLines(label, size, room);
    // Title lines, the meta line (0.45 em, 1.3 high), the bar and the gaps between them.
    const tall = lines * size * 1.08 + size * 0.45 * 1.3 + size * 0.18 + size * 0.5 + 2 * FAR_PAD_Y;
    if ((lines <= FAR_TITLE_LINES && tall <= h) || size <= 12) return { size: Math.round(size), lines };
    size *= 0.92;
  }
  return { size: 12, lines: titleLines(label, 12, room) };
}

/** A region's title in the middle distance and close up: 22 canvas units close up, growing a
 * little as the camera pulls back so it stays readable before the zoomed-out view takes over. */
export function nearTitleSize(zoom: number): number {
  return Math.round(Math.min(30, Math.max(22, 12 / Math.max(zoom, 0.01))));
}

/** `text` cut to `max` characters with an ellipsis, at a word when one ends near the cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const PLATFORM_LABEL: Record<string, string> = { web: "Web", ios: "iOS", android: "Android", desktop: "Desktop" };

/** "iOS", "Web": a platform's name as the sidebar says it. */
export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

/** How much of a frame's top is the device's status bar (the time, the island, the battery), as
 * a share of its height: about 6.5% of an iPhone frame and 4.5% of an Android one; nothing for a
 * web or desktop frame or anything not phone-shaped. The card crops it, so a screen starts at its
 * content. */
export function statusBarCrop(width: number, height: number, platform: string | null | undefined): number {
  if (platform === "web" || platform === "desktop") return 0;
  if (!(width > 0) || height / width < 1.6) return 0;
  return platform === "android" ? 0.045 : 0.065;
}

/** Where a screen is known from, for a card no run has reached: "from code", "from code · tests". */
export function knownFrom(node: AppMapNode): string | null {
  const s = nodeSources(node).filter((x) => x !== "live");
  return s.length ? `from ${s.join(" · ")}` : null;
}
