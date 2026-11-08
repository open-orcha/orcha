import { describe, expect, it } from "vitest";
import type { Scenario } from "./adapt";
import { groupByCategory, groupTally, nextSelection, parseScenariosView, visibleOrder, type ScenarioListItem } from "./scenario-list";

const item = (id: string, category: string | null): ScenarioListItem => ({
  scenario: { id, name: id, category } as Scenario,
  outcome: null,
});

describe("the scenarios list", () => {
  it("groups by category, alphabetically, keeping each group's order", () => {
    const groups = groupByCategory([item("a", "Payments"), item("b", null), item("c", "Payments"), item("d", "Auth")]);
    expect(groups.map((g) => [g.category, g.items.map((i) => i.scenario.id)])).toEqual([
      ["Auth", ["d"]],
      ["General", ["b"]],
      ["Payments", ["a", "c"]],
    ]);
  });

  it("selects one on click, toggles with cmd, extends with shift", () => {
    const order = ["a", "b", "c", "d"];
    expect([...nextSelection(order, new Set(["a"]), "a", "c", { toggle: false, range: false })]).toEqual(["c"]);
    expect([...nextSelection(order, new Set(["a"]), "a", "c", { toggle: true, range: false })]).toEqual(["a", "c"]);
    expect([...nextSelection(order, new Set(["a", "c"]), "a", "c", { toggle: true, range: false })]).toEqual(["a"]);
    expect([...nextSelection(order, new Set(["d"]), "d", "b", { toggle: false, range: true })]).toEqual(["b", "c", "d"]);
  });

  it("opens on the map unless the address asks for the list", () => {
    expect(parseScenariosView("list")).toBe("list");
    expect(parseScenariosView(null)).toBe("map");
    expect(parseScenariosView(null, 223)).toBe("list");
    expect(parseScenariosView("map", 223)).toBe("map");
    expect(parseScenariosView("grid")).toBe("map");
  });

  it("tallies a group's outcomes for its header", () => {
    const withOutcome = (id: string, outcome: ScenarioListItem["outcome"]): ScenarioListItem => ({ ...item(id, "Auth"), outcome });
    expect(groupTally([withOutcome("a", "fail"), withOutcome("b", "pass"), withOutcome("c", "pass"), withOutcome("d", "inconclusive"), withOutcome("e", null)])).toEqual({
      fail: 1,
      pass: 2,
      other: 1,
      notRun: 1,
    });
  });

  it("walks only the rows of open groups with the arrow keys", () => {
    const groups = groupByCategory([item("a", "Auth"), item("b", "Form"), item("c", "Form"), item("d", "Login")]);
    expect(visibleOrder(groups, new Set())).toEqual(["a", "b", "c", "d"]);
    expect(visibleOrder(groups, new Set(["Form"]))).toEqual(["a", "d"]);
  });
});
