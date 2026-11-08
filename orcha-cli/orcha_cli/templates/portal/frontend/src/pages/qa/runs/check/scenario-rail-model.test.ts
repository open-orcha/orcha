import { describe, expect, it } from "vitest";
import { railKeyTarget, railSummary } from "./scenario-rail-model";

describe("railKeyTarget (#158)", () => {
  it("moves one row with the arrows and stops at the ends", () => {
    expect(railKeyTarget("ArrowDown", 0, 3)).toBe(1);
    expect(railKeyTarget("ArrowDown", 2, 3)).toBe(2);
    expect(railKeyTarget("ArrowUp", 1, 3)).toBe(0);
    expect(railKeyTarget("ArrowUp", 0, 3)).toBe(0);
    expect(railKeyTarget("ArrowRight", 0, 3)).toBe(1);
    expect(railKeyTarget("ArrowLeft", 2, 3)).toBe(1);
  });

  it("jumps to the first and last scenario with Home and End", () => {
    expect(railKeyTarget("Home", 2, 5)).toBe(0);
    expect(railKeyTarget("End", 0, 5)).toBe(4);
  });

  it("ignores other keys and an empty list", () => {
    expect(railKeyTarget("Enter", 0, 3)).toBeNull();
    expect(railKeyTarget("a", 0, 3)).toBeNull();
    expect(railKeyTarget("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("railSummary", () => {
  it("counts failures first and leaves out verdicts nobody has", () => {
    expect(railSummary(["passed", "failed", "passed", "failed"])).toBe("2 failed · 2 passed");
    expect(railSummary(["unprocessable", "passed"])).toBe("1 unprocessable · 1 passed");
    expect(railSummary(["running"])).toBe("1 running");
    expect(railSummary([])).toBe("");
  });
});
