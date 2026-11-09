/** Triage in plain words: what a finding turned out to be, and what that did. */
import type { Classification, DiagnosisRow, TriageAction, TriageDecision } from "./api";

export const CLASSIFICATION: Record<Classification, string> = {
  product_bug: "Product bug", test_issue: "Test issue", environment: "Environment", flaky: "Flaky",
  agent_error: "Agent error", duplicate: "Duplicate", not_a_bug: "Not a bug",
};
export const classificationWord = (c: string | null | undefined) => (c && (CLASSIFICATION as Record<string, string>)[c]) || "Not triaged";

/** What a classification means, in a sentence, for the person reading the diagnosis. */
const CLASSIFICATION_HINT: Record<Classification, string> = {
  product_bug: "A real bug in the app. The agent made it happen again.",
  test_issue: "The app is fine. The test expects the wrong thing.",
  environment: "Something around the app stopped the run, not the app itself.",
  flaky: "It fails some of the time, so it should not fail a run on its own.",
  agent_error: "The agent got this wrong. It is kept for the record.",
  duplicate: "The same problem as another finding.",
  not_a_bug: "A person said this is how it should work.",
};
export const classificationHint = (c: string | null | undefined) => (c && (CLASSIFICATION_HINT as Record<string, string>)[c]) || null;

export function classificationTone(c: string | null | undefined): "danger" | "warn" | "neutral" {
  return c === "product_bug" ? "danger" : c === "flaky" || c === "environment" || c === "test_issue" ? "warn" : "neutral";
}

const ACTION: Record<TriageAction, string> = {
  confirmed: "Confirmed. It goes to the fix.",
  backlog: "Filed as a backlog task. It does not block.",
  suggested: "A change to the scenario waits for a person.",
  quarantined: "The scenario is quarantined. It no longer fails a gate alone.",
  already_quarantined: "The scenario was already quarantined.",
  no_scenario: "No scenario to change.",
  blocked: "A person is told what is missing.",
  dismissed: "Dismissed, and kept for the record.",
  merged: "Merged into the finding it repeats.",
  remembered: "QA will not report this behaviour again.",
  kept: "Kept open.",
};
export const actionWord = (a: string | null | undefined) => (a && (ACTION as Record<string, string>)[a]) || null;

const DECISION: Record<TriageDecision, string> = { fix: "Goes to the fix", clear: "Nothing left that blocks", needs_person: "Needs a person" };
export const decisionWord = (d: string | null | undefined) => (d && (DECISION as Record<string, string>)[d]) || null;

/** The request's decision: the server's word, else what its diagnoses add up to. */
export function decisionOf(result: { decision?: string | null; diagnoses: DiagnosisRow[]; confirmed_ids: string[] } | null | undefined, status: string): TriageDecision | null {
  if (!result) return null;
  if (result.decision === "fix" || result.decision === "clear" || result.decision === "needs_person") return result.decision;
  if (result.confirmed_ids.length) return "fix";
  if (status === "passed") return "clear";
  return status === "blocked" ? "needs_person" : null;
}
