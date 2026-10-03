/**
 * Proof-of-work evidence pack + Verdikt run shapes — mirror of
 * GET /api/tasks/{tid}/evidence (portal_backend/evidence_routes.py) and
 * portal_backend/verdikt_integration.run_public. Everything here is what the
 * task's own runs recorded (or what Verdikt reported); nothing is inferred
 * client-side.
 */

export type DodStatus = "proven" | "not_proven" | "needs_human";

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  total: number;
  unit: string; // "tests" | "packages"
  source: string;
  /** the runner the output revealed ("node:test", "vitest", "jest", "go", …), null when unknown */
  runner?: string | null;
}

export interface TestInvocation {
  run_id: string | null;
  /** the command's runner; a package script whose output revealed its runner reads e.g.
   *  "npm test (node:test)" — plain "npm test" means the framework is unknown */
  framework: string;
  runner?: string | null;
  command: string;
  exit_code: number | null;
  counts: TestCounts | null;
  outcome: "passed" | "failed" | "no_tests" | "exit_ok" | "exit_failed" | "unknown";
}

export interface TestsSummary {
  status: "none" | "passed" | "failed" | "exit_ok" | "unverified";
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  suites: number;
  invocations: number;
  latest: TestInvocation[];
  earlier: number;
}

export interface RiskFlag {
  kind: "migration" | "auth" | "secrets" | "deletion" | "large_diff" | "dependencies" | "ci" | string;
  label: string;
  detail: string;
  severity: "warn" | "danger";
  files: string[];
  count: number;
}

export interface ChangedFile {
  path: string;
  status: string | null;
  additions: number | null;
  deletions: number | null;
  binary?: boolean | null;
  run_id: string;
}

export interface ChangesSummary {
  files: number;
  additions: number;
  deletions: number;
  categories: Record<string, number>;
  summary: string;
  ui_touching: boolean;
  flags: RiskFlag[];
  list: ChangedFile[];
  truncated_list: boolean;
  unavailable_runs: { run_id: string; reason: string | null; detail: string | null }[];
}

export interface VerdiktCriterion {
  dod_index: number;
  text: string;
  outcome: "pass" | "fail" | "blocked" | "warning" | "unprocessable" | "running" | null;
  expected?: string | null;
  actual?: string | null;
  from_step?: number | null;
  to_step?: number | null;
  evidence_seq?: number | null;
}

export interface DodItem {
  index: number;
  text: string;
  status: DodStatus;
  basis: "tests" | "changes" | "verdikt" | "none";
  evidence: string | null;
  related?: string[];
  claim?: string;
  verdikt?: VerdiktCriterion & { run_short?: string };
}

export interface EvidenceLink {
  kind: "live_changes" | "captured_diff" | "runs" | "pr" | string;
  label: string;
  href: string;
  run_id?: string;
}

export type VerdiktStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout" | "unavailable";

export interface VerdiktShot {
  /** portal-relative: /api/tasks/{tid}/verdikt/runs/{rid}/artifact?path=… (streamed from
   *  Verdikt by the portal — Verdikt's own URL may be a Docker-only host the browser can't reach) */
  url: string;
  /** the artifact path inside the Verdikt run folder */
  path?: string;
  label: string;
  severity?: string | null;
  seq?: number | null;
  kind: "evidence" | "frame";
}

export type VerdiktPreviewStatus = "requested" | "starting" | "ready" | "failed" | "stopped";

/** The preview environment behind a Verdikt run (mig 064): the task's worktree built and served
 *  by the host notifier so Verdikt tests the change, not whatever runs at the configured URL. */
export interface VerdiktPreview {
  id: string;
  status: VerdiktPreviewStatus;
  port: number | null;
  /** the URL Verdikt was handed (http://127.0.0.1:{port}/…, on the notifier's machine) */
  verdikt_url: string | null;
  /** portal redirect to the running preview at the host the portal was opened on (ready only) */
  open_url: string | null;
  /** the full log tail (GET) */
  log_url: string;
  branch: string | null;
  worktree_name: string | null;
  ready_path: string;
  error: string | null;
  /** the last ~12 log lines */
  log_tail: string | null;
  stop_reason: string | null;
  created_at: string | null;
  claimed_at: string | null;
  ready_at: string | null;
  stopped_at: string | null;
  expires_at: string | null;
}

export interface VerdiktRun {
  id: string;
  task_id: string;
  trigger: "manual" | "auto";
  triggered_by: string | null;
  status: VerdiktStatus;
  verdict: "pass" | "fail" | "blocked" | "warning" | "unprocessable" | "running" | null;
  reason: string | null;
  base_url: string;
  verdikt_project_id: string | null;
  verdikt_scenario_id: string | null;
  verdikt_request_id: string | null;
  verdikt_run_id: string | null;
  target_kind: "web" | "ios" | "android";
  locator: string;
  handoff: {
    scenario_name?: string;
    criteria?: { dod_index: number; text: string }[];
    skipped_items?: { dod_index: number; text: string; why: string }[];
    changed_files?: string[];
    worker_online_at_queue?: boolean;
  };
  criteria: VerdiktCriterion[];
  screenshots: VerdiktShot[];
  /** portal-relative /api/tasks/{tid}/verdikt/runs/{rid}/report — a redirect to the Verdikt
   *  report at a host the browser can open */
  report_url: string | null;
  /** portal-relative artifact proxy URL of the run recording */
  video_url: string | null;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_polled_at: string | null;
  finished_at: string | null;
  /** the preview environment behind this run; null/absent when it tested a configured URL */
  preview?: VerdiktPreview | null;
  /** set on the pack's run when it was handed off before the last rejected verification —
   *  it judged the previous claim, so it proves nothing about the rework */
  previous_round?: boolean;
  /** mig 068: auto-triggered while the auto-fix loop applied — its verdict drives the loop */
  autofix?: boolean;
}

/* ---- the Verdikt auto-fix loop (mig 068, portal_backend/verdikt_autofix.py) ---------------- */

export type AutofixStopKind =
  | "pass" | "attempt_limit" | "no_diff" | "same_failure" | "non_fail" | "budget" | "agent_paused"
  | "human" | "stopped_by_human" | "turned_off" | "no_assignee";

/** One Verdikt check the loop judged: attempt N of the loop's max. */
export interface AutofixAttempt {
  attempt: number;
  /** pass | fail | the non-fail status / verdict (blocked, timeout, unavailable …) */
  outcome: string;
  action: "reworked" | "stopped" | "passed";
  verdikt_run: string;
  /** portal redirect to this attempt's Verdikt report (its run evidence) */
  report_url: string;
  /** portal redirect to this attempt's run page in Verdikt */
  open_url: string;
  failed: { text: string; expected?: string | null; actual?: string | null }[];
  /** the code changes Verdikt checked on this attempt (Live changes / captured diff link) */
  changes: { summary: string | null; files: number | null; href: string | null };
  created_at: string | null;
}

export interface AutofixLoop {
  id: string;
  status: "running" | "stopped";
  /** false: an older review cycle (a person accepted/rejected since) */
  current?: boolean;
  max_attempts: number;
  attempts_made: number;
  /** while running: the attempt being reworked / checked now */
  current_attempt: number;
  stop_kind: AutofixStopKind | null;
  stop_label: string | null;
  /** plain words, e.g. "Verdikt passed on attempt 3 of 3 — ready for your review" */
  stop_reason: string | null;
  stopped_by: string | null;
  started_at: string | null;
  stopped_at: string | null;
  attempts: AutofixAttempt[];
}

/** GET /api/tasks/{tid}/verdikt/autofix (also `autofix` on GET …/verdikt/runs). */
export interface AutofixState {
  task_id: string;
  effective: boolean;
  why: string;
  override: "inherit" | "on" | "off";
  project: { enabled: boolean; max_attempts: number; applies: boolean };
  loop: AutofixLoop | null;
}

/** The compact loop line on the evidence summary / Needs-you rows (current cycle only). */
export interface AutofixSummary {
  status: "running" | "stopped";
  attempts_made: number;
  max_attempts: number;
  current_attempt: number;
  stop_kind: AutofixStopKind | null;
  stop_label: string | null;
  stop_reason: string | null;
}

export interface EvidenceSummary {
  dod: { total: number; proven: number; not_proven: number; needs_human: number };
  tests: { status: TestsSummary["status"]; passed: number; failed: number; skipped: number; errors: number; suites: number };
  risk_flags: number;
  verdikt: { status: VerdiktStatus; verdict: VerdiktRun["verdict"] } | null;
  line: string;
  /** mig 068 — absent on an older backend */
  autofix?: AutofixSummary | null;
}

export interface EvidencePack {
  version: number;
  task_id: string;
  task_status: string;
  basis: string;
  built_at: string;
  round_started_at: string | null;
  runs: { run_id: string; agent_alias: string | null; status: string; exit_code: number | null; lane: string | null; started_at: string | null; ended_at: string | null }[];
  tests: TestsSummary;
  changes: ChangesSummary;
  flags: RiskFlag[];
  branch: string | null;
  pr_urls: string[];
  preview_urls: string[];
  links: EvidenceLink[];
  claim: { text: string; truncated: boolean } | null;
  dod_text: string;
  dod: { items: DodItem[]; total: number; proven: number; not_proven: number; needs_human: number };
  verdikt: VerdiktRun | null;
  summary: EvidenceSummary;
  rebuilt?: boolean;
  autofix?: AutofixSummary | null;
}

export interface VerdiktSettings {
  configured: boolean;
  enabled: boolean;
  base_url: string | null;
  verdikt_project: string | null;
  target_kind: "web" | "ios" | "android";
  target_locator: string | null;
  trigger_mode: "manual" | "ui_changes" | "always";
  timeout_minutes: number;
  updated_at: string | null;
  updated_by: string | null;
  /** preview environments (mig 064) — absent on an older backend */
  preview_command?: string | null;
  preview_ready_path?: string;
  preview_timeout_seconds?: number;
  preview_ttl_minutes?: number;
  /** auto-fix loop (mig 068) — absent on an older backend */
  autofix_enabled?: boolean;
  autofix_max_attempts?: number;
  /** read-only: the trigger mode lets auto-fix take effect (ui_changes / always) */
  autofix_applies?: boolean;
}

export const VERDIKT_OPEN: VerdiktStatus[] = ["queued", "running"];
