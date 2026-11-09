import { describe, expect, it } from "vitest";
import { RENTALS_MAP_JSON } from "./fixture";
import {
  FAR_ZOOM,
  NEAR_ZOOM,
  connectionsOf,
  edgePasses,
  endpointPrefix,
  farTitle,
  featureSummaryLine,
  filterByPlatform,
  flowSteps,
  flowsOf,
  focusShows,
  frameSrc,
  initialPlatform,
  knownFrom,
  litNodes,
  lodFor,
  mapPlatforms,
  nearTitleSize,
  nodeSources,
  passesEvidence,
  platformLabel,
  statusBarCrop,
  quoteLabel,
  splitFlows,
  titleLines,
  truncate,
  unlinkedReason,
  whyNotSeen,
  zoomStep,
} from "./model";
import { scaleMap } from "./scale-fixture";
import { parseAppMap, type EvidenceSource } from "./types";

const map = parseAppMap(RENTALS_MAP_JSON);
const node = (id: string) => map.nodes.find((n) => n.id === id)!;
const chosen = (...s: EvidenceSource[]) => new Set<EvidenceSource>(s);

describe("level of detail", () => {
  it("shows regions far out, cards in the middle and frames close up", () => {
    expect(lodFor(0.05)).toBe("far");
    expect(lodFor(FAR_ZOOM - 0.01)).toBe("far");
    expect(lodFor(FAR_ZOOM)).toBe("mid");
    expect(lodFor(0.6)).toBe("mid");
    expect(lodFor(NEAR_ZOOM)).toBe("near");
    expect(lodFor(2.5)).toBe("near");
    expect(lodFor(Number.NaN)).toBe("far");
  });
});

describe("evidence filter", () => {
  it("knows which sources back a node", () => {
    expect(nodeSources(node("screen:listing-detail"))).toEqual(["code", "tests", "live"]);
    expect(nodeSources(node("screen:map-search"))).toEqual(["code"]);
    expect(nodeSources(node("screen:viewing-confirmed"))).toEqual(["tests"]);
    expect(nodeSources(node("flow:sign-in"))).toEqual(["tests"]);
  });

  it("keeps a node lit when any chosen source backs it; all three is no filter", () => {
    expect(passesEvidence(["code"], chosen("code", "tests", "live"))).toBe(true);
    expect(passesEvidence([], chosen("code", "tests", "live"))).toBe(true);
    expect(passesEvidence(["code"], chosen("live"))).toBe(false);
    expect(passesEvidence(["code", "live"], chosen("live"))).toBe(true);
    expect(passesEvidence(["code"], chosen())).toBe(false);
  });

  it("dims what only the code knows when Live alone is on", () => {
    const lit = litNodes(map, chosen("live"));
    expect(lit.has("screen:listing-detail")).toBe(true);
    expect(lit.has("screen:map-search")).toBe(false);
    expect(lit.has("screen:inbox")).toBe(false);
    expect(lit.has("endpoint:POST /api/viewings")).toBe(false);
    expect(litNodes(map, chosen("tests")).size).toBe(5);
  });

  it("judges an edge by its own sources, or by its ends when it names none", () => {
    const e = map.edges.find((x) => x.label === "Sign in to book")!;
    expect(edgePasses(e, { from: true, to: true }, chosen("code"))).toBe(false);
    expect(edgePasses(e, { from: false, to: false }, chosen("live"))).toBe(true);
    const bare = { ...e, sources: [] };
    expect(edgePasses(bare, { from: true, to: false }, chosen("live"))).toBe(false);
    expect(edgePasses(bare, { from: true, to: true }, chosen("live"))).toBe(true);
  });
});

describe("connections and flows", () => {
  it("lists where a screen leads, what leads there, what it calls and the flows through it", () => {
    const c = connectionsOf(map, "screen:listing-detail");
    expect(c.to.map((x) => x.node.label)).toEqual(["Book a viewing", "Conversation"]);
    expect(c.from.map((x) => x.node.label)).toEqual(["Listings"]);
    expect(c.calls.map((x) => x.node.label)).toEqual(["GET /api/listings/*"]);
    expect(c.flows.map((x) => x.node.label)).toEqual(["testBookViewingFromListing"]);
  });

  it("lists who reads and writes an entity", () => {
    const c = connectionsOf(map, "entity:viewing");
    expect(c.writtenBy.map((x) => x.node.label)).toEqual(["POST /api/viewings"]);
    expect(c.readBy.map((x) => x.node.label)).toEqual(["GET /api/viewings"]);
  });

  it("orders a flow's steps and lists the longest flow first", () => {
    expect(flowSteps(map, "flow:book-a-viewing").map((n) => n.label)).toEqual(["Listings", "Listing detail", "Book a viewing", "Viewing confirmed"]);
    expect(flowsOf(map).map((f) => [f.flow.label, f.steps.length])).toEqual([
      ["testBookViewingFromListing", 4],
      ["testSignInWithEmail", 2],
    ]);
  });

  it("says why a screen is not seen", () => {
    expect(whyNotSeen(node("screen:listing-detail"))).toBeNull();
    expect(whyNotSeen(node("screen:inbox"))).toBe("Needs a conversation to exist");
    expect(whyNotSeen(node("screen:map-search"))).toBe("No run has reached it yet; it is known from the code.");
    expect(whyNotSeen(node("screen:viewing-confirmed"))).toBe("No run has reached it yet; it is known from the existing tests.");
    expect(whyNotSeen({ ...node("screen:inbox"), blocked_reason: null })).toBe("A run tried to reach it and could not.");
  });
});

describe("endpoints and frames", () => {
  it("groups endpoints by path prefix", () => {
    expect(endpointPrefix(node("endpoint:GET /api/listings/*"))).toBe("/api/listings");
    expect(endpointPrefix(node("endpoint:POST /api/viewings"))).toBe("/api/viewings");
    const bare = (key: string) => ({ key, detail: { ...node("screen:listings").detail, pattern: null } });
    expect(endpointPrefix(bare("GET /v2/listings/:id/photos"))).toBe("/v2/listings");
    expect(endpointPrefix(bare("GET /health"))).toBe("/health");
    expect(endpointPrefix(bare("GET /"))).toBe("/");
  });

  it("uses a frame URL as given, and makes a storage path into one", () => {
    expect(frameSrc("/api/artifacts/runs/run-2041/frames/1.png")).toBe("/api/artifacts/runs/run-2041/frames/1.png");
    expect(frameSrc(null)).toBeNull();
  });
});

describe("platforms", () => {
  /** A home-rentals app on web, iOS and Android: the same screen once per platform, one Expo
   * screen no run has seen (no platform), an endpoint per client, a server-only route, data. */
  const multi = parseAppMap({
    features: [
      { key: "listings", name: "Listings" },
      { key: "admin", name: "Admin" },
      { key: "help", name: "Help" },
    ],
    nodes: [
      { id: "screen:web-detail", kind: "screen", label: "Properties details", feature: "listings", state: "seen", detail: { platform: "web" } },
      { id: "screen:ios-detail", kind: "screen", label: "Property details", feature: "listings", state: "seen", detail: { platform: "ios" } },
      { id: "screen:and-detail", kind: "screen", label: "Properties detail", feature: "listings", state: "declared", detail: { platform: "android" } },
      { id: "screen:admin", kind: "screen", label: "Admin", feature: "admin", detail: { platform: "web" } },
      { id: "screen:expo", kind: "screen", label: "Welcome", feature: "listings" },
      { id: "endpoint:GET /api/listings/*", kind: "endpoint", detail: { method: "GET", pattern: "/api/listings/*" } },
      { id: "endpoint:GET /api/admin", kind: "endpoint", detail: { method: "GET", pattern: "/api/admin" } },
      { id: "endpoint:POST /api/hooks", kind: "endpoint", detail: { method: "POST", pattern: "/api/hooks", side: "server" } },
      { id: "entity:listing", kind: "entity", label: "Listing" },
      { id: "entity:audit", kind: "entity", label: "Audit" },
      { id: "flow:web-browse", kind: "flow", label: "Browse on web" },
    ],
    edges: [
      { id: "c1", kind: "calls", from: "screen:web-detail", to: "endpoint:GET /api/listings/*" },
      { id: "c2", kind: "calls", from: "screen:ios-detail", to: "endpoint:GET /api/listings/*" },
      { id: "c3", kind: "calls", from: "screen:admin", to: "endpoint:GET /api/admin" },
      { id: "r1", kind: "reads", from: "endpoint:GET /api/listings/*", to: "entity:listing" },
      { id: "w1", kind: "writes", from: "endpoint:GET /api/admin", to: "entity:audit" },
      { id: "n1", kind: "navigates", from: "screen:admin", to: "screen:web-detail" },
      { id: "s1", kind: "steps", from: "flow:web-browse", to: "screen:web-detail", order: 0 },
      { id: "s2", kind: "steps", from: "flow:web-browse", to: "screen:admin", order: 1 },
    ],
  });

  it("lists the platforms the screens are on, web first, and names them", () => {
    expect(mapPlatforms(multi)).toEqual(["web", "ios", "android"]);
    expect(mapPlatforms(map)).toEqual(["ios"]);
    expect(["web", "ios", "android", "tvos"].map(platformLabel)).toEqual(["Web", "iOS", "Android", "Tvos"]);
  });

  it("opens on the sidebar's platform when the map has it and more than one platform", () => {
    expect(initialPlatform(["web", "ios", "android"], "ios")).toBe("ios");
    expect(initialPlatform(["web", "ios", "android"], "desktop")).toBeNull();
    expect(initialPlatform(["ios"], "ios")).toBeNull();
    expect(initialPlatform(["web", "ios"], null)).toBeNull();
  });

  it("keeps one platform's screens, the ones with no platform, and what only they touch", () => {
    const ios = filterByPlatform(multi, "ios");
    const ids = new Set(ios.nodes.map((n) => n.id));
    expect([...ids].filter((id) => id.startsWith("screen:")).sort()).toEqual(["screen:expo", "screen:ios-detail"]);
    // Called from an iOS screen; reads data the iOS screen shows.
    expect(ids.has("endpoint:GET /api/listings/*")).toBe(true);
    expect(ids.has("entity:listing")).toBe(true);
    // Only the web admin calls these, and only that endpoint writes the audit.
    expect(ids.has("endpoint:GET /api/admin")).toBe(false);
    expect(ids.has("entity:audit")).toBe(false);
    // A route no screen calls is on every platform; a web-only flow is not.
    expect(ids.has("endpoint:POST /api/hooks")).toBe(true);
    expect(ids.has("flow:web-browse")).toBe(false);
    // Admin has no iOS screen; Help never had a screen and stays.
    expect(ios.features.map((f) => f.key)).toEqual(["listings", "help"]);
    expect(ios.edges.map((e) => e.id).sort()).toEqual(["c2", "r1"]);
    expect(ios.counts).toMatchObject({ features: 2, screens: 2, seen: 1, declared: 1, endpoints: 2, entities: 1, flows: 0, edges: 2 });
  });

  it("keeps a flow while one of its steps is on the platform, and changes nothing for all platforms", () => {
    const web = filterByPlatform(multi, "web");
    expect(web.nodes.some((n) => n.id === "flow:web-browse")).toBe(true);
    expect(web.edges.map((e) => e.id)).toContain("n1");
    expect(filterByPlatform(multi, null)).toBe(multi);
  });

  it("splits the big app into thirds, no screen of another platform left", () => {
    const big = scaleMap();
    const total = big.nodes.filter((n) => n.kind === "screen").length;
    const per = mapPlatforms(big).map((p) => filterByPlatform(big, p));
    expect(per.reduce((sum, m) => sum + m.counts.screens, 0)).toBe(total);
    per.forEach((m, i) => expect(m.nodes.every((n) => n.kind !== "screen" || n.detail.platform === mapPlatforms(big)[i])).toBe(true));
  });
});

describe("reading at a distance", () => {
  it("steps the zoom in quarters of a doubling", () => {
    expect(zoomStep(1)).toBe(1);
    expect(zoomStep(0.5)).toBe(0.5);
    expect(zoomStep(0.52)).toBe(zoomStep(0.5));
    expect(zoomStep(0.6)).not.toBe(zoomStep(0.5));
    expect(zoomStep(Number.NaN)).toBe(1);
  });

  it("holds a region's far title near 17 px on screen while there is room", () => {
    for (const zoom of [0.1, 0.2, 0.3]) {
      const t = farTitle("Payments", 2000, 1200, zoom);
      expect(Math.round(t.size * zoom)).toBe(17);
      expect(t.lines).toBe(1);
    }
  });

  it("shrinks a far title to its region, wraps it to three lines at most and never cuts a word", () => {
    for (const label of ["Tenancy agreements and deposits", "Maintenance", "Ag", "Landlord dashboard for property managers and agents"]) {
      for (const [w, h] of [
        [516, 272],
        [788, 684],
      ]) {
        const t = farTitle(label, w, h, 0.05);
        expect(t.lines).toBeLessThanOrEqual(3);
        const longest = Math.max(...label.split(" ").map((x) => x.length));
        expect(longest * 0.6 * t.size).toBeLessThanOrEqual(w - 80 + 0.5);
        expect(t.size * 1.08 * t.lines).toBeLessThan(h);
      }
    }
    expect(titleLines("Rent schedule", 100, 500)).toBe(2);
    expect(titleLines("Rent schedule", 40, 500)).toBe(1);
  });

  it("grows a region's close title a little as the camera pulls back", () => {
    expect(nearTitleSize(1.2)).toBe(22);
    expect(nearTitleSize(0.45)).toBe(27);
    expect(nearTitleSize(0.1)).toBe(30);
  });

  it("cuts text at a word with an ellipsis", () => {
    expect(truncate("Tap Get started", 40)).toBe("Tap Get started");
    expect(truncate("Open Properties details Admin", 14)).toBe("Open Properti…");
    expect(truncate("Open Properties details Admin", 20)).toBe("Open Properties…");
    expect(truncate("propertyOpensLocation", 10)).toBe("propertyO…");
  });
});

describe("the Tests layer's flows", () => {
  const withUnlinked = parseAppMap({
    ...RENTALS_MAP_JSON,
    nodes: [
      ...RENTALS_MAP_JSON.nodes,
      { id: "flow:admin-shell", kind: "flow", key: "admin-shell", label: "admin shell tabs", detail: { framework: "xcuitest", skipped: true, skip_reason: "No admin session" } },
      { id: "flow:guest", kind: "flow", key: "guest", label: "guest browse", detail: { framework: "maestro", unlinked: "None of the 4 texts it taps or checks is in a screen's code" } },
      { id: "flow:bare", kind: "flow", key: "bare", label: "bare probe", detail: {} },
    ],
  });

  it("lists flows that walk screens first, then the ones tied to none", () => {
    const flows = flowsOf(withUnlinked);
    expect(flows.map((f) => f.flow.label)).toEqual(["testBookViewingFromListing", "testSignInWithEmail", "bare probe", "guest browse", "admin shell tabs"]);
    const { linked, unlinked } = splitFlows(flows);
    expect(linked.map((f) => f.steps.length)).toEqual([4, 2]);
    expect(unlinked.map((f) => f.flow.key)).toEqual(["bare", "guest", "admin-shell"]);
  });

  it("says why a flow walks no screen, skipped ones marked", () => {
    const node = (id: string) => withUnlinked.nodes.find((n) => n.id === id)!;
    expect(node("flow:admin-shell").detail.skipped).toBe(true);
    expect(unlinkedReason(node("flow:admin-shell"))).toBe("Skipped: No admin session");
    expect(unlinkedReason(node("flow:guest"))).toBe("None of the 4 texts it taps or checks is in a screen's code");
    expect(unlinkedReason(node("flow:bare"))).toMatch(/None of the screens/);
  });
});

describe("words on the map", () => {
  it("puts typographic quotes on edge labels, with no space inside them", () => {
    expect(quoteLabel('Tap " Add"')).toBe("Tap \u201cAdd\u201d");
    expect(quoteLabel('Tap "Theme color"')).toBe("Tap \u201cTheme color\u201d");
    expect(quoteLabel("Open /faqs")).toBe("Open /faqs");
  });

  it("drops the feature scan's screen count from a region's summary", () => {
    expect(featureSummaryLine("1 screen")).toBeNull();
    expect(featureSummaryLine("4 screens: overview, detail")).toBe("Kinds of screen in the code: overview, detail");
    expect(featureSummaryLine("Browse, search and save homes to rent")).toBe("Browse, search and save homes to rent");
    expect(featureSummaryLine(null)).toBeNull();
  });

  it("knows whether a platform's map has what the URL focuses on", () => {
    const ios = filterByPlatform(map, "ios");
    expect(focusShows(ios, { feature: "listings", node: null })).toBe(true);
    expect(focusShows(ios, { feature: "nope", node: null })).toBe(false);
    expect(focusShows(ios, { feature: null, node: "screen:listings" })).toBe(true);
    expect(focusShows(ios, { feature: null, node: null })).toBe(true);
  });
});


describe("screen cards", () => {
  it("crops the status bar off a phone frame, and nothing off a web one", () => {
    expect(statusBarCrop(1206, 2622, "ios")).toBe(0.065);
    expect(statusBarCrop(1080, 2400, "android")).toBe(0.045);
    // An Expo screen says no platform: a phone-shaped frame is cropped like an iPhone's.
    expect(statusBarCrop(1206, 2622, null)).toBe(0.065);
    expect(statusBarCrop(1440, 900, null)).toBe(0);
    expect(statusBarCrop(390, 844, "web")).toBe(0);
    expect(statusBarCrop(0, 0, "ios")).toBe(0);
  });

  it("says where a screen no run reached is known from", () => {
    const m = parseAppMap(RENTALS_MAP_JSON);
    const declared = m.nodes.find((n) => n.kind === "screen" && n.state === "declared" && n.evidence.code.length > 0)!;
    expect(knownFrom(declared)).toMatch(/^from code/);
    expect(knownFrom({ ...declared, evidence: { ...declared.evidence, code: [], tests: [] } })).toBeNull();
  });
});
