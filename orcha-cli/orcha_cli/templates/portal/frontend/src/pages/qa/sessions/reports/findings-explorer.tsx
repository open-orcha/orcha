import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Moon, Search, Sun, X } from "../../map/kit/icons";
import { Input } from "../../map/kit";
import { Select } from "../../map/kit";
import { severityDot } from "../../map/kit";
import { appearanceLabel, countSeverity } from "./exploration";
import {
  EMPTY_FILTER,
  ITEM_HEIGHT,
  buildListItems,
  filterFindings,
  filterOptions,
  groupIds,
  isFilterActive,
  itemOffsets,
  nextRowIndex,
  scrollToReveal,
  toggleSeverity,
  visibleRange,
  type FindingFilter,
  type ListItem,
  type ListSection,
} from "./exploration-list";
import { sevOrder } from "../../map/kit";
import { cn } from "../../map/kit";
import type { ExplorationFinding } from "./types";
import { FindingDetailPanel } from "./finding-detail-panel";
import { DenseFindingRow } from "./finding-row";
import { SeverityBar } from "./severity-bar";

const ALL = "__all__";

/** Is this key event aimed at something that wants the keys for itself? */
function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return target.closest('[role="listbox"], [role="menu"], dialog') != null;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-xs border border-border bg-panel-2 px-1 font-mono text-2xs leading-none text-fg-2">
      {children}
    </kbd>
  );
}

function MiniSeverity({ counts, total }: { counts: Record<string, number>; total: number }) {
  return (
    <span aria-hidden className="hidden h-1 w-14 overflow-hidden rounded-full bg-panel-2 sm:flex">
      {sevOrder.map((s) =>
        counts[s] ? (
          <span key={s} className={severityDot[s]} style={{ width: `${(counts[s] / Math.max(1, total)) * 100}%` }} />
        ) : null,
      )}
    </span>
  );
}

function HeaderItem({
  item,
  style,
  onToggle,
}: {
  item: Exclude<ListItem, { type: "row" }>;
  style: CSSProperties;
  onToggle: (id: string) => void;
}) {
  if (item.type === "section") {
    const { section } = item;
    const tone = section.tone;
    return (
      <div
        style={style}
        className="flex items-end gap-2 px-2.5 pb-1.5"
        data-finding-group={section.key}
        data-diff-group={tone === "worse" || tone === "better" || tone === "same" ? tone : undefined}
      >
        {tone ? (
          <i
            aria-hidden
            className={cn(
              "mb-[5px] inline-block size-1.5 shrink-0 rounded-full",
              tone === "worse" && "bg-danger",
              tone === "better" && "bg-success",
              (tone === "same" || tone === "muted") && "bg-muted/50",
            )}
          />
        ) : null}
        <h3 className="shrink-0 text-sm font-semibold text-fg">{section.title}</h3>
        <span className="shrink-0 text-sm tabular text-muted">{item.count}</span>
        {section.description ? (
          <span className="min-w-0 truncate text-xs text-muted" title={section.description}>
            {section.description}
          </span>
        ) : null}
      </div>
    );
  }

  const isCheck = item.type === "check";
  return (
    <button
      type="button"
      style={style}
      onClick={() => onToggle(item.id)}
      aria-expanded={!item.collapsed}
      data-check-group={isCheck ? item.kind : undefined}
      data-screen-group={isCheck ? undefined : item.screen}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md pr-2.5 text-left transition-colors duration-[90ms] hover:bg-hover",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isCheck ? "pl-2 text-sm" : "pl-5 text-xs",
      )}
    >
      <ChevronRight
        aria-hidden
        className={cn("size-3 shrink-0 text-muted transition-transform", !item.collapsed && "rotate-90")}
      />
      <span className={cn("truncate", isCheck ? "font-medium text-fg" : "text-fg-2")}>{item.label}</span>
      <span className={cn("shrink-0 tabular text-muted", isCheck ? "text-sm" : "text-xs")}>{item.count}</span>
      {item.rows !== item.count ? (
        <span className="shrink-0 text-xs text-muted" title="Rows after merging identical findings">
          · {item.rows} unique
        </span>
      ) : null}
      {isCheck ? (
        <span className="ml-auto flex items-center">
          <MiniSeverity counts={item.bySeverity} total={item.count} />
        </span>
      ) : null}
    </button>
  );
}

/**
 * The findings list every findings tab shares: filters and search on top, the
 * severity bar as a filter, then the findings merged, grouped by check and screen
 * into 36px rows — only the rows in the viewport are rendered — and a detail panel
 * on the right for the selected row.
 *
 * `j`/`k` move the selection, Enter opens the panel, Esc closes it. The keys are
 * listened for on the window (Linear-style, no need to focus the list first) but
 * ignored while typing, inside a menu or a dialog, or when the list is hidden.
 *
 * `sections` must be stable across renders (memoised by the caller): everything
 * below is derived from it.
 */
export function FindingsExplorer({
  sections,
  filter,
  onFilterChange,
  severityFindings,
  testId,
}: {
  sections: readonly ListSection[];
  filter: FindingFilter;
  onFilterChange: (next: FindingFilter) => void;
  /** Findings the severity bar counts; omit to hide the bar. */
  severityFindings?: readonly ExplorationFinding[];
  testId: string;
}) {
  const all = useMemo(() => sections.flatMap((s) => s.findings), [sections]);
  const options = useMemo(() => filterOptions(all), [all]);
  const filtered = useMemo(
    () => sections.map((s) => ({ ...s, findings: filterFindings(s.findings, filter) })),
    [sections, filter],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(() => buildListItems(filtered, collapsed), [filtered, collapsed]);
  const offsets = useMemo(() => itemOffsets(items), [items]);
  const total = offsets[offsets.length - 1] ?? 0;
  const shownFindings = filtered.reduce((n, s) => n + s.findings.length, 0);
  const shownRows = items.reduce((n, i) => n + (i.type === "row" ? 1 : 0), 0);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const selectedIndex = selectedId ? items.findIndex((i) => i.id === selectedId) : -1;
  const selected = selectedIndex >= 0 ? items[selectedIndex] : null;
  const panelRow = panelOpen && selected?.type === "row" ? selected.row : null;

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // A first guess for the server render and the first paint; measured right after.
  const [viewport, setViewport] = useState(640);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight || 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new filter is a new list: start it at the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [filter]);

  const { start, end } = visibleRange(offsets, scrollTop, viewport);

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allCollapsed = collapsed.size > 0;
  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(groupIds(items)));

  const select = (index: number, open?: boolean) => {
    const item = items[index];
    if (!item || item.type !== "row") return;
    setSelectedId(item.id);
    if (open != null) setPanelOpen(open);
    const el = scrollRef.current;
    if (!el) return;
    const top = scrollToReveal(offsets, index, el.scrollTop, el.clientHeight, ITEM_HEIGHT.screen);
    if (top != null) el.scrollTop = top;
    // Keep keyboard focus with the selection when the list has it.
    if (el.contains(document.activeElement)) {
      requestAnimationFrame(() => {
        el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(item.id)}"] button`)?.focus({ preventScroll: true });
      });
    }
  };

  // The latest key handler, so the window listener is attached once.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    onKeyRef.current = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (ownsKeys(e.target) || document.querySelector("dialog[open]")) return;
      const root = rootRef.current;
      if (!root || root.offsetParent === null) return;
      const inList = root.contains(e.target as Node);
      if (e.key === "j" || (inList && e.key === "ArrowDown")) {
        e.preventDefault();
        select(nextRowIndex(items, selectedIndex, 1));
      } else if (e.key === "k" || (inList && e.key === "ArrowUp")) {
        e.preventDefault();
        select(nextRowIndex(items, selectedIndex, -1));
      } else if (e.key === "Enter") {
        // A focused button already turns Enter into its own click.
        if (e.target instanceof HTMLElement && e.target.closest("button, a")) return;
        if (selectedIndex < 0) {
          const first = nextRowIndex(items, -1, 1);
          if (first >= 0) {
            e.preventDefault();
            select(first, true);
          }
        } else if (selectedId) {
          e.preventDefault();
          setPanelOpen((v) => !v);
        }
      } else if (e.key === "Escape" && panelOpen) {
        e.preventDefault();
        setPanelOpen(false);
      }
    };
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const set = (patch: Partial<FindingFilter>) => onFilterChange({ ...filter, ...patch });
  const severityCounts = useMemo(
    () => (severityFindings ? countSeverity(severityFindings) : null),
    [severityFindings],
  );

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-3" data-findings-explorer={testId}>
      <div className="flex flex-wrap items-center gap-2" data-findings-toolbar>
        <label className="relative min-w-[160px] max-w-[260px] flex-1">
          <span className="sr-only">Search findings</span>
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <Input
            type="search"
            value={filter.query}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filter.query) {
                e.preventDefault();
                set({ query: "" });
              }
            }}
            placeholder="Search element, sentence, check"
            className="pl-7"
            data-findings-search
          />
        </label>
        {options.kinds.length > 1 || filter.kind ? (
          <Select
            aria-label="Check"
            value={filter.kind ?? ALL}
            onValueChange={(v) => set({ kind: v === ALL ? null : v })}
            options={[
              { value: ALL, label: "All checks", hint: String(all.length) },
              ...options.kinds.map((k) => ({ value: k.kind, label: k.label, hint: String(k.count) })),
            ]}
            data-findings-filter="check"
            wrapperClassName="w-auto max-w-[240px]"
            menuClassName="min-w-[260px]"
          />
        ) : null}
        {options.screens.length > 1 || filter.screen ? (
          <Select
            aria-label="Screen"
            value={filter.screen ?? ALL}
            onValueChange={(v) => set({ screen: v === ALL ? null : v })}
            options={[
              { value: ALL, label: "All screens", hint: String(options.screens.length) },
              ...options.screens.map((s) => ({ value: s.screen, label: s.label, hint: String(s.count) })),
            ]}
            data-findings-filter="screen"
            wrapperClassName="w-auto max-w-[220px]"
            menuClassName="min-w-[260px]"
          />
        ) : null}
        {options.appearances.length > 1 || filter.appearance ? (
          <div className="flex h-7 items-center rounded-md border border-border-strong p-0.5" role="group" aria-label="Appearance">
            {[null, ...options.appearances].map((a) => (
              <button
                key={a ?? "all"}
                type="button"
                aria-pressed={filter.appearance === a}
                onClick={() => set({ appearance: a })}
                data-findings-filter-appearance={a ?? "all"}
                className={cn(
                  "inline-flex h-full items-center gap-1 rounded-[4px] px-2 text-xs transition-colors",
                  filter.appearance === a ? "bg-selected text-fg" : "text-muted hover:text-fg",
                )}
              >
                {a === "dark" ? <Moon className="size-3" aria-hidden /> : a === "light" ? <Sun className="size-3" aria-hidden /> : null}
                {a ? appearanceLabel(a) : "All"}
              </button>
            ))}
          </div>
        ) : null}
        {isFilterActive(filter) ? (
          <button
            type="button"
            onClick={() => onFilterChange(EMPTY_FILTER)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-fg"
            data-findings-clear
          >
            <X className="size-3" aria-hidden />
            Clear
          </button>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted">
          <span className="tabular" data-findings-shown>
            {shownRows} {shownRows === 1 ? "row" : "rows"} · {shownFindings} {shownFindings === 1 ? "finding" : "findings"}
          </span>
          <button
            type="button"
            onClick={toggleAll}
            title={allCollapsed ? "Expand all groups" : "Collapse all groups"}
            aria-label={allCollapsed ? "Expand all groups" : "Collapse all groups"}
            className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-fg"
          >
            {allCollapsed ? <ChevronsUpDown className="size-3.5" aria-hidden /> : <ChevronsDownUp className="size-3.5" aria-hidden />}
          </button>
        </span>
      </div>

      {severityCounts && severityFindings && severityFindings.length > 0 ? (
        <SeverityBar
          counts={severityCounts}
          total={severityFindings.length}
          selected={filter.severities}
          onToggle={(s) => onFilterChange(toggleSeverity(filter, s))}
          className="rounded-md border border-border bg-panel px-3 pb-1.5 pt-3"
        />
      ) : null}

      <div className={cn("grid items-start gap-3", panelRow && "xl:grid-cols-[minmax(0,1fr)_360px]")}>
        <div className="min-w-0 rounded-lg border border-border bg-panel">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-sm text-muted" data-findings-empty>
              No findings match these filters.
              <button
                type="button"
                onClick={() => onFilterChange(EMPTY_FILTER)}
                className="text-xs text-fg-2 underline-offset-2 hover:underline"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div
              ref={scrollRef}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              className="max-h-[min(72vh,760px)] overflow-y-auto overscroll-contain"
              data-findings-scroll
            >
              <div className="relative" style={{ height: total }} data-findings-list>
                {items.slice(start, end).map((item, i) => {
                  const index = start + i;
                  const style: CSSProperties = {
                    position: "absolute",
                    top: offsets[index],
                    left: 4,
                    right: 4,
                    height: offsets[index + 1] - offsets[index],
                  };
                  if (item.type !== "row") {
                    return <HeaderItem key={item.id} item={item} style={style} onToggle={toggleGroup} />;
                  }
                  return (
                    <div key={item.id} style={style} data-item-id={item.id} className="py-px">
                      <DenseFindingRow
                        row={item.row}
                        sectionKey={item.sectionKey}
                        selected={item.id === selectedId}
                        onSelect={() => {
                          const reopen = !(panelOpen && item.id === selectedId);
                          setSelectedId(item.id);
                          setPanelOpen(reopen);
                        }}
                        style={{ height: "100%" }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="hidden items-center gap-3 border-t border-border px-3 py-1.5 text-2xs text-muted sm:flex">
            <span className="flex items-center gap-1">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd>
              move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Enter</Kbd>
              details
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd>
              close
            </span>
          </div>
        </div>

        {panelRow ? (
          <>
            <div aria-hidden className="fixed inset-0 z-30 bg-black/25 xl:hidden" onClick={() => setPanelOpen(false)} />
            <div
              className={cn(
                "fixed inset-y-0 right-0 z-40 w-[min(400px,100vw)] overflow-y-auto border-l border-border-strong bg-raised shadow-md",
                "xl:sticky xl:inset-auto xl:top-4 xl:z-auto xl:max-h-[min(72vh,760px)] xl:w-auto xl:rounded-lg xl:border xl:border-border xl:bg-panel xl:shadow-none",
              )}
            >
              <FindingDetailPanel key={panelRow.key} row={panelRow} onClose={() => setPanelOpen(false)} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
