/** QA (brief §3): the per-task spend drilldown never shows unknown cost as $0. */
import { describe, expect, it } from "vitest";
import { spendCostState } from "./MetricsPage";

describe("spendCostState", () => {
  it("no run recorded a cost → not reported, even though the SUM is 0", () => {
    expect(spendCostState({ runs: 2, total_cost_usd: 0, runs_with_cost: 0 })).toBe("none");
  });
  it("every run recorded a cost → full (a real $0.00 is allowed)", () => {
    expect(spendCostState({ runs: 2, total_cost_usd: 0, runs_with_cost: 2 })).toBe("full");
    expect(spendCostState({ runs: 1, total_cost_usd: 2, runs_with_cost: 1 })).toBe("full");
  });
  it("some runs recorded a cost → partial", () => {
    expect(spendCostState({ runs: 3, total_cost_usd: 2, runs_with_cost: 1 })).toBe("partial");
  });
  it("older backend without runs_with_cost: $0 is not reported, >0 is partial", () => {
    expect(spendCostState({ runs: 2, total_cost_usd: 0 })).toBe("none");
    expect(spendCostState({ runs: 2, total_cost_usd: 1.5 })).toBe("partial");
  });
});
