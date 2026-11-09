
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type OnInit,
  type OnNodeDrag,
  type OnNodesChange,
} from "@xyflow/react";
import { RotateCw } from "../map/kit/icons";
import { StatusGlyph, buttonVariants, cn } from "../map/kit";
import { useCallback, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { Scenario, ScenarioOutcome } from "./adapt";
import { autoArrangeScenarios, initialViewport, layoutScenarios } from "./scenario-layout";
import type { PlatformStatus } from "./platform-status-strip";
import { modifierClickNodeId, selectionAfterChanges, toggleSelection } from "./modifier-select";
import { categorySeriesToken, scenarioNodeTypes, type ScenarioNodeData } from "./scenario-node";

export interface GraphScenario extends Pick<Scenario, "id" | "name" | "category" | "status" | "criteria" | "depends_on" | "position" | "target_kind"> {
  health?: Scenario["health"];
  quarantined_at?: string | null;
  quarantine_reason?: string | null;
  /** The newest verdicts rolled up. */
  outcome?: ScenarioOutcome | null;
  /** Open suggested changes waiting for a person. */
  pending?: number;
  /** The result on the scenario's platform. */
  platformStatus?: PlatformStatus[];
}

export interface ScenarioGraphProps {
  scenarios: GraphScenario[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Editable canvas: persists drag + edge edits. */
  editable?: boolean;
  /** Edges stay as they are (only a person changes dependencies). */
  edgesLocked?: boolean;
  onPositionChange?: (id: string, position: { x: number; y: number }) => void;
  onDependencyChange?: (id: string, dependsOn: string[]) => void;
  /** Exposes the xyflow instance (e.g. for a toolbar's Fit view button). */
  onInit?: OnInit<Node<ScenarioNodeData>, Edge>;
  /**
   * Persists a full set of recomputed positions (e.g. from the "Auto-arrange"
   * control-corner button) via the same path as a drag-end save. Passing
   * this in enables the button; omit it to hide the control (e.g. read-only
   * run graph).
   */
  onArrange?: (positions: Map<string, { x: number; y: number }>) => void;
  /** Shows the category/outcome legend chip row (default true). */
  showLegend?: boolean;
  /** Shows the MiniMap (default true). */
  showMiniMap?: boolean;
  /** Toolbar search (spec §3 rework): matching node ids stay full-opacity, the rest dim. `null`/omitted means no search is active. */
  highlightedIds?: ReadonlySet<string> | null;
  /** Multi-select (shift-click / shift-drag box select) driving the toolbar's bulk action bar. */
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (ids: string[]) => void;
}

const seriesVar: Record<ReturnType<typeof categorySeriesToken>, string> = {
  "series-1": "var(--color-series-1)",
  "series-2": "var(--color-series-2)",
  "series-3": "var(--color-series-3)",
  "series-4": "var(--color-series-4)",
};

function toNode(s: GraphScenario, position: { x: number; y: number }, selected: boolean): Node<ScenarioNodeData> {
  return {
    id: s.id,
    type: "scenario",
    position,
    selected,
    draggable: true,
    data: {
      name: s.name,
      category: s.category,
      status: s.status,
      criteriaCount: s.criteria.length,
      outcome: s.outcome ?? null,
      targetKind: s.target_kind ?? null,
      pending: s.pending ?? 0,
      platformStatus: s.platformStatus,
      health: s.health ?? null,
      quarantinedAt: s.quarantined_at ?? null,
      quarantineReason: s.quarantine_reason ?? null,
    },
  };
}

const FAILING_OUTCOMES: ReadonlySet<ScenarioOutcome> = new Set(["fail", "blocked"]);

function toEdges(scenarios: GraphScenario[]): Edge[] {
  const ids = new Set(scenarios.map((s) => s.id));
  const edges: Edge[] = [];
  for (const s of scenarios) {
    for (const dep of s.depends_on) {
      if (!ids.has(dep)) continue;
      const targetFailing = s.outcome != null && FAILING_OUTCOMES.has(s.outcome);
      const classNames = cn(targetFailing && "scenario-edge-danger");
      edges.push({
        id: `${dep}->${s.id}`,
        source: dep,
        target: s.id,
        type: "smoothstep",
        className: classNames || undefined,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--color-edge)" },
      });
    }
  }
  return edges;
}

/**
 * Pannable/zoomable scenario canvas. Auto-layouts scenarios with no saved `position`: by category
 * column, or by dependency depth left→right once any scenario has a dependency.
 */
export function ScenarioGraph({
  scenarios,
  selectedId,
  onSelect,
  editable = false,
  edgesLocked = false,
  onPositionChange,
  onDependencyChange,
  onInit,
  onArrange,
  showLegend = true,
  showMiniMap = true,
  highlightedIds,
  selectedIds,
  onSelectionChange,
}: ScenarioGraphProps) {
  const layout = useMemo(() => layoutScenarios(scenarios), [scenarios]);
  const isSelected = useCallback(
    (id: string) => (selectedIds ? selectedIds.has(id) : id === selectedId),
    [selectedIds, selectedId],
  );
  const initialNodes = useMemo(
    () => scenarios.map((s) => toNode(s, layout.get(s.id) ?? { x: 0, y: 0 }, isSelected(s.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenarios],
  );
  const initialEdges = useMemo(() => toEdges(scenarios), [scenarios]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const lastScenarioIds = useRef<string>("");
  const flowInstanceRef = useRef<Parameters<OnInit<Node<ScenarioNodeData>, Edge>>[0] | null>(null);

  // Re-derive nodes/edges when the scenario set materially changes (new/removed
  // scenarios, outcome updates) — but not on every render, so drag stays smooth.
  // Uses `isSelected` (selectedIds when given, else selectedId) so a rebuild here
  // never drops the current multi-selection back to nothing.
  useEffect(() => {
    const key = scenarios
      // Everything a card draws (fix/ask-apply-live-ui): an edit from Ask or another tab that
      // changes only the criteria count, the platform, health or quarantine left the card stale.
      .map((s) =>
        [
          s.id, s.outcome ?? "", s.status, s.name, s.category, s.depends_on.join(","), s.pending ?? 0, s.criteria.length,
          s.target_kind ?? "", s.health ?? "", s.quarantined_at ?? "", JSON.stringify(s.platformStatus ?? null),
        ].join(":"),
      )
      .join("|");
    if (key === lastScenarioIds.current) return;
    lastScenarioIds.current = key;
    setNodes(scenarios.map((s) => toNode(s, layout.get(s.id) ?? { x: 0, y: 0 }, isSelected(s.id))));
    setEdges(toEdges(scenarios));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios]);

  // Reflect selection without rebuilding the whole node list. Skips the update
  // entirely when nothing would actually change, so an unrelated render never
  // hands xyflow a fresh node array.
  useEffect(() => {
    setNodes((nds) => {
      let changed = false;
      const next = nds.map((n) => {
        const selected = isSelected(n.id);
        if (selected === n.selected) return n;
        changed = true;
        return { ...n, selected };
      });
      return changed ? next : nds;
    });
  }, [isSelected, setNodes]);

  // Toolbar search (spec §3 rework): dim non-matching nodes via xyflow's own
  // per-node `style`, so the shared ScenarioNode renderer stays untouched. Same
  // no-op guard as the selection effect above, for the same reason.
  useEffect(() => {
    setNodes((nds) => {
      let changed = false;
      const next = nds.map((n) => {
        const opacity = highlightedIds && !highlightedIds.has(n.id) ? 0.25 : 1;
        if (n.style?.opacity === opacity) return n;
        changed = true;
        return { ...n, style: { ...n.style, opacity } };
      });
      return changed ? next : nds;
    });
  }, [highlightedIds, setNodes]);

  const handleNodeClick: NodeMouseHandler<Node<ScenarioNodeData>> = useCallback(
    (_e, node) => {
      onSelect?.(node.id);
    },
    [onSelect],
  );

  const handlePaneClick = useCallback(() => {
    onSelect?.(null);
  }, [onSelect]);

  const handleNodeDragStop: OnNodeDrag<Node<ScenarioNodeData>> = useCallback(
    (_e, node) => {
      if (editable) onPositionChange?.(node.id, node.position);
    },
    [editable, onPositionChange],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!editable || !connection.source || !connection.target) return;
      const target = scenarios.find((s) => s.id === connection.target);
      if (!target) return;
      const next = [...new Set([...target.depends_on, connection.source])];
      onDependencyChange?.(connection.target, next);
    },
    [editable, scenarios, onDependencyChange],
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (!editable) return;
      for (const edge of deleted) {
        const target = scenarios.find((s) => s.id === edge.target);
        if (!target) continue;
        onDependencyChange?.(
          target.id,
          target.depends_on.filter((d) => d !== edge.source),
        );
      }
    },
    [editable, scenarios, onDependencyChange],
  );

  // The first view: everything when it fits legibly, else the top-left at a legible zoom
  // (a phone, or a big project), rather than xyflow's `fitView`, which shrinks a 50-node
  // map to unreadable dots. Set before `onInit` so a caller's deep-link focus still wins.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const handleInit = useCallback<OnInit<Node<ScenarioNodeData>, Edge>>(
    (instance) => {
      flowInstanceRef.current = instance;
      const el = wrapperRef.current;
      const view = el ? initialViewport(layout.values(), el.clientWidth, el.clientHeight) : null;
      if (view) void instance.setViewport(view);
      onInit?.(instance);
    },
    [onInit, layout],
  );

  const handleAutoArrange = useCallback(() => {
    const positions = autoArrangeScenarios(scenarios);
    setNodes((nds) =>
      nds.map((n) => {
        const position = positions.get(n.id);
        return position ? { ...n, position } : n;
      }),
    );
    onArrange?.(positions);
    // Fit view after the layout settles.
    requestAnimationFrame(() => {
      flowInstanceRef.current?.fitView({ duration: 250 });
    });
  }, [scenarios, setNodes, onArrange]);

  const legendCategories = useMemo(() => {
    const seen = new Map<string, ReturnType<typeof categorySeriesToken>>();
    for (const s of scenarios) {
      const category = s.category ?? "General";
      if (!seen.has(category)) seen.set(category, categorySeriesToken(s.category));
    }
    return [...seen.entries()];
  }, [scenarios]);

  const hasOutcomes = useMemo(() => scenarios.some((s) => s.outcome != null), [scenarios]);

  // The user's selection comes from xyflow's `select` changes (click, pane click, box select),
  // never from `onSelectionChange`: that one also reports xyflow's view of the nodes this
  // component passes in, so a selection made by the parent (a `?scenario=` link, "Select N
  // drafts") was echoed back, often as an empty list before xyflow had the nodes, and undid
  // or looped it. The displayed selection is driven only by the `selectedIds` prop (above).
  const currentSelection = useMemo<ReadonlySet<string>>(
    () => selectedIds ?? new Set(selectedId ? [selectedId] : []),
    [selectedIds, selectedId],
  );
  const handleNodesChange = useCallback<OnNodesChange<Node<ScenarioNodeData>>>(
    (changes) => {
      if (!onSelectionChange) {
        onNodesChange(changes);
        return;
      }
      // Selection is the parent's (controlled): xyflow's `select` changes are a request, never
      // applied here. Applied, a click the parent then held back (the open panel's "Keep
      // editing", #189) left the clicked node marked selected: clicking it again did nothing,
      // and the next click's changes deselected only that node, so the open one stayed in the
      // selection ("2 selected" after Discard). xyflow also marks its own copy of the nodes
      // before asking, so the nodes it touched are handed back fresh with the parent's
      // selection; the `selectedIds` effect above paints whatever the parent decides.
      const rest = changes.filter((c) => c.type !== "select" && c.type !== "remove");
      if (rest.length > 0) onNodesChange(rest);
      const touched = new Set(changes.flatMap((c) => (c.type === "select" ? [c.id] : [])));
      if (touched.size > 0) setNodes((nds) => nds.map((n) => (touched.has(n.id) ? { ...n, selected: currentSelection.has(n.id) } : n)));
      const next = selectionAfterChanges(currentSelection, changes);
      if (next) onSelectionChange(next);
    },
    [onNodesChange, onSelectionChange, currentSelection, setNodes],
  );

  // ⌘/Ctrl/Shift-click toggles a node in the selection (D100), decided from the click itself
  // and kept away from xyflow (capture phase), whose own multi-select key is tracked from
  // keydown events and so missed ⌘ entirely and a Shift it never saw pressed.
  const handleModifierCapture = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!onSelectionChange) return;
      const id = modifierClickNodeId(e);
      if (id === null) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.type !== "click") return;
      onSelectionChange(toggleSelection(currentSelection, id));
    },
    [onSelectionChange, currentSelection],
  );

  return (
    <ReactFlowProvider>
      <ReactFlow
        ref={wrapperRef}
        onMouseDownCapture={onSelectionChange ? handleModifierCapture : undefined}
        onPointerDownCapture={onSelectionChange ? handleModifierCapture : undefined}
        onClickCapture={onSelectionChange ? handleModifierCapture : undefined}
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onNodeDragStop={editable ? handleNodeDragStop : undefined}
        onConnect={editable ? handleConnect : undefined}
        onEdgesDelete={editable ? handleEdgesDelete : undefined}
        onInit={handleInit}
        nodesDraggable={editable}
        nodesConnectable={editable && !edgesLocked}
        // Scenarios are never deleted from the map (Retire keeps their history); a selected edge is.
        deleteKeyCode={["Backspace", "Delete"]}
        onBeforeDelete={async ({ edges: deleted }) => ({ nodes: [], edges: editable && !edgesLocked ? deleted : [] })}
        elementsSelectable
        // Multi-select (toolbar bulk actions): ⌘/Ctrl/Shift-click toggles a node
        // (`handleModifierCapture`), Shift-drag on the pane draws a selection box
        // (xyflow's `selectionKeyCode` default); a plain drag keeps panning.
        multiSelectionKeyCode={onSelectionChange ? "Shift" : undefined}
        nodeTypes={scenarioNodeTypes}
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        className="scenario-graph"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="!bg-bg" />
        <Controls showInteractive={false} className="scenario-graph-controls" />
        {showMiniMap ? (
          <MiniMap
            className="scenario-graph-minimap max-md:!hidden"
            pannable
            zoomable
            nodeColor={(n) => seriesVar[categorySeriesToken((n.data as ScenarioNodeData)?.category ?? null)]}
            maskColor="transparent"
          />
        ) : null}
        {onArrange ? (
          <Panel position="top-right" className="scenario-graph-arrange">
            <button
              type="button"
              onClick={handleAutoArrange}
              data-auto-arrange
              title="Auto-arrange: lay out by dependency depth (or category) and save positions"
              className={buttonVariants({ size: "sm", className: "m-2" })}
            >
              <RotateCw aria-hidden />
              Auto-arrange
            </button>
          </Panel>
        ) : null}
        {showLegend && (legendCategories.length > 0 || hasOutcomes) ? (
          // Beside the zoom controls (also bottom-left), never over them.
          <Panel position="bottom-left" className="scenario-graph-arrange !ml-[52px] max-md:!hidden">
            <div className="scenario-graph-legend" data-scenario-legend>
              {legendCategories.map(([category, token]) => (
                <span key={category} className="scenario-graph-legend-item">
                  <span
                    aria-hidden
                    className="scenario-graph-legend-swatch"
                    style={{ background: seriesVar[token] }}
                  />
                  {category}
                </span>
              ))}
              {hasOutcomes ? (
                <>
                  <span aria-hidden className="scenario-graph-legend-sep" />
                  <span className="scenario-graph-legend-item">
                    <StatusGlyph status="pass" decorative className="size-3" />
                    pass
                  </span>
                  <span className="scenario-graph-legend-item">
                    <StatusGlyph status="fail" decorative className="size-3" />
                    fail
                  </span>
                  <span className="scenario-graph-legend-item">
                    <StatusGlyph status="inconclusive" decorative className="size-3" />
                    inconclusive
                  </span>
                  <span className="scenario-graph-legend-item">
                    <StatusGlyph status="blocked" decorative className="size-3" />
                    blocked
                  </span>
                </>
              ) : null}
            </div>
          </Panel>
        ) : null}
      </ReactFlow>
    </ReactFlowProvider>
  );
}
