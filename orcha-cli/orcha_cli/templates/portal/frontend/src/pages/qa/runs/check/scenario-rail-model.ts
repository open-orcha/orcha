import type { ScenarioVerdict } from "../lib/verdict";

/**
 * Where a key press moves the selection in the run's scenario list, or null when the key is
 * not one the list handles. Selection follows focus, like a tab list: the list is a navigator
 * between scenario cards, so arrowing to a row should show its card without a second key.
 * The ends do not wrap, so holding an arrow key stops at the first or last scenario.
 */
export function railKeyTarget(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return Math.min(count - 1, current + 1);
    case "ArrowUp":
    case "ArrowLeft":
      return Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The list header's one-line tally, failures first because they are what a reader came for:
 * "2 failed · 1 passed". Verdicts with no scenario are left out. */
export function railSummary(verdicts: readonly ScenarioVerdict[]): string {
  const order: ScenarioVerdict[] = ["failed", "running", "inconclusive", "needs_setup", "warning", "unprocessable", "passed"];
  const words: Record<ScenarioVerdict, string> = {
    failed: "failed",
    running: "running",
    inconclusive: "inconclusive",
    warning: "warning",
    unprocessable: "unprocessable",
    needs_setup: "need setup",
    passed: "passed",
  };
  return order
    .map((v) => [v, verdicts.filter((x) => x === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${words[v]}`)
    .join(" · ");
}
