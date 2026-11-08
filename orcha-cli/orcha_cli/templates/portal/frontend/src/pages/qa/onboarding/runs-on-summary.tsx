import { Laptop } from "../map/kit/icons";
import { DEFAULT_DEVICE_NOUN } from "./device-picker";
import { PlatformIcon, PLATFORM_NAMES, cn } from "./ui";
import type { RunDevice, TargetKind } from "./types";

export interface Placement {
  kind: TargetKind;
  platform: string;
  /** The device's name, or the default ("Any booted simulator") when the run names none. */
  device: string;
  /** True when `device` is the default rather than a named device. */
  isDefault: boolean;
}

export function runPlacement({ kind, device }: { kind: TargetKind; device?: RunDevice | null }): Placement {
  const named = device && device.kind === kind ? (device.kind === "web" ? null : device.name) : null;
  const web = kind === "web" && device?.kind === "web" && device.viewport === "mobile" ? "Mobile browser (390×844)" : null;
  return { kind, platform: PLATFORM_NAMES[kind], device: named ?? web ?? DEFAULT_DEVICE_NOUN[kind], isDefault: !named && !web };
}

export const placementLine = (p: Placement) => `${p.platform} · ${p.device} (local)`;

export function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "Web + iOS · 2 runs": how a group of runs queued together is named. */
export function groupTitle(kinds: readonly TargetKind[], noun = "run"): string {
  const names = kinds.map((k) => PLATFORM_NAMES[k]);
  return `${names.join(" + ")} · ${kinds.length} ${kinds.length === 1 ? noun : `${noun}s`}`;
}

/** "Runs on: Web · Desktop browser (local) and iOS · iPhone 17 Pro (local)". */
export function runsOnSummary(plans: readonly { placement: Placement }[]): string {
  return plans.length === 0 ? "Runs on: nothing selected" : `Runs on: ${joinAnd(plans.map((p) => placementLine(p.placement)))}`;
}

export interface SummaryPlan {
  placement: Placement;
  /** Exploration: its budget. */
  minutes?: number | null;
  /** Scenario-file runs: the file. */
  file?: string | null;
}

/**
 * The line before Queue: exactly what will run, where, and on which device. One row per platform
 * (one run each), so "Web and iOS" can never be read off a run that only covers Web.
 */
export function RunsOnSummary({ plans, className }: { plans: readonly SummaryPlan[]; className?: string }) {
  if (plans.length === 0) return null;
  const many = plans.length > 1;
  return (
    <section
      aria-label="Runs on"
      className={cn("flex flex-col gap-1.5 rounded-lg border border-border bg-panel-2 px-3 py-2.5", className)}
      data-runs-on
      data-runs-on-count={plans.length}
    >
      <div className="flex items-baseline gap-2">
        <h3 className="shrink-0 whitespace-nowrap text-xs font-semibold text-fg">Runs on</h3>
        {many ? (
          <span className="text-xs text-muted" data-runs-on-group>
            {groupTitle(plans.map((p) => p.placement.kind))}, queued together
          </span>
        ) : null}
      </div>
      {/* The plain sentence, for screen readers and tests. */}
      <p className="sr-only" data-runs-on-line>
        {runsOnSummary(plans)}
      </p>
      <ul className="flex flex-col gap-1">
        {plans.map((p) => (
          <li key={p.placement.kind} className="flex flex-col" data-runs-on-platform={p.placement.kind}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs" data-placement={p.placement.kind} title={placementLine(p.placement)}>
                <PlatformIcon kind={p.placement.kind} className="size-3 shrink-0" />
                <span className="shrink-0 text-fg-2">{p.placement.platform}</span>
                <span aria-hidden className="text-muted">
                  ·
                </span>
                <span className={cn("min-w-0 truncate", p.placement.isDefault ? "text-muted" : "text-fg")} data-placement-device>
                  {p.placement.device}
                </span>
                <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-2xs font-medium text-fg-2" data-placement-where="local" title="Runs on this Mac">
                  <Laptop className="size-2.5" aria-hidden />
                  Local
                </span>
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted tabular">
                {p.file ? p.file.replace(/^scenarios\//, "") : p.minutes != null ? `${p.minutes} min exploration` : "The approved scenarios"}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
