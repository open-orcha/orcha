import { describe, expect, it } from "vitest";
import type { QaMap } from "../qaApi";
import { adaptMap } from "./adapt";
import { layoutScreens } from "./layout";
import { flowSteps, nodeSources } from "./model";

const ID = { home: "0e1b6a52-6c7b-4f3e-9a51-2f0f9f3c1d11", cart: "7d1a34c0-49a1-4b1f-8e57-5a3a7e7b9c22", pay: "c3a5f1de-1f7e-4e4b-b7a9-1e2d3c4b5a33", flow: "aa11bb22-cc33-4d44-8e55-ff6677889900", api: "11112222-3333-4444-8555-666677778888" };
const node = (over: object) => ({ platform: "ios", label: null, feature_key: null, state: "declared", blocked_kind: null, blocked_reason: null, sources: [], frame_id: null, last_seen_at: null, evidence: {}, detail: {}, ...over });

const MAP = {
  features: [
    { id: "f1", key: "shop", name: "Shop", summary: "2 screens", entry: null, paths: [], source: "code", last_explored_at: null, coverage: "thin", covered_screens: 1 },
    { id: "f2", key: "ios-only", name: "Elsewhere", summary: null, entry: null, paths: [], source: "code", last_explored_at: null },
  ],
  nodes: [
    node({
      id: ID.home, kind: "screen", key: "home", label: "Home", feature_key: "shop", state: "seen", frame_id: "fr1", last_seen_at: "2026-11-01T10:00:00Z", sources: ["code", "live"],
      evidence: { code: [{ path: "Home.swift", line: 4 }], tests: ["HomeTests.swift:12"], live: { sightings: 3, session_ids: ["s2", "s1"], last_seen_at: "2026-11-01T10:00:00Z" } },
      detail: { code: { platform: "ios", anchors: ["From code"], actions: ["Open"] }, live: { anchors: ["Welcome"], actions: ["Open", "Close"] } },
      covered_by: [{ scenario_id: "sc1", title: "Browse", result: "pass", via: "run" }],
    }),
    node({ id: ID.cart, kind: "screen", key: "cart", label: "Cart", feature_key: "gone", state: "blocked", blocked_kind: "needs_sign_in", blocked_reason: "asks for an account", sources: ["agent"], evidence: { agent: { blocked: { kind: "needs_sign_in", reason: "asks for an account", session_id: "s2", at: "2026-11-01T10:01:00Z" } } } }),
    node({ id: ID.pay, kind: "screen", key: "pay", label: "Pay", feature_key: "shop", state: "seen", sources: ["crawl"], evidence: { crawl: { runs: 2, last_run_id: "s9" } } }),
    node({ id: ID.flow, kind: "flow", key: "Buy.swift#buy", label: "Buy", sources: ["tests"], detail: { tests: { framework: "xcuitest" } }, evidence: { tests: [{ path: "Buy.swift", test_name: "buy", line: 3, framework: "xcuitest" }] } }),
    node({ id: ID.api, kind: "endpoint", key: "GET /v1/items", label: "GET /v1/items", sources: ["code"], detail: { code: { method: "get", pattern: "/v1/items", side: "client", handler: "Items.swift:9" } } }),
  ],
  edges: [
    { id: "e1", platform: "ios", kind: "navigates", from_node_id: ID.home, to_node_id: ID.pay, label: "Pay", count: 2, sources: ["crawl", "code"], covered: true },
    { id: "e2", platform: "ios", kind: "steps", from_node_id: ID.flow, to_node_id: ID.pay, label: "", count: 1, sources: ["tests"], detail: { tests: { order: 1 } } },
    { id: "e3", platform: "ios", kind: "steps", from_node_id: ID.flow, to_node_id: ID.home, label: "", count: 1, sources: ["tests"], detail: { tests: { order: 0 } } },
    { id: "e4", platform: "ios", kind: "navigates", from_node_id: ID.home, to_node_id: "not-on-the-map", label: "", count: 1, sources: [] },
  ],
  last_build: { id: "b1", platform: "ios", source: "code", status: "done", error: null, started_at: "2026-11-01T09:00:00Z", ended_at: "2026-11-01T09:00:05Z" },
  sources: { code: { at: "2026-11-01T09:00:05Z", screens: 2, edges: 3, endpoints: 1, entities: 0 }, tests: null, live: { at: "2026-11-01T10:00:00Z", runs: 2, last_run_id: "s2" } },
} as unknown as QaMap;

const map = adaptMap(MAP, "c1", "ios");
const byId = (id: string) => map.nodes.find((n) => n.id === id)!;

describe("adaptMap", () => {
  it("folds each source's evidence into the map's, on UUID ids", () => {
    const home = byId(ID.home);
    expect(home.evidence.code).toEqual([{ path: "Home.swift", line: 4 }]);
    expect(home.evidence.tests.map((t) => [t.path, t.line])).toEqual([["HomeTests.swift", 12]]);
    expect(home.evidence.live).toEqual({ runs: 2, last_run_id: "s2", last_seen_at: "2026-11-01T10:00:00Z" });
    expect(nodeSources(home)).toEqual(["code", "tests", "live"]);
    expect(home.frame_url).toBe("/api/qa/frames/fr1");
    expect(home.covered_by).toEqual([{ scenario_id: "sc1", title: "Browse", result: "pass", via: "run" }]);
  });

  it("counts a crawl's sightings as live evidence", () => {
    expect(byId(ID.pay).evidence.live).toMatchObject({ runs: 2, last_run_id: "s9" });
    expect(nodeSources(byId(ID.pay))).toEqual(["live"]);
  });

  it("keeps a dead end with the session that hit it", () => {
    expect(byId(ID.cart).evidence.crawl).toEqual({ reason: "asks for an account", kind: "needs_sign_in", run_id: "s2", at: "2026-11-01T10:01:00Z" });
  });

  it("folds details, a run's words first, and sets the page's platform", () => {
    const home = byId(ID.home);
    expect(home.detail.platform).toBe("ios");
    expect(home.detail.anchors).toEqual(["Welcome"]);
    expect(home.detail.actions).toEqual(["Open", "Close"]);
    expect(byId(ID.api).detail).toMatchObject({ method: "GET", pattern: "/v1/items", side: "client", handler: "Items.swift:9" });
    expect(byId(ID.flow).detail.framework).toBe("xcuitest");
  });

  it("drops a feature with no screen on this platform, and treats an unknown one as none", () => {
    expect(map.features.map((f) => [f.key, f.screens, f.seen, f.coverage, f.covered_screens])).toEqual([["shop", 2, 2, "thin", 1]]);
    expect(byId(ID.cart).feature).toBeNull();
  });

  it("keeps every feature while the platform has no screens", () => {
    expect(adaptMap({ ...MAP, nodes: [], edges: [] }, "c1", "ios").features).toHaveLength(2);
  });

  it("maps edges, their order, their sources in the canvas's words, and drops an end not on the map", () => {
    expect(map.edges.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(map.edges[0]).toMatchObject({ from: ID.home, to: ID.pay, count: 2, covered: true });
    expect(map.edges[0].sources).toEqual(["code", "live"]);
    expect(flowSteps(map, ID.flow).map((n) => n.key)).toEqual(["home", "pay"]);
  });

  it("carries the last build, each source's last read and the counts", () => {
    expect(map.build).toMatchObject({ id: "b1", status: "done", finished_at: "2026-11-01T09:00:05Z" });
    expect(map.built_at).toBe("2026-11-01T09:00:05Z");
    expect(map.sources.code?.screens).toBe(2);
    expect(map.sources.tests).toBeNull();
    expect(map.sources.live?.runs).toBe(2);
    expect(map.counts).toMatchObject({ screens: 3, seen: 2, blocked: 1, flows: 1, endpoints: 1 });
  });

  it("gives the layout a map it can lay out with UUID ids", () => {
    const layout = layoutScreens(map);
    expect(layout.regions.map((r) => r.key)).toEqual(expect.arrayContaining(["shop"]));
    expect([...layout.cards.keys()]).toEqual(expect.arrayContaining([ID.home, ID.pay]));
  });

  it("says what a build read and what it reused from earlier reads", () => {
    const api = { features: [], nodes: [], edges: [], platform: "ios", last_build: { id: "b1", platform: "ios", source: "code", status: "done", counts: {}, error: null, started_at: "2026-11-01T10:00:00Z", ended_at: "2026-11-01T10:00:05Z" }, sources: { tests: { at: "2026-10-30T10:00:00Z", tests: 4 }, live: { at: "2026-10-31T10:00:00Z", runs: 2 } } };
    const build = adaptMap(api as never, "c1", "ios").build!;
    expect(build.planned).toEqual(["code"]);
    expect(build.reused).toEqual({ tests: "2026-10-30T10:00:00Z", live: "2026-10-31T10:00:00Z" });
    expect(build.ran).toEqual({ code: true });
  });
});
