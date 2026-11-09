/**
 * Scenario health (#188): the audit the portal's audit (`qa_scenario_health.py`) computes per scenario, shared by
 * the Health board, the compact badge other views import and the API routes. Pure types and
 * labels, safe to import from client and server code alike.
 */

/** What can be wrong with a scenario, most urgent first (`FLAG_ORDER`). */
export type HealthFlagKind =
  | "suspicious" // reads like an agent task or work order, not a user outcome
  | "env_failing" // fails the same way every time: the environment, not the product
  | "orphaned" // pinned to a platform the project has no target for
  | "duplicate" // near-identical to another scenario on the same platform
  | "never_passed" // ran several times and never passed
  | "stale" // its replay trace no longer matches the app
  | "flaky" // passes and fails on the same build
  | "platform_wording"; // shared by every platform, but quotes words only one platform shows

/** The one action each row offers first. `open` opens the scenario on the map. */
export type HealthAction = "rename" | "merge" | "drafts" | "archive" | "fix_env" | "dismiss" | "open";

export interface HealthFlag {
  scenario_id: string;
  kind: HealthFlagKind;
  /** One plain sentence: why this flag is here. */
  reason: string;
  /** The recommended action. */
  action: HealthAction;
  /** Kind-specific facts: `duplicate_of`/`duplicate_name`, `error`, `count`, `matched`… */
  detail?: Record<string, unknown>;
  /** Set when a person said "this is fine": the flag stays quiet and never skips the scenario. */
  dismissed_at?: string | null;
}

export interface HealthScenario {
  id: string;
  name: string;
  status: "draft" | "validated";
  target_kind: string | null;
  archived_at?: string | null;
  flags: HealthFlag[];
}

export interface HealthAudit {
  project_id: string;
  computed_at: string;
  /** Scenarios the audit looked at (retired ones are left out). */
  total: number;
  /** Open (not dismissed) flags per kind. */
  counts: Partial<Record<HealthFlagKind, number>>;
  /** Only the scenarios with at least one flag (dismissed ones included, marked). */
  scenarios: HealthScenario[];
}

export const FLAG_ORDER: readonly HealthFlagKind[] = ["suspicious", "env_failing", "orphaned", "platform_wording", "duplicate", "never_passed", "stale", "flaky"];

export const FLAG_LABEL: Record<HealthFlagKind, { title: string; short: string; blurb: string }> = {
  suspicious: { title: "Not really scenarios", short: "suspicious", blurb: "Agent tasks or work orders imported as scenarios. Batches skip them until you keep them." },
  env_failing: { title: "Failing on the environment", short: "environment", blurb: "The same error every time. Fix the platform, not the app." },
  orphaned: { title: "No platform to run on", short: "no platform", blurb: "Pinned to a platform this project has no target for." },
  duplicate: { title: "Duplicates", short: "duplicate", blurb: "Near-identical to another scenario on the same platform." },
  never_passed: { title: "Never passed", short: "never passed", blurb: "Ran several times and never passed once." },
  stale: { title: "Stale", short: "stale", blurb: "Its recorded replay no longer matches the app." },
  flaky: { title: "Flaky", short: "flaky", blurb: "Passes and fails without a change." },
  platform_wording: {
    title: "One platform's words",
    short: "platform words",
    blurb: "Runs on every platform but quotes words only one of them shows. Pin it or split it per platform.",
  },
};

export const ACTION_LABEL: Record<HealthAction, string> = {
  rename: "Rename",
  merge: "Merge into…",
  drafts: "Move to drafts",
  // The action key stays `archive` (the audit's actions); it retires the scenario (migration 107).
  archive: "Retire",
  fix_env: "Fix environment",
  dismiss: "Dismiss",
  open: "Open",
};

/** Open flags of a scenario, most urgent first. */
export function openFlags(flags: readonly HealthFlag[] | null | undefined): HealthFlag[] {
  return (flags ?? [])
    .filter((f) => !f.dismissed_at)
    .sort((a, b) => FLAG_ORDER.indexOf(a.kind) - FLAG_ORDER.indexOf(b.kind));
}

/** Narrow an untrusted JSON value to a flag, or null. */
export function parseFlag(raw: unknown): HealthFlag | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.scenario_id !== "string" || typeof r.kind !== "string" || !(FLAG_ORDER as readonly string[]).includes(r.kind)) return null;
  return {
    scenario_id: r.scenario_id,
    kind: r.kind as HealthFlagKind,
    reason: typeof r.reason === "string" ? r.reason : "",
    action: (typeof r.action === "string" && r.action in ACTION_LABEL ? r.action : "open") as HealthAction,
    detail: typeof r.detail === "object" && r.detail !== null ? (r.detail as Record<string, unknown>) : undefined,
    dismissed_at: typeof r.dismissed_at === "string" ? r.dismissed_at : null,
  };
}
