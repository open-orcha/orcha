import { Layers } from "../map/kit/icons";
import { PLATFORM_LABELS, PlatformIcon, cn, type TargetKind } from "../map/kit";
import type { ScenarioOutcome } from "./adapt";

/** One cell of a scenario's status strip. */
export interface PlatformStatus {
  kind: TargetKind;
  /** Newest result on this platform; null = never run here. */
  outcome: ScenarioOutcome | null;
  /** The newest result could not be judged because the checks do not fit here. */
  noFit?: boolean;
}

/** "Sign in (iOS)" → "Sign in": the platform is shown as a mark, so the name does not repeat it. */
export function displayScenarioName(name: string, targetKind: TargetKind | null | undefined): string {
  if (!targetKind) return name;
  const stripped = name.replace(/\s*[([]\s*(?:web|ios|android|desktop)\s*(?:only)?\s*[)\]]\s*$/i, "").trim();
  return stripped || name;
}

const OUTCOME_WORD: Record<ScenarioOutcome, string> = {
  pass: "passed",
  fail: "failed",
  blocked: "blocked",
  inconclusive: "inconclusive",
};

/** The mark's colour says the result: green passed, red failed or blocked, amber a warning,
 * muted never run here. */
function tone(outcome: ScenarioOutcome | null): string {
  if (!outcome) return "text-muted opacity-60";
  if (outcome === "pass") return "text-success";
  if (outcome === "fail" || outcome === "blocked") return "text-danger";
  return "text-warning";
}

/** The newest result on a platform in words. */
function resultWord(s: PlatformStatus): string {
  if (s.noFit) return "criteria don't fit";
  return s.outcome ? OUTCOME_WORD[s.outcome] : "never run";
}

/** "iOS: passed" / "Android: never run". */
export function platformStatusLabel(s: PlatformStatus): string {
  return `${PLATFORM_LABELS[s.kind]}: ${resultWord(s)}`;
}

/**
 * A scenario's result on each platform it applies to, as a row of platform marks coloured by
 * the newest result there.
 */
export function PlatformStatusStrip({
  statuses,
  className,
  showLabels = false,
}: {
  statuses: PlatformStatus[];
  className?: string;
  /** Names each platform beside its mark (the scenario panel); the canvas node shows marks. */
  showLabels?: boolean;
}) {
  if (statuses.length === 0) return null;
  return (
    <span
      className={cn("inline-flex items-center gap-1", showLabels && "gap-1.5", className)}
      role="list"
      aria-label="Result per platform"
      data-platform-strip
    >
      {statuses.map((s) => (
        <span
          key={s.kind}
          role="listitem"
          title={platformStatusLabel(s)}
          aria-label={platformStatusLabel(s)}
          data-platform-status={s.kind}
          data-outcome={s.outcome ?? "none"}
          className={cn(
            "inline-flex h-[18px] items-center gap-0.5 rounded-full border border-border px-1 text-[11px] leading-none",
            showLabels && "h-6 gap-1 px-2 text-xs",
          )}
        >
          <PlatformIcon kind={s.kind} className={cn("size-3", tone(s.outcome))} />
          {showLabels ? (
            <span className="text-fg-2">
              {PLATFORM_LABELS[s.kind]}{" "}
              <span className={cn(s.outcome ? tone(s.outcome) : "text-muted")}>
                {resultWord(s)}
              </span>
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** "All platforms" or "iOS only": what a scenario's platform pin means, as a quiet chip. */
export function PlatformScopeChip({ kind, className }: { kind: TargetKind | null | undefined; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] leading-none text-fg-2",
        className,
      )}
      data-platform-scope={kind ?? "all"}
      title={kind ? `Runs only on ${PLATFORM_LABELS[kind]}` : "Runs on every platform of the project"}
    >
      {kind ? <PlatformIcon kind={kind} className="size-3" /> : <Layers aria-hidden className="size-3" />}
      {kind ? `${PLATFORM_LABELS[kind]} only` : "All platforms"}
    </span>
  );
}
