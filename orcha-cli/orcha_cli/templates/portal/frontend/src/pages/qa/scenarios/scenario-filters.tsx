
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ListFilter, X } from "../map/kit/icons";
import { Button, Select, StatusGlyph, cn, type GlyphStatus } from "../map/kit";
import type { Scenario } from "./adapt";
import { EFFECTIVE_STATUSES, STATUS_LABEL, effectiveStatus, type EffectiveStatus, type StatusRow } from "./scenario-status";
import { ScenarioStatusIcon } from "./scenario-status-control";

export interface ScenarioFilterValues {
  category: string;
  /** Lifecycle statuses to show. Empty = every status but Retired, which is hidden until ticked. */
  statuses: EffectiveStatus[];
  health: ScenarioHealth | "";
  hasDepsOnly: boolean;
}

type ScenarioHealth = NonNullable<Scenario["health"]>;
const SCENARIO_HEALTHS: readonly ScenarioHealth[] = ["healthy", "flaky", "failing"];
const HEALTH_GLYPH: Record<ScenarioHealth, GlyphStatus> = { healthy: "pass", flaky: "flaky", failing: "fail" };
const HEALTH_WORD: Record<ScenarioHealth, string> = { healthy: "stable", flaky: "flaky", failing: "failing" };

export const EMPTY_FILTERS: ScenarioFilterValues = {
  category: "",
  statuses: [],
  health: "",
  hasDepsOnly: false,
};

/** Whether the status filter shows a scenario: the ticked statuses, or (none ticked) every
 * status but Retired. */
export function inStatusFilter(s: StatusRow, statuses: readonly EffectiveStatus[]): boolean {
  const e = effectiveStatus(s);
  return statuses.length === 0 ? e !== "retired" : statuses.includes(e);
}

/** How many scenarios have each effective status (the filter's counts). */
export function statusCounts(scenarios: readonly StatusRow[]): Partial<Record<EffectiveStatus, number>> {
  const out: Partial<Record<EffectiveStatus, number>> = {};
  for (const s of scenarios) {
    const e = effectiveStatus(s);
    out[e] = (out[e] ?? 0) + 1;
  }
  return out;
}

/** Active filters as short chip labels, in toolbar order. */
export function activeFilterChips(
  f: ScenarioFilterValues,
): { key: keyof ScenarioFilterValues; label: string }[] {
  const out: { key: keyof ScenarioFilterValues; label: string }[] = [];
  if (f.category) out.push({ key: "category", label: f.category });
  if (f.statuses.length) out.push({ key: "statuses", label: f.statuses.map((s) => STATUS_LABEL[s]).join(", ") });
  if (f.health) out.push({ key: "health", label: `Health: ${HEALTH_WORD[f.health]}` });
  if (f.hasDepsOnly) out.push({ key: "hasDepsOnly", label: "Has dependencies" });
  return out;
}

/**
 * Compact toolbar filters: one "Filters" button with a count badge, a popover holding
 * the selects, and a chip per active filter (each with its own clear) so the toolbar
 * stays one row tall however many filters exist.
 */
export function ScenarioFilters({
  value,
  onChange,
  categories,
  counts = {},
}: {
  value: ScenarioFilterValues;
  onChange: (next: ScenarioFilterValues) => void;
  categories: string[];
  /** Scenarios per effective status, shown beside each status. */
  counts?: Partial<Record<EffectiveStatus, number>>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const chips = activeFilterChips(value);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Element;
      // A Select's options render in a portal: a press there is still "inside".
      if (t.closest?.("[data-select-menu]")) return;
      if (ref.current && !ref.current.contains(t)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function clear(key: keyof ScenarioFilterValues) {
    onChange({ ...value, [key]: EMPTY_FILTERS[key] });
  }

  function toggleStatus(s: EffectiveStatus) {
    const on = value.statuses.includes(s);
    onChange({ ...value, statuses: on ? value.statuses.filter((x) => x !== s) : EFFECTIVE_STATUSES.filter((x) => x === s || value.statuses.includes(x)) });
  }

  return (
    <div ref={ref} className="relative flex items-center gap-1.5" data-scenario-filters>
      <Button
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-filters-toggle
      >
        <ListFilter /> Filters
        {chips.length > 0 ? (
          <span
            className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-selected px-1 text-[11px] font-medium tabular leading-none text-fg"
            data-filters-count
          >
            {chips.length}
          </span>
        ) : null}
        <ChevronDown className="size-3" />
      </Button>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-border-strong bg-selected pl-2.5 pr-1 text-xs font-medium text-fg"
          data-filter-chip={chip.key}
        >
          {chip.label}
          <button
            type="button"
            onClick={() => clear(chip.key)}
            aria-label={`Clear ${chip.label} filter`}
            className="rounded-full p-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <div
        role="dialog"
        aria-label="Scenario filters"
        data-filters-popover
        className={cn(
          "absolute left-0 top-full z-20 mt-1.5 flex w-[260px] max-w-[calc(100vw-32px)] flex-col gap-2.5 rounded-lg border border-border bg-raised p-3 shadow-md",
          open ? "flex" : "hidden",
        )}
      >
        <label className="flex flex-col gap-1 text-xs text-muted">
          Category
          <Select
            dimension="sm"
            value={value.category}
            onChange={(e) => onChange({ ...value, category: e.target.value })}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </label>
        <fieldset className="flex flex-col gap-0.5" data-status-filter>
          <legend className="mb-1 text-xs text-muted">Status</legend>
          {EFFECTIVE_STATUSES.map((s) => (
            <label key={s} className="flex h-6 items-center gap-2 text-sm text-fg" data-status-filter-option={s}>
              <input
                type="checkbox"
                className="size-3.5 rounded-xs border-border accent-primary"
                checked={value.statuses.includes(s)}
                onChange={() => toggleStatus(s)}
              />
              <ScenarioStatusIcon status={s} className="size-3" />
              <span className="min-w-0 flex-1 truncate">{STATUS_LABEL[s]}</span>
              {counts[s] ? <span className="text-xs tabular text-muted">{counts[s]}</span> : null}
            </label>
          ))}
          {value.statuses.length === 0 && counts.retired ? (
            <p className="mt-0.5 text-xs text-muted" data-retired-hidden>
              {counts.retired} retired hidden. Tick Retired to see {counts.retired === 1 ? "it" : "them"}.
            </p>
          ) : null}
        </fieldset>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Health
          <Select
            dimension="sm"
            value={value.health}
            onChange={(e) => onChange({ ...value, health: e.target.value as ScenarioHealth | "" })}
            aria-label="Filter by health"
            data-health-filter
            options={[{ value: "", label: "All health" }, ...SCENARIO_HEALTHS.map((h) => ({ value: h, label: HEALTH_WORD[h], icon: <StatusGlyph status={HEALTH_GLYPH[h]} decorative /> }))]}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="size-3.5 rounded-xs border-border accent-primary"
            checked={value.hasDepsOnly}
            onChange={(e) => onChange({ ...value, hasDepsOnly: e.target.checked })}
            data-has-dependencies-filter
          />
          Has dependencies
        </label>
        <div className="flex items-center justify-between border-t border-border pt-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(EMPTY_FILTERS)}
            disabled={chips.length === 0}
            data-filters-clear
          >
            Clear all
          </Button>
          <Button size="sm" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
