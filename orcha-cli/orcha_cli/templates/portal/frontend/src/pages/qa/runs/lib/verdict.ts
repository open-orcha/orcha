import type { Criterion, CriterionEventRow, CriterionJudge, Json, ScenarioOutcome } from "../types";
import { parseSetup } from "./needs-setup";
import { isReplaySource, recheckedP } from "./provenance";

/**
 * A criterion whose text ends with `[warning]` is non-critical: it can fail
 * without failing the scenario, but a failure still surfaces as `warning`.
 * The marker itself is stripped before display.
 */
const WARNING_SUFFIX_RE = /\s*\[warning\]\s*$/i;

export function isWarningCriterion(text: string): boolean {
  return WARNING_SUFFIX_RE.test(text.replace(CHECKED_SUFFIX_RE, ""));
}

/**
 * A criterion whose text ends with `[checked]` is decided by its deterministic checks alone
 * (`Check:` lines): the agent drives the app there but need not judge it.
 */
const CHECKED_SUFFIX_RE = /\s*\[checked\]\s*$/i;

export function isCheckedCriterion(text: string): boolean {
  return CHECKED_SUFFIX_RE.test(text.replace(WARNING_SUFFIX_RE, ""));
}

/** Criterion text with trailing `[warning]` / `[checked]` markers removed, for display. */
export function displayCriterionText(text: string): string {
  let out = text;
  for (let i = 0; i < 2; i++) out = out.replace(WARNING_SUFFIX_RE, "").replace(CHECKED_SUFFIX_RE, "");
  return out.trim();
}

const PLACEHOLDER_RE = /\{\{\s*[A-Za-z_][\w.-]*\s*\}\}/g;

/**
 * `text` with its `{{name}}` placeholders filled the way the run filled them, read from the line
 * the agent reported (`reported_text`): used only when that line is the template with values in
 * the placeholders' places, so a reworded report never replaces the scenario's line. Null when
 * there is nothing to fill or no match (#283).
 */
export function filledCriterionText(text: string, reported: unknown): string | null {
  if (typeof reported !== "string" || !reported.trim() || !PLACEHOLDER_RE.test(text)) return null;
  PLACEHOLDER_RE.lastIndex = 0;
  // Matched without a `[warning]` / `[checked]` suffix: the report may leave it off.
  const said = displayCriterionText(reported);
  const pattern = displayCriterionText(text)
    .split(PLACEHOLDER_RE)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("(.+?)");
  return new RegExp(`^${pattern}$`, "s").test(said) ? said : null;
}

/** Parse `scenario_results.criteria` jsonb into typed `Criterion[]` (defensive: tolerates legacy string-only lists). */
export function parseCriteria(json: Json | null | undefined): Criterion[] {
  if (!Array.isArray(json)) return [];
  return json.map((c): Criterion => {
    if (typeof c === "string") {
      return { text: c, outcome: null, from_step: null, to_step: null };
    }
    if (typeof c === "object" && c !== null && !Array.isArray(c)) {
      const o = c.outcome;
      const outcome: ScenarioOutcome | null =
        o === "pass" ||
        o === "fail" ||
        o === "blocked" ||
        o === "running" ||
        o === "warning" ||
        o === "unprocessable" ||
        o === "inconclusive" ||
        o === "needs_setup"
          ? o
          : null;
      return {
        text: String(c.text ?? ""),
        shown_text: filledCriterionText(String(c.text ?? ""), c.reported_text),
        criterion_key: typeof c.criterion_key === "string" ? c.criterion_key : null,
        outcome,
        from_step: typeof c.from_step === "number" ? c.from_step : null,
        to_step: typeof c.to_step === "number" ? c.to_step : null,
        expected: typeof c.expected === "string" ? c.expected : null,
        actual: typeof c.actual === "string" ? c.actual : null,
        explanation: typeof c.explanation === "string" ? c.explanation : null,
        evidence_frame: typeof c.evidence_frame === "number" ? c.evidence_frame : null,
        fingerprint: typeof c.fingerprint === "string" ? c.fingerprint : null,
        evidence_seq:
          typeof c.evidence_seq === "number" ? c.evidence_seq : null,
        finding_seq: typeof c.finding_seq === "number" ? c.finding_seq : null,
        source: typeof c.source === "string" ? c.source : null,
        events: c.source === "events" ? parseEventRows(c.events) : null,
        judge: parseCriterionJudge(c.judge),
        rechecked_p: recheckedP(c as Record<string, unknown>),
        criterion_index: typeof c.criterion_index === "number" ? c.criterion_index : null,
        not_reported: c.not_reported === true,
        not_run: c.not_run === true,
        setup: parseSetup(c.setup),
        ...parseCheckItemFields(c as Record<string, unknown>),
      };
    }
    return { text: String(c), outcome: null, from_step: null, to_step: null };
  });
}

const CHANGE_KINDS = ["identical", "copy_changed", "layout_changed", "element_missing", "new_content", "dynamic_data"];

/** The judge's second opinion on one criterion (`judge` on the stored record), or null. */
export function parseCriterionJudge(value: unknown): CriterionJudge | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const j = value as Record<string, unknown>;
  if (
    typeof j.criterion_met !== "number" ||
    typeof j.agrees !== "boolean" ||
    typeof j.confidence !== "number"
  ) {
    return null;
  }
  const result: CriterionJudge = { criterion_met: j.criterion_met, agrees: j.agrees, confidence: j.confidence };
  if (typeof j.same_state === "number") result.same_state = j.same_state;
  if (typeof j.change_kind === "string" && CHANGE_KINDS.includes(j.change_kind)) {
    result.change_kind = j.change_kind as CriterionJudge["change_kind"];
  }
  if (typeof j.meaningful === "number") result.meaningful = j.meaningful;
  return result;
}

/** Below this `criterion_met`, the judge scores a criterion unmet (`result_record.JUDGE_DISPUTE_BELOW`). */
export const JUDGE_DISPUTE_BELOW = 0.5;

/**
 * A pass that rests on the agent's word alone (no deterministic check proved it, not replayed)
 * while the independent judge scored the criterion unmet (#234). Still a pass: the judge never
 * changes an outcome. The run page says so next to it and counts such passes apart, so a lead
 * can tell a proven pass from one only the agent vouches for. Mirrors `result_record.judge_disputed`.
 */
export function judgeDisputed(c: Pick<Criterion, "outcome" | "proof" | "source" | "judge">): boolean {
  if (c.outcome !== "pass") return false;
  if (c.proof === "checked" || c.proof === "checked+judged" || isReplaySource(c.source)) return false;
  return c.judge != null && c.judge.agrees === false && c.judge.criterion_met < JUDGE_DISPUTE_BELOW;
}

/** The per-expectation rows of a tracking-events criterion (`source: "events"`). */
export function parseEventRows(json: Json | undefined): CriterionEventRow[] {
  if (!Array.isArray(json)) return [];
  const rows: CriterionEventRow[] = [];
  for (const r of json) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
    rows.push({
      expectation: String(r.expectation ?? ""),
      warning: r.warning === true,
      matched: r.matched === true,
      at: typeof r.at === "number" ? r.at : null,
      event: typeof r.event === "string" ? r.event : null,
    });
  }
  return rows;
}

/** A criterion the tracking-event check appended. */
export function isEventsCriterion(c: Pick<Criterion, "source">): boolean {
  return c.source === "events";
}

/** Display title of a criterion: tracking-event verdicts get a fixed label instead of their
 * long generated text (`Tracking events: a; b; c`). */
export function criterionTitle(c: Pick<Criterion, "source" | "text" | "shown_text">): string {
  return isEventsCriterion(c) ? "Tracking events" : displayCriterionText(c.shown_text || c.text);
}

/** Verdict shown in the left rail and scenario header — a coarser view than the raw per-criterion outcomes. */
export type ScenarioVerdict =
  "failed" | "warning" | "passed" | "inconclusive" | "unprocessable" | "needs_setup" | "running";

export interface VerdictCounts {
  verdict: ScenarioVerdict;
  /** Criteria with a `pass` outcome. */
  passed: number;
  /** Total criteria considered (length of the list). */
  total: number;
  /** Criteria no verdict was ever given for (`not_reported`). */
  notReported: number;
  /** Passes only the agent's word proves that the judge scored unmet (`judgeDisputed`). */
  disputed: number;
}

/**
 * Roll up one scenario's criteria (plus its `scenario_results.outcome`, when
 * given) into a single verdict.
 *
 * - `running`: any criterion is still running.
 * - `unprocessable`: every criterion is blocked, or there's no usable
 *   criteria data and the row's outcome is `blocked`/`unprocessable` with no
 *   passes.
 * - `failed`: any *critical* (non-`[warning]`) criterion failed.
 * - `needs_setup`: nothing critical failed, but a criterion (or the result) could not be tested
 *   here (`lib/needs-setup`): not a pass, not a failure.
 * - `inconclusive`: no critical criterion failed but one is still inconclusive (the screen did
 *   not show enough to decide); never a pass.
 * - `warning`: every critical criterion passed but some warning criterion failed.
 * - `passed`: every critical criterion passed (warning criteria may be
 *   pending/blocked without affecting this).
 */
export function scenarioVerdict(
  criteria: readonly Criterion[],
  resultOutcome?: ScenarioOutcome | null,
): VerdictCounts {
  const total = criteria.length;
  const passed = criteria.filter((c) => c.outcome === "pass").length;
  const notReported = criteria.filter((c) => c.not_reported).length;
  const disputed = criteria.filter((c) => judgeDisputed(c)).length;
  const counts = (verdict: ScenarioVerdict): VerdictCounts => ({ verdict, passed, total, notReported, disputed });

  // A criterion still marked running only means "in progress" while the scenario itself is
  // open; once the scenario has a terminal outcome (the run ended, was aborted or blocked)
  // those criteria count as blocked, never as running.
  const scenarioOpen = resultOutcome == null || resultOutcome === "running";
  if (scenarioOpen && criteria.some((c) => c.outcome === "running")) {
    return counts("running");
  }
  if (!scenarioOpen && criteria.some((c) => c.outcome === "running")) {
    criteria = criteria.map((c) =>
      c.outcome === "running" ? { ...c, outcome: "blocked" } : c,
    );
  }

  if (total === 0) {
    if (resultOutcome === "running")
      return counts("running");
    if (resultOutcome === "pass") return counts("passed");
    if (resultOutcome === "warning")
      return counts("warning");
    if (resultOutcome === "inconclusive")
      return counts("inconclusive");
    if (resultOutcome === "needs_setup") return counts("needs_setup");
    return counts("unprocessable");
  }

  const needsSetup = resultOutcome === "needs_setup" || criteria.some((c) => c.outcome === "needs_setup");

  const allBlocked = criteria.every(
    (c) => c.outcome === "blocked" || c.outcome == null,
  );
  if (allBlocked) {
    return counts(needsSetup ? "needs_setup" : "unprocessable");
  }
  if (
    passed === 0 &&
    !needsSetup &&
    (resultOutcome === "blocked" || resultOutcome === "unprocessable")
  ) {
    return counts("unprocessable");
  }

  let criticalFailed = false;
  let warningFailed = false;
  let criticalUnresolved = false;
  let criticalInconclusive = false;
  for (const c of criteria) {
    const warn = isWarningCriterion(c.text);
    // A criterion nobody reported keeps a pass from standing (#223): a critical one makes the
    // scenario inconclusive, a [warning] one a warning (`result_record.scenario_outcome`).
    if (c.not_reported) {
      if (warn) warningFailed = true;
      else criticalInconclusive = true;
      continue;
    }
    if (c.outcome === "inconclusive" && !warn) criticalInconclusive = true;
    if (c.outcome === "needs_setup") continue;
    if (c.outcome === "fail") {
      if (warn) warningFailed = true;
      else criticalFailed = true;
    } else if (!warn && c.outcome !== "pass") {
      // Blocked, or not yet started — a critical criterion that never
      // resolved to pass keeps the scenario from reading as fully "passed".
      criticalUnresolved = true;
    }
  }

  if (criticalFailed) return counts("failed");
  if (needsSetup) return counts("needs_setup");
  if (criticalInconclusive) return counts("inconclusive");
  if (warningFailed) return counts("warning");
  if (criticalUnresolved) return counts("unprocessable");
  return counts("passed");
}

/** Run-level rollup: counts of scenarios by verdict, for the stacked progress bar. */
export interface RunVerdictCounts {
  passed: number;
  warning: number;
  failed: number;
  inconclusive: number;
  unprocessable: number;
  needs_setup: number;
  running: number;
  total: number;
}

export function rollupVerdicts(
  verdicts: readonly ScenarioVerdict[],
): RunVerdictCounts {
  const counts: RunVerdictCounts = {
    passed: 0,
    warning: 0,
    failed: 0,
    inconclusive: 0,
    unprocessable: 0,
    needs_setup: 0,
    running: 0,
    total: verdicts.length,
  };
  for (const v of verdicts) counts[v]++;
  return counts;
}


/** The deterministic-check fields of one criterion item. */
function parseCheckItemFields(c: Record<string, unknown>): Pick<Criterion, "checks" | "proof" | "judgment" | "agent_disagreed" | "suggested_checks"> {
  const checks = Array.isArray(c.checks)
    ? (c.checks as unknown[]).flatMap((r) => {
        if (typeof r !== "object" || r === null || Array.isArray(r)) return [];
        const o = r as Record<string, unknown>;
        // Stored as "fail" with "not evaluated" for a criterion never reached (verdicts.checks).
        const outcome: "pass" | "fail" | "warning" | "not_run" =
          o.outcome === "pass" || o.outcome === "warning" ? o.outcome : o.outcome === "not_run" || o.actual === "not evaluated" ? "not_run" : "fail";
        return [{ expression: String(o.expression ?? ""), outcome, actual: typeof o.actual === "string" ? o.actual : "" }];
      })
    : null;
  return {
    checks,
    proof: c.proof === "checked" || c.proof === "judged" || c.proof === "checked+judged" ? c.proof : null,
    judgment: typeof c.judgment === "string" ? c.judgment : null,
    agent_disagreed: c.agent_disagreed === true,
    suggested_checks: Array.isArray(c.suggested_checks)
      ? (c.suggested_checks as unknown[]).filter((x): x is string => typeof x === "string")
      : null,
  };
}
