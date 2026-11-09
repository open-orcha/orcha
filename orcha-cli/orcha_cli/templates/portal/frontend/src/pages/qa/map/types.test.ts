import { describe, expect, it } from "vitest";
import { RENTALS_MAP_JSON } from "./fixture";
import { isBuilding, isEmptyMap, parseAppMap, parseBuild } from "./types";

describe("parseAppMap", () => {
  const map = parseAppMap(RENTALS_MAP_JSON);

  it("reads the builder's map: build, sources, counts, features, nodes and edges", () => {
    expect(map.project_id).toBe("proj-rentals");
    expect(map.build).toEqual({ id: "build-7", status: "done", started_at: "2026-10-21T08:59:12Z", finished_at: "2026-10-21T09:00:00Z", error: null });
    expect(map.sources.code).toMatchObject({ repo: "/Users/mary/rentals", screens: 11, endpoints: 6 });
    expect(map.sources.tests).toMatchObject({ tests: 2, flows: 2, frameworks: ["xcuitest"] });
    expect(map.sources.live).toMatchObject({ runs: 12, last_run_id: "run-2041" });
    expect(map.counts).toMatchObject({ features: 4, screens: 11, seen: 5, declared: 4, blocked: 2, flows: 2 });
    expect(map.features.map((f) => f.name)).toEqual(["Listings", "Viewings", "Messages", "Account"]);
    expect(map.nodes).toHaveLength(23);
    expect(map.edges).toHaveLength(29);
  });

  it("keeps every fact's source: code path and line, test and framework, runs", () => {
    const detail = map.nodes.find((n) => n.id === "screen:listing-detail")!;
    expect(detail.evidence.code).toEqual([{ path: "ios/Rentals/Views/ListingDetailView.swift", line: 12 }]);
    expect(detail.evidence.tests[0]).toEqual({ path: "ios/RentalsUITests/BookingTests.swift", test_name: "testBookViewingFromListing", line: 40, framework: "xcuitest" });
    expect(detail.evidence.live).toEqual({ runs: 7, last_run_id: "run-2041", last_seen_at: "2026-10-20T16:42:00Z" });
    expect(detail.detail.actions).toEqual(["Book a viewing", "Message the agent"]);
    expect(detail.frame_url).toBe("/api/artifacts/runs/run-2041/frames/listing-detail.png");
  });

  it("reads endpoint and entity detail, a handler given as a file and line", () => {
    const post = map.nodes.find((n) => n.id === "endpoint:POST /api/viewings")!;
    expect(post.detail).toMatchObject({ method: "POST", pattern: "/api/viewings", side: "server", statuses: [200], handler: "web/app/api/viewings/route.ts:8" });
    const saved = map.nodes.find((n) => n.id === "entity:savedlisting")!;
    expect(saved.detail).toMatchObject({ store: "swiftdata", fields: ["listingId", "savedAt"] });
  });

  it("treats an empty live record as no live evidence", () => {
    const declared = map.nodes.find((n) => n.id === "screen:map-search")!;
    expect(declared.evidence.live).toBeNull();
    expect(map.nodes.find((n) => n.id === "screen:inbox")!.blocked_reason).toBe("Needs a conversation to exist");
  });

  it("reads a map with no build yet as empty", () => {
    const empty = parseAppMap({ project_id: "p1", build: null, sources: {}, counts: {}, features: [], nodes: [], edges: [] });
    expect(empty.build).toBeNull();
    expect(empty.sources).toEqual({ code: null, tests: null, live: null });
    expect(empty.counts.screens).toBe(0);
    expect(isEmptyMap(empty)).toBe(true);
    expect(isEmptyMap(map)).toBe(false);
  });

  it("reads features with no screens, before the first build, as empty", () => {
    const features = [{ key: "listings", name: "Listings", summary: null, screens: 0, seen: 0, coverage: "covered" }];
    const unbuilt = parseAppMap({ project_id: "p1", build: null, features, nodes: [], edges: [] });
    expect(unbuilt.features).toHaveLength(1);
    expect(isEmptyMap(unbuilt)).toBe(true);
  });

  it("tolerates junk and missing fields", () => {
    for (const raw of [null, undefined, 42, "map", [], {}]) {
      const m = parseAppMap(raw);
      expect(m.nodes).toEqual([]);
      expect(m.build).toBeNull();
      expect(isEmptyMap(m)).toBe(true);
    }
    const m = parseAppMap({
      nodes: [
        { id: "screen:home", kind: "screen" },
        { id: "x", kind: "planet" },
        { kind: "screen", label: "No id" },
        { id: "endpoint:GET /api/listings", kind: "endpoint", detail: { method: "get", pattern: "/api/listings", side: "sideways", store: 3 } },
        { id: "entity:listing", kind: "entity", detail: { store: "Core Data", fields: [{ name: "title" }, "rent", 5] } },
      ],
      edges: [
        { kind: "navigates", from: "screen:home", to: "screen:gone" },
        { kind: "calls", from: "screen:home", to: "endpoint:GET /api/listings", count: "lots", sources: ["code", "rumour"] },
      ],
      counts: { screens: "eleven" },
      features: [{ name: "No key" }, { key: "home", coverage: "excellent" }],
    });
    expect(m.nodes.map((n) => n.id)).toEqual(["screen:home", "endpoint:GET /api/listings", "entity:listing"]);
    const home = m.nodes[0];
    expect(home).toMatchObject({ key: "home", label: "home", state: "declared", feature: null, frame_url: null });
    expect(home.evidence).toEqual({ code: [], tests: [], live: null, crawl: null });
    expect(m.nodes[1].detail).toMatchObject({ method: "GET", side: null, store: null });
    expect(m.nodes[2].detail).toMatchObject({ store: "coredata", fields: ["title", "rent"] });
    // The edge to a node not on the map is dropped; the other gets an id, a count and only known sources.
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0]).toMatchObject({ kind: "calls", count: 1, sources: ["code"] });
    expect(m.edges[0].id).toBeTruthy();
    // A count that is not a number is counted from the nodes.
    expect(m.counts.screens).toBe(1);
    expect(m.features).toEqual([{ key: "home", name: "home", summary: null, screens: 0, seen: 0, coverage: "untested", covered_screens: 0 }]);
  });
});

describe("parseBuild", () => {
  it("reads a build's status and knows when it is still going", () => {
    const b = parseBuild({ id: "build-8", status: "running", started_at: "2026-10-21T09:10:00Z", finished_at: null, error: null });
    expect(b).toEqual({ id: "build-8", status: "running", started_at: "2026-10-21T09:10:00Z", finished_at: null, error: null });
    expect(isBuilding(b)).toBe(true);
    expect(isBuilding(parseBuild({ id: "build-8", status: "failed", error: "The repository could not be read." }))).toBe(false);
    expect(isBuilding(null)).toBe(false);
    expect(parseBuild({ status: "done" })).toBeNull();
  });

  it("reads which sources a build reads, which ran, and what it reused (#467)", () => {
    const b = parseBuild({
      id: "a1320066", status: "done", planned: ["live"], reused: { code: "2026-10-28T21:30:00Z", tests: "2026-10-28T21:30:05Z" },
      sources: { code: null, tests: null, live: { at: "2026-10-29T08:00:00Z", runs: 64, error: null } },
    })!;
    expect(b.planned).toEqual(["live"]);
    expect(b.ran).toEqual({ live: true });
    expect(b.reused).toEqual({ code: "2026-10-28T21:30:00Z", tests: "2026-10-28T21:30:05Z" });
    const failed = parseBuild({ id: "b2", status: "done", planned: ["code", "tests", "live"], sources: { code: { at: null, error: "The repository could not be read." } } })!;
    expect(failed.ran).toEqual({ code: false });
  });
});
