import { useRef, type KeyboardEvent } from "react";
import type { TargetKind } from "../types";
import type { ScenarioVerdict } from "../lib/verdict";
import { cn } from "../../map/kit";
import { railKeyTarget, railSummary } from "./scenario-rail-model";
import { VerdictIcon } from "./verdict-icon";

export interface ScenarioRailItem {
  scenarioId: string;
  name: string;
  targetKind: TargetKind | null;
  verdict: ScenarioVerdict;
  /** Criteria passed and recorded, for the row's "2/3" tally. */
  passed?: number;
  total?: number;
}

/** A scenario that already passed on the run this one resumes (recovery §3). */
export interface PassedEarlierItem {
  scenarioId: string;
  name: string;
}

/**
 * The scenario navigator of a run that reports on more than one scenario (#158).
 *
 * a7d24485 dropped the old verdict-grouped rail on the grounds that the batch bar's dropdown
 * navigates between scenarios. That holds for a fan-out batch, where each scenario is its own
 * run, but a single run with several scenario results has no batch bar, which left only its
 * first scenario reachable. This brings a navigator back in a quieter form: one list in run
 * order, each row a verdict glyph, the name and a criteria tally, so a five-scenario run reads
 * like a short table of contents rather than a second sidebar.
 *
 * It is a listbox whose selection follows focus (arrows, Home, End), so a keyboard reader moves
 * through the cards the way they would through tabs. Beside the card from md up; above it, full
 * width and capped in height, on a phone where the panes stack.
 */
export function ScenarioRail({
  items,
  selectedId,
  onSelect,
}: {
  items: readonly ScenarioRailItem[];
  selectedId: string | null;
  onSelect: (scenarioId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    items.findIndex((i) => i.scenarioId === selectedId),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = railKeyTarget(e.key, selectedIndex, items.length);
    if (next == null) return;
    e.preventDefault();
    const item = items[next];
    if (!item) return;
    onSelect(item.scenarioId);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-scenario-row="${CSS.escape(item.scenarioId)}"]`)
      ?.focus();
  };

  return (
    <nav
      aria-label="Scenarios in this run"
      data-scenario-rail
      className="flex shrink-0 flex-col border-border md:w-64 md:border-r max-md:max-h-[40vh] max-md:border-b"
    >
      <div className="flex items-baseline justify-between gap-2 px-4 pt-3.5 pb-1.5">
        <span className="text-xs font-medium text-fg-2">
          Scenarios <span className="tabular text-muted">{items.length}</span>
        </span>
        <span className="truncate text-xs text-muted" data-scenario-rail-summary>
          {railSummary(items.map((i) => i.verdict))}
        </span>
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Scenarios"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2"
      >
        {items.map((row, i) => {
          const selected = i === selectedIndex;
          return (
            <div
              key={row.scenarioId}
              role="option"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(row.scenarioId)}
              data-scenario-row={row.scenarioId}
              title={row.name}
              className={cn(
                "flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none",
                selected ? "bg-selected text-fg hover:bg-selected" : "text-fg-2",
              )}
            >
              <VerdictIcon verdict={row.verdict} />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {row.total != null && row.total > 0 ? (
                <span className="shrink-0 font-mono text-xs tabular text-muted">
                  {row.passed ?? 0}/{row.total}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
