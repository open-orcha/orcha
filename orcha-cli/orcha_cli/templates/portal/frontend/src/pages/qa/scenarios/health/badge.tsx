import { Archive, CopyX, History, Languages, PlugZap, ScanSearch, ServerCrash, TimerOff, Unplug } from "../../map/kit/icons";
import { cn } from "../../map/kit";
import { useProjectId } from "../context";
import { useStoredFlags } from "./health-store";
import { FLAG_LABEL, openFlags, type HealthFlag, type HealthFlagKind } from "./types";

export type { HealthAction, HealthAudit, HealthFlag, HealthFlagKind, HealthScenario } from "./types";
export { FLAG_LABEL, FLAG_ORDER, openFlags } from "./types";

export const FLAG_ICON: Record<HealthFlagKind, typeof ScanSearch> = {
  suspicious: ScanSearch,
  env_failing: ServerCrash,
  orphaned: Unplug,
  duplicate: CopyX,
  never_passed: TimerOff,
  stale: History,
  flaky: PlugZap,
  platform_wording: Languages,
};

const PILL =
  "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] font-medium leading-none text-fg-2";

/**
 * The compact scenario health pill (#188): the most urgent open flag of a scenario ("suspicious",
 * "environment", "duplicate"…) with every open flag's reason as the tooltip, and "+N" when there
 * are more. Renders nothing for a healthy scenario. Pass `flags` when you already have them (the
 * Health board, a batch tile that loaded them); otherwise the badge looks its scenario up through
 * a batched store (one request per render, however many badges). `flaky` is left out: the
 * quarantine pill beside it already says so.
 */
export function ScenarioHealthBadge({
  scenarioId,
  flags,
  archivedAt,
  className,
}: {
  scenarioId: string;
  flags?: readonly HealthFlag[] | null;
  /** When the scenario was retired : shown instead of any flag. */
  archivedAt?: string | null;
  className?: string;
}) {
  const cid = useProjectId();
  const stored = useStoredFlags(cid ?? "", scenarioId, !!cid && flags == null && !archivedAt);
  if (archivedAt) {
    return (
      <span className={cn(PILL, className)} title="Retired. It no longer runs. Restore it from its Status to bring it back." data-scenario-health-badge="retired">
        <Archive aria-hidden className="size-3 text-muted" strokeWidth={1.75} />
        retired
      </span>
    );
  }
  const open = openFlags(flags ?? stored).filter((f) => f.kind !== "flaky");
  if (open.length === 0) return null;
  const top = open[0];
  const Icon = FLAG_ICON[top.kind];
  const more = open.length - 1;
  const title = open.map((f) => `${FLAG_LABEL[f.kind].short}: ${f.reason}`).join("\n");
  return (
    <span className={cn(PILL, className)} title={title} data-scenario-health-badge={top.kind}>
      <Icon aria-hidden className={cn("size-3", top.kind === "suspicious" || top.kind === "env_failing" ? "text-warning" : "text-muted")} strokeWidth={1.75} />
      {FLAG_LABEL[top.kind].short}
      {more > 0 ? <span className="tabular text-muted">+{more}</span> : null}
      <span className="sr-only">. {title}</span>
    </span>
  );
}
