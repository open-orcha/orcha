/** The verdict a run row and header show, from its status and its scenarios' outcomes. */
import type { ScenarioOutcome } from "../types";

export type RunVerdict =
  | "passed"
  | "failed"
  | "mixed"
  | "inconclusive"
  | "needs_setup"
  | "running"
  | "queued"
  | "errored"
  /** Nothing ran: what it tests was not there (`couldNotStart`). Not a failed test, and left out
   * of every pass rate; it still needs someone. */
  | "could_not_start"
  | "cancelled"
  | "completed";

export interface ScenarioTally {
  passed: number;
  failed: number;
  /** Blocked, unprocessable, inconclusive, needs setup or still running. */
  other: number;
  /** Could not be tested here (`lib/needs-setup`): part of `other`, never a failure. */
  needsSetup: number;
  total: number;
  /** The warnings among `passed` (a pass with a `[warning]` criterion failed). */
  warnings?: number;
  /** The one result of a single-scenario run: its own word ("Blocked", "Passed with a warning"). */
  only?: ScenarioOutcome | null;
}

/** Counts by the classes of `lib/runs/metrics`: a warning is passed, blocked / unprocessable /
 * inconclusive are no verdict (in `other`). */
export function tallyOutcomes(outcomes: readonly (ScenarioOutcome | null | undefined)[]): ScenarioTally {
  const t: ScenarioTally = { passed: 0, failed: 0, other: 0, needsSetup: 0, total: outcomes.length, warnings: 0, only: outcomes.length === 1 ? (outcomes[0] ?? null) : null };
  for (const o of outcomes) {
    const c = o === "pass" || o === "warning" ? "passed" : o === "fail" ? "failed" : o === "needs_setup" ? "needs_setup" : "other";
    if (c === "passed") {
      t.passed++;
      if (o === "warning") t.warnings = (t.warnings ?? 0) + 1;
    } else if (c === "failed") t.failed++;
    else {
      t.other++;
      if (c === "needs_setup") t.needsSetup++;
    }
  }
  return t;
}

/**
 * The run's verdict. The run status says whether the worker finished; the scenario outcomes
 * say whether the app passed. A completed run whose only scenario failed is `failed`, never a
 * green check. A run the site rate-limited or walled (`errorCode` `TARGET_RATE_LIMITED` /
 * `TARGET_BOT_BLOCKED`, `lib/site-limits`) needs setup, an exploration included, unless a
 * scenario failed before the wall (a real bug is never hidden behind it).
 */
export function runVerdict(
  status: string | null | undefined,
  outcomes: readonly (ScenarioOutcome | null | undefined)[],
): RunVerdict {
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  if (status === "cancelled") return "cancelled";
  const t = tallyOutcomes(outcomes);
  if (t.total === 0) return status === "failed" ? "errored" : "completed";
  if (t.passed === t.total) return "passed";
  if (t.passed === 0 && t.failed > 0) return "failed";
  if (t.passed > 0) return "mixed";
  if (t.failed === 0 && t.needsSetup === t.total) return "needs_setup";
  return "inconclusive";
}

/** How one verdict is drawn: a `StatusGlyph` status, its accessible name and colour. */
export interface VerdictStyle {
  glyph: "pass" | "fail" | "mixed" | "errored" | "blocked" | "inconclusive" | "needs_setup" | "running" | "queued" | "cancelled" | "replayed";
  label: string;
  /** Text colour utility (the glyph and the result text paint with it). */
  color: string;
}

export const VERDICT_STYLE: Record<RunVerdict, VerdictStyle> = {
  passed: { glyph: "pass", label: "Passed", color: "text-success" },
  failed: { glyph: "fail", label: "Failed", color: "text-danger" },
  mixed: { glyph: "mixed", label: "Mixed: some scenarios failed", color: "text-sev-major" },
  inconclusive: { glyph: "inconclusive", label: "Inconclusive", color: "text-sev-minor" },
  needs_setup: { glyph: "needs_setup", label: "Needs setup: it could not be tested here", color: "text-info" },
  running: { glyph: "running", label: "Running", color: "text-progress" },
  queued: { glyph: "queued", label: "Queued", color: "text-muted" },
  errored: { glyph: "errored", label: "Errored: the run stopped before a verdict", color: "text-danger" },
  could_not_start: { glyph: "blocked", label: "Couldn't start: nothing ran, so no test failed", color: "text-warning" },
  cancelled: { glyph: "cancelled", label: "Stopped", color: "text-muted" },
  completed: { glyph: "replayed", label: "Completed (no scenario verdict)", color: "text-muted" },
};

export function verdictStyle(v: RunVerdict): VerdictStyle {
  return VERDICT_STYLE[v];
}

/** `1/1 passed`, `1/1 failed`, `2/3 passed`, `1 inconclusive`; null without scenarios. */
export function resultText(v: RunVerdict, t: ScenarioTally): string | null {
  if (t.total === 0) return null;
  if (v === "failed") return `${t.failed}/${t.total} failed`;
  if (v === "inconclusive") return `${t.other} inconclusive`;
  if (v === "needs_setup") return `${t.needsSetup} need${t.needsSetup === 1 ? "s" : ""} setup`;
  if (v === "running") return `${t.passed + t.failed}/${t.total} done`;
  // A warning is never a plain pass (#239): the run header said "1/1 passed" for one.
  const warned = t.warnings ?? (t.only === "warning" ? 1 : 0);
  if (warned > 0) return `${t.passed}/${t.total} passed (${warned} with a warning)`;
  return `${t.passed}/${t.total} passed`;
}
