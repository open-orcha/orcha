import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeMarker,
  type Node,
} from "@xyflow/react";
import { ChevronLeft, ChevronRight, Expand, FileCode2, FlaskConical, Pause, Play, Radio, RotateCcw } from "./kit/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import cov from "./coverage.module.css";
import { fogStyle, paintFog } from "./fog-paint";
import { cn, useDarkTheme, usePrefersReducedMotion } from "./kit";
import { dropCovered, isCovered } from "./coverage-model";
import { DetailPanel, type Selection } from "./detail-panel";
import {
  dataNeighbours,
  edgeLabels,
  edgeWidth,
  featureFocus,
  fogPatches,
  labelObstacles,
  layoutDataFlow,
  layoutScreens,
  linkPlan,
  navWidth,
  placeLabels,
  routeBetween,
  routeMidpoint,
  screenEdgePlan,
  screenOrder,
  tourStops,
  type EdgeFocus,
  type LabelCandidate,
  type Rect,
  type ScreensLayout,
} from "./layout";
import { UncoveredChip, useApplyUrlFocus, useMapUrlFocus } from "./map-coverage";
import { SpeedChip, SpeedLegend, useSpeedHeat, type HeatMark } from "./map-speed";
import { mapEdgeTypes, type MapEdgeData } from "./map-edge";
import { mapNodeTypes, type BandData, type DataGroupData, type FogData, type NoteData, type PillData, type PortNodeData, type PrefixData, type RegionNodeData, type ScreenCardData } from "./map-nodes";
import type { QueueMark } from "./live-reveal";
import {
  edgePasses,
  flowsOf,
  litNodes,
  lodFor,
  plural,
  splitFlows,
  unlinkedReason,
  type FlowEntry,
  type Layer,
} from "./model";
import { useMapActions, useMapHrefs } from "./map-actions";
import { usePanelMode } from "./panel-state";
import styles from "./app-map.module.css";
import { EVIDENCE_SOURCES, SOURCE_LABEL, type AppMap, type AppMapNode, type EvidenceSource } from "./types";

const SPEEDS = [1, 2, 4] as const;
/** Time the camera rests on a region, and on a screen, before the speed multiplier. */
const TOUR_REGION_MS = 2600;
const TOUR_SCREEN_MS = 1700;
/** The side panel's width plus its margin, on a wide window: docked, collapsed to its rail, or
 * full (over the whole canvas, so the camera centres as if there were none). */
const PANEL_PX = { docked: 404, collapsed: 68, full: 0 } as const;
/** The fog is painted at a fifth of the canvas size: it is a blur anyway. */
const FOG_SCALE = 0.2;
/** The toolbar strip over the canvas (layers, evidence), which the canvas starts under. */
const STRIP_PX = 44;

/** The fog over the screens layer as one painted bitmap (coverage `fog-paint.ts`), repainted
 * when the layout or the theme changes; old blob URLs are revoked. */
function useFog(box: React.RefObject<HTMLElement | null>, layout: ScreensLayout, nodes: ReadonlyMap<string, AppMapNode>, dark: boolean): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const patches = useMemo(() => fogPatches(layout, nodes), [layout, nodes]);
  const key = patches.map((p) => `${p.x},${p.y},${p.w},${p.h},${p.fog}`).join("|");
  useEffect(() => {
    if (!box.current || patches.length === 0 || layout.width <= 0) return;
    let alive = true;
    let url: string | null = null;
    // The coverage palette's fog token, light or dark; nothing to paint with outside the palette.
    const color = getComputedStyle(box.current).getPropertyValue("--cov-fog").trim();
    if (!color) return;
    const scaled = patches.map((p) => ({ x: p.x * FOG_SCALE, y: p.y * FOG_SCALE, w: p.w * FOG_SCALE, h: p.h * FOG_SCALE, fog: p.fog }));
    void paintFog(scaled, layout.width * FOG_SCALE, layout.height * FOG_SCALE, fogStyle(dark, color, true)).then((u) => {
      url = u;
      if (alive) setSrc(u);
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      alive = false;
      // Revoked after the next paint has replaced it, so the fog never blinks.
      setTimeout(() => {
        if (url) URL.revokeObjectURL(url);
      }, 1500);
    };
    // `key` stands for the patches; `box` is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dark, layout.width, layout.height]);
  // A map with nothing in the fog shows none, even while an older paint is still held.
  return patches.length > 0 ? src : null;
}

/** Whether the side panel sits beside the canvas (a wide window) rather than over it. */
function wide(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
}

function arrow(color: string, size = 16): EdgeMarker {
  return { type: MarkerType.ArrowClosed, width: size, height: size, color, markerUnits: "userSpaceOnUse" };
}

function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/**
 * The app map's canvas: the screens layer (features as regions, screens inside by navigation
 * depth, fog over what no run reached), the data-flow layer (screens, endpoints, entities) and
 * the tests layer (a picked test's flow lit over the screens). Zoom picks the level of detail;
 * the evidence chips dim what a source does not know; Play tours the features. `overlay` sits
 * over the canvas (the building card during a rebuild). `reveal`, during a Map the app crawl: the
 * screens it just reached (they pulse) and the one the camera follows. `onSelect` hears the node
 * picked, and `selected` (the URL's `?screen=`) moves the selection from outside.
 */
export function AppMapView(props: { map: AppMap; overlay?: ReactNode; reveal?: MapViewReveal; selected?: string | null; onSelect?: (id: string | null) => void }) {
  return (
    <ReactFlowProvider>
      <MapInner {...props} />
    </ReactFlowProvider>
  );
}

/** A crawl's live reveal (`use-map-crawl.ts`). */
export interface MapViewReveal {
  fresh: ReadonlySet<string>;
  /** The screen the camera follows; null when Follow is off. */
  follow: string | null;
  /** A planned crawl's queue by screen key (`queueMarks`): the target it is on and the next ones. */
  queue?: ReadonlyMap<string, QueueMark>;
}

function MapInner({
  map,
  overlay,
  reveal,
  selected: selectedParam = null,
  onSelect,
}: {
  map: AppMap;
  overlay?: ReactNode;
  reveal?: MapViewReveal;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
}) {
  const flow = useReactFlow();
  const { platform } = useMapActions();
  const speedHref = useMapHrefs().slowest();
  const reduced = usePrefersReducedMotion();
  const dark = useDarkTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const lod = useStore((s) => lodFor(s.transform[2]));

  const [layer, setLayer] = useState<Layer>("screens");
  const [evidence, setEvidence] = useState<ReadonlySet<EvidenceSource>>(() => new Set(EVIDENCE_SOURCES));
  // `?screen=` opens the panel at once; the camera flies there when the canvas is ready.
  const urlFocus = useMapUrlFocus();
  const [selection, setSelection] = useState<Selection | null>(() => (urlFocus.node && map.nodes.some((n) => n.id === urlFocus.node) ? { kind: "node", id: urlFocus.node } : null));
  /** The panel's frame (docked, full, collapsed), remembered per viewer; picking keeps it. */
  const [panelMode, setPanelMode] = usePanelMode();
  const panelPx = useRef<number>(PANEL_PX[panelMode]);
  useEffect(() => {
    panelPx.current = PANEL_PX[panelMode];
  }, [panelMode]);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [tourIndex, setTourIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [intro, setIntro] = useState(true);
  /** The summary cards the reader opened (`AREAS_REGION`, `OTHER_REGION`). */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [hover, setHover] = useState<{ node?: string; region?: string; port?: string; edge?: string } | null>(null);

  /** Where the camera goes once the layout has changed: a screen (or a data-flow node) just
   * opened out of a summary card or group, a feature's region just opened out of "Other areas"
   * (selected), or the regions of a group just opened or folded. */
  const pendingFocus = useRef<{ node?: string; data?: boolean; group?: string; region?: string } | null>(null);
  const toggleGroup = useCallback((group: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
    // A selected region may be about to disappear into (or out of) the group.
    setSelection((s) => (s?.kind === "region" ? null : s));
    setHover(null);
    pendingFocus.current = { group };
  }, []);
  /** The data-flow groups the reader opened (by group id); the others stay folded. */
  const [dataOpen, setDataOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggleDataGroup = useCallback((id: string) => {
    setDataOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setHover(null);
  }, []);
  // "Uncovered": dim what a scenario already covers.
  const [uncovered, setUncovered] = useState(false);
  // "Speed": colour each screen by how fast it appears, from Slowest screens.
  const [speedOn, setSpeedOn] = useState(false);
  const heat = useSpeedHeat(map.project_id, speedOn, platform);

  const nodesById = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map]);
  const screens = useMemo(() => layoutScreens(map, { expanded }), [map, expanded]);
  const data = useMemo(() => layoutDataFlow(map, screenOrder(screens), { expanded: dataOpen }), [map, screens, dataOpen]);
  const lit = useMemo(() => (uncovered ? dropCovered(litNodes(map, evidence), map) : litNodes(map, evidence)), [map, evidence, uncovered]);
  const flows = useMemo(() => flowsOf(map), [map]);
  const stops = useMemo(() => tourStops(screens, nodesById), [screens, nodesById]);
  const fog = useFog(containerRef, screens, nodesById, dark);
  const regionsByKey = useMemo(() => new Map(screens.regions.map((r) => [r.key, r])), [screens]);

  const picked = layer === "tests" ? (flows.find((f) => f.flow.id === flowId) ?? null) : null;
  const stepOf = useMemo(() => {
    const m = new Map<string, number>();
    picked?.steps.forEach((s, i) => {
      if (!m.has(s.id)) m.set(s.id, i + 1);
    });
    return m;
  }, [picked]);

  const touring = tourIndex >= 0;
  const stop = touring ? stops[Math.min(tourIndex, stops.length - 1)] : null;
  const selectedId = selection?.kind === "node" ? selection.id : stop?.kind === "screen" ? stop.id : null;
  const selectedRegion = selection?.kind === "region" ? selection.key : stop?.kind === "region" ? stop.id : null;

  // Data flow: what is hovered (else picked) lights its links and the ends they reach; the rest
  // fades. A node folded into a group speaks through the group.
  const dataFocus = useMemo(() => {
    if (layer !== "data") return null;
    const id = hover?.node ?? (selectedId ? (data.holder.get(selectedId) ?? selectedId) : null);
    if (!id || !(data.pills.has(id) || data.groups.some((g) => g.id === id && g.collapsed))) return null;
    return dataNeighbours(data.links, id);
  }, [layer, hover, selectedId, data]);
  // A folded map's summed links say how many edges they stand for, where the words fit: for what
  // is in focus, or for all of them when there are only a few.
  const dataLabels = useMemo(() => {
    if (layer !== "data" || !(data.folded.screens || data.folded.endpoints)) return new Map();
    if (!dataFocus && data.links.length > 12) return new Map();
    const noun = { calls: "call", reads: "read", writes: "write" } as const;
    const candidates: LabelCandidate[] = data.links.flatMap((l) => {
      const route = data.routes.get(l.id);
      if (!route || l.count < 2 || (dataFocus && !dataFocus.links.has(l.id))) return [];
      return [{ id: l.id, text: plural(l.count, noun[l.kind]), at: routeMidpoint(route), priority: dataFocus ? 0 : 1 / (1 + l.count) }];
    });
    return placeLabels(candidates, [...data.pills.values(), ...data.groups]);
  }, [layer, data, dataFocus]);

  // The entrance stagger plays once; cards that return on zooming in just rise.
  useEffect(() => {
    const t = window.setTimeout(() => setIntro(false), 2600);
    return () => window.clearTimeout(t);
  }, []);

  const nodes: Node[] = useMemo(() => {
    const box = (r: Rect) => ({ position: { x: r.x, y: r.y }, width: r.w, height: r.h, measured: { width: r.w, height: r.h }, draggable: false });
    if (layer === "data") {
      const out: Node[] = [];
      const near = (id: string) => !dataFocus || dataFocus.ends.has(id);
      const heldBySelected = selectedId ? data.holder.get(selectedId) : undefined;
      for (const b of data.bands) out.push({ id: `band:${b.key}`, type: "band", ...box(b), zIndex: 0, selectable: false, focusable: false, data: { band: b.key, quiet: b.key === "endpoints" && data.note !== null } satisfies BandData });
      // Over the screen-to-data edges that pass through the empty endpoints band.
      if (data.note) out.push({ id: "note:no-backend", type: "note", ...box(data.note), zIndex: 4, selectable: false, focusable: false, data: { text: "No backend calls seen: this app keeps its data on the device" } satisfies NoteData });
      let i = 0;
      for (const g of data.groups) {
        if (!g.collapsed) {
          out.push({ id: g.id, type: "prefix", ...box(g), zIndex: 1, selectable: false, focusable: false, data: { label: g.label, count: g.count, fold: g.foldable ? g.id : null, band: g.band } satisfies PrefixData });
          continue;
        }
        out.push({
          id: g.id,
          type: "dataGroup",
          ...box(g),
          zIndex: 3,
          data: { group: g, lit: g.members.some((m) => lit.has(m)) && near(g.id), active: hover?.node === g.id || heldBySelected === g.id, delay: reduced || !intro ? 0 : Math.min(i++ * 30, 900) } satisfies DataGroupData,
        });
      }
      for (const [id, r] of data.pills) {
        const node = nodesById.get(id);
        if (!node) continue;
        out.push({ id, type: "pill", ...box(r), zIndex: 3, data: { node, lit: lit.has(id) && near(id), selected: selectedId === id, delay: reduced || !intro ? 0 : Math.min(i++ * 30, 900) } satisfies PillData });
      }
      return out;
    }
    const out: Node[] = [];
    const cardsIn = new Map<string, string[]>();
    for (const c of screens.cards.values()) cardsIn.set(c.region, [...(cardsIn.get(c.region) ?? []), c.id]);
    for (const r of screens.regions) {
      const ids = cardsIn.get(r.key) ?? [];
      const regionLit = ids.length === 0 ? evidence.size >= 3 : ids.some((id) => lit.has(id) && (!picked || stepOf.has(id)));
      // Over the fog and the edges between regions (see-through tints, so both show and the names
      // stay on top), under a region's own edges and the cards.
      // With Speed on, a region carries its timed screens' heat: from afar the cards are not drawn.
      const marks = heat ? ids.map((id) => heat.get(nodesById.get(id)?.key ?? "")).filter((m): m is HeatMark => Boolean(m)) : [];
      const regionHeat = heat ? { slow: marks.filter((m) => m.heat === "slow").length, warm: marks.filter((m) => m.heat === "warm").length, ok: marks.filter((m) => m.heat === "ok").length } : null;
      out.push({ id: `region:${r.key}`, type: "region", ...box(r), zIndex: 2, selectable: false, data: { region: r, lit: regionLit, selected: selectedRegion === r.key, heat: regionHeat } satisfies RegionNodeData });
    }
    // The fog reads from afar, under the regions; closer in, a screen no run has reached is a
    // ghost card instead, and nothing blurs behind the cards.
    if (fog && lod === "far") {
      out.push({
        id: "fog",
        type: "fog",
        ...box({ x: 0, y: 0, w: screens.width, h: screens.height }),
        zIndex: 0,
        selectable: false,
        focusable: false,
        style: { pointerEvents: "none" },
        data: { src: fog } satisfies FogData,
      });
    }
    let i = 0;
    for (const c of screens.cards.values()) {
      const node = nodesById.get(c.id);
      if (!node) continue;
      out.push({
        id: c.id,
        type: "screen",
        ...box(c),
        zIndex: 4,
        hidden: lod === "far",
        data: {
          node,
          lit: lit.has(c.id) && (!picked || stepOf.has(c.id)),
          selected: selectedId === c.id,
          flowStep: stepOf.get(c.id) ?? null,
          delay: reduced || !intro ? 0 : Math.min(i++ * 45, 1400),
          revealed: reveal?.fresh.has(c.id) ?? false,
          crawl: reveal?.queue?.get(node.key) ?? null,
          heat: heat?.get(node.key) ?? null,
        } satisfies ScreenCardData,
      });
    }
    // Each region's ports to the others, on its bottom border, over everything.
    if (lod !== "far") {
      const focusNode = hover?.node ?? (selectedId && screens.cards.has(selectedId) ? selectedId : null);
      for (const p of screens.ports) {
        const regionLit = (cardsIn.get(p.region) ?? []).some((id) => lit.has(id));
        const mine = focusNode !== null && p.bundles.some((b) => {
          const bundle = screens.bundles.get(b);
          return bundle ? bundle.from === focusNode || bundle.to === focusNode : false;
        });
        out.push({
          id: p.id,
          type: "port",
          ...box(p),
          zIndex: 5,
          selectable: false,
          data: { port: p, active: hover?.port === p.id || mine, lit: regionLit && !picked } satisfies PortNodeData,
        });
      }
    }
    return out;
  }, [layer, data, dataFocus, hover, screens, nodesById, lit, evidence, selectedId, selectedRegion, fog, lod, picked, stepOf, reduced, intro, reveal, heat]);

  // Which screen edges show: the region links from afar; closer in each region's own edges, and the
  // ones between regions for what is hovered or picked. A hovered screen or feature leads.
  const focus: EdgeFocus = useMemo(() => {
    const port = hover?.port ?? null;
    const node = port ? null : (hover?.node ?? (selectedId && screens.cards.has(selectedId) ? selectedId : null));
    const region = hover?.region ?? (node ? (screens.cards.get(node)?.region ?? null) : null) ?? selectedRegion;
    return { node, region, port };
  }, [hover, selectedId, selectedRegion, screens]);
  const edgePlan = useMemo(() => (layer === "data" || lod === "far" ? null : screenEdgePlan(screens, focus)), [layer, lod, screens, focus]);
  const linksPlan = useMemo(() => (layer !== "data" && lod === "far" ? linkPlan(screens.links, focus.region) : null), [layer, lod, screens, focus]);
  const obstacles = useMemo(() => labelObstacles(screens), [screens]);
  // Labels only close up, only on the lines in focus or the one hovered, and only where they fit:
  // at rest the map carries no free-floating words.
  const labels = useMemo(() => (!edgePlan || lod !== "near" ? new Map() : edgeLabels(screens, edgePlan.shown, hover?.edge ?? null, obstacles)), [edgePlan, lod, screens, obstacles, hover]);
  const hiddenLinks = edgePlan?.hidden ?? linksPlan?.hidden ?? 0;

  const edges: Edge[] = useMemo(() => {
    if (layer === "data") {
      const byId = new Map(map.edges.map((e) => [e.id, e]));
      // A folded map keeps its particles for what is in focus, so the summed links stay calm.
      const calm = data.folded.screens || data.folded.endpoints;
      return data.links.flatMap((l): Edge[] => {
        const route = data.routes.get(l.id);
        if (!route) return [];
        const passes = l.edges.some((id) => {
          const e = byId.get(id);
          return e ? edgePasses(e, { from: lit.has(e.from), to: lit.has(e.to) }, evidence) : false;
        });
        const active = dataFocus?.links.has(l.id) ?? false;
        const color = active ? "var(--map-line-active)" : "var(--color-edge)";
        return [
          {
            id: l.id,
            source: l.from,
            target: l.to,
            type: "map",
            zIndex: 2,
            // Reads point up, from the data to whoever reads it.
            markerEnd: l.kind === "reads" ? undefined : arrow(color, 14),
            markerStart: l.kind === "reads" ? arrow(color, 14) : undefined,
            data: {
              route,
              tone: l.kind,
              flowing: false,
              particles: reduced || (calm && !active) ? 0 : l.weight > 3 ? 2 : 1,
              reverse: l.kind === "reads",
              dim: !passes || (dataFocus !== null && !active),
              active,
              width: active ? edgeWidth(l.weight) + 1 : edgeWidth(l.weight),
              label: dataLabels.get(l.id) ?? null,
            } satisfies MapEdgeData,
          },
        ];
      });
    }
    if (linksPlan) {
      // Faint, the busiest pairs only, under the regions so the names stay on top.
      return linksPlan.shown.map(({ link: l, look }): Edge => {
        const color = look === "active" ? "var(--map-line-active)" : "color-mix(in srgb, var(--color-muted) 55%, transparent)";
        return {
          id: `link:${l.id}`,
          source: `region:${l.from}`,
          target: `region:${l.to}`,
          type: "map",
          zIndex: 1,
          markerEnd: arrow(color, 32),
          markerStart: l.both ? arrow(color, 32) : undefined,
          data: { route: l.route, tone: "link", width: Math.min(14, edgeWidth(l.count) * 2.5) + (look === "active" ? 2 : 0), flowing: !reduced && look === "active", particles: 0, dim: look === "dim", active: look === "active", label: null } satisfies MapEdgeData,
        };
      });
    }
    const byId = new Map(map.edges.map((e) => [e.id, e]));
    // Thin, neutral and calm at rest; the lines of what is in focus in the map's line colour, 2 px,
    // with a small arrowhead, drawn last so they sit on top. Dashed only for a way the code knows
    // and no run or test has taken.
    const shown = [...(edgePlan?.shown ?? [])].reverse();
    const out: Edge[] = shown.flatMap((s): Edge[] => {
      const b = screens.bundles.get(s.bundle);
      if (!b) return [];
      const members = b.edges.flatMap((id) => byId.get(id) ?? []);
      const active = s.look === "active" || hover?.edge === s.id;
      const passes = members.some((e) => edgePasses(e, { from: lit.has(e.from), to: lit.has(e.to) }, evidence));
      const covered = members.length > 0 && members.every((e) => e.covered === true);
      const port = s.part === "inner" ? null : screens.crossRoutes.get(b.id)?.ports[s.part === "out" ? 0 : 1];
      return [
        {
          id: s.id,
          source: s.part === "in" ? port! : b.from,
          target: s.part === "out" ? port! : b.to,
          type: "map",
          // Over the region's tint, under the cards and the ports.
          zIndex: 3,
          markerEnd: arrow(active ? "var(--map-line-active)" : "var(--map-line-head)", active ? 9 : 7),
          data: {
            route: s.route,
            tone: s.cross ? "cross" : "nav",
            width: navWidth(b.count, active),
            flowing: false,
            particles: 0,
            dim: Boolean(picked) || s.look === "dim" || (uncovered && covered) || !passes,
            active,
            dashed: b.fromCode,
            label: null,
            title: b.label ? `${b.label}${b.more ? ` (+${b.more} more)` : ""}` : null,
          } satisfies MapEdgeData,
        },
      ];
    });
    // The labels last, over every line.
    for (const s of shown) {
      const label = labels.get(s.id);
      const b = screens.bundles.get(s.bundle);
      if (!label || !b) continue;
      const port = s.part === "inner" ? null : screens.crossRoutes.get(b.id)?.ports[s.part === "out" ? 0 : 1];
      out.push({
        id: `label:${s.id}`,
        source: s.part === "in" ? port! : b.from,
        target: s.part === "out" ? port! : b.to,
        type: "map",
        zIndex: 3,
        focusable: false,
        data: { route: s.route, tone: "nav", width: 0, flowing: false, particles: 0, dim: false, active: s.look === "active", label, labelOnly: true } satisfies MapEdgeData,
      });
    }
    if (picked) {
      picked.steps.forEach((s, i) => {
        const next = picked.steps[i + 1];
        const route = next ? routeBetween(screens, s.id, next.id) : null;
        if (!next || !route) return;
        out.push({
          id: `flow:${picked.flow.id}:${i}`,
          source: s.id,
          target: next.id,
          type: "map",
          // Under the regions like any edge between them: the flow is bold enough through a tint.
          zIndex: 1,
          markerEnd: arrow("var(--color-primary)", 18),
          data: { route, tone: "flow", width: 4, flowing: false, particles: 0, dim: false, active: true, label: null, delay: reduced ? 0 : i * 700 + 350 } satisfies MapEdgeData,
        });
      });
    }
    return out;
  }, [layer, map, data, dataFocus, dataLabels, screens, lit, evidence, picked, reduced, linksPlan, edgePlan, labels, hover, uncovered]);

  // Camera ---------------------------------------------------------------------------------

  /** Fit `rect` in the canvas (beside the panel when it is open), no closer than `maxZoom`. */
  const focusRect = useCallback(
    (rect: Rect, maxZoom: number, duration = 900, panel = false) => {
      const el = containerRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const side = panel && wide() ? panelPx.current : 0;
      // The canvas starts under the toolbar strip.
      const zoom = Math.max(0.03, Math.min(maxZoom, (width - side - 80) / Math.max(1, rect.w), (height - STRIP_PX - 96) / Math.max(1, rect.h)));
      void flow.setCenter(rect.x + rect.w / 2 + side / 2 / zoom, rect.y + rect.h / 2, { zoom, duration: reduced ? 0 : duration });
    },
    [flow, reduced],
  );

  const fitAll = useCallback(
    (duration = 900, panel = false) => {
      void flow.fitView({ padding: { top: "40px", bottom: "48px", left: "40px", right: panel && wide() ? `${panelPx.current + 24}px` : "40px" }, duration: reduced ? 0 : duration });
    },
    [flow, reduced],
  );

  // The whole map stays in view until the reader takes the camera. The first view waits until
  // React Flow has the nodes and the canvas has its size, then fits the whole map (or flies to
  // the URL's focus); while the reader has not moved, a resize or a map that grows (a build
  // revealing source by source) fits it again.
  const autoFit = useRef(true);
  const introDone = useRef(false);
  const nodesReady = useNodesInitialized();
  const [boxSize, setBoxSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      setBoxSize((b) => (b && b.w === width && b.h === height ? b : { w: width, h: height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const measured = nodesReady && boxSize !== null && boxSize.w > 0 && boxSize.h > STRIP_PX;
  const hasUrlFocus = Boolean(urlFocus.node || urlFocus.feature);
  useEffect(() => {
    if (!measured || introDone.current) return;
    introDone.current = true;
    // The URL's focus flies there instead (`useApplyUrlFocus`), and fits all when it is gone. It
    // takes the camera: React Flow runs a fit queued now after that flight and would undo it.
    if (!hasUrlFocus) fitAll(0);
    else autoFit.current = false;
  }, [measured, hasUrlFocus, fitAll]);
  const contentSize = layer === "data" ? `${data.width}x${data.height}` : `${screens.width}x${screens.height}`;
  useEffect(() => {
    if (autoFit.current && introDone.current) fitAll(300);
    // Only a new canvas size or a map that grew or shrank refits, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxSize, contentSize]);

  // A layer picked from the toolbar is fitted once its nodes are in React Flow's store (its own
  // effects run before this one). A layer switched to show one node flies there instead.
  const fitLayer = useRef(false);
  const hasPanel = selection !== null;
  useEffect(() => {
    if (!fitLayer.current) return;
    fitLayer.current = false;
    fitAll(700, hasPanel);
  }, [layer, fitAll, hasPanel]);

  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    autoFit.current = false;
    if (p.node) {
      const rect = p.data ? data.pills.get(p.node) : screens.cards.get(p.node);
      if (rect) focusRect(rect, p.data ? 1.2 : 1.05, 900, true);
      return;
    }
    if (p.region) {
      const r = screens.regions.find((x) => x.key === p.region);
      if (r) focusRect(r, 0.95, 900, true);
      return;
    }
    const rect = boundsOf(screens.regions.filter((r) => r.key === p.group || r.fold === p.group));
    if (rect) focusRect(rect, 0.95, 900);
  }, [screens, data, focusRect]);

  const changeLayer = useCallback(
    (next: Layer) => {
      if (next === layer) return;
      fitLayer.current = true;
      setLayer(next);
      setPlaying(false);
      setTourIndex(-1);
      if (next === "tests" && !flowId && flows[0]) setFlowId(flows[0].flow.id);
    },
    [layer, flowId, flows],
  );

  /** Select a node and fly to it, switching to the layer that shows it. */
  const go = useCallback(
    (id: string) => {
      const n = nodesById.get(id);
      if (!n) return;
      setPlaying(false);
      setTourIndex(-1);
      autoFit.current = false;
      setSelection({ kind: "node", id });
      let target: Layer = layer;
      if (n.kind === "endpoint" || n.kind === "entity") target = "data";
      else if (n.kind === "flow") target = "tests";
      else if (layer === "data" && !data.pills.has(id) && !data.holder.has(id)) target = "screens";
      if (n.kind === "flow") setFlowId(id);
      if (target !== layer) setLayer(target);
      // A node folded into a data-flow group: open the group, then fly once the layout has it.
      const group = target === "data" ? data.holder.get(id) : undefined;
      if (group) {
        pendingFocus.current = { node: id, data: true };
        setDataOpen((prev) => new Set(prev).add(group));
        return;
      }
      // A screen inside a summary card: open the card, then fly once the layout has it.
      const holder = n.kind === "screen" && target !== "data" && !screens.cards.has(id) ? regionsByKey.get(screens.regionOf.get(id) ?? "") : undefined;
      if (holder?.collapsed) {
        pendingFocus.current = { node: id };
        setExpanded((prev) => new Set(prev).add(holder.key));
        return;
      }
      const flowRect = n.kind === "flow" ? boundsOf(flows.find((f) => f.flow.id === id)?.steps.flatMap((s) => screens.cards.get(s.id) ?? []) ?? []) : null;
      const rect = flowRect ?? (target === "data" ? data.pills.get(id) : screens.cards.get(id));
      if (rect) window.requestAnimationFrame(() => focusRect(rect, n.kind === "flow" ? 0.8 : target === "data" ? 1.2 : 1.05, 900, true));
    },
    [nodesById, layer, data, screens, flows, focusRect, regionsByKey],
  );

  const goRegion = useCallback(
    (key: string) => {
      const r = regionsByKey.get(key);
      if (!r) return;
      setPlaying(false);
      setTourIndex(-1);
      autoFit.current = false;
      setSelection({ kind: "region", key });
      if (layer === "data") setLayer("screens");
      window.requestAnimationFrame(() => focusRect(r, 0.95, 900, true));
    },
    [regionsByKey, layer, focusRect],
  );

  /** `?feature=`: a feature of one screen opens that screen's panel; else its region, opening the
   * summary card it is folded into first. A feature the map does not have fits the whole map. */
  const goFeature = useCallback(
    (key: string) => {
      const f = featureFocus(map, screens, key);
      if (!f) {
        fitAll(0);
        return;
      }
      if (f.kind === "screen") {
        go(f.id);
        return;
      }
      if (!f.open) {
        goRegion(f.key);
        return;
      }
      setPlaying(false);
      setTourIndex(-1);
      autoFit.current = false;
      if (layer === "data") setLayer("screens");
      setSelection({ kind: "region", key: f.key });
      pendingFocus.current = { region: f.key };
      setExpanded((prev) => new Set(prev).add(f.open!));
    },
    [map, screens, fitAll, go, goRegion, layer],
  );
  const goUrlNode = useCallback((id: string) => (nodesById.has(id) ? go(id) : fitAll(0)), [nodesById, go, fitAll]);
  useApplyUrlFocus(urlFocus, measured, goUrlNode, goFeature);

  const closePanel = useCallback(() => {
    setSelection(null);
    fitAll(900);
  }, [fitAll]);

  // The selected node stays in the URL (`?screen=`): what the panel shows is written there, and a
  // new address from outside (a link, Back) moves the panel.
  const selectedNode = selection?.kind === "node" ? selection.id : null;
  const inUrl = useRef(selectedParam);
  const lastNode = useRef(selectedNode);
  useEffect(() => {
    if (selectedNode === lastNode.current) return;
    lastNode.current = selectedNode;
    if (selectedNode === inUrl.current) return;
    inUrl.current = selectedNode;
    onSelect?.(selectedNode);
  }, [selectedNode, onSelect]);
  const urlRead = useRef(selectedParam);
  useEffect(() => {
    if (selectedParam === urlRead.current) return;
    urlRead.current = selectedParam;
    if (selectedParam === inUrl.current) return;
    inUrl.current = selectedParam;
    if (selectedParam) goUrlNode(selectedParam);
    else if (lastNode.current) closePanel();
  }, [selectedParam, goUrlNode, closePanel]);

  // A crawl's Follow: the camera flies to each screen it reaches, unless the reader is busy.
  const followId = reveal?.follow ?? null;
  useEffect(() => {
    if (!followId || selection || touring || layer !== "screens") return;
    const card = screens.cards.get(followId);
    if (!card) return;
    autoFit.current = false;
    focusRect(card, 0.9, 900);
    // Only a new screen to follow moves the camera, not a relayout of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followId]);

  // The tour ----------------------------------------------------------------------------------

  useEffect(() => {
    if (!playing || !touring) return;
    const rest = (stop?.kind === "region" ? TOUR_REGION_MS : TOUR_SCREEN_MS) / speed;
    const t = window.setTimeout(() => {
      if (tourIndex >= stops.length - 1) {
        setPlaying(false);
        setTourIndex(-1);
        fitAll(1600);
      } else setTourIndex((i) => i + 1);
    }, rest);
    return () => window.clearTimeout(t);
  }, [playing, touring, tourIndex, stops.length, speed, stop, fitAll]);

  useEffect(() => {
    if (!stop) return;
    focusRect(stop.rect, stop.kind === "region" ? 0.8 : 1.15, Math.max(500, 1200 / speed));
  }, [stop, focusRect, speed]);

  const play = useCallback(() => {
    if (stops.length === 0) return;
    setSelection(null);
    if (layer === "data") setLayer("screens");
    autoFit.current = false;
    if (!touring || tourIndex >= stops.length - 1) setTourIndex(0);
    setPlaying(true);
  }, [stops.length, layer, touring, tourIndex]);

  const stopTour = useCallback(() => {
    setPlaying(false);
    setTourIndex(-1);
    fitAll(1200);
  }, [fitAll]);

  const stepTour = useCallback(
    (delta: number) => {
      if (stops.length === 0) return;
      setPlaying(false);
      setSelection(null);
      if (layer === "data") setLayer("screens");
      setTourIndex((i) => Math.min(Math.max(0, (i < 0 ? 0 : i) + delta), stops.length - 1));
    },
    [stops.length, layer],
  );

  // Keyboard: space plays/pauses, arrows step the tour, F fits, Esc leaves a full-screen panel,
  // then closes it. A dialog over the map (the frame's lightbox) has the keys to itself: its Esc
  // closes it and leaves the panel as it was.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || t?.closest?.("dialog")) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!containerRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (e.key === " ") {
        e.preventDefault();
        if (playing) setPlaying(false);
        else play();
      } else if (e.key === "ArrowRight") stepTour(1);
      else if (e.key === "ArrowLeft") stepTour(-1);
      else if (e.key === "f" || e.key === "F") fitAll(900, selection !== null);
      else if (e.key === "Escape") {
        if (selection && panelMode === "full") setPanelMode("docked");
        else if (selection) closePanel();
        else if (touring) stopTour();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, play, stepTour, fitAll, selection, closePanel, touring, stopTour, panelMode, setPanelMode]);

  const toggleSource = (s: EvidenceSource) =>
    setEvidence((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      // Never nothing: turning the last one off turns all three back on.
      return next.size === 0 ? new Set(EVIDENCE_SOURCES) : next;
    });

  const SOURCE_ICON = { code: FileCode2, tests: FlaskConical, live: Radio } as const;
  const region = selection?.kind === "region" ? (regionsByKey.get(selection.key) ?? null) : null;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      // The canvas starts under the toolbar strip, so the strip never covers a card.
      style={{ paddingTop: STRIP_PX }}
      className={cn(cov.palette, styles.canvas, "xmap relative h-full min-h-0 overflow-hidden outline-none")}
      data-app-map
      data-layer={layer}
      data-lod={lod}
      data-platform={platform}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={mapNodeTypes}
        edgeTypes={mapEdgeTypes}
        // A pan or zoom by the reader (an event, not the camera's own moves) ends auto-fit.
        onMoveStart={(event) => {
          if (event) autoFit.current = false;
        }}
        onNodeClick={(event, n) => {
          // A summary card's Show and an open group's Fold buttons, inside the region node.
          const toggle = (event.target as HTMLElement).closest<HTMLElement>("[data-map-region-open], [data-map-region-fold]");
          // A data-flow group opens in place; its frame's Fold button folds it back.
          const fold = (event.target as HTMLElement).closest<HTMLElement>("[data-map-group-fold]");
          if (toggle) toggleGroup(toggle.dataset.mapRegionOpen ?? toggle.dataset.mapRegionFold ?? "");
          else if (fold || n.type === "dataGroup") {
            autoFit.current = false;
            toggleDataGroup(fold?.dataset.mapGroupFold ?? n.id);
          } else if (n.type === "region") goRegion((n.data as RegionNodeData).region.key);
          else if (n.type === "port") {
            const to = (n.data as PortNodeData).port.to;
            if (to) goRegion(to);
          }
          else if (n.type === "screen" || n.type === "pill") go(n.id);
        }}
        onPaneClick={() => (selection ? closePanel() : undefined)}
        onNodeMouseEnter={(_, n) => {
          if (n.type === "region") setHover({ region: (n.data as RegionNodeData).region.key });
          else if (n.type === "port") setHover({ port: n.id, region: (n.data as PortNodeData).port.region });
          else if (n.type === "screen" || n.type === "pill" || n.type === "dataGroup") setHover({ node: n.id });
        }}
        onNodeMouseLeave={() => setHover(null)}
        onEdgeMouseEnter={(_, e) => setHover((h) => ({ ...h, edge: e.id }))}
        onEdgeMouseLeave={() => setHover((h) => (h ? { node: h.node, region: h.region } : null))}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        minZoom={0.03}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        className="xmap-flow"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} className="!bg-transparent" />
        {selection ? null : (
          <MiniMap
            pannable
            zoomable
            className="!bottom-4 !right-4 !rounded-lg !border !border-border !bg-panel max-md:!hidden"
            nodeColor={(n) => {
              if (n.type === "screen") {
                const s = (n.data as ScreenCardData).node.state;
                return s === "seen" ? "var(--cov-strong)" : s === "blocked" ? "var(--color-warning)" : "var(--color-muted)";
              }
              return n.type === "region" || n.type === "band" ? "var(--color-panel-2)" : n.type === "fog" || n.type === "port" ? "transparent" : "var(--color-muted)";
            }}
            maskColor="color-mix(in srgb, var(--color-bg) 70%, transparent)"
          />
        )}
      </ReactFlow>

      {/* Layers and the evidence filter: a solid strip the canvas starts under */}
      <div
        className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 overflow-x-auto border-b border-border bg-panel px-4 md:pr-64 [&>*]:shrink-0"
        style={{ height: STRIP_PX }}
        data-map-toolbar
      >
        <div role="tablist" aria-label="Layer" className="inline-flex rounded-lg border border-border bg-raised p-0.5 shadow-[var(--shadow-sm)]">
          {(
            [
              ["screens", "Screens"],
              ["data", "Data flow"],
              ["tests", "Tests"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={layer === value}
              onClick={() => changeLayer(value)}
              className={cn("inline-flex h-6 items-center rounded-md px-2 text-sm transition-colors", layer === value ? "bg-selected text-fg" : "text-fg-2 hover:text-fg")}
              data-map-layer={value}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-raised p-0.5 shadow-[var(--shadow-sm)]" role="group" aria-label="Show what each source knows">
          {EVIDENCE_SOURCES.map((s) => {
            const Icon = SOURCE_ICON[s];
            const on = evidence.has(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleSource(s)}
                title={on ? `Hide what only other sources know` : `Show what ${SOURCE_LABEL[s].toLowerCase()} knows`}
                className={cn("inline-flex h-6 items-center gap-1 rounded-md px-2 text-sm transition-colors", on ? "bg-selected text-fg" : "text-muted hover:text-fg")}
                data-map-evidence-chip={s}
              >
                <Icon className="size-3.5" aria-hidden />
                {SOURCE_LABEL[s]}
              </button>
            );
          })}
        </div>
        <UncoveredChip on={uncovered} onToggle={() => setUncovered((v) => !v)} count={map.nodes.filter((n) => n.kind === "screen" && !isCovered(n)).length} />
        <SpeedChip on={speedOn} onToggle={() => setSpeedOn((v) => !v)} count={heat ? map.nodes.filter((n) => n.kind === "screen" && heat.has(n.key)).length : null} />
      </div>

      {/* Tour controls: top right on a wide canvas, bottom left on a narrow one. */}
      <div className="absolute right-4 top-1 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-raised p-0.5 shadow-sm max-md:bottom-4 max-md:left-4 max-md:right-auto max-md:top-auto max-md:shadow-md" data-map-controls>
        <IconButton label={playing ? "Pause the tour (space)" : "Play a tour of the features (space)"} onClick={playing ? () => setPlaying(false) : play}>
          {playing ? <Pause /> : <Play />}
        </IconButton>
        <IconButton label="Previous stop (←)" onClick={() => stepTour(-1)}>
          <ChevronLeft />
        </IconButton>
        <IconButton label="Next stop (→)" onClick={() => stepTour(1)}>
          <ChevronRight />
        </IconButton>
        <button
          type="button"
          onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])}
          className="h-7 rounded-md px-2 text-sm tabular text-muted hover:bg-hover hover:text-fg"
          title="Tour speed"
        >
          {speed}×
        </button>
        {touring ? (
          <IconButton label="Stop the tour (esc)" onClick={stopTour}>
            <RotateCcw />
          </IconButton>
        ) : null}
        <span className="mx-0.5 h-4 w-px bg-border" />
        <IconButton label="Fit the whole map (F)" onClick={() => fitAll(900, selection !== null)}>
          <Expand />
        </IconButton>
      </div>

      {layer === "tests" ? <FlowPicker flows={flows} picked={picked?.flow.id ?? null} onPick={go} /> : null}
      {speedOn ? <SpeedLegend marks={heat} href={speedHref} top={STRIP_PX + 12} /> : null}

      {stop ? (
        <div key={tourIndex} className="xmap-caption absolute bottom-5 left-1/2 z-10 -translate-x-1/2 max-md:bottom-16" data-map-tour-caption>
          <div className="flex items-center gap-3 rounded-lg border border-border bg-raised px-3.5 py-2 shadow-md">
            <span className="font-mono text-[11px] tabular text-muted">
              {tourIndex + 1}/{stops.length}
            </span>
            <span className="max-w-[60vw] truncate text-sm text-fg">
              {stop.kind === "screen" ? (
                <>
                  <span className="text-muted">{regionsByKey.get(screens.cards.get(stop.id)?.region ?? "")?.label}</span>
                  <span className="mx-1.5 text-muted">›</span>
                </>
              ) : null}
              <span className="font-medium">{stop.label}</span>
            </span>
          </div>
          <div className="mx-auto mt-2 h-0.5 w-64 max-w-full overflow-hidden rounded-full bg-border">
            <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${((tourIndex + 1) / stops.length) * 100}%` }} />
          </div>
        </div>
      ) : selection ? null : (
        <p className="pointer-events-none absolute bottom-5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap text-[11px] text-muted max-md:hidden">
          {layer === "data"
            ? "Particles carry the data: calls and writes flow down, reads flow up · click anything for its sources"
            : lod === "far"
              ? `${plural(screens.regions.length, "region")} · zoom in for screens and frames · fog is what no run has reached${hiddenLinks ? ` · +${plural(hiddenLinks, "more link")} between features` : ""}`
              : hiddenLinks
                ? `Hover a screen for its links · +${plural(hiddenLinks, "more link")} · a badge on a feature's edge leads to another feature`
                : "Hover a screen for its links · a badge on a feature's edge leads to another feature · dashed: known from code, never taken"}
        </p>
      )}

      {overlay}

      {selection ? <DetailPanel map={map} selection={selection} region={region} mode={panelMode} onMode={setPanelMode} onGo={go} onRegion={goRegion} onClose={closePanel} /> : null}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

/** The Tests layer's list of flows the existing tests walk; picking one lights its steps. The ones
 * tied to no screen yet are folded away under their own heading, each with why in its tooltip. */
function FlowPicker({ flows, picked, onPick }: { flows: readonly FlowEntry[]; picked: string | null; onPick: (id: string) => void }) {
  const { linked, unlinked } = splitFlows(flows);
  const [showUnlinked, setShowUnlinked] = useState(() => linked.length === 0);
  const item = ({ flow: f, steps }: FlowEntry) => {
    const framework = f.detail.framework ?? f.evidence.tests[0]?.framework ?? null;
    const why = steps.length ? null : unlinkedReason(f);
    return (
      <li key={f.id}>
        <button
          type="button"
          onClick={() => onPick(f.id)}
          aria-pressed={picked === f.id}
          title={why ?? undefined}
          className={cn("flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-hover", picked === f.id && "bg-selected")}
          data-map-flow={f.key}
          data-linked={steps.length ? "true" : "false"}
        >
          <span className={cn("truncate text-sm", steps.length ? "text-fg" : "text-fg-2")}>{f.label}</span>
          <span className="truncate text-xs text-muted">
            {framework ? `${framework} · ` : ""}
            {steps.length ? plural(steps.length, "screen") : "no screen yet"}
            {f.detail.skipped ? " · skipped" : ""}
          </span>
        </button>
      </li>
    );
  };
  return (
    <div
      className="absolute left-4 top-[52px] z-10 flex max-h-[calc(100%-7rem)] w-[288px] flex-col overflow-hidden rounded-xl border border-border bg-raised shadow-md max-md:inset-x-4 max-md:bottom-16 max-md:top-auto max-md:max-h-[38%] max-md:w-auto"
      data-map-flows
    >
      <p className="border-b border-border px-3 py-2 text-2xs font-semibold uppercase tracking-[0.1em] text-muted">
        Existing tests · {plural(flows.length, "flow")}
      </p>
      {flows.length === 0 ? (
        <p className="px-3 py-3 text-sm text-fg-2">No existing tests were read for this app. When its repository has UI tests (XCUITest, Espresso, Playwright, Maestro…), the flows they walk show here.</p>
      ) : (
        <div className="min-h-0 overflow-y-auto p-1">
          {linked.length ? <ul>{linked.map(item)}</ul> : null}
          {unlinked.length ? (
            <div className={cn(linked.length > 0 && "mt-1 border-t border-border pt-1")} data-map-flows-unlinked={unlinked.length}>
              <button
                type="button"
                onClick={() => setShowUnlinked((v) => !v)}
                aria-expanded={showUnlinked}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs font-medium text-fg-2 hover:bg-hover hover:text-fg"
                title="Tests whose steps the map could not tie to a screen: hover one for why"
              >
                <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", showUnlinked && "rotate-90")} aria-hidden />
                Not tied to screens yet ({unlinked.length})
              </button>
              {showUnlinked ? <ul>{unlinked.map(item)}</ul> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
