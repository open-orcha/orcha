import { describe, expect, it } from "vitest";
import { coverMark, coverOf, dropCovered, isCovered, parseMapFocus, screenCoverage } from "./coverage-model";
import { parseAppMap } from "./types";

/** A map with what covers each node. */
const MAP = parseAppMap({
  project_id: "proj-homes",
  features: [
    { key: "listings", name: "Listings", screens: 2, seen: 2, coverage: "covered", covered_screens: 2 },
    { key: "contact", name: "Contact an agent", screens: 1, seen: 0, coverage: "untested", covered_screens: 0 },
  ],
  nodes: [
    {
      id: "screen:/listings", kind: "screen", key: "/listings", label: "Listings", feature: "listings", state: "seen",
      covered_by: [
        { scenario_id: "sc-browse", title: "Browse listings and open one", result: "pass", via: "run" },
        { scenario_id: "sc-saved", title: "Keep a saved search", result: "fail", via: "trace" },
      ],
    },
    {
      id: "screen:/listings/*", kind: "screen", key: "/listings/*", label: "Listing detail", feature: "listings", state: "seen",
      covered_by: [{ scenario_id: "sc-open", title: "Open a listing from the list", result: null, via: "migration" }, { title: "no id" }],
    },
    { id: "screen:/contact", kind: "screen", key: "/contact", label: "Contact", feature: "contact", state: "declared" },
    { id: "endpoint:GET /api/listings", kind: "endpoint", key: "GET /api/listings", label: "GET /api/listings", covered_by: [{ scenario_id: "sc-browse", title: "Browse", result: "pass", via: "teleport" }] },
  ],
  edges: [
    { id: "e1", kind: "navigates", from: "screen:/listings", to: "screen:/listings/*", label: "Tap a listing", count: 3, covered: true },
    { id: "e2", kind: "navigates", from: "screen:/listings/*", to: "screen:/contact", label: "Tap Contact the agent", count: 0 },
  ],
});

describe("coverage on the map", () => {
  it("parses who covers each node, each edge's walk and each feature's covered screens", () => {
    const list = MAP.nodes.find((n) => n.id === "screen:/listings")!;
    expect(coverOf(list)).toEqual([
      { scenario_id: "sc-browse", title: "Browse listings and open one", result: "pass", via: "run" },
      { scenario_id: "sc-saved", title: "Keep a saved search", result: "fail", via: "trace" },
    ]);
    // A link without a scenario is dropped; an unknown way in reads as a run; no result is null.
    expect(coverOf(MAP.nodes.find((n) => n.id === "screen:/listings/*")!)).toEqual([
      { scenario_id: "sc-open", title: "Open a listing from the list", result: null, via: "migration" },
    ]);
    expect(coverOf(MAP.nodes.find((n) => n.kind === "endpoint")!)[0].via).toBe("run");
    expect(coverOf(MAP.nodes.find((n) => n.id === "screen:/contact")!)).toEqual([]);
    expect(MAP.edges.map((e) => e.covered)).toEqual([true, false]);
    expect(MAP.features.map((f) => f.covered_screens)).toEqual([2, 0]);
  });

  it("marks cards and counts covered screens", () => {
    const [list, , contact] = MAP.nodes;
    expect(coverMark(list)).toBe("Covered by 2");
    expect(coverMark(contact)).toBe("Not covered");
    expect(isCovered({})).toBe(false);
    expect(screenCoverage(MAP)).toEqual({ covered: 2, total: 3 });
  });

  it("the Uncovered filter dims every covered node", () => {
    const lit = new Set(MAP.nodes.map((n) => n.id));
    expect([...dropCovered(lit, MAP)]).toEqual(["screen:/contact"]);
  });

});

describe("the Map page's URL focus", () => {
  it("reads ?feature= and ?screen=, ignoring junk", () => {
    expect(parseMapFocus(new URLSearchParams("feature=listings"))).toEqual({ feature: "listings", node: null });
    expect(parseMapFocus(new URLSearchParams("screen=0e1b6a52-6c7b-4f3e-9a51-2f0f9f3c1d11"))).toEqual({ feature: null, node: "0e1b6a52-6c7b-4f3e-9a51-2f0f9f3c1d11" });
    expect(parseMapFocus({ feature: "Bad Key!", screen: "\u0001" })).toEqual({ feature: null, node: null });
    expect(parseMapFocus(null)).toEqual({ feature: null, node: null });
  });
});
