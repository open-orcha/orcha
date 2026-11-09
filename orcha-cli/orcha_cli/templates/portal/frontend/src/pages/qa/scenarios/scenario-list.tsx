
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, ListChecks, Network, Rows3, Sparkles } from "../map/kit/icons";
import { StatusGlyph, cn } from "../map/kit";
import type { Scenario, ScenarioOutcome } from "./adapt";
import { PlatformStatusStrip, displayScenarioName, type PlatformStatus } from "./platform-status-strip";
import { ScenarioHealthBadge } from "./health/badge";
import { HealthBadge } from "./health-pill";
import { ScenarioStatusPill } from "./scenario-status-control";
import { effectiveStatus } from "./scenario-status";
import { categorySeriesToken } from "./scenario-node";

/** The Scenarios tab's layout: the dependency map or the list (`?sub=map`, `?sub=list`). */
export type ScenariosView = "map" | "list";

/** Past this many scenarios the map stops reading: the tab opens on the list. */
const MAP_MAX = 40;

export function parseScenariosView(raw: string | null | undefined, count = 0): ScenariosView {
  if (raw === "list" || raw === "map") return raw;
  return count > MAP_MAX ? "list" : "map";
}

/** The Map / List switch in the Scenarios toolbar, the same segmented shape as the platform filter. */
export function ScenariosViewToggle({ value, onChange }: { value: ScenariosView; onChange: (view: ScenariosView) => void }) {
  const options: { view: ScenariosView; label: string; icon: typeof Network }[] = [
    { view: "map", label: "Map", icon: Network },
    { view: "list", label: "List", icon: Rows3 },
  ];
  return (
    <div role="radiogroup" aria-label="View" className="inline-flex h-7 items-center rounded-md bg-panel-2 p-0.5" data-scenarios-view={value}>
      {options.map(({ view, label, icon: Icon }) => (
        <button
          key={view}
          type="button"
          role="radio"
          aria-checked={value === view}
          onClick={() => onChange(view)}
          data-view-option={view}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2.5 text-sm font-medium transition-colors duration-150 motion-reduce:transition-none",
            value === view ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

export interface ScenarioListItem {
  scenario: Scenario;
  outcome: ScenarioOutcome | null;
  platformStatus?: PlatformStatus[];
}

const swatchBg = { "series-1": "bg-series-1", "series-2": "bg-series-2", "series-3": "bg-series-3", "series-4": "bg-series-4" } as const;

/** Rows grouped by category (alphabetical), each group keeping the scenarios' own order. */
export function groupByCategory(items: readonly ScenarioListItem[]): { category: string; items: ScenarioListItem[] }[] {
  const groups = new Map<string, ScenarioListItem[]>();
  for (const item of items) {
    const key = item.scenario.category ?? "General";
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, list]) => ({ category, items: list }));
}

/** What a click does to the selection: plain selects one, ⌘/Ctrl toggles, Shift extends from the anchor. */
export function nextSelection(
  order: readonly string[],
  current: ReadonlySet<string>,
  anchor: string | null,
  id: string,
  mods: { toggle: boolean; range: boolean },
): Set<string> {
  if (mods.range && anchor && order.includes(anchor)) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    return new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
  }
  if (mods.toggle) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  return new Set([id]);
}
/** Outcome tally for a group header: how many failed, passed, are unclear or never ran. */
export function groupTally(items: readonly ScenarioListItem[]): { fail: number; pass: number; other: number; notRun: number } {
  const t = { fail: 0, pass: 0, other: 0, notRun: 0 };
  for (const i of items) {
    if (!i.outcome) t.notRun += 1;
    else if (i.outcome === "fail") t.fail += 1;
    else if (i.outcome === "pass") t.pass += 1;
    else t.other += 1;
  }
  return t;
}

/** The ids keyboard navigation walks: every row of the groups that are open. */
export function visibleOrder(groups: readonly { category: string; items: readonly ScenarioListItem[] }[], collapsed: ReadonlySet<string>): string[] {
  return groups.filter((g) => !collapsed.has(g.category)).flatMap((g) => g.items.map((i) => i.scenario.id));
}

function readCollapsed(key: string | undefined): Set<string> {
  if (!key) return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(key: string | undefined, collapsed: ReadonlySet<string>): void {
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify([...collapsed]));
  } catch {
    /* storage is a convenience */
  }
}

const COLS = "grid-cols-[minmax(0,1fr)_64px_104px_220px] max-lg:grid-cols-[minmax(0,1fr)_200px]";

/**
 * The Scenarios tab's list view: every scenario as a row, grouped by category in collapsible
 * sections (the open/closed state is remembered per project in this browser). With nothing
 * open it spans the page; with a scenario open it narrows to a rail and the details take the
 * rest of the width. ↑/↓ move through the open rows.
 */
export function ScenarioList({
  items,
  selectedIds,
  onSelectionChange,
  compact,
  storageKey,
}: {
  items: readonly ScenarioListItem[];
  selectedIds: ReadonlySet<string>;
  onSelectionChange: (ids: Set<string>) => void;
  /** A scenario is open beside the list: show the narrow rail. */
  compact: boolean;
  /** Where the collapsed groups are remembered (per project); none: not remembered. */
  storageKey?: string;
}) {
  const groups = useMemo(() => groupByCategory(items), [items]);
  // Starts open (what the server renders); the remembered state is read after mount so the
  // first client render matches the server's HTML.
  const [collapsed, setCollapsedState] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only storage read after hydration
    setCollapsedState(readCollapsed(storageKey));
  }, [storageKey]);
  const setCollapsed = (next: Set<string>) => {
    setCollapsedState(next);
    writeCollapsed(storageKey, next);
  };
  const order = useMemo(() => visibleOrder(groups, collapsed), [groups, collapsed]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const single = selectedIds.size === 1 ? [...selectedIds][0] : null;

  // A selected scenario (a click on the map, a ?scenario= link) opens its group.
  const selectedGroup = single ? (items.find((i) => i.scenario.id === single)?.scenario.category ?? "General") : null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (single && single !== openedFor && selectedGroup && collapsed.has(selectedGroup)) {
    setOpenedFor(single);
    const next = new Set(collapsed);
    next.delete(selectedGroup);
    setCollapsedState(next);
  }

  useEffect(() => {
    if (!single) return;
    listRef.current?.querySelector(`[data-scenario-row="${CSS.escape(single)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [single]);

  function select(id: string, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) {
    onSelectionChange(nextSelection(order, selectedIds, anchor, id, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey }));
    if (!e.shiftKey) setAnchor(id);
  }

  function toggleGroup(category: string) {
    const next = new Set(collapsed);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    setCollapsed(next);
  }

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.category));

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.target !== e.currentTarget) return; // a group header button handles its own keys
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (order.length === 0) return;
    e.preventDefault();
    const at = single ? order.indexOf(single) : -1;
    const to = e.key === "ArrowDown" ? Math.min(order.length - 1, at + 1) : Math.max(0, at === -1 ? 0 : at - 1);
    onSelectionChange(new Set([order[to]]));
    setAnchor(order[to]);
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Scenarios"
      aria-multiselectable
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        "min-h-0 overflow-y-auto pb-6 outline-none",
        compact ? "w-[340px] shrink-0 border-r border-border max-md:hidden" : "flex-1",
      )}
      data-scenario-list={compact ? "compact" : "full"}
    >
      <div className={cn("sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-bg/95 px-4.5 py-1.5 text-xs text-muted backdrop-blur", !compact && "grid", !compact && COLS)}>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.category)))}
            className="inline-flex items-center gap-1 rounded-xs px-1 py-0.5 text-muted transition-colors hover:bg-raised hover:text-fg"
            data-scenario-groups-toggle={allCollapsed ? "expand" : "collapse"}
          >
            {allCollapsed ? <ChevronsUpDown aria-hidden className="size-3.5" /> : <ChevronsDownUp aria-hidden className="size-3.5" />}
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
          <span className="tabular">{items.length} scenarios</span>
        </span>
        {!compact ? (
          <>
            <span className="max-lg:hidden">Criteria</span>
            <span className="max-lg:hidden">Status</span>
            <span className="text-right">Platforms</span>
          </>
        ) : null}
      </div>
      {groups.map((group) => {
        const open = !collapsed.has(group.category);
        const tally = groupTally(group.items);
        const groupId = `scenario-group-${group.category.replace(/[^A-Za-z0-9_-]/g, "-")}`;
        return (
          <div key={group.category} role="group" aria-label={group.category} data-scenario-group={group.category} data-open={open ? "" : undefined}>
            <button
              type="button"
              onClick={() => toggleGroup(group.category)}
              aria-expanded={open}
              aria-controls={groupId}
              className="group/header sticky top-[29px] z-10 flex w-full items-center gap-2 border-b border-transparent bg-bg/95 px-4.5 py-2 text-left backdrop-blur transition-colors hover:bg-raised/60"
              data-scenario-group-toggle={group.category}
            >
              <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
              <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full", swatchBg[categorySeriesToken(group.category)])} />
              <span className="truncate text-[13px] font-medium text-fg">{group.category}</span>
              <span className="rounded-full bg-panel-2 px-1.5 font-mono text-[11px] tabular leading-[18px] text-muted">{group.items.length}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[11px] tabular text-muted" aria-label={`${tally.fail} failing, ${tally.pass} passing, ${tally.notRun} not run`}>
                {tally.fail ? <span className="inline-flex items-center gap-1"><StatusGlyph status="fail" decorative className="size-3" />{tally.fail}</span> : null}
                {tally.pass ? <span className="inline-flex items-center gap-1"><StatusGlyph status="pass" decorative className="size-3" />{tally.pass}</span> : null}
                {tally.other ? <span className="inline-flex items-center gap-1"><StatusGlyph status="warning" decorative className="size-3" />{tally.other}</span> : null}
                {tally.notRun && !compact ? <span className="max-sm:hidden">{tally.notRun} not run</span> : null}
              </span>
            </button>
            {open ? (
              // Its scenarios hang under the header like children: indented, on a guide line
              // that drops from the header's chevron.
              <div id={groupId} className="relative mb-1 ml-[25px] border-l border-border/70 pl-1" data-scenario-group-children>
                {group.items.map((item) => (
                  <Row key={item.scenario.id} item={item} compact={compact} selected={selectedIds.has(item.scenario.id)} onSelect={select} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Row({
  item,
  compact,
  selected,
  onSelect,
}: {
  item: ScenarioListItem;
  compact: boolean;
  selected: boolean;
  onSelect: (id: string, e: React.MouseEvent) => void;
}) {
  const { scenario: s, outcome, platformStatus } = item;
  const name = displayScenarioName(s.name, s.target_kind);
  const description = s.description && s.description.trim() !== s.name.trim() ? s.description : null;
  // The pill says the status, with the reason on hover.
  const status = effectiveStatus(s);
  const draft = status === "draft" || status === "retired";
  const marks = (
    <span className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5">
      {s.pending ? (
        <span title="Suggested changes waiting for review" className="inline-flex" data-row-suggestions={s.pending}>
          <Sparkles aria-label="Suggested changes waiting for review" className="size-3.5 text-accent" />
        </span>
      ) : null}
      <HealthBadge health={s.health} />
      {status === "retired" ? null : <ScenarioHealthBadge scenarioId={s.id} />}
      {platformStatus ? <PlatformStatusStrip statuses={platformStatus} /> : null}
    </span>
  );
  const statusPill = status === "validated" ? null : <ScenarioStatusPill scenario={s} />;
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={(e) => onSelect(s.id, e)}
      data-scenario-row={s.id}
      className={cn(
        "group/row relative ml-1 mr-2 cursor-default rounded-md py-1.5 pl-[34px] pr-3 transition-colors duration-100 motion-reduce:transition-none",
        selected ? "bg-selected" : "hover:bg-raised",
        !compact && cn("grid items-center gap-3", COLS),
      )}
    >
      <StatusGlyph
        status={outcome ?? "queued"}
        label={outcome ? `Latest outcome: ${outcome}` : "Not run yet"}
        className="absolute left-3 top-[9px] size-3.5"
      />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate text-[13px] font-medium", draft ? "text-fg-2" : "text-fg")} title={s.name}>
            {name}
          </span>
          {compact ? statusPill : null}
        </div>
        {compact ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
            <span className="tabular">{s.criteria.length} criteria</span>
            <span className="ml-auto">{marks}</span>
          </div>
        ) : description ? (
          <div className="mt-px truncate text-xs text-muted/90" title={description}>
            {description}
          </div>
        ) : null}
      </div>
      {!compact ? (
        <>
          <span className="inline-flex items-center gap-1 text-xs tabular text-muted max-lg:hidden" title={`${s.criteria.length} acceptance ${s.criteria.length === 1 ? "criterion" : "criteria"}`}>
            <ListChecks aria-hidden className="size-3.5" />
            {s.criteria.length}
          </span>
          <span className="min-w-0 max-lg:hidden">{statusPill ?? <span className="text-xs text-muted/60">Validated</span>}</span>
          {marks}
        </>
      ) : null}
    </div>
  );
}
