import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import {
  ChevronLeft,
  ChevronRight,
  Expand,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  X,
} from "../../map/kit/icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { urlFor } from "../frames";
import { fmtMs } from "../../map/kit";
import type { TargetKind } from "../explorations";
import type { QaFinding } from "../../qaApi";
import type { QaStep } from "../api";
import { severityOf } from "../adapt";
import { EXPANDED_CLASS, useFullscreen } from "./fullscreen";
import { cn } from "../../map/kit";
import { screenNodeTypes, type ScreenNodeData } from "./screen-node";
import {
  buildExplorationTree,
  layoutTree,
  type Evidence,
  type ScreenNode as TreeNode,
  type Step,
} from "./tree-model";

export interface ExplorationMapProps {
  steps: readonly QaStep[];
  findings: readonly QaFinding[];
  kind: TargetKind;
}

const SPEEDS = [1, 2, 4] as const;
/** Base time the camera spends on each move of the tour, before the speed multiplier. */
const TOUR_STEP_MS = 1900;
/** Fit padding: clear of the title card and controls above, the hint line below. */
const FIT_PADDING = { top: "84px", bottom: "56px", x: "40px" } as const;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = window.matchMedia(REDUCED_MOTION);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/**
 * The agent's exploration as a tree of screenshots: the first screen at the top, each new
 * screen below the one it was reached from. Plays a camera tour along the exact path the agent
 * walked (including backing out), and opens any screen for a closer look.
 */
export function ExplorationMap(props: ExplorationMapProps) {
  return (
    <ReactFlowProvider>
      <MapInner {...props} />
    </ReactFlowProvider>
  );
}

/** The session's steps as the map reads them: times from its first step, frames by id. */
export function mapSteps(steps: readonly QaStep[]): Step[] {
  const first = steps[0]?.at ? Date.parse(steps[0].at) : NaN;
  return steps.map((s) => ({
    seq: s.seq,
    kind: s.kind,
    args: (s.args ?? {}) as Step["args"],
    result: s.result,
    at_ms: s.at && Number.isFinite(first) ? Math.max(0, Date.parse(s.at) - first) : 0,
    frame_path: s.frame_id,
    screen_hash: s.screen_hash,
  }));
}

/** Each finding pinned on its last step. */
export function mapEvidence(findings: readonly QaFinding[]): Evidence[] {
  const out: Evidence[] = [];
  for (const f of findings as readonly (QaFinding & { end_seq?: number | null })[]) {
    if (typeof f.end_seq === "number" && f.status !== "dismissed") out.push({ seq: f.end_seq, severity: severityOf(f.severity), label: f.title });
  }
  return out;
}

function MapInner({ steps: rows, findings, kind }: ExplorationMapProps) {
  const steps = useMemo(() => mapSteps(rows), [rows]);
  const evidence = useMemo(() => mapEvidence(findings), [findings]);
  const flow = useReactFlow();
  const reduced = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(
    () => buildExplorationTree(steps, evidence),
    [steps, evidence],
  );
  const byId = useMemo(() => new Map(tree.nodes.map((n) => [n.id, n])), [tree]);
  // The run header's "N screens" (every distinct screen read). The map folds a scroll, typed
  // text or the device's home screen into the screen it changed, so it can show fewer cards.
  const screensSeen = useMemo(() => new Set(steps.filter((s) => s.kind === "screen").map((s) => s.screen_hash ?? s.seq)).size, [steps]);

  // Card geometry follows the device: wide cards for web, tall ones for phones, wide
  // near-square ones for tablets (sized from the capture, never from a phone-shaped app window).
  const mobile = kind === "ios" || kind === "android";
  const aspect = mobile ? 874 / 402 : kind === "web" ? 0.625 : 2.16;
  const cardW = kind === "web" ? 300 : 200;
  const imageH = Math.round(cardW * aspect);
  const rowH = imageH + 170;
  const positions = useMemo(
    () => layoutTree(tree, cardW, rowH, 70),
    [tree, cardW, rowH],
  );

  // Tour state: index into the journey, or -1 when not touring.
  const [tourIndex, setTourIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [inspectVisit, setInspectVisit] = useState(0);
  const [dive, setDive] = useState<string | null>(null);
  const fullscreen = useFullscreen(containerRef);

  // React Flow measures each node and reports it through onNodesChange; a controlled node is
  // only shown once its measured size is passed back in.
  const [measured, setMeasured] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const dims = changes.filter(
      (c): c is Extract<NodeChange, { type: "dimensions" }> =>
        c.type === "dimensions" && Boolean(c.dimensions),
    );
    if (!dims.length) return;
    setMeasured((prev) => {
      const next = { ...prev };
      for (const c of dims)
        next[c.id] = {
          width: c.dimensions!.width,
          height: c.dimensions!.height,
        };
      return next;
    });
  }, []);

  const touring = tourIndex >= 0;
  const journey = tree.journey;
  const tourStep = touring
    ? journey[Math.min(tourIndex, journey.length - 1)]
    : null;

  // Nodes and edges the tour has reached so far; everything when not touring.
  const reached = useMemo(() => {
    if (!touring) return null;
    const nodes = new Set<string>();
    const edges = new Set<string>();
    for (const j of journey.slice(0, tourIndex + 1)) {
      nodes.add(j.nodeId);
      if (j.edgeId) edges.add(j.edgeId);
    }
    return { nodes, edges };
  }, [touring, journey, tourIndex]);

  const activeId = tourStep?.nodeId ?? inspectId;

  const nodes: Node[] = useMemo(
    () =>
      tree.nodes.map((n) => {
        const p = positions.get(n.id) ?? { x: 0, y: 0 };
        const data: ScreenNodeData = {
          name: n.name,
          framePath: n.visits[0].framePath,
          depth: n.depth,
          visits: n.visits.length,
          order: n.order,
          isRoot: n.id === tree.rootId,
          worst: n.worst,
          findingCount: n.findings.length,
          width: cardW,
          imageHeight: imageH,
          active: n.id === activeId,
          reached: reached ? reached.nodes.has(n.id) : true,
          revealDelay: reduced ? 0 : Math.min(n.order * 90, 2400),
        };
        const size = measured[n.id] ?? { width: cardW, height: imageH + 38 };
        return {
          id: n.id,
          type: "screen",
          position: p,
          data,
          draggable: false,
          width: size.width,
          height: size.height,
          measured: size,
        };
      }),
    [tree, positions, cardW, imageH, activeId, reached, reduced, measured],
  );

  const activeEdgeId = tourStep?.edgeId ?? null;
  const edges: Edge[] = useMemo(
    () =>
      tree.edges.map((e) => {
        const isActive = e.id === activeEdgeId;
        const isReached = reached ? reached.edges.has(e.id) : true;
        const target = byId.get(e.target);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: e.kind === "tree" ? "smoothstep" : "default",
          label:
            isActive || !touring
              ? e.kind === "tree"
                ? e.label
                : undefined
              : undefined,
          animated: isActive || e.kind === "return",
          className: cn(
            "xmap-edge",
            e.kind === "return" ? "xmap-edge-return" : "xmap-edge-tree",
            isActive && "xmap-edge-active",
            !isReached && "xmap-edge-dim",
          ),
          style: reduced
            ? undefined
            : {
                animationDelay: `${Math.min((target?.order ?? 0) * 90, 2400) + 250}ms`,
              },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 6,
          labelClassName: "xmap-edge-label",
        };
      }),
    [tree, byId, activeEdgeId, reached, touring, reduced],
  );

  const centreOf = useCallback(
    (id: string) => {
      const p = positions.get(id) ?? { x: 0, y: 0 };
      return { x: p.x + cardW / 2, y: p.y + imageH / 2 + 20 };
    },
    [positions, cardW, imageH],
  );

  const flyTo = useCallback(
    (id: string, zoom: number, duration: number, shiftPx = 0) => {
      const c = centreOf(id);
      // `shiftPx` moves the screen left of centre, e.g. to clear the inspector panel.
      void flow.setCenter(c.x + shiftPx / zoom, c.y, {
        zoom,
        duration: reduced ? 0 : duration,
      });
    },
    [flow, centreOf, reduced],
  );

  const fitAll = useCallback(
    (duration = 1400) => {
      // Room for the title card and controls at the top and the hint line at the bottom.
      void flow.fitView({ padding: FIT_PADDING, duration: reduced ? 0 : duration });
    },
    [flow, reduced],
  );

  // The whole tree stays in view until the reader takes the camera: the first fit can run
  // before every card is measured or before the canvas has its final height (the page's
  // header and tabs settling), which left the bottom of the tree cut off on open.
  const introDone = useRef(false);
  // Set once the opening shot's pull-back starts; before that a refit would cut the intro short.
  const fitted = useRef(false);
  const autoFit = useRef(true);
  const idle = !touring && !inspectId;
  const allMeasured = tree.nodes.length > 0 && tree.nodes.every((n) => measured[n.id]);
  useEffect(() => {
    if (!idle) autoFit.current = false;
  }, [idle]);
  useEffect(() => {
    if (allMeasured && autoFit.current && fitted.current) fitAll(300);
  }, [allMeasured, fitAll]);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (autoFit.current && fitted.current) fitAll(300);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitAll]);

  // Opening shot: start close on the root, then pull back to reveal the whole tree while the
  // screens appear in the order the agent discovered them.
  const onInit = useCallback(() => {
    if (introDone.current || !tree.rootId) return;
    introDone.current = true;
    const root = centreOf(tree.rootId);
    void flow.setCenter(root.x, root.y, { zoom: 1.35, duration: 0 });
    if (reduced) {
      fitted.current = true;
      fitAll(0);
      return;
    }
    window.setTimeout(() => {
      fitted.current = true;
      fitAll(2200);
    }, 700);
  }, [tree.rootId, centreOf, flow, fitAll, reduced]);

  // The tour: one move of the agent at a time, the camera following.
  useEffect(() => {
    if (!playing || !touring) return;
    if (tourIndex >= journey.length - 1) {
      const t = window.setTimeout(() => {
        setPlaying(false);
        fitAll(1800);
      }, TOUR_STEP_MS / speed);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(
      () => setTourIndex((i) => i + 1),
      TOUR_STEP_MS / speed,
    );
    return () => window.clearTimeout(t);
  }, [playing, touring, tourIndex, journey.length, speed, fitAll]);

  useEffect(() => {
    if (!tourStep) return;
    flyTo(
      tourStep.nodeId,
      kind === "web" ? 1.05 : 1.2,
      Math.max(450, 1100 / speed),
    );
  }, [tourStep, flyTo, speed, kind]);

  const play = useCallback(() => {
    setInspectId(null);
    if (!touring || tourIndex >= journey.length - 1) setTourIndex(0);
    setPlaying(true);
  }, [touring, tourIndex, journey.length]);

  const stopTour = useCallback(() => {
    setPlaying(false);
    setTourIndex(-1);
    fitAll(1400);
  }, [fitAll]);

  const stepTour = useCallback(
    (delta: number) => {
      setPlaying(false);
      setInspectId(null);
      setTourIndex((i) =>
        Math.min(Math.max(0, (i < 0 ? 0 : i) + delta), journey.length - 1),
      );
    },
    [journey.length],
  );

  const inspect = useCallback(
    (id: string) => {
      setPlaying(false);
      setTourIndex(-1);
      setInspectId(id);
      setInspectVisit(0);
      // Half the inspector's width (360 px + margin), so the screen sits beside it.
      flyTo(id, kind === "web" ? 1.1 : 1.35, 900, 190);
    },
    [flyTo, kind],
  );

  const closeInspector = useCallback(() => {
    setInspectId(null);
    fitAll(1200);
  }, [fitAll]);

  // Entering or leaving full screen (or the expanded fallback) resizes the canvas: refit.
  const fullscreenMode = fullscreen.mode;
  const lastFullscreenMode = useRef(fullscreenMode);
  useEffect(() => {
    if (lastFullscreenMode.current === fullscreenMode) return;
    lastFullscreenMode.current = fullscreenMode;
    window.setTimeout(() => fitAll(600), 120);
  }, [fullscreenMode, fitAll]);

  // Keyboard: space plays/pauses, arrows step the tour, F fits, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (
        !containerRef.current?.contains(document.activeElement) &&
        document.activeElement !== document.body
      )
        return;
      if (e.key === " ") {
        e.preventDefault();
        if (playing) setPlaying(false);
        else play();
      } else if (e.key === "ArrowRight") stepTour(1);
      else if (e.key === "ArrowLeft") stepTour(-1);
      else if (e.key === "f" || e.key === "F") fitAll(900);
      else if (e.key === "Escape") {
        // A handled Escape is marked, so it does not also leave the expanded full screen.
        if (dive) setDive(null);
        else if (inspectId) closeInspector();
        else if (touring) stopTour();
        else return;
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    playing,
    play,
    stepTour,
    fitAll,
    dive,
    inspectId,
    closeInspector,
    touring,
    stopTour,
  ]);

  if (tree.nodes.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted">
        No screenshots were recorded for this run, so there is nothing to map
        yet.
      </p>
    );
  }

  const inspected = inspectId ? (byId.get(inspectId) ?? null) : null;
  const depthMax = tree.nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  const returns = tree.edges.filter((e) => e.kind === "return").length;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={cn(
        "xmap relative min-h-0 flex-1 overflow-hidden outline-none",
        fullscreen.active && "bg-bg",
        fullscreen.expanded && EXPANDED_CLASS,
      )}
      data-fullscreen={fullscreen.mode}
      data-exploration-map
    >
      <div
        aria-hidden
        className="xmap-vignette pointer-events-none absolute inset-0 z-[1]"
      />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={screenNodeTypes}
        onInit={onInit}
        // A pan or zoom by the reader (an event, not the camera's own moves) ends auto-fit.
        onMoveStart={(event) => {
          if (event) autoFit.current = false;
        }}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => inspect(n.id)}
        onNodeDoubleClick={(_, n) => {
          const node = byId.get(n.id);
          if (node) setDive(node.visits[0].framePath);
        }}
        onPaneClick={() => (inspectId ? closeInspector() : undefined)}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        // Low enough that a long run's whole tree fits on open (70 screens, 21 deep did not at 0.05).
        minZoom={0.02}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
        className="xmap-flow"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.2}
          className="!bg-transparent"
        />
        {inspectId ? null : (
          <MiniMap
            pannable
            zoomable
            className="!bottom-4 !right-4 !rounded-lg !border !border-border !bg-panel max-md:!hidden"
            nodeColor={(n) =>
              (n.data as ScreenNodeData).active
                ? "var(--color-accent)"
                : "var(--color-muted)"
            }
            maskColor="color-mix(in srgb, var(--color-bg) 70%, transparent)"
          />
        )}
      </ReactFlow>

      {/* Title card */}
      <div className="xmap-title pointer-events-none absolute left-5 top-4 z-10">
        <p className="text-sm font-semibold text-fg">
          Exploration map
        </p>
        <p className="mt-0.5 text-sm text-muted">
          <span data-xmap-screens>
            {tree.nodes.length < screensSeen ? `${tree.nodes.length} of ${screensSeen} screens mapped` : `${tree.nodes.length} screens`}
          </span>{" "}
          · depth {depthMax} · {journey.length - 1}{" "}
          moves
          {returns ? ` · ${returns} jumps back` : ""}
        </p>
      </div>

      {/* Controls: beside the title on a wide canvas, under it at phone width so neither
          covers the other. */}
      <div data-xmap-controls className="absolute right-4 top-4 z-10 max-md:top-[68px] flex items-center gap-0.5 rounded-lg border border-border bg-raised p-0.5 shadow-md">
        <IconButton
          label={
            playing ? "Pause tour (space)" : "Play the agent's path (space)"
          }
          onClick={playing ? () => setPlaying(false) : play}
        >
          {playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </IconButton>
        <IconButton label="Previous move (←)" onClick={() => stepTour(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <IconButton label="Next move (→)" onClick={() => stepTour(1)}>
          <ChevronRight className="h-4 w-4" />
        </IconButton>
        <button
          type="button"
          onClick={() =>
            setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])
          }
          className="h-7 rounded-md px-2 text-sm tabular text-muted hover:bg-hover hover:text-fg"
          title="Tour speed"
        >
          {speed}×
        </button>
        {touring ? (
          <IconButton label="Stop tour (esc)" onClick={stopTour}>
            <RotateCcw className="h-4 w-4" />
          </IconButton>
        ) : null}
        <span className="mx-0.5 h-4 w-px bg-border" />
        <IconButton label="Fit the whole tree (F)" onClick={() => fitAll(900)}>
          <Expand className="h-4 w-4" />
        </IconButton>
        <IconButton label={fullscreen.label} onClick={fullscreen.toggle}>
          {fullscreen.active ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </IconButton>
      </div>

      {/* Tour caption */}
      {tourStep ? (
        <div
          key={tourIndex}
          className="xmap-caption absolute bottom-5 left-1/2 z-10 -translate-x-1/2"
        >
          <div className="flex items-center gap-3 rounded-lg border border-border bg-raised px-3.5 py-2 shadow-md">
            <span className="font-mono text-[11px] text-muted tabular">
              {tourIndex + 1}/{journey.length}
            </span>
            <span className="text-sm text-fg">
              {tourStep.label ? (
                <>
                  <span className="text-muted">{tourStep.label}</span>
                  <span className="mx-1.5 text-muted">→</span>
                </>
              ) : null}
              <span className="font-medium">
                {byId.get(tourStep.nodeId)?.name}
              </span>
            </span>
            <span className="font-mono text-[11px] text-muted tabular">
              {fmtMs(tourStep.atMs)}
            </span>
          </div>
          <div className="mx-auto mt-2 h-0.5 w-64 overflow-hidden rounded-full bg-border">
            <div
              className="h-full bg-accent transition-[width] duration-500"
              style={{ width: `${((tourIndex + 1) / journey.length) * 100}%` }}
            />
          </div>
        </div>
      ) : inspectId ? null : (
        // A mouse hint: hidden at phone width, where the minimap is hidden too and the
        // canvas has no room for a wrapped three-line caption.
        <p className="pointer-events-none absolute bottom-5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap text-[11px] text-muted max-md:hidden">
          Play to follow the agent · click a screen to inspect · double-click to
          dive in
        </p>
      )}

      {inspected ? (
        <Inspector
          node={inspected}
          visitIndex={inspectVisit}
          onVisit={setInspectVisit}
          kids={inspected.childIds
            .map((c) => byId.get(c))
            .filter((n): n is TreeNode => Boolean(n))}
          parent={
            inspected.parentId ? (byId.get(inspected.parentId) ?? null) : null
          }
          onGo={inspect}
          onDive={setDive}
          onClose={closeInspector}
        />
      ) : null}

      {dive ? (
        <button
          type="button"
          className="xmap-dive absolute inset-0 z-30 flex items-center justify-center bg-black/80 p-8 backdrop-blur-md"
          onClick={() => setDive(null)}
          aria-label="Close"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- full-size local artifact */}
          <img
            src={urlFor(dive)}
            alt="Screenshot"
            className="xmap-dive-img max-h-full max-w-full rounded-xl border border-white/10 shadow-2xl"
          />
        </button>
      ) : null}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
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

function Inspector({
  node,
  visitIndex,
  onVisit,
  kids,
  parent,
  onGo,
  onDive,
  onClose,
}: {
  node: TreeNode;
  visitIndex: number;
  onVisit: (i: number) => void;
  kids: TreeNode[];
  parent: TreeNode | null;
  onGo: (id: string) => void;
  onDive: (framePath: string) => void;
  onClose: () => void;
}) {
  const visit = node.visits[Math.min(visitIndex, node.visits.length - 1)];
  return (
    <aside className="xmap-inspector absolute bottom-4 right-4 top-16 z-20 flex w-[360px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-panel border border-border-strong bg-raised shadow-md">
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-base font-medium text-fg">{node.name}</p>
          <p className="text-[11px] text-muted">
            depth {node.depth} · visited {node.visits.length}× · first at{" "}
            {fmtMs(node.visits[0].atMs)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <button
          type="button"
          onClick={() => onDive(visit.framePath)}
          className="block w-full p-3"
          title="Open full size"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local artifact */}
          <img
            key={visit.framePath}
            src={urlFor(visit.framePath)}
            alt={`${node.name}, visit ${visitIndex + 1}`}
            className="xmap-inspector-img w-full rounded-lg border border-border"
          />
        </button>
        {node.visits.length > 1 ? (
          <div className="flex gap-1.5 overflow-x-auto px-3 pb-2">
            {node.visits.map((v, i) => (
              <button
                key={v.seq}
                type="button"
                onClick={() => onVisit(i)}
                className={cn(
                  "shrink-0 overflow-hidden rounded-md border",
                  i === visitIndex
                    ? "border-accent"
                    : "border-border opacity-70 hover:opacity-100",
                )}
                title={`Visit ${i + 1} at ${fmtMs(v.atMs)}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- local artifact */}
                <img
                  src={urlFor(v.framePath)}
                  alt=""
                  className="h-12 w-16 object-cover object-top"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        ) : null}
        <dl className="space-y-3 px-4 pb-4 text-sm">
          {node.via ? (
            <div>
              <dt className="text-muted">Reached by</dt>
              <dd className="mt-0.5 font-mono text-fg">{node.via}</dd>
            </div>
          ) : null}
          {parent ? (
            <div>
              <dt className="text-muted">From</dt>
              <dd className="mt-0.5">
                <button
                  type="button"
                  className="text-fg underline-offset-2 hover:underline"
                  onClick={() => onGo(parent.id)}
                >
                  ↑ {parent.name}
                </button>
              </dd>
            </div>
          ) : null}
          {kids.length ? (
            <div>
              <dt className="text-muted">Led to</dt>
              <dd className="mt-1 flex flex-col gap-1">
                {kids.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="truncate text-left text-fg underline-offset-2 hover:underline"
                    onClick={() => onGo(c.id)}
                  >
                    ↓ {c.name}{" "}
                    <span className="font-mono text-muted">{c.via}</span>
                  </button>
                ))}
              </dd>
            </div>
          ) : null}
          {node.findings.length ? (
            <div>
              <dt className="text-muted">Findings here</dt>
              <dd className="mt-1 flex flex-col gap-1">
                {node.findings.map((f) => (
                  <span key={f.seq} className="text-fg">
                    <span className="font-mono text-muted">#{f.seq}</span>{" "}
                    {f.severity} · {f.label ?? "evidence"}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </aside>
  );
}
