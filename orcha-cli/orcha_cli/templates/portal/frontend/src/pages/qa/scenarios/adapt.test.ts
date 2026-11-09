import { describe, expect, it } from "vitest";
import type { QaScenario } from "../qaApi";
import { adaptScenario, dependencyIds, fromChecks, pendingBy, rollupOutcome, toChecks } from "./adapt";

const row = (over: Partial<QaScenario> & Record<string, unknown> = {}) =>
  ({ id: "a", platform: "ios", name: "Sign in", category: null, persona: null, description: null, criteria: ["x", "y"], tags: null, source: "walk", status: "draft", status_reason: null, walk_id: null, session_id: null, task_id: null, created_at: null, updated_at: null, verdicts: [], ...over }) as QaScenario;

describe("the scenario adapter", () => {
  it("rolls the newest verdicts up into one outcome", () => {
    const v = (criterion_index: number, verdict: "pass" | "fail" | "blocked" | "inconclusive") => ({ criterion_index, verdict });
    expect(rollupOutcome(2, [])).toBeNull();
    expect(rollupOutcome(2, [v(0, "pass"), v(1, "pass")])).toBe("pass");
    expect(rollupOutcome(2, [v(0, "pass")])).toBe("inconclusive");
    expect(rollupOutcome(2, [v(0, "blocked"), v(1, "fail")])).toBe("fail");
    expect(rollupOutcome(2, [v(0, "blocked"), v(1, "inconclusive")])).toBe("blocked");
  });

  it("keeps checks by criterion, both ways", () => {
    const raw = [{ criterion_index: null, line: 'text "Hi"' }, { criterion_index: 1, line: "Button A" }, { criterion_index: 1, line: "Button B" }, { line: "" }, null];
    const c = toChecks(raw);
    expect(c).toEqual({ criteria: { "1": ["Button A", "Button B"] }, scenario: ['text "Hi"'] });
    expect(fromChecks(c)).toEqual([{ criterion_index: null, line: 'text "Hi"' }, { criterion_index: 1, line: "Button A" }, { criterion_index: 1, line: "Button B" }]);
  });

  it("resolves dependencies by id or name and keeps what matches nothing", () => {
    expect(dependencyIds(["b", "Sign In ", "gone", 3], [{ id: "a", name: "Sign in" }, { id: "b", name: "Other" }])).toEqual(["b", "a", "gone"]);
  });

  it("adapts a row: platform as the pin, a position and open suggestions when known", () => {
    const s = adaptScenario(row({ depends_on: [], needs: ["signed in"], data: { plan: "pro" }, checks: [] }), [], { positions: { a: { x: 1, y: 2 } }, pending: pendingBy([{ scenario_id: "a", status: "proposal" }, { scenario_id: "a", status: "dismissed" }]) });
    expect(s).toMatchObject({ target_kind: "ios", tags: [], position: { x: 1, y: 2 }, pending: 1, needs: ["signed in"], data: { plan: "pro" }, outcome: null });
  });
});
