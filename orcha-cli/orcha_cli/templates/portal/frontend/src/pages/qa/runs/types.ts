/** The run page's data shapes: the source's row types, filled from QA sessions by `adapt.ts`. */
export type { Severity, TargetKind } from "../map/kit";
import type { Severity, TargetKind } from "../map/kit";
import type { NeedsSetup } from "./lib/needs-setup";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type RunStatus = "running" | "completed" | "failed" | "cancelled";
export type ScenarioOutcome = "pass" | "fail" | "warning" | "blocked" | "unprocessable" | "inconclusive" | "needs_setup" | "running";

export interface Step {
  seq: number;
  kind: string;
  args: Json;
  result: string | null;
  /** The page or screen it landed on. */
  foreground: string | null;
  /** The frame's stored id. */
  frame_path: string | null;
  /** Milliseconds from the session's start. */
  at_ms: number;
  screen_key?: string | null;
  screen_hash?: string | null;
}

export interface Evidence {
  seq: number;
  step_seq: number | null;
  severity: Severity | "info";
  label: string | null;
  png_path: string | null;
  note?: string | null;
  expected?: string | null;
  actual?: string | null;
}

export interface Finding {
  run_id: string;
  seq: number;
  severity: Severity;
  title: string;
  kind?: string | null;
  repro_from_step: number | null;
  repro_to_step: number | null;
  evidence_seqs: number[];
  note: string | null;
  expected: string | null;
  actual: string | null;
  /** What to tell a coding agent: composed from the finding's own fields. */
  fix_prompt: string | null;
}

export type RunLogLevel = "error" | "warn" | "info" | "debug";
export type RunLogSource = "console" | "network" | "device" | "crash";
export const RUN_LOG_LEVELS: readonly RunLogLevel[] = ["error", "warn", "info", "debug"];
export const RUN_LOG_SOURCES: readonly RunLogSource[] = ["console", "network", "device", "crash"];

export interface RunLog {
  seq: number;
  step_seq: number | null;
  at_ms: number;
  level: RunLogLevel;
  source: RunLogSource;
  text: string;
  detail: Json | null;
}

export type CriterionFeedbackStatus = "not_a_bug" | "acknowledged" | "resolved";

export interface CriterionFeedback {
  scenario_id: string;
  criterion_index: number;
  status: CriterionFeedbackStatus;
  note: string | null;
}

export interface CriterionJudge {
  criterion_met: number;
  agrees: boolean;
  confidence: number;
  same_state?: number;
  change_kind?: "identical" | "copy_changed" | "layout_changed" | "element_missing" | "new_content" | "dynamic_data";
  meaningful?: number;
}

export interface CriterionEventRow {
  expectation: string;
  warning: boolean;
  matched: boolean;
  /** `steps.seq` the matching event was captured at; null when missing. */
  at: number | null;
  /** Short text of the matching event. */
  event: string | null;
}

export interface CriterionCheckResult {
  expression: string;
  /** `not_run`: the criterion was never reached (the run stopped for setup, or never reported
   * it), so its checks were not evaluated: never shown as a failure (#280). */
  outcome: "pass" | "fail" | "warning" | "not_run";
  actual: string;
}

export type CriterionProof = "judged" | "checked" | "checked+judged";

export interface CriterionReadback {
  line: string;
  outcome: "pass" | "fail" | "warning" | "inconclusive" | "needs_setup";
  /** "saved as entered (read from …)" or "saved Amount 4.0 oz; entered nothing (…)". */
  actual: string;
  /** Where the values came from: "the device storage (snuglog_db)", "POST /api/events", … */
  source?: string | null;
  kind?: string | null;
  /** The fields read, as stored. */
  fields?: Record<string, unknown> | null;
}

export interface Criterion {
  judge?: CriterionJudge | null;
  text: string;
  /** The line as the run used it, when `text` is a template whose `{{name}}` placeholders the run
   * filled (an Examples row's values, Data): what the page shows (#283). `text` stays the
   * scenario's line, which results are keyed and matched by. */
  shown_text?: string | null;
  /** Durable id for the assertion this criterion makes — a hash of its normalised text, so a
   * result stays findable after the scenario is reordered or reworded (see `lib/criterion-key`).
   * Absent on rows recorded before criterion keys existed, which match by index instead. */
  criterion_key?: string | null;
  outcome: ScenarioOutcome | null;
  from_step: number | null;
  to_step: number | null;
  /** Expectation text for the Expectations tab; falls back to `text` when absent. */
  expected?: string | null;
  /** What was actually observed, for the Expectations tab. */
  actual?: string | null;
  /** The agent's reason, written before its verdict (absent on runs recorded before it was required). */
  explanation?: string | null;
  /** The `screen` step a pass was judged from. */
  evidence_frame?: number | null;
  /** Identity of how a failed criterion failed (migration 028), shared by runs that failed the same way. */
  fingerprint?: string | null;
  /** Pinned evidence screenshot for this criterion (`evidence.seq`). */
  evidence_seq?: number | null;
  /** Linked finding whose `fix_prompt` backs the Prompt-to-fix tab (`findings.seq`). */
  finding_seq?: number | null;
  /** `"events"` for the tracking-events verdict appends;
   * `"replayed"` / `"replay+judge"` for a criterion a worker replay proved (#377). */
  source?: string | null;
  /** A criterion a PR check re-checked by replay (#377): the judge's `criterion_met` on the new
   * build. Null otherwise. */
  rechecked_p?: number | null;
  /** Per-expectation rows of a tracking-events criterion (`source: "events"`). */
  events?: CriterionEventRow[] | null;
  /** Deterministic checks evaluated for this criterion (`Check:` lines). */
  checks?: CriterionCheckResult[] | null;
  /** How the outcome was proven: by checks, by the agent's judgment, or both. */
  proof?: CriterionProof | null;
  /** What the agent reported, when the checks changed the outcome. */
  judgment?: string | null;
  /** A check failed where the agent said pass. */
  agent_disagreed?: boolean | null;
  /** `Check:` lines the harness proposes after a judged pass. */
  suggested_checks?: string[] | null;
  /** "Check needs fixing" (#191): the check is wrong, not the product; the corrected line. */
  /** The declared criterion this record is about: one record per
   * declared criterion, in order. Absent on rows written before records carried it. */
  criterion_index?: number | null;
  /** No verdict was ever given for this criterion (#223): stored inconclusive, never a pass. */
  not_reported?: boolean | null;
  /** Never reached: the run stopped for setup (needs setup) before this criterion (#280). */
  not_run?: boolean | null;
  /** Why this criterion could not be tested here (`outcome: "needs_setup"`, migration 098). */
  setup?: NeedsSetup | null;
  /** Lines the run repaired before judging them (#226), each to keep or undo. */
  /** `Saved:` read-backs (#266): what the record holds and where it was read from. */
  readback?: CriterionReadback[] | null;
}

export interface ScenarioResult {
  /** How the result was decided (migration 031): replay, replay prefix + agent, or agent. */
  provenance?: Json | null;
  /** `flaky` when it passed only on the in-request retry (migration 028). */
  outcome_class?: string | null;
  /** Why the result could not be tested here, when `outcome` is `needs_setup` (migration 098):
   * `{code, category, title, fix, detail, source}`, see `lib/needs-setup`. */
  setup?: Json | null;
  failure_fingerprint?: string | null;
  run_id: string;
  scenario_id: string;
  outcome: ScenarioOutcome;
  reason: string | null;
  finding_seqs: number[];
  /** `[{text, outcome, from_step, to_step, judge?}]`, running criteria included (spec §2).
   * `judge?: {criterion_met: number, agrees: boolean, confidence: number}` (TypeSafe "second
   * opinion" contract, migration 007) appears on an item only when `judge.uses.verdict_check`
   * was on for the run — see `scenario-results.tsx`'s `CriterionJudgeChip`. It never changes
   * `outcome` itself. */
  criteria: Json;
  /** Deterministic replay ("Maestro mode for regression"): true when this result came from
   * replaying a `qa.scenario_traces` row (no model in the loop) rather than a normal agent
   * run. Undefined/false for a normal run, including one that fell back to the agent mid-way
   * after a drifted trace (that fallback re-runs with the agent, so the result it writes is a
   * normal one again). Absent entirely on rows written before replay shipped. */
  replayed?: boolean;
}

export interface Scenario {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  /** Ordered list of acceptance-criterion strings. */
  criteria: string[];
  status: string;
  depends_on: string[];
  position: { x: number; y: number } | null;
  target_kind: TargetKind | null;
}

/** A session as the run page reads it. */
export interface RunWithTarget {
  id: string;
  mode: "exploratory" | "scenarios";
  status: RunStatus;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  step_count: number;
  device_name: string | null;
  device: unknown;
  screen_w: number | null;
  screen_h: number | null;
  report_md: string | null;
  counts: Partial<Record<Severity, number>>;
  targets: { id: string | null; kind: TargetKind; locator: string; label: string | null } | null;
}
