/** Criterion sources: a session's verdicts are all the agent's, these read the rows as the source does. */
export function isReplaySource(source: unknown): boolean {
  return source === "replayed" || source === "replay+judge";
}

/** The judge's `criterion_met` on a criterion re-checked, else null. */
export function recheckedP(item: Record<string, unknown>): number | null {
  if (item.source !== "replay+judge") return null;
  const judge = item.judge as Record<string, unknown> | null | undefined;
  const p = judge && typeof judge === "object" ? judge.criterion_met : null;
  return typeof p === "number" ? p : null;
}
