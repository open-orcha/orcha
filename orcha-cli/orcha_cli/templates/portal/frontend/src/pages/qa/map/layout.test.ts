import { describe, expect, it } from "vitest";
import { RENTALS_MAP_JSON } from "./fixture";
import {
  AREAS_REGION,
  CARD,
  GHOST,
  PAD_BOTTOM,
  REGION_HEAD,
  bundleEdges,
  bundleLabel,
  edgeLabels,
  portText,
  routeHits,
  type Route,
  EDGE_CAP,
  LABEL,
  LINK_CAP,
  MIN_REGION_H,
  MIN_REGION_W,
  OTHER_REGION,
  DATA_GROUP_FROM,
  borderPoint,
  dataNeighbours,
  depthOrder,
  endpointTopic,
  edgeWidth,
  featureFocus,
  fogPatches,
  foldedInto,
  labelObstacles,
  layoutDataFlow,
  layoutScreens,
  linkPlan,
  placeLabels,
  routeBetween,
  routeMidpoint,
  routePath,
  screenEdgePlan,
  screenOrder,
  tourStops,
  type Rect,
} from "./layout";
import { farTitle, filterByPlatform } from "./model";
import { scaleMap } from "./scale-fixture";
import { parseAppMap, type AppMap, type AppMapEdge } from "./types";

const map = parseAppMap(RENTALS_MAP_JSON);
const nodesById = new Map(map.nodes.map((n) => [n.id, n]));

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function inside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

function strictlyInside(p: { x: number; y: number }, r: Rect): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

/** A bigger app: `features` features of 1..9 screens each, chained by navigation. */
function bigMap(features: number): AppMap {
  const nodes = [];
  const edges = [];
  for (let f = 0; f < features; f++) {
    const size = 1 + ((f * 5) % 9);
    for (let s = 0; s < size; s++) {
      nodes.push({ id: `screen:f${f}-s${s}`, kind: "screen", key: `f${f}-s${s}`, label: `Screen ${s}`, feature: `f${f}`, state: s % 3 === 0 ? "seen" : "declared" });
      if (s > 0) edges.push({ id: `n${f}-${s}`, kind: "navigates", from: `screen:f${f}-s${Math.floor((s - 1) / 2)}`, to: `screen:f${f}-s${s}` });
    }
    if (f > 0) edges.push({ id: `x${f}`, kind: "navigates", from: `screen:f${f - 1}-s0`, to: `screen:f${f}-s0`, count: 3 });
  }
  return parseAppMap({ features: Array.from({ length: features }, (_, f) => ({ key: `f${f}`, name: `Feature ${f}` })), nodes, edges });
}

const nav = (from: string, to: string, count = 1): AppMapEdge => ({ id: `${from}>${to}`, kind: "navigates", from, to, label: null, count, sources: [], order: 0 });

describe("depthOrder", () => {

  it("walks from the entry, breadth first, the busiest way first", () => {
    const order = depthOrder(["detail", "book", "list", "saved"], [nav("list", "detail", 7), nav("list", "saved", 2), nav("detail", "book", 4)]);
    expect(order).toEqual([
      { id: "list", depth: 0 },
      { id: "detail", depth: 1 },
      { id: "saved", depth: 1 },
      { id: "book", depth: 2 },
    ]);
  });

  it("starts a screen nothing leads to on its own walk, and survives a cycle", () => {
    const order = depthOrder(["a", "b", "lonely"], [nav("a", "b"), nav("b", "a")]);
    expect(order.map((o) => o.id).sort()).toEqual(["a", "b", "lonely"]);
    // Nothing leads to it: it is the entry.
    expect(order.find((o) => o.id === "lonely")!.depth).toBe(0);
    expect(order.find((o) => o.id === "a")!.depth).toBe(1);
  });

  it("prefers the screen other features lead to as the entry", () => {
    const order = depthOrder(["a", "b"], [nav("a", "b"), nav("b", "a")], new Map([["b", 5]]));
    expect(order[0].id).toBe("b");
  });
});

describe("layoutScreens", () => {
  const layout = layoutScreens(map);

  it("gives every feature a region and every screen a card", () => {
    expect(layout.regions.map((r) => r.key).sort()).toEqual(["account", "listings", "messages", "viewings"]);
    expect(layout.cards.size).toBe(11);
    const listings = layout.regions.find((r) => r.key === "listings")!;
    expect(listings).toMatchObject({ label: "Listings", screens: 4, seen: 3, declared: 1, blocked: 0, coverage: "covered" });
    expect(layout.regions.find((r) => r.key === "viewings")).toMatchObject({ screens: 3, seen: 1, declared: 1, blocked: 1 });
  });

  it("is the same for the same map", () => {
    const again = layoutScreens(parseAppMap(RENTALS_MAP_JSON));
    expect(again.regions).toEqual(layout.regions);
    expect([...again.cards.entries()]).toEqual([...layout.cards.entries()]);
    expect([...again.routes.entries()]).toEqual([...layout.routes.entries()]);
  });

  it("puts screens in columns by depth from the feature's entry", () => {
    const card = (id: string) => layout.cards.get(`screen:${id}`)!;
    expect(card("listings").depth).toBe(0);
    expect(card("listing-detail").depth).toBe(1);
    expect(card("listing-detail").x).toBeGreaterThan(card("listings").x);
    expect(card("book-viewing").depth).toBe(0);
    expect(card("viewing-confirmed").depth).toBe(1);
  });

  for (const [name, m] of [
    ["the rentals app", map],
    ["40 features", bigMap(40)],
    ["one feature", bigMap(1)],
  ] as const) {
    it(`never overlaps regions and keeps cards inside their region (${name})`, () => {
      const l = layoutScreens(m);
      for (let i = 0; i < l.regions.length; i++) for (let j = i + 1; j < l.regions.length; j++) expect(overlap(l.regions[i], l.regions[j])).toBe(0);
      const byKey = new Map(l.regions.map((r) => [r.key, r]));
      const cards = [...l.cards.values()];
      for (const c of cards) expect(inside(c, byKey.get(c.region)!)).toBe(true);
      for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) expect(overlap(cards[i], cards[j])).toBe(0);
      for (const r of l.regions) expect(inside(r, { x: 0, y: 0, w: l.width, h: l.height })).toBe(true);
    });
  }

  it("is wider than tall for a big app", () => {
    const l = layoutScreens(bigMap(40));
    expect(l.width).toBeGreaterThan(l.height);
  });

  it("routes a region's navigation orthogonally in its gutters, one line per screen pair and direction", () => {
    const l = layoutScreens(bigMap(12));
    expect(l.routes.size).toBeGreaterThan(0);
    for (const [id, route] of l.routes) {
      const b = l.bundles.get(id)!;
      const [s, t] = [l.cards.get(b.from)!, l.cards.get(b.to)!];
      expect(s.region).toBe(t.region);
      // Every run is horizontal or vertical, and the line starts and ends on its two cards' borders.
      for (let i = 1; i < route.points.length; i++) {
        const [p, q] = [route.points[i - 1], route.points[i]];
        expect(p.x === q.x || p.y === q.y).toBe(true);
      }
      for (const [p, c] of [[route.points[0], s], [route.points.at(-1)!, t]] as const) {
        expect(strictlyInside(p, c)).toBe(false);
        expect(p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h).toBe(true);
      }
    }
    // Between regions a test's flow still gets one curve under them.
    expect(routeBetween(l, "screen:f0-s0", "screen:f1-s0")!.points).toHaveLength(2);
  });

  it("sums navigation between regions for the zoomed-out map, one link per pair", () => {
    const signIn = layout.links.find((k) => k.from === "account" && k.to === "listings")!;
    expect(signIn.count).toBe(5);
    expect(signIn.route.points).toHaveLength(2);
    const back = parseAppMap({
      features: [{ key: "a", name: "A" }, { key: "b", name: "B" }],
      nodes: [
        { id: "screen:a", kind: "screen", feature: "a" },
        { id: "screen:b", kind: "screen", feature: "b" },
      ],
      edges: [
        { id: "ab", kind: "navigates", from: "screen:a", to: "screen:b", count: 2 },
        { id: "ba", kind: "navigates", from: "screen:b", to: "screen:a", count: 5 },
      ],
    });
    const links = layoutScreens(back).links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from: "b", to: "a", count: 7, both: true });
  });

  it("never makes a region smaller than two cards wide and one row tall", () => {
    for (const r of layoutScreens(bigMap(14)).regions) {
      expect(r.w).toBeGreaterThanOrEqual(MIN_REGION_W);
      expect(r.h).toBeGreaterThanOrEqual(MIN_REGION_H);
    }
  });

  it("keeps a feature with no screens as an empty region, and screens without a feature in Other", () => {
    const m = parseAppMap({
      features: [{ key: "listings", name: "Listings" }, { key: "payments", name: "Payments" }],
      nodes: [
        { id: "screen:listings", kind: "screen", label: "Listings", feature: "listings" },
        { id: "screen:about", kind: "screen", label: "About" },
      ],
    });
    const l = layoutScreens(m);
    expect(l.regions.map((r) => [r.key, r.screens])).toEqual([
      ["listings", 1],
      ["payments", 0],
      ["~other", 1],
    ]);
    expect(l.regions[2]).toMatchObject({ label: "Other screens", kind: "other", collapsed: false, fold: null });
    expect(fogPatches(l, new Map(m.nodes.map((n) => [n.id, n]))).some((p) => p.w === l.regions[1].w && p.fog === 1)).toBe(true);
  });

  it("lays out an empty map as nothing", () => {
    const l = layoutScreens(parseAppMap({}));
    expect(l).toMatchObject({ width: 0, height: 0, regions: [] });
  });
});

describe("a big app (60 features, 180 screens, 350 edges)", () => {
  const big = scaleMap();
  const l = layoutScreens(big);
  const byKey = new Map(l.regions.map((r) => [r.key, r]));

  it("folds the small features into one Other areas card and the screens no feature claims into another, last", () => {
    expect(big.features).toHaveLength(60);
    expect(big.nodes.filter((n) => n.kind === "screen")).toHaveLength(180);
    expect(big.edges).toHaveLength(350);
    const areas = byKey.get(AREAS_REGION)!;
    expect(areas).toMatchObject({ kind: "areas", collapsed: true, label: "Other areas" });
    expect(areas.members).toHaveLength(48);
    expect(areas.summary!.split(", ")).toHaveLength(48);
    expect(l.regions.at(-1)).toMatchObject({ key: OTHER_REGION, collapsed: true, screens: 38 });
    expect(l.regions.length).toBeLessThanOrEqual(15);
    // A summary card draws no cards, but every screen still knows its region.
    expect([...l.cards.values()].some((c) => c.region === AREAS_REGION || c.region === OTHER_REGION)).toBe(false);
    expect(l.regionOf.size).toBe(180);
    expect(fogPatches(l, new Map(big.nodes.map((n) => [n.id, n]))).some((p) => p.w === areas.w && p.h === areas.h)).toBe(false);
  });

  it("keeps every region readable from afar: wide enough, its title on screen at about 17 px, never cut", () => {
    const zoom = Math.min(1360 / l.width, 760 / l.height);
    for (const r of l.regions) {
      expect(r.w).toBeGreaterThanOrEqual(MIN_REGION_W);
      const t = farTitle(r.label, r.w, r.h, zoom);
      expect(t.lines).toBeLessThanOrEqual(3);
      expect(t.size * zoom).toBeGreaterThanOrEqual(13);
      const longest = Math.max(...r.label.split(" ").map((w) => w.length));
      expect(longest * 0.6 * t.size).toBeLessThanOrEqual(r.w - 80);
    }
  });

  it("opens Other areas into one region per small feature, each foldable back and full size", () => {
    const open = layoutScreens(big, { expanded: new Set([AREAS_REGION, OTHER_REGION]) });
    expect(open.regions.some((r) => r.key === AREAS_REGION)).toBe(false);
    const small = open.regions.filter((r) => r.fold === AREAS_REGION);
    expect(small).toHaveLength(48);
    for (const r of small) expect(r.w).toBeGreaterThanOrEqual(MIN_REGION_W);
    expect(open.regions.at(-1)).toMatchObject({ key: OTHER_REGION, collapsed: false, fold: OTHER_REGION });
    expect(open.cards.size).toBe(180);
    for (let i = 0; i < open.regions.length; i++) for (let j = i + 1; j < open.regions.length; j++) expect(overlap(open.regions[i], open.regions[j])).toBe(0);
  });

  it("from afar draws at most LINK_CAP region links, the busiest, the focused region's first", () => {
    const pairs = l.links.map((k) => [k.from, k.to].sort().join("~"));
    expect(new Set(pairs).size).toBe(pairs.length);
    const plan = linkPlan(l.links, null);
    expect(plan.shown.length).toBe(Math.min(LINK_CAP, l.links.length));
    expect(plan.hidden).toBe(l.links.length - plan.shown.length);
    for (let i = 1; i < plan.shown.length; i++) expect(plan.shown[i - 1].link.count).toBeGreaterThanOrEqual(plan.shown[i].link.count);
    const quiet = l.links.at(-1)!.from;
    const focused = linkPlan(l.links, quiet);
    const mine = l.links.filter((k) => k.from === quiet || k.to === quiet).length;
    expect(focused.shown.slice(0, mine).every((s) => s.look === "active")).toBe(true);
    expect(focused.shown.slice(mine).every((s) => s.look === "dim")).toBe(true);
  });

  it("closer in draws each region's own lines and none between regions until something is in focus, capped", () => {
    const plan = screenEdgePlan(l, { node: null, region: null });
    expect(plan.shown.length).toBeLessThanOrEqual(EDGE_CAP);
    expect(plan.shown.every((s) => !s.cross && s.part === "inner" && s.look === "normal")).toBe(true);
    expect(plan.shown.length + plan.hidden).toBe(l.routes.size);
    expect(screenEdgePlan(l, { node: null, region: null }, 10).shown).toHaveLength(10);
  });

  it("lights a focused screen's lines in and out, to and from the ports for other regions, and dims the rest", () => {
    const cross = [...l.bundles.values()].find((b) => l.crossRoutes.get(b.id)?.out && l.crossRoutes.get(b.id)?.in)!;
    const node = cross.from;
    const plan = screenEdgePlan(l, { node, region: l.cards.get(node)!.region });
    const mine = [...l.bundles.values()].filter((b) => (b.from === node || b.to === node) && (l.routes.has(b.id) || l.crossRoutes.has(b.id)));
    const active = new Set(plan.shown.filter((s) => s.look === "active").map((s) => s.bundle));
    expect([...active].sort()).toEqual(mine.map((b) => b.id).sort());
    expect(plan.shown.filter((s) => s.bundle === cross.id).map((s) => s.part).sort()).toEqual(["in", "out"]);
    // Lines between other regions stay hidden; the rest of the regions' own lines dim.
    for (const s of plan.shown) if (s.look !== "active") expect(s).toMatchObject({ cross: false, part: "inner", look: "dim" });
  });

  it("shows the lines a hovered port stands for, and nothing else between regions", () => {
    const port = l.ports.find((p) => p.to !== null && p.count >= 2)!;
    const plan = screenEdgePlan(l, { node: null, region: port.region, port: port.id });
    const cross = plan.shown.filter((s) => s.cross);
    expect(new Set(cross.map((s) => s.bundle))).toEqual(new Set(port.bundles));
    for (const s of cross) expect(s.look).toBe("active");
    // The half in the port's own region ends (or starts) at the port.
    for (const s of cross) {
      const r = l.crossRoutes.get(s.bundle)!;
      const at = s.part === "out" ? s.route.points.at(-1)! : s.route.points[0];
      const pid = s.part === "out" ? r.ports[0] : r.ports[1];
      expect(at).toEqual(l.ports.find((p) => p.id === pid)!.anchor);
    }
    expect(plan.shown.filter((s) => !s.cross).every((s) => s.look === "dim")).toBe(true);
  });

  it("dims the other features' lines for a focused feature, and draws none between regions", () => {
    const region = l.regions[0].key;
    const plan = screenEdgePlan(l, { node: null, region });
    for (const s of plan.shown) {
      expect(s.cross).toBe(false);
      expect(s.look).toBe(l.cards.get(l.bundles.get(s.bundle)!.from)!.region === region ? "normal" : "dim");
    }
    expect(plan.shown.some((s) => s.look === "normal")).toBe(true);
  });
});

describe("edge labels", () => {
  const l = layoutScreens(scaleMap());
  const obstacles = labelObstacles(l);

  it("places labels on no card, no region name and no other label, cut to fit", () => {
    const candidates = [...l.routes.entries()].map(([id, route], i) => ({ id, text: "Open Properties details Admin propertyOpensLocation map full screen", at: routeMidpoint(route), priority: i }));
    const placed = placeLabels(candidates, obstacles);
    expect(placed.size).toBeGreaterThan(0);
    const boxes = [...placed.values()].map((p) => ({ x: p.x - p.w / 2, y: p.y - LABEL.h / 2, w: p.w, h: LABEL.h }));
    for (const b of boxes) for (const o of obstacles) expect(overlap(b, o)).toBe(0);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(0);
    for (const p of placed.values()) {
      expect(p.text.length).toBeLessThanOrEqual(LABEL.maxChars);
      expect(p.text.endsWith("…")).toBe(true);
    }
  });

  it("gives the first in priority the room, and leaves a label out when too little fits", () => {
    const at = { x: 100, y: 100 };
    const placed = placeLabels(
      [
        { id: "busy", text: "Tap Book a viewing", at, priority: 1 },
        { id: "hovered", text: "Press back", at, priority: -1 },
      ],
      [],
    );
    expect([...placed.keys()]).toEqual(["hovered"]);
    expect(placed.get("hovered")!.text).toBe("Press back");
    // Between two cards 40 units apart: under six characters fit, so no label.
    const tight = placeLabels([{ id: "x", text: "Tap Get started", at, priority: 0 }], [{ x: 0, y: 0, w: 80, h: 200 }, { x: 120, y: 0, w: 80, h: 200 }]);
    expect(tight.size).toBe(0);
    // In a gutter of 76: cut to the room.
    const gutter = placeLabels([{ id: "x", text: "Tap Get started now", at, priority: 0 }], [{ x: 0, y: 0, w: 62, h: 200 }, { x: 138, y: 0, w: 62, h: 200 }]);
    expect(gutter.get("x")!.text).toBe("Tap Get…");
  });
});

/** Lately's Home, as the map showed it messily: an entry ("Lately") that leads to "Add routine"
 * by three moves and back by two, two screens only the code knows, and other features that lead
 * in and out of all of them. */
function latelyMap(): AppMap {
  const screen = (key: string, feature: string, state: string) => ({ id: `screen:${key}`, kind: "screen", key, label: key, feature, state });
  const nav = (id: string, from: string, to: string, label: string, count: number, sources: string[] = ["live"]) => ({ id, kind: "navigates", from: `screen:${from}`, to: `screen:${to}`, label, count, sources });
  return parseAppMap({
    features: [
      { key: "home", name: "Home" },
      { key: "settings", name: "Settings" },
      { key: "routine", name: "Routine" },
      { key: "onboarding", name: "Onboarding" },
    ],
    nodes: [
      screen("main-tab", "home", "seen"),
      screen("add-routine", "home", "seen"),
      screen("browse-library", "home", "declared"),
      screen("symbol-picker", "home", "blocked"),
      screen("settings", "settings", "seen"),
      screen("appearance", "settings", "seen"),
      screen("routine-detail", "routine", "seen"),
      screen("edit-routine", "routine", "declared"),
      screen("onboarding", "onboarding", "seen"),
    ],
    edges: [
      nav("a1", "main-tab", "add-routine", 'Tap "Add a routine"', 19),
      nav("a2", "main-tab", "add-routine", 'Tap "Add"', 12),
      nav("a3", "main-tab", "add-routine", 'Tap "Tab Bar"', 13),
      nav("b1", "add-routine", "main-tab", 'Tap "Save"', 31),
      nav("b2", "add-routine", "main-tab", 'Tap "Close"', 7),
      nav("c1", "main-tab", "browse-library", "Open Browse library", 0, ["code"]),
      nav("c2", "main-tab", "symbol-picker", "Open Symbol picker", 0, ["code"]),
      nav("x1", "onboarding", "main-tab", 'Tap "Skip onboarding"', 19),
      nav("x2", "main-tab", "settings", "Tab Settings", 0, ["code"]),
      nav("x3", "main-tab", "settings", 'Tap "Tab Bar"', 17),
      nav("x4", "settings", "main-tab", 'Tap "Home"', 8),
      nav("x5", "settings", "browse-library", "Open Browse library", 0, ["code"]),
      nav("x6", "settings", "symbol-picker", "Open Symbol picker", 0, ["code"]),
      nav("x7", "routine-detail", "browse-library", "Open Browse library", 0, ["code"]),
      nav("x8", "main-tab", "routine-detail", 'Tap "View details"', 3),
      nav("x9", "routine-detail", "main-tab", 'Tap "Back"', 12),
      nav("s1", "settings", "appearance", 'Tap "Appearance"', 10),
      nav("r1", "routine-detail", "edit-routine", "Open Edit routine", 0, ["code"]),
    ],
  });
}

describe("the zoomed-in region", () => {
  const lately = latelyMap();
  const l = layoutScreens(lately);
  const card = (key: string) => l.cards.get(`screen:${key}`)!;
  const maps = [
    ["Lately", l],
    ["the rentals app", layoutScreens(map)],
    ["40 features", layoutScreens(bigMap(40))],
    ["a big app, opened", layoutScreens(scaleMap(), { expanded: new Set([AREAS_REGION, OTHER_REGION]) })],
  ] as const;

  it("bundles the moves between two screens into one line per direction, dashed only when only the code knows it", () => {
    const bundles = bundleEdges(lately.edges);
    const there = bundles.find((b) => b.from === "screen:main-tab" && b.to === "screen:add-routine")!;
    expect(there).toMatchObject({ edges: ["a1", "a3", "a2"], count: 44, label: 'Tap "Add a routine"', more: 2, fromCode: false });
    expect(bundleLabel(there)).toBe("Tap \u201cAdd a routine\u201d +2");
    expect(bundles.find((b) => b.from === "screen:add-routine" && b.to === "screen:main-tab")).toMatchObject({ count: 38, more: 1 });
    expect(bundles.find((b) => b.edges.includes("c1"))!.fromCode).toBe(true);
    // Code and a run on the same line: travelled, solid.
    expect(bundles.find((b) => b.edges.includes("x2"))).toMatchObject({ edges: ["x3", "x2"], fromCode: false });
  });

  it("stands the entry alone in the first column and the screens it leads to in the next, whatever the parallel moves", () => {
    expect(card("main-tab")).toMatchObject({ col: 0, row: 0, depth: 0 });
    for (const key of ["add-routine", "browse-library", "symbol-picker"]) expect(card(key)).toMatchObject({ col: 1, depth: 1 });
    // The travelled way first in its column.
    expect(card("add-routine").row).toBe(0);
    expect(card("main-tab").x).toBeLessThan(card("add-routine").x);
    // A screen nothing in the region leads to stands beside the entry, not in its column.
    const order = depthOrder(["a", "b", "lonely"], [nav("a", "b"), nav("b", "a")], new Map([["a", 3]]));
    expect(order).toEqual([
      { id: "a", depth: 0 },
      { id: "b", depth: 1 },
      { id: "lonely", depth: 1 },
    ]);
  });

  it("draws a seen screen as a frame card and one no run reached as a compact ghost, and sizes the region to them", () => {
    expect(card("main-tab")).toMatchObject({ h: CARD.h, ghost: false });
    expect(card("browse-library")).toMatchObject({ h: GHOST.h, ghost: true });
    expect(card("symbol-picker")).toMatchObject({ h: GHOST.h, ghost: true });
    expect(GHOST.h).toBeLessThanOrEqual(CARD.h / 2);
    for (const [, layout] of maps) {
      for (const r of layout.regions) {
        const mine = [...layout.cards.values()].filter((c) => c.region === r.key);
        if (mine.length === 0) continue;
        const top = Math.min(...mine.map((c) => c.y));
        const bottom = Math.max(...mine.map((c) => c.y + c.h));
        // No empty band: the cards fill the region from under its name to above its ports (a
        // region never shorter than one frame card centres a shorter column of ghosts).
        const above = top - (r.y + REGION_HEAD);
        const below = r.y + r.h - PAD_BOTTOM - bottom;
        expect(above).toBeGreaterThanOrEqual(0);
        expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
        if (bottom - top >= CARD.h) expect(above).toBe(0);
        // Each column centred on the tallest one.
        for (const col of new Set(mine.map((c) => c.col))) {
          const cs = mine.filter((c) => c.col === col);
          const mid = (Math.min(...cs.map((c) => c.y)) + Math.max(...cs.map((c) => c.y + c.h))) / 2;
          expect(Math.abs(mid - (top + bottom) / 2)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  for (const [name, layout] of maps) {
    it(`never routes a line under or through a card, and keeps every line inside its region (${name})`, () => {
      const cards = [...layout.cards.values()];
      const byKey = new Map(layout.regions.map((r) => [r.key, r]));
      const within = (route: Route, r: Rect) => route.points.every((p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
      for (const [id, route] of layout.routes) {
        expect(routeHits(route, cards), id).toBe(false);
        expect(within(route, byKey.get(layout.cards.get(layout.bundles.get(id)!.from)!.region)!)).toBe(true);
      }
      for (const [id, cross] of layout.crossRoutes) {
        const b = layout.bundles.get(id)!;
        for (const [route, end] of [[cross.out, b.from], [cross.in, b.to]] as const) {
          if (!route) continue;
          expect(routeHits(route, cards), id).toBe(false);
          expect(within(route, byKey.get(layout.cards.get(end)!.region)!)).toBe(true);
        }
      }
    });
  }

  it("collapses the lines to another region into one port per neighbour on the border, with counts", () => {
    const home = l.regions.find((r) => r.key === "home")!;
    const ports = l.ports.filter((p) => p.region === "home");
    expect(ports.map((p) => [p.to, p.count, p.out, p.in])).toEqual([
      ["settings", 4, true, true],
      ["routine", 3, true, true],
      ["onboarding", 1, false, true],
    ]);
    expect(portText(ports[0].label, ports[0].count)).toBe("Settings · 4");
    for (const [, layout] of maps) {
      const byKey = new Map(layout.regions.map((r) => [r.key, r]));
      for (const r of layout.regions) {
        const mine = layout.ports.filter((p) => p.region === r.key);
        // One port per neighbour, on the bottom border, side by side.
        const tos = mine.map((p) => p.to);
        expect(new Set(tos).size).toBe(tos.length);
        for (const p of mine) {
          expect(p.y + p.h / 2).toBe(r.y + r.h);
          expect(p.x).toBeGreaterThanOrEqual(r.x);
          if (p.to) expect(byKey.has(p.to)).toBe(true);
        }
        for (let i = 1; i < mine.length; i++) expect(mine[i].x).toBeGreaterThanOrEqual(mine[i - 1].x + mine[i - 1].w);
        // Every line between this region and another is counted once, in the port to that region.
        const crossing = [...layout.bundles.values()].filter((b) => layout.cards.get(b.from)?.region === r.key || layout.cards.get(b.to)?.region === r.key).filter((b) => layout.regionOf.get(b.from) !== layout.regionOf.get(b.to));
        expect(mine.reduce((a, p) => a + p.count, 0)).toBe(crossing.length);
        for (const p of mine.filter((x) => x.to)) {
          const pair = crossing.filter((b) => [layout.regionOf.get(b.from), layout.regionOf.get(b.to)].includes(p.to!));
          expect(p.count).toBe(pair.length);
        }
      }
    }
    // As tall as its taller column: a frame card and two ghosts, and no taller.
    expect(home.h).toBe(REGION_HEAD + CARD.h + 2 * GHOST.h + 2 * 24 + PAD_BOTTOM);
  });

  it("labels only the lines in focus or hovered, on their line, never on a card or another label", () => {
    const rest = screenEdgePlan(l, { node: null, region: null });
    expect(edgeLabels(l, rest.shown, null).size).toBe(0);
    const focus = screenEdgePlan(l, { node: "screen:add-routine", region: "home" });
    const labels = edgeLabels(l, focus.shown, null);
    expect(labels.size).toBeGreaterThan(0);
    const active = new Set(focus.shown.filter((s) => s.look === "active").map((s) => s.id));
    for (const id of labels.keys()) expect(active.has(id)).toBe(true);
    const boxes = [...labels.values()].map((p) => ({ x: p.x - p.w / 2, y: p.y - LABEL.h / 2, w: p.w, h: LABEL.h }));
    for (const b of boxes) for (const o of labelObstacles(l)) expect(overlap(b, o)).toBe(0);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(0);
    // A hovered line at rest gets its label, and only it.
    const code = rest.shown.find((s) => l.bundles.get(s.bundle)!.edges.includes("c1"))!;
    expect([...edgeLabels(l, rest.shown, code.id).keys()]).toEqual([code.id]);
    // Each label sits on its own line.
    for (const [id, p] of labels) {
      const route = focus.shown.find((s) => s.id === id)!.route;
      const on = route.points.slice(1).some((q, i) => {
        const a = route.points[i];
        return Math.min(a.x, q.x) - 0.5 <= p.x && p.x <= Math.max(a.x, q.x) + 0.5 && Math.min(a.y, q.y) - 0.5 <= p.y && p.y <= Math.max(a.y, q.y) + 0.5;
      });
      expect(on, id).toBe(true);
    }
  });
});

describe("fog and the tour", () => {
  const layout = layoutScreens(map);

  it("fogs what no run reached: declared thick, blocked thinner, seen clear", () => {
    const patches = fogPatches(layout, nodesById);
    expect(patches).toHaveLength(6);
    const card = layout.cards.get("screen:inbox")!;
    expect(patches.find((p) => p.x === card.x - 14 && p.y === card.y - 14)!.fog).toBe(0.65);
  });

  it("tours region by region, then the first screens a user walks to", () => {
    const stops = tourStops(layout, nodesById, 2);
    expect(stops[0].kind).toBe("region");
    expect(stops.filter((s) => s.kind === "region")).toHaveLength(4);
    const listings = stops.findIndex((s) => s.id === "listings");
    expect(stops.slice(listings + 1, listings + 3).map((s) => s.label)).toEqual(["Listings", "Listing detail"]);
  });
});

describe("layoutDataFlow", () => {
  const screens = layoutScreens(map);
  const data = layoutDataFlow(map, screenOrder(screens));

  it("stacks screens over endpoints over entities", () => {
    const [top, mid, low] = data.bands;
    expect([top.key, mid.key, low.key]).toEqual(["screens", "endpoints", "entities"]);
    expect(top.y + top.h).toBeLessThan(mid.y);
    expect(mid.y + mid.h).toBeLessThan(low.y);
    for (const n of map.nodes) {
      const p = data.pills.get(n.id);
      if (!p) continue;
      const band = data.bands.find((b) => b.key === (n.kind === "screen" ? "screens" : n.kind === "endpoint" ? "endpoints" : "entities"))!;
      expect(inside(p, band)).toBe(true);
    }
  });

  it("leaves out screens with no data edge and the flows", () => {
    expect(data.pills.has("screen:map-search")).toBe(false);
    expect(data.pills.has("flow:sign-in")).toBe(false);
    expect(data.pills.has("screen:saved")).toBe(true);
  });

  it("groups endpoints by path prefix, each inside its group, no overlaps", () => {
    expect(data.groups.map((g) => [g.key, g.count]).sort()).toEqual([
      ["/api/listings", 2],
      ["/api/messages", 1],
      ["/api/session", 1],
      ["/api/viewings", 2],
    ]);
    const listings = data.groups.find((g) => g.key === "/api/listings")!;
    expect(inside(data.pills.get("endpoint:GET /api/listings")!, listings)).toBe(true);
    const pills = [...data.pills.values()];
    for (let i = 0; i < pills.length; i++) for (let j = i + 1; j < pills.length; j++) expect(overlap(pills[i], pills[j])).toBe(0);
  });

  it("collapses the endpoints band to a note when nothing calls a backend, and routes screens to their data", () => {
    const local = parseAppMap({
      features: [{ key: "journal", name: "Journal" }],
      nodes: [
        { id: "screen:entries", kind: "screen", label: "Entries", feature: "journal" },
        { id: "screen:entry", kind: "screen", label: "Entry", feature: "journal" },
        { id: "entity:entry", kind: "entity", label: "Entry", detail: { store: "swiftdata" } },
      ],
      edges: [
        { id: "r1", kind: "reads", from: "screen:entries", to: "entity:entry" },
        { id: "w1", kind: "writes", from: "screen:entry", to: "entity:entry" },
      ],
    });
    const d = layoutDataFlow(local, ["screen:entries", "screen:entry"]);
    const [top, mid, low] = d.bands;
    expect(d.note).not.toBeNull();
    expect(inside(d.note!, mid)).toBe(true);
    expect(mid.h).toBeLessThan(100);
    expect(low.y - (top.y + top.h)).toBeLessThan(data.bands[2].y - (data.bands[0].y + data.bands[0].h));
    expect(d.routes.get("w1")!.sides).toEqual(["bottom", "top"]);
    expect(d.routes.get("r1")!.points[1].y).toBeGreaterThan(mid.y + mid.h);
    expect(data.note).toBeNull();
  });

  it("routes calls down and writes down", () => {
    const call = map.edges.find((e) => e.kind === "calls" && e.from === "screen:book-viewing")!;
    const write = map.edges.find((e) => e.kind === "writes" && e.from === "endpoint:POST /api/viewings")!;
    for (const e of [call, write]) {
      const r = data.routes.get(e.id)!;
      expect(r.sides).toEqual(["bottom", "top"]);
      expect(r.points[1].y).toBeGreaterThan(r.points[0].y);
    }
  });
});

describe("layoutDataFlow at scale", () => {
  // Nyumbani's size: 180 screens, 186 endpoints under fourteen prefixes, a few entities.
  const big = scaleMap({ endpoints: 186, entities: 6 });
  const order = screenOrder(layoutScreens(big));
  const data = layoutDataFlow(big, order);
  const flowEdges = big.edges.filter((e) => e.kind === "calls" || e.kind === "reads" || e.kind === "writes");
  const drawn = (id: string) => data.pills.has(id) || data.groups.some((g) => g.id === id && g.collapsed);

  it("folds both bands into groups past DATA_GROUP_FROM, and keeps a small map as it was", () => {
    expect(data.folded).toEqual({ screens: true, endpoints: true });
    const small = layoutDataFlow(map, screenOrder(layoutScreens(map)));
    expect(small.folded).toEqual({ screens: false, endpoints: false });
    expect(small.holder.size).toBe(0);
    expect(small.groups.every((g) => !g.collapsed && !g.foldable)).toBe(true);
    expect(small.links.every((l) => l.count === 1 && map.edges.some((e) => e.id === l.id))).toBe(true);
    expect(DATA_GROUP_FROM).toBe(40);
  });

  it("shows one box per feature and per path prefix, with counts, method mix and sides", () => {
    const endpoints = big.nodes.filter((n) => n.kind === "endpoint");
    const props = data.groups.find((g) => g.id === "group:endpoints:/api/properties")!;
    expect(props.collapsed).toBe(true);
    expect(props.label).toBe("/api/properties/*");
    expect(props.count).toBe(endpoints.filter((n) => n.key.includes("/api/properties/")).length);
    expect(props.methods.reduce((a, [, n]) => a + n, 0)).toBe(props.count);
    expect(props.sides.reduce((a, [, n]) => a + n, 0)).toBe(props.count);
    expect(data.groups.filter((g) => g.band === "endpoints")).toHaveLength(14);
    // Every node is drawn on its own or held by exactly one folded group.
    for (const n of endpoints) expect(data.pills.has(n.id) !== data.holder.has(n.id)).toBe(true);
    const featureOf = (id: string) => big.nodes.find((n) => n.id === id)?.feature ?? null;
    for (const g of data.groups.filter((x) => x.band === "screens" && x.key !== AREAS_REGION)) {
      expect(g.members.every((m) => featureOf(m) === (g.key === OTHER_REGION ? null : g.key))).toBe(true);
      expect(g.count).toBeGreaterThanOrEqual(2);
    }
    // The features with one screen here share "Other areas", as on the screens layer.
    const areas = data.groups.find((g) => g.id === `group:screens:${AREAS_REGION}`)!;
    expect(areas.label).toBe("Other areas");
    expect(new Set(areas.members.map(featureOf)).size).toBe(areas.count);
    // Far fewer things to draw than nodes.
    expect(data.pills.size + data.groups.length).toBeLessThan(120);
  });

  it("keeps boxes and pills inside their band, without overlaps", () => {
    const boxes: Rect[] = [...data.pills.values(), ...data.groups.filter((g) => g.collapsed)];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(0);
    for (const g of data.groups) expect(inside(g, data.bands.find((b) => b.key === g.band)!)).toBe(true);
  });

  it("sums the edges between groups into one link per pair, with counts", () => {
    const keys = data.links.map((l) => `${l.kind}|${l.from}|${l.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const l of data.links) {
      expect(drawn(l.from) && drawn(l.to)).toBe(true);
      expect(data.routes.has(l.id)).toBe(true);
      expect(l.count).toBe(l.edges.length);
    }
    const inside = flowEdges.filter((e) => (data.holder.get(e.from) ?? e.from) === (data.holder.get(e.to) ?? e.to)).length;
    expect(data.links.reduce((a, l) => a + l.count, 0)).toBe(flowEdges.length - inside);
    expect(data.links.length).toBeLessThan(flowEdges.length * 0.6);
  });

  it("opens one group in place and leaves the others folded", () => {
    const id = "group:endpoints:/api/properties";
    const open = layoutDataFlow(big, order, { expanded: new Set([id]) });
    const g = open.groups.find((x) => x.id === id)!;
    expect(g.collapsed).toBe(false);
    for (const m of g.members) {
      expect(open.holder.has(m)).toBe(false);
      expect(inside(open.pills.get(m)!, g)).toBe(true);
    }
    expect(open.groups.filter((x) => x.id !== id && x.foldable).every((x) => x.collapsed)).toBe(true);
    // Links now reach the opened endpoints one by one.
    expect(open.links.some((l) => g.members.includes(l.to))).toBe(true);
    expect(open.links.some((l) => l.to === id || l.from === id)).toBe(false);
  });

  it("lights what a hovered group touches", () => {
    const n = dataNeighbours(data.links, "group:endpoints:/api/properties");
    expect(n.links.size).toBeGreaterThan(0);
    for (const l of data.links.filter((x) => n.links.has(x.id))) expect([l.from, l.to]).toContain("group:endpoints:/api/properties");
    expect(n.ends.has("group:endpoints:/api/properties")).toBe(true);
  });

  it("follows the platform switch", () => {
    const ios = filterByPlatform(big, "ios");
    const d = layoutDataFlow(ios, screenOrder(layoutScreens(ios)));
    const shown = [...d.pills.keys(), ...d.holder.keys()].filter((id) => id.startsWith("screen:"));
    expect(shown.length).toBeGreaterThan(0);
    for (const id of shown) expect(["ios", null]).toContain(ios.nodes.find((n) => n.id === id)!.detail.platform);
  });
});

describe("endpointTopic", () => {
  it("names what a one-segment RPC path acts on", () => {
    expect(endpointTopic("/get_chats")).toBe("chat");
    expect(endpointTopic("/delete_chat_message")).toBe("chat");
    expect(endpointTopic("/change-property-status")).toBe("property");
    expect(endpointTopic("/get_facilities")).toBe("facility");
    expect(endpointTopic("/getUserProfile")).toBe("user");
    expect(endpointTopic("/get")).toBeNull();
  });
});

describe("featureFocus", () => {
  const big = scaleMap();
  const l = layoutScreens(big);

  it("opens a one-screen feature's screen, out of the summary card it is folded into", () => {
    // f20 has one screen and is folded into "Other areas".
    expect(featureFocus(big, l, "f20")).toEqual({ kind: "screen", id: "screen:f20-s0", open: AREAS_REGION });
    expect(foldedInto(l, "screen:f20-s0")).toBe(AREAS_REGION);
  });

  it("opens the summary card holding a small feature, then its region", () => {
    expect(featureFocus(big, l, "f21")).toEqual({ kind: "region", key: "f21", open: AREAS_REGION });
    const opened = layoutScreens(big, { expanded: new Set([AREAS_REGION]) });
    expect(featureFocus(big, opened, "f21")).toEqual({ kind: "region", key: "f21", open: null });
    expect(featureFocus(big, opened, "f20")).toEqual({ kind: "screen", id: "screen:f20-s0", open: null });
  });

  it("flies to a big feature's region, and finds nothing for a feature the map has not got", () => {
    expect(featureFocus(big, l, "f0")).toEqual({ kind: "region", key: "f0", open: null });
    expect(featureFocus(big, l, "nope")).toBeNull();
  });
});

describe("drawing helpers", () => {
  it("draws a curve for two points and rounds the corners of a longer route", () => {
    expect(routePath({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], sides: ["right", "left"] })).toBe("M0,0 C40,0 60,0 100,0");
    const d = routePath({ points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 50 }], sides: ["right", "left"] });
    expect(d.startsWith("M0,0 L34,0 Q50,0 50,16")).toBe(true);
    expect(d.endsWith("L100,50")).toBe(true);
  });

  it("finds a route's midpoint and a rectangle's border toward a point", () => {
    expect(routeMidpoint({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], sides: ["right", "left"] })).toEqual({ x: 100, y: 0 });
    expect(borderPoint({ x: 0, y: 0, w: 100, h: 50 }, { x: 500, y: 25 })).toEqual({ point: { x: 100, y: 25 }, side: "right" });
    expect(borderPoint({ x: 0, y: 0, w: 100, h: 50 }, { x: 50, y: -400 }).side).toBe("top");
  });

  it("thickens an edge with how often it was taken, within bounds", () => {
    expect(edgeWidth(1)).toBe(1.4);
    expect(edgeWidth(4)).toBeGreaterThan(edgeWidth(2));
    expect(edgeWidth(10_000)).toBe(5);
    expect(CARD.w).toBeGreaterThan(0);
  });
});
