/** Results per Examples row: what the scenario panel shows beside each row, from
 * `GET /api/qa/scenarios/{id}/rows` (each row's newest check). */
import type { ScenarioOutcome } from "./adapt";

export type RowState = "passed" | "failed" | "inconclusive" | "errored" | "skipped" | "running" | "queued" | "cancelled";

export interface RowResult {
  row: number;
  values: Record<string, string>;
  label: string;
  state: RowState;
  outcome: ScenarioOutcome | null;
  reason: string | null;
  runId: string | null;
  requestId: string;
  at: string;
}

const STATE: Record<ScenarioOutcome, RowState> = { pass: "passed", fail: "failed", inconclusive: "inconclusive", blocked: "errored" };

/** One row of the route's answer as the field reads it. */
export function rowResult(r: { index: number; outcome: ScenarioOutcome | null; reason: string | null; run_id: string | null; at: string }): RowResult {
  return { row: r.index, values: {}, label: `Row ${r.index + 1}`, state: r.outcome ? STATE[r.outcome] : "inconclusive", outcome: r.outcome, reason: r.reason, runId: r.run_id, requestId: r.run_id ?? "", at: r.at };
}

/** "3 passed, 1 failed": what ran, or "" before a row ran. */
export function rowsSummary(results: readonly { state: RowState | (string & {}); runId?: string | null }[]): string {
  const count = (s: string) => results.filter((r) => r.state === s).length;
  const parts = [["passed", count("passed")], ["failed", count("failed")], ["could not run", count("errored")], ["no verdict", count("inconclusive")]] as const;
  return parts.filter(([, n]) => n > 0).map(([word, n]) => `${n} ${word}`).join(", ");
}
