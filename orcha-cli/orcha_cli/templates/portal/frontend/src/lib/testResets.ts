/**
 * Module-level state resets for the unit-test runner. Modules that keep
 * page-lifetime singletons (the /api/me single-flight cache, the acting
 * identity slot, optimistic attention marks) register a reset here; the
 * shared test setup (src/test-setup.ts) runs them after EVERY test so one
 * test's /api/me answer or acting identity can never leak into the next
 * (a source of order-dependent flakes). A no-op outside the test runner.
 */
const resets: Array<() => void> = [];
const TEST = (() => {
  try { return import.meta.env?.MODE === "test"; } catch { return false; }
})();

export function registerTestReset(fn: () => void): void {
  if (TEST) resets.push(fn);
}

export function runTestResets(): void {
  for (const r of resets) {
    try { r(); } catch { /* a reset must never fail a test */ }
  }
}
