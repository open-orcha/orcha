import { describe, expect, it } from "vitest";
import { ago, areaPanel, areaSentence, headlineParts, ranOn, riskSorted, sharedScenarios, stateCounts, stateWords } from "./panel-model";
import type { CoverageArea, Depth } from "./types";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const depth = (over: Partial<Depth> = {}): Depth => ({ score: 2, scenarios: 1, criteria: 3, edge_kinds: [], happy_only: true, accounts: [], examples: 0, ...over });

function area(over: Partial<CoverageArea> = {}): CoverageArea {
  return {
    key: "expenses",
    name: "Expenses",
    summary: null,
    entry: "/expenses",
    paths: [],
    source: "code",
    state: "thin",
    states: { all: "thin", web: "thin", ios: "untested" },
    depth: depth(),
    depths: { all: depth(), web: depth(), ios: depth({ scenarios: 0, criteria: 0, happy_only: false, score: 0 }) },
    seen: false,
    visits: 0,
    recent: false,
    explored: { at: null, screens: [] },
    last: { web: { outcome: "pass", at: "2026-10-17T10:00:00Z" } },
    last_result_at: "2026-10-17T10:00:00Z",
    scenarios: [
      { id: "s1", name: "Add an expense", status: "validated", target_kind: "web", source: "draft", confidence: 0.95, confirmed: 0, linked: true, suggestion: false, last: { web: { outcome: "pass", at: "2026-10-17T10:00:00Z" } } },
      { id: "s2", name: "Totals", status: "validated", target_kind: null, source: "text", confidence: 0.45, confirmed: 0, linked: false, suggestion: true, last: {} },
    ],
    linked: 1,
    drafts: 0,
    suggestions: 1,
    importance: 2,
    risk: 2,
    rank: 1,
    ...over,
  };
}

const REPORT = { platforms: ["ios", "web"], edge_labels: { error: "Errors", empty: "Empty states" } };

describe("areaPanel", () => {
  it("splits linked scenarios from suggestions and reads each platform", () => {
    const p = areaPanel(area(), REPORT, "all", NOW);
    expect(p.linked.map((s) => [s.name, s.source, s.confidence])).toEqual([["Add an expense", "Drafted for this area", "95%"]]);
    expect(p.suggestions.map((s) => s.id)).toEqual(["s2"]);
    expect(p.platforms).toEqual([
      { platform: "ios", label: "iOS", outcome: "none", at: null, text: "No scenario" },
      { platform: "web", label: "Web", outcome: "pass", at: "2026-10-17T10:00:00Z", text: "Passed 2h ago" },
    ]);
    expect(p.depth.facts).toEqual(["1 scenario", "3 criteria"]);
    expect(p.depth.edges.find((e) => e.key === "error")).toEqual({ key: "error", label: "Errors", tested: false });
  });

  it("follows the platform switch", () => {
    const p = areaPanel(area(), REPORT, "ios", NOW);
    expect(p.state).toBe("untested");
    expect(p.sentence).toBe("No scenario tests this yet on iOS. 1 scenario might. Confirm below.");
  });

  it("says a run trace below the threshold passes through, and one that tests the area visits it", () => {
    const rows = [
      { id: "t1", name: "Search with no matches", status: "validated", target_kind: "web", source: "run_trace" as const, confidence: 0.5, confirmed: 0, linked: false, suggestion: true, last: {} },
      { id: "t2", name: "About us loads", status: "validated", target_kind: "web", source: "run_trace" as const, confidence: 0.85, confirmed: 0, linked: true, suggestion: false, last: {} },
    ];
    const p = areaPanel(area({ scenarios: rows }), REPORT, "all", NOW);
    expect(p.suggestions.map((s) => [s.id, s.source, s.confidence])).toEqual([["t1", "Runs pass through it", "50%"]]);
    expect(p.linked.map((s) => [s.id, s.source])).toEqual([["t2", "Runs visit it"]]);
  });

  it("says seen, not tested for an explored untested area", () => {
    const a = area({ state: "untested", states: { all: "untested" }, seen: true, suggestions: 0, scenarios: [] });
    expect(areaPanel(a, REPORT, "all", NOW).stateLabel).toBe("Seen, not tested");
    expect(areaSentence(a, "all")).toBe("Explored, but no scenario tests it.");
  });
});

describe("covered on paper, and where it ran", () => {
  it("says a platform covered by scenarios that never ran there is not run yet", () => {
    // A scenario for every platform covers Android on paper; it only ever ran on iOS.
    const a = area({
      state: "covered",
      states: { all: "covered", ios: "covered", android: "covered" },
      depths: { all: depth({ score: 4, scenarios: 2 }), ios: depth({ score: 4, scenarios: 2 }), android: depth({ score: 4, scenarios: 2 }) },
      last: { ios: { outcome: "pass", at: "2026-10-17T10:00:00Z" } },
    });
    expect(ranOn(a, "ios")).toBe(true);
    expect(ranOn(a, "android")).toBe(false);
    expect(stateWords(a, "ios")).toBe("Covered");
    expect(stateWords(a, "android")).toBe("Covered, not run yet");
    expect(areaSentence(a, "android")).toBe("2 scenarios on Android, with 0 edge cases. None has run on Android yet.");
    expect(stateWords({ ...a, last: {} }, "all")).toBe("Covered, not run yet");
    expect(stateWords({ ...a, state: "untested", states: { all: "untested" }, seen: true }, "all")).toBe("Seen, not tested");
  });

  it("knows when one scenario counts in several areas", () => {
    const totals = { scenarios: 2 } as Parameters<typeof sharedScenarios>[0]["totals"];
    expect(sharedScenarios({ areas: [area({ depth: depth({ scenarios: 2 }) }), area({ depth: depth({ scenarios: 1 }) })], totals })).toBe(true);
    expect(sharedScenarios({ areas: [area({ depth: depth({ scenarios: 2 }) })], totals })).toBe(false);
  });
});

describe("list and legend", () => {
  it("ranks failing, then seen, then thin", () => {
    const list = [
      area({ key: "thin", name: "Thin" }),
      area({ key: "fail", name: "Fail", states: { all: "failing" } }),
      area({ key: "seen", name: "Seen", states: { all: "untested" }, seen: true }),
      area({ key: "dark", name: "Dark", states: { all: "untested" } }),
    ];
    expect(riskSorted(list, "all").map((a) => a.key)).toEqual(["fail", "seen", "dark", "thin"]);
    expect(stateCounts(list, "all")).toEqual({ untested: 2, thin: 1, covered: 0, strong: 0, failing: 1, seen: 1 });
  });

  it("sets the headline's numbers apart", () => {
    expect(headlineParts("3 of 12 areas tested.")).toEqual([
      { text: "3", number: true },
      { text: " of ", number: false },
      { text: "12", number: true },
      { text: " areas tested.", number: false },
    ]);
  });

  it("says how long ago", () => {
    expect(ago("2026-10-17T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-10-14T12:00:00Z", NOW)).toBe("3 days ago");
    expect(ago(null, NOW)).toBe("");
  });
});
