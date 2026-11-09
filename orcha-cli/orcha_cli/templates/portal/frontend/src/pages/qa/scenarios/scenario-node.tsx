
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Sparkles } from "../map/kit/icons";
import { StatusGlyph, cn, type TargetKind } from "../map/kit";
import type { ScenarioStatus } from "../qaApi";
import type { Scenario, ScenarioOutcome } from "./adapt";
import { ScenarioHealthBadge } from "./health/badge";
import { HealthBadge } from "./health-pill";
import { QuarantineBadge } from "./quarantine-badge";
import { PlatformStatusStrip, displayScenarioName, type PlatformStatus } from "./platform-status-strip";

export interface ScenarioNodeData extends Record<string, unknown> {
  name: string;
  category: string | null;
  status: ScenarioStatus;
  criteriaCount: number;
  /** The newest verdicts rolled up. */
  outcome: ScenarioOutcome | null;
  /** The platform the scenario belongs to. */
  targetKind?: TargetKind | null;
  /** Open suggested changes waiting for a person. */
  pending?: number;
  /** The result on the scenario's platform (one mark). */
  platformStatus?: PlatformStatus[];
  health?: Scenario["health"];
  quarantinedAt?: string | null;
  quarantineReason?: string | null;
  selected?: boolean;
}

const TARGET_LABEL: Record<TargetKind, string> = { web: "Web", ios: "iOS", android: "Android", desktop: "Desktop" };

/** category → series-1..4 token, stable via a small string hash so the same
 * category always gets the same colour across nodes, the legend and the
 * minimap. */
const SERIES_TOKENS = ["series-1", "series-2", "series-3", "series-4"] as const;

export function categorySeriesToken(category: string | null): (typeof SERIES_TOKENS)[number] {
  const key = category ?? "General";
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % SERIES_TOKENS.length;
  return SERIES_TOKENS[index];
}

const swatchBg: Record<(typeof SERIES_TOKENS)[number], string> = {
  "series-1": "bg-series-1",
  "series-2": "bg-series-2",
  "series-3": "bg-series-3",
  "series-4": "bg-series-4",
};

const STATUS_LABEL: Record<ScenarioStatus, string> = { draft: "Draft", validated: "Validated", paused: "Paused", retired: "Retired" };

/** Custom xyflow node for a scenario card. A calm Linear card: the latest outcome as a StatusGlyph, the name, then one meta row
 * (category chip, criteria, status, platform) with quiet indicators on the right. */
export function ScenarioNode({ id, data, selected }: NodeProps & { data: ScenarioNodeData }) {
  const outcome = data.outcome;
  const seriesToken = categorySeriesToken(data.category);
  return (
    <div
      data-scenario-node
      data-scenario-id={id}
      data-node-outcome={outcome ?? undefined}
      className={cn(
        "group relative flex w-[260px] flex-col gap-1.5 rounded-lg border border-border bg-panel px-3 py-2.5 transition-colors",
        "hover:border-border-strong hover:bg-raised",
        selected && "border-primary/70 bg-raised ring-2 ring-primary/25",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted" />
      <Handle type="source" position={Position.Right} className="!bg-muted" />
      <div className="flex min-w-0 items-center gap-2">
        <StatusGlyph
          status={outcome ?? "queued"}
          label={outcome ? `Latest outcome: ${outcome}` : "Not run yet"}
          className="size-3.5"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={data.name}>
          {displayScenarioName(data.name, data.targetKind)}
        </span>
        {data.platformStatus ? (
          // The mark of the scenario's platform, coloured by its result there.
          <span className="inline-flex shrink-0">
            <PlatformStatusStrip statuses={data.platformStatus} />
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted">
        <span
          className="inline-flex h-[18px] max-w-[100px] shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] leading-none text-fg-2"
          title={data.category ?? "General"}
        >
          <span
            aria-hidden
            data-category-swatch
            className={cn("inline-block size-[6px] shrink-0 rounded-full", swatchBg[seriesToken])}
          />
          <span className="truncate">{data.category ?? "General"}</span>
        </span>
        <span className="shrink-0 tabular">
          {data.criteriaCount} {data.criteriaCount === 1 ? "criterion" : "criteria"}
        </span>
        <span aria-hidden>·</span>
        <span className={cn("shrink-0", data.status === "validated" && "text-fg-2", data.status === "paused" && "text-info")} data-node-status={data.status}>
          {STATUS_LABEL[data.status] ?? data.status}
        </span>
        {data.platformStatus ? null : data.targetKind ? (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0" title={`Only runs against the ${TARGET_LABEL[data.targetKind]} target`} data-node-target-kind={data.targetKind}>
              {TARGET_LABEL[data.targetKind]}
            </span>
          </>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {data.pending ? (
            <span className="inline-flex shrink-0" title="Suggested changes waiting for review" data-node-suggestions={data.pending}>
              <Sparkles aria-label="Suggested changes waiting for review" className="size-3.5 text-accent" />
            </span>
          ) : null}
          <HealthBadge health={data.health} />
          <QuarantineBadge quarantinedAt={data.quarantinedAt} reason={data.quarantineReason} />
          {/* The scenario audit: agent tasks, duplicates, environment failures. */}
          <ScenarioHealthBadge scenarioId={id} />
        </span>
      </div>
    </div>
  );
}

export const scenarioNodeTypes = { scenario: ScenarioNode };
