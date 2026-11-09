import { describe, expect, it } from "vitest";
import { checkNewDependency, dependencyRefusalMessage } from "./scenario-dependency-graph";

describe("checkNewDependency", () => {
  it("refuses a self-dependency", () => {
    const result = checkNewDependency([{ id: "a", depends_on: [] }], "a", "a");
    expect(result).toEqual({ ok: false, reason: "self" });
  });

  it("refuses a duplicate dependency", () => {
    const scenarios = [
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
    ];
    const result = checkNewDependency(scenarios, "a", "b");
    expect(result).toEqual({ ok: false, reason: "duplicate" });
  });

  it("refuses a direct cycle (b depends on a, adding a depends on b)", () => {
    const scenarios = [
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
    ];
    const result = checkNewDependency(scenarios, "b", "a");
    expect(result).toEqual({ ok: false, reason: "cycle" });
  });

  it("refuses a transitive cycle (a -> b -> c, adding c depends on a)", () => {
    const scenarios = [
      { id: "a", depends_on: ["b"] },
      { id: "b", depends_on: ["c"] },
      { id: "c", depends_on: [] },
    ];
    const result = checkNewDependency(scenarios, "a", "c");
    expect(result).toEqual({ ok: false, reason: "cycle" });
  });

  it("allows a new, non-cyclic dependency", () => {
    const scenarios = [
      { id: "a", depends_on: [] },
      { id: "b", depends_on: [] },
      { id: "c", depends_on: [] },
    ];
    const result = checkNewDependency(scenarios, "a", "c");
    expect(result).toEqual({ ok: true });
  });

  it("allows a diamond shape (c depends on a and b, a and b independent)", () => {
    const scenarios = [
      { id: "a", depends_on: [] },
      { id: "b", depends_on: [] },
      { id: "c", depends_on: ["a"] },
    ];
    const result = checkNewDependency(scenarios, "b", "c");
    expect(result).toEqual({ ok: true });
  });
});

describe("dependencyRefusalMessage", () => {
  it("has copy for every reason", () => {
    expect(dependencyRefusalMessage("self")).toMatch(/itself/);
    expect(dependencyRefusalMessage("duplicate")).toMatch(/already/);
    expect(dependencyRefusalMessage("cycle")).toMatch(/cycle/);
  });
});
