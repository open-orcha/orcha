import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, Info, ListChecks, Maximize2, Plus, Sparkles, X } from "../map/kit/icons";
import { Button, Empty, PLATFORM_LABELS, cn, useToast, type TargetKind } from "../map/kit";
import { errText } from "../parts";
import type { Platform, QaScenario } from "../qaApi";
import type { Scenario } from "./adapt";
import { patchScenario } from "./api";
import { BulkActionBar } from "./bulk-action-bar";
import { HumanGate, useScenarios } from "./context";
import { ExportMenu } from "./export-menu";
import { downloadGraph } from "./graph-png";
import { NewScenarioReview } from "./new-scenario-review";
import type { PlatformStatus } from "./platform-status-strip";
import { checkNewDependency, dependencyRefusalMessage } from "./scenario-dependency-graph";
import { criteriaDontFit, inPlatformFilter } from "./scenario-platform";
import { platformWord } from "../qaWords";
import { EMPTY_FILTERS, ScenarioFilters, inStatusFilter, statusCounts, type ScenarioFilterValues } from "./scenario-filters";
import { ScenarioGraph, type GraphScenario } from "./scenario-graph";
import { ScenarioList, ScenariosViewToggle, type ScenarioListItem, type ScenariosView } from "./scenario-list";
import type { ScenarioNodeData } from "./scenario-node";
import { ScenarioPanel } from "./scenario-panel";
import { ScenarioSearchBox } from "./scenario-search-box";
import type { EffectiveStatus } from "./scenario-status";
import { ShortcutsHelp } from "./shortcuts-help";
import { useScenarioShortcuts } from "./use-scenario-shortcuts";

export interface ScenariosCanvasProps {
  projectName: string;
  /** Every platform's scenarios, adapted. */
  initialScenarios: Scenario[];
  /** The rows behind them, to adapt what a save returns. */
  adapt: (row: QaScenario, all: readonly Pick<Scenario, "id" | "name">[]) => Scenario;
  /** The platforms with scenarios (iOS, Android, web order): the filter's segments. */
  kinds: TargetKind[];
  /** The page's platform: the filter starts on it. */
  platformKind: Platform;
  onPlatform: (kind: Platform) => void;
  /** Map (the dependency canvas, default) or List (`?sub=list`): rows, details wide. */
  view: ScenariosView;
  onViewChange: (view: ScenariosView) => void;
  /** `?status=`: the status filter starts on it (Overview's "to review"). */
  initialStatus?: EffectiveStatus | null;
  /** `?scenario=<id>`: opened on load. */
  scenarioId: string | null;
  onScenarioChange: (id: string | null) => void;
  /** Open suggested changes on the listed scenarios. */
  pendingTotal: number;
  /** A map position moved (this browser keeps them). */
  onPositions: (positions: Map<string, { x: number; y: number }>) => void;
  nonce: number;
  onRefresh: () => void;
}

/** Substring match against name + criteria text, case-insensitive. */
function matchesSearch(s: Scenario, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (s.name.toLowerCase().includes(q)) return true;
  return s.criteria.some((c) => c.toLowerCase().includes(q));
}

/** The status strip: the scenario's platform and its result there. */
function platformStatusOf(s: Pick<Scenario, "target_kind" | "platform" | "by_platform">, kinds: readonly TargetKind[]): PlatformStatus[] {
  const on = s.target_kind ? [s.target_kind] : kinds.length ? kinds : [s.platform];
  return on.map((kind) => {
    const r = s.by_platform[kind];
    return { kind, outcome: r?.outcome ?? null, noFit: criteriaDontFit(r?.outcome, r?.reason) || undefined };
  });
}

export function ScenariosCanvas({
  projectName,
  initialScenarios,
  adapt,
  kinds,
  platformKind,
  onPlatform: _onPlatform,
  view,
  onViewChange,
  initialStatus = null,
  scenarioId,
  onScenarioChange,
  pendingTotal,
  onPositions,
  nonce,
  onRefresh,
}: ScenariosCanvasProps) {
  const { auth, cid, runQa } = useScenarios();
  const { toast } = useToast();
  // `?scenario=<id>`: opened on load, in either view.
  const deepLinkedScenario = scenarioId ? (initialScenarios.find((s) => s.id === scenarioId) ?? null) : null;
  const deepLinked = deepLinkedScenario?.id ?? null;
  // The filter starts on the page's platform; "All" when a linked scenario belongs to another one.
  const [allPlatforms, setAllPlatforms] = useState(() => !!deepLinkedScenario && !!deepLinkedScenario.target_kind && deepLinkedScenario.target_kind !== platformKind);
  const platform: TargetKind | null = allPlatforms ? null : platformKind;
  const [lastKind, setLastKind] = useState(platformKind);
  if (lastKind !== platformKind) {
    // The page's own platform switch: the filter follows it.
    setLastKind(platformKind);
    setAllPlatforms(false);
  }
  const [showMissingLink, setShowMissingLink] = useState(!!scenarioId && !deepLinked);
  // Follows the page: a re-read brings the new list; a position just dragged keeps its place.
  const [scenarios, setScenarios] = useState<Scenario[]>(initialScenarios);
  useEffect(() => {
    setScenarios((local) => {
      const mine = new Map(local.map((s) => [s.id, s]));
      return initialScenarios.map((s) => {
        const was = mine.get(s.id);
        const next = was?.position ? { ...s, position: was.position } : s;
        // Unchanged rows keep their object, so nothing re-renders for them.
        return was && JSON.stringify(was) === JSON.stringify(next) ? was : next;
      });
    });
  }, [initialScenarios]);
  // `selectedIds` is the single source of truth for selection (single or multi); `selectedId`
  // below is *derived* from it rather than tracked separately, so the two can never disagree.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => (deepLinked ? new Set([deepLinked]) : new Set()));
  const selectedId = selectedIds.size === 1 ? [...selectedIds][0] : null;
  // The address names the one open scenario; a link followed from this page opens its scenario.
  const [lastLink, setLastLink] = useState(scenarioId);
  if (lastLink !== scenarioId) {
    setLastLink(scenarioId);
    if (scenarioId !== selectedId && (scenarioId || selectedIds.size <= 1)) setSelectedIds(scenarioId ? new Set([scenarioId]) : new Set());
  }
  useEffect(() => {
    if (selectedId !== scenarioId && (selectedId || selectedIds.size === 0)) onScenarioChange(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedIds.size]);
  const [filters, setFilters] = useState<ScenarioFilterValues>(() => (initialStatus ? { ...EMPTY_FILTERS, statuses: [initialStatus] } : EMPTY_FILTERS));
  const { category: categoryFilter, statuses: statusFilter, health: healthFilter, hasDepsOnly } = filters;
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const flowRef = useRef<ReactFlowInstance<Node<ScenarioNodeData>, Edge> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => [...new Set(scenarios.map((s) => s.category ?? "General"))].sort(), [scenarios]);

  // The platform tabs count what clicking them shows: retired scenarios stay out until the status
  // filter asks for them, as they do in the list.

  const filtered = useMemo(
    () =>
      scenarios.filter(
        (s) =>
          inPlatformFilter(s.target_kind, platform) &&
          (!categoryFilter || (s.category ?? "General") === categoryFilter) &&
          // Retired stays hidden until ticked.
          inStatusFilter(s, statusFilter) &&
          (!healthFilter || s.health === healthFilter) &&
          (!hasDepsOnly || s.depends_on.length > 0),
      ),
    [scenarios, platform, categoryFilter, statusFilter, healthFilter, hasDepsOnly],
  );
  const counts = useMemo(() => statusCounts(scenarios.filter((s) => inPlatformFilter(s.target_kind, platform))), [scenarios, platform]);
  // Nothing on this platform is not the filters' doing: say that, not "no match".
  const nothingHere = platform !== null && !scenarios.some((s) => inPlatformFilter(s.target_kind, platform));
  const noMatchWords = nothingHere
    ? `No ${platformWord(platform)} scenarios yet. Draft them, or add one with New scenario.`
    : "No scenarios match the current filters.";

  const highlightedIds = useMemo(() => {
    if (!search.trim()) return null;
    return new Set(filtered.filter((s) => matchesSearch(s, search)).map((s) => s.id));
  }, [filtered, search]);

  const graphScenarios: GraphScenario[] = useMemo(
    () =>
      filtered.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        status: s.status,
        criteria: s.criteria,
        depends_on: s.depends_on,
        position: s.position,
        target_kind: s.target_kind,
        outcome: s.outcome,
        pending: s.pending,
        health: s.health,
        quarantined_at: s.quarantined_at,
        quarantine_reason: s.quarantine_reason,
        platformStatus: platformStatusOf(s, kinds),
      })),
    [filtered, kinds],
  );

  const selected = scenarios.find((s) => s.id === selectedId) ?? null;
  // List view: the search narrows the rows (the map highlights instead).
  const listItems: ScenarioListItem[] = useMemo(
    () => filtered.filter((s) => !highlightedIds || highlightedIds.has(s.id)).map((s) => ({ scenario: s, outcome: s.outcome, platformStatus: platformStatusOf(s, kinds) })),
    [filtered, highlightedIds, kinds],
  );
  // Drafts on the canvas: one click selects them all for the bulk bar's Validate.
  const visibleDraftIds = useMemo(() => filtered.filter((s) => s.status === "draft").map((s) => s.id), [filtered]);
  const selectedScenarios = useMemo(() => scenarios.filter((s) => selectedIds.has(s.id)), [scenarios, selectedIds]);

  /** Removes a deleted scenario here and from what depends on it. */
  function handleDeleted(id: string) {
    setScenarios((list) => list.filter((s) => s.id !== id).map((s) => (s.depends_on.includes(id) ? { ...s, depends_on: s.depends_on.filter((d) => d !== id) } : s)));
    setSelectedIds((cur) => new Set([...cur].filter((x) => x !== id)));
    if (selectedId === id) onScenarioChange(null);
  }

  function applyPatch(id: string, patch: Partial<Scenario>) {
    setScenarios((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function handlePositionChange(id: string, position: { x: number; y: number }) {
    applyPatch(id, { position });
    onPositions(new Map([[id, position]]));
  }

  /** "Auto-arrange": the graph recomputes positions for every visible scenario and hands them
   * back here so they are kept the same way a manual drag is. */
  function handleArrange(positions: Map<string, { x: number; y: number }>) {
    setScenarios((list) => list.map((s) => (positions.has(s.id) ? { ...s, position: positions.get(s.id) ?? s.position } : s)));
    onPositions(positions);
  }

  /** Diffs old vs new `depends_on` for `id`: a single add or remove drives the drag-to-connect
   * cycle/self/duplicate guard. */
  function handleDependencyChange(id: string, dependsOn: string[]) {
    if (!auth.can) {
      toast({ title: "Could not add dependency", description: auth.reason ?? undefined, variant: "error" });
      return;
    }
    const current = scenarios.find((s) => s.id === id);
    if (current) {
      const added = dependsOn.filter((d) => !current.depends_on.includes(d));
      if (added.length === 1 && added.length === dependsOn.length - current.depends_on.length) {
        const check = checkNewDependency(scenarios, added[0], id);
        if (!check.ok) {
          toast({ title: "Could not add dependency", description: dependencyRefusalMessage(check.reason), variant: "error" });
          return;
        }
      }
    }
    const previous = current?.depends_on ?? [];
    applyPatch(id, { depends_on: dependsOn });
    void patchScenario(id, auth.human?.id ?? null, { depends_on: dependsOn }).catch((e) => {
      applyPatch(id, { depends_on: previous });
      toast({ title: "Could not save the dependency", description: errText(e), variant: "error" });
    });
  }

  function newScenario() {
    if (!auth.can) return;
    leavePanel(() => {
      clearSelection();
      setCreating(true);
    });
  }

  // The open scenario panel's guard: closing or switching it with unsaved edits asks Save /
  // Discard / Keep editing first. Empty while no panel is open.
  const panelLeaveGuard = useRef<((leave: () => void) => void) | null>(null);
  // Map view: the open scenario fills the map instead of sitting beside it.
  const [mapPanelFull, setMapPanelFull] = useState(false);
  const leavePanel = useCallback((leave: () => void) => {
    const guard = panelLeaveGuard.current;
    if (guard) guard(leave);
    else leave();
  }, []);

  const handleSelectionChange = useCallback(
    (ids: Iterable<string>) => {
      const next = [...ids];
      // Only a real change makes a new Set, so an equivalent selection never re-renders.
      if (selectedIds.size === next.length && next.every((id) => selectedIds.has(id))) return;
      leavePanel(() => {
        setCreating(false);
        setSelectedIds(new Set(next));
      });
    },
    [selectedIds, leavePanel],
  );

  function clearSelection() {
    setSelectedIds(new Set());
  }

  useScenarioShortcuts({
    onNew: newScenario,
    onFitView: () => flowRef.current?.fitView({ duration: 200 }),
    onFocusSearch: () => searchRef.current?.focus(),
    onEscape: () => {
      if (creating) {
        setCreating(false);
        return true;
      }
      if (selectedIds.size === 0 && !selectedId) return false;
      leavePanel(clearSelection);
      return true;
    },
    onDelete: () => {
      // No scenario is ever deleted here: Retire keeps the history. The map's selected edge
      // removes itself through xyflow's own Delete key.
    },
    onSelectAll: () => {
      setSelectedIds(new Set(filtered.map((s) => s.id)));
    },
  });

  function newReview() {
    if (!creating) return null;
    return (
      <NewScenarioReview
        platform={platformKind}
        onClose={() => setCreating(false)}
        onCreated={(row) => {
          const created = adapt(row, scenarios);
          setScenarios((list) => (list.some((s) => s.id === created.id) ? list.map((s) => (s.id === created.id ? created : s)) : [...list, created]));
          setCreating(false);
          setSelectedIds(new Set([created.id]));
          onRefresh();
        }}
      />
    );
  }

  function panel(wide: boolean, full?: { on: boolean; toggle: () => void }) {
    if (!selected) return null;
    return (
      <ScenarioPanel
        key={selected.id}
        wide={wide}
        full={full?.on}
        onToggleFull={full?.toggle}
        scenario={selected}
        allScenarios={scenarios}
        categories={categories}
        nonce={nonce}
        platformStatus={platformStatusOf(selected, kinds)}
        onClose={clearSelection}
        leaveGuardRef={panelLeaveGuard}
        onSaved={(updated) => applyPatch(updated.id, updated)}
        onRefresh={onRefresh}
        kinds={kinds}
        onDeleted={handleDeleted}
        onDuplicated={(created) => {
          setScenarios((list) => [...list, created]);
          setSelectedIds(new Set([created.id]));
          onRefresh();
        }}
      />
    );
  }

  const bulk =
    selectedScenarios.length > 1 ? <BulkActionBar selected={selectedScenarios} allScenarios={scenarios} onClear={clearSelection} onDeleted={(ids) => ids.forEach(handleDeleted)} onPatched={applyPatch} onSaved={onRefresh} /> : null;
  const newButton = (
    <HumanGate placement="bottom">
      <Button variant="primary" size="sm" disabled={!auth.can} onClick={newScenario} data-new-scenario>
        <Plus /> New scenario
      </Button>
    </HumanGate>
  );

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-scenarios-canvas>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4.5 py-2">
          {newButton}
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <ScenarioSearchBox ref={searchRef} value={search} onChange={setSearch} />
          <ScenarioFilters value={filters} onChange={setFilters} categories={categories} counts={counts} />
          {visibleDraftIds.length > 0 ? (
            <Button size="sm" onClick={() => setSelectedIds(new Set(visibleDraftIds))} title="Select every draft, then validate them together (⌘A selects all)" data-select-drafts={visibleDraftIds.length}>
              <CheckCheck /> Select {visibleDraftIds.length} draft{visibleDraftIds.length === 1 ? "" : "s"}
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <ScenariosViewToggle value={view} onChange={onViewChange} />
            {view === "map" ? (
              <Button size="sm" onClick={() => flowRef.current?.fitView({ duration: 200 })} data-fit-view>
                <Maximize2 /> Fit view
              </Button>
            ) : null}
            <ExportMenu cid={cid} platform={platform as Platform | null} onPng={view === "map" ? () => { const f = flowRef.current; return !!f && downloadGraph(f.getNodes(), f.getEdges(), projectName); } : undefined} projectName={platform ? `${projectName} on ${PLATFORM_LABELS[platform]}` : projectName} />
            <ShortcutsHelp />
          </div>
        </div>

        {showMissingLink ? (
          <div role="status" data-scenario-link-missing className="flex items-center gap-2 border-b border-border bg-panel px-4.5 py-1.5 text-xs text-muted">
            <Info aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">That link points to a scenario that no longer exists in this project.</span>
            <button type="button" onClick={() => setShowMissingLink(false)} aria-label="Dismiss" className="rounded p-0.5 hover:bg-hover hover:text-fg">
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        ) : null}

        {pendingTotal > 0 ? (
          <div role="status" data-scenario-suggestions-waiting className="flex items-center gap-2 border-b border-border bg-panel px-4.5 py-1.5 text-xs text-muted">
            <Sparkles aria-hidden className="size-3.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              {pendingTotal} suggested change{pendingTotal === 1 ? "" : "s"} to validated scenarios {pendingTotal === 1 ? "is" : "are"} waiting for review.
            </span>
          </div>
        ) : null}

        {scenarios.length === 0 ? (
          <Empty
            icon={ListChecks}
            title="No scenarios yet"
            description={`Create the first scenario for ${projectName} to start building its coverage graph.`}
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {newButton}
                <HumanGate>
                  <Button size="sm" disabled={!auth.can} onClick={() => runQa("draft")} data-draft-scenarios>
                    <Sparkles /> Draft scenarios
                  </Button>
                </HumanGate>
              </div>
            }
          />
        ) : view === "list" ? (
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {listItems.length === 0 ? (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-muted">{noMatchWords}</p>
              </div>
            ) : (
              <ScenarioList items={listItems} selectedIds={selectedIds} onSelectionChange={handleSelectionChange} compact={Boolean((selected && selectedScenarios.length <= 1) || creating)} storageKey={`orcha.qa.scenarios.collapsed.${cid}`} />
            )}
            {creating ? newReview() : selected && selectedScenarios.length <= 1 ? panel(true) : null}
            {bulk}
          </div>
        ) : (
          <div className={cn("relative flex-1 overflow-hidden", filtered.length === 0 && "relative")}>
            <ScenarioGraph
              scenarios={graphScenarios}
              selectedId={selectedId}
              // Node selections (single or multi) arrive through onSelectionChange below;
              // a pane click also clears here.
              onSelect={(id) => {
                if (id === null) leavePanel(clearSelection);
              }}
              editable
              edgesLocked={!auth.can}
              onPositionChange={handlePositionChange}
              onDependencyChange={handleDependencyChange}
              onArrange={handleArrange}
              onInit={(instance) => {
                flowRef.current = instance;
                // A deep link on the Map (already selected): bring its node into view.
                if (deepLinked) void instance.fitView({ nodes: [{ id: deepLinked }], maxZoom: 1, duration: 200 });
              }}
              highlightedIds={highlightedIds}
              selectedIds={selectedIds}
              onSelectionChange={handleSelectionChange}
            />
            {filtered.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-muted">{noMatchWords}</p>
              </div>
            ) : null}
            {bulk}
            {mapPanelFull && selected && selectedScenarios.length <= 1 ? (
              // Full view: the panel over the map, which stays mounted (its zoom and position
              // are where they were when the panel collapses back beside it).
              <div className="absolute inset-0 z-20 flex bg-panel" data-scenario-panel-overlay>
                {panel(true, { on: true, toggle: () => setMapPanelFull(false) })}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {view === "map" && creating ? newReview() : view === "map" && !mapPanelFull && selected && selectedScenarios.length <= 1 ? panel(false, { on: false, toggle: () => setMapPanelFull(true) }) : null}
    </div>
  );
}

