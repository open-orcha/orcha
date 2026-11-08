/** The Atlas's model: the JSON parsed as Python prints it (the Juniper fixture, from
 * `tools/atlas_fixture`), the filters and the URL, the storyboard's geometry, and that laying
 * out 10, 50 and 200 screens stays fast. */
import { describe, expect, it } from "vitest";
import folio from "./folio.fixture.json";
import juniper from "./juniper.fixture.json";
import {
  areaCountWords,
  areaSummary,
  capturing,
  cardHeight,
  cardWidth,
  displayText,
  filterAtlas,
  filtersFrom,
  filtersQuery,
  frameFit,
  framePosition,
  GUTTER,
  hasFilters,
  keeps,
  layoutRow,
  moveWords,
  NO_FILTERS,
  passProgress,
  presenceWords,
  fillPlan,
  fillWords,
  screenOfNode,
  shapesOf,
  shownPlatforms,
  wireWords,
} from "./model";
import { isEmptyAtlas, parseAtlas, presenceOf, type Atlas, type AtlasScreen, type Platform } from "./types";

const atlas = parseAtlas(juniper);
const byName = (name: string) => atlas.screens.find((s) => s.name === name)!;
const names = (a: Atlas, f = NO_FILTERS) => filterAtlas(a, f).flatMap((r) => r.screens.map((s) => s.name));

describe("parseAtlas", () => {
  it("reads what the Python atlas prints", () => {
    expect(atlas.platforms).toEqual(["ios", "android", "web"]);
    expect(atlas.counts.screens).toBe(15);
    expect(atlas.areas.map((a) => a.name).slice(0, 3)).toEqual(["Browse", "Products", "Cart and checkout"]);
    const detail = byName("Product detail");
    expect(detail.similarity?.badge).toBe("minor");
    expect(detail.similarity?.reasons).toEqual(["iOS and Web say “Add to cart”, Android says “Add to bag”"]);
    expect(detail.variants.ios?.frame_url).toMatch(/^\/api\/artifacts\/qa-runs\//);
    expect(byName("Cart").change?.platforms.map((c) => c.platform)).toEqual(["ios", "web"]);
    expect(byName("Order confirmed").never_seen).toBe(true);
    expect(atlas.refresh.state).toBe("idle");
  });

  it("drops what it does not know and keeps an atlas from another version readable", () => {
    const a = parseAtlas({ project_id: "p", platforms: ["ios", "watch"], screens: [{ id: "screen:x", variants: { ios: {}, tv: {} }, similarity: { badge: "odd" } }, { name: "no id" }], areas: [{ key: "a", screens: ["screen:x", "gone"] }] });
    expect(a.platforms).toEqual(["ios"]);
    expect(a.screens).toHaveLength(1);
    expect(Object.keys(a.screens[0].variants)).toEqual(["ios"]);
    expect(a.screens[0].similarity?.badge).toBe("unchecked");
    expect(a.areas[0].screens).toEqual(["screen:x"]);
    expect(() => parseAtlas({})).toThrow();
    expect(isEmptyAtlas(parseAtlas({ project_id: "p" }))).toBe(true);
  });
});

describe("filters", () => {
  it("round-trip through the URL, keeping the rest of the query", () => {
    const f = filtersFrom(new URLSearchParams("area=checkout&platforms=android,ios,tv&filter=differs,never_seen&q=pay&arrows=0&device=watch,tablet&appearance=dark"));
    expect(f).toEqual({ area: "checkout", platforms: ["ios", "android"], differs: true, changed: false, neverSeen: true, q: "pay", arrows: false, devices: ["tablet"], appearances: ["dark"] });
    expect(filtersQuery(f, new URLSearchParams("screen=screen:cart")).toString()).toBe(
      "screen=screen%3Acart&area=checkout&platforms=ios%2Candroid&device=tablet&appearance=dark&filter=differs%2Cnever_seen&q=pay&arrows=0",
    );
    expect(hasFilters({ ...NO_FILTERS, appearances: ["dark"] })).toBe(true);
    expect(filtersQuery(NO_FILTERS).toString()).toBe("");
    expect(filtersFrom({ platforms: ["web"], filter: "changed" })).toMatchObject({ platforms: ["web"], changed: true });
    expect(hasFilters(NO_FILTERS)).toBe(false);
  });

  it("keep the same screens the export keeps", () => {
    // tests/unit/app_map/test_atlas.py: test_the_filters_keep_what_the_page_keeps
    expect(names(atlas, { ...NO_FILTERS, differs: true })).toEqual(["Product detail", "Reviews", "Cart", "Payment", "Profile", "Wishlist", "Settings"]);
    expect(names(atlas, { ...NO_FILTERS, changed: true })).toEqual(["Cart"]);
    expect(names(atlas, { ...NO_FILTERS, neverSeen: true })).toEqual(["Order confirmed", "Help", "Settings"]);
    expect(names(atlas, { ...NO_FILTERS, platforms: ["web"], q: "product" })).toEqual(["Product list", "Product detail", "Reviews"]);
    expect(names(atlas, { ...NO_FILTERS, platforms: ["android"], q: "wish" })).toEqual([]);
    // Between iOS and Android only: Reviews (web only) and Settings (missing on the web) do not differ there.
    expect(names(atlas, { ...NO_FILTERS, platforms: ["ios", "android"], differs: true })).toEqual(["Product detail", "Cart", "Payment", "Profile", "Wishlist"]);
    expect(filterAtlas(atlas, { ...NO_FILTERS, area: "checkout" }).map((r) => r.area.key)).toEqual(["checkout"]);
  });

  it("show the platforms picked as the cards' columns", () => {
    expect(shownPlatforms(atlas, NO_FILTERS)).toEqual(["ios", "android", "web"]);
    expect(shownPlatforms(atlas, { ...NO_FILTERS, platforms: ["web", "ios"] })).toEqual(["ios", "web"]);
    expect(keeps(byName("Reviews"), { ...NO_FILTERS, platforms: ["ios"] })).toBe(false);
  });

  it("find the screen a map node belongs to", () => {
    expect(screenOfNode(atlas, "screen:/cart")?.name).toBe("Cart");
    expect(screenOfNode(atlas, "screen:nope")).toBeNull();
  });
});

describe("the storyboard's geometry", () => {
  it("sizes a card for its platforms", () => {
    expect(cardWidth(["ios", "android", "web"])).toBeGreaterThan(cardWidth(["ios", "android"]));
    expect(cardHeight(["web"])).toBeLessThan(cardHeight(["ios"]));
  });

  it("wraps a row onto more lines at the board's width, and every arrow still reaches its card", () => {
    const mk = (i: number) => ({ ...byName("Home"), id: `s${i}`, name: `S${i}` }) as AtlasScreen;
    const screens = [0, 1, 2, 3, 4, 5, 6].map(mk);
    const flow = (a: number, b: number) => ({ from: `s${a}`, to: `s${b}`, label: "Tap", count: 1, seen: true });
    const flows = [flow(0, 1), flow(1, 2), flow(2, 3), flow(3, 4), flow(5, 0), flow(6, 2)];
    const plats: Platform[] = ["ios", "android"];
    const one = layoutRow(screens, plats, flows, () => "a");
    const w = one.cards[0].w;
    // Room for three cards: three lines (3 + 3 + 1), no wider than the board, all of it taller.
    const wrapped = layoutRow(screens, plats, flows, () => "a", undefined, 3 * w + 2 * 44 + 10);
    expect(wrapped.cards.map((c) => c.y > 0)).toEqual([false, false, false, true, true, true, true]);
    expect(new Set(wrapped.cards.map((c) => c.y)).size).toBe(3);
    expect(wrapped.width).toBeLessThanOrEqual(3 * w + 2 * 44 + 10);
    expect(wrapped.height).toBeGreaterThan(2 * one.cardH);
    expect(wrapped.cards[3].x).toBe(0);
    // The same moves are drawn; one to the next card on the same line stays a straight "next".
    expect(wrapped.arrows).toHaveLength(one.arrows.length);
    expect(wrapped.arrows.find((a) => a.from === "s0" && a.to === "s1")!.kind).toBe("next");
    // s2 -> s3 crosses the line break: it ends at s3's left side, pointing right, at its line.
    const cross = wrapped.arrows.find((a) => a.from === "s2" && a.to === "s3")!;
    expect(cross.kind).toBe("arc");
    const pts = [...cross.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const [ex, ey] = pts[pts.length - 1];
    const s3 = wrapped.cards[3];
    expect(ex).toBeLessThanOrEqual(s3.x);
    expect(ey).toBeGreaterThan(s3.y);
    expect(ey).toBeLessThan(s3.y + wrapped.cardH);
    // Without a width, the row stays one line.
    expect(new Set(one.cards.map((c) => c.y))).toEqual(new Set([0]));
  });

  it("routes every arc below the cards, in its own lane, from a port of its own: never under a card", () => {
    const mk = (i: number) => ({ ...byName("Home"), id: `s${i}`, name: `S${i}` }) as AtlasScreen;
    const screens = [0, 1, 2, 3, 4].map(mk);
    const flow = (a: number, b: number) => ({ from: `s${a}`, to: `s${b}`, label: "Tap", count: 1, seen: a % 2 === 0 });
    const flows = [flow(0, 1), flow(0, 2), flow(0, 3), flow(3, 1), flow(1, 4), flow(4, 0)];
    const plats: Platform[] = ["ios", "android"];
    const row = layoutRow(screens, plats, flows, () => "a");
    const arcs = row.arrows.filter((a) => a.kind === "arc");
    expect(arcs).toHaveLength(5);
    for (const a of arcs) {
      // The run across sits below every card, and the row is tall enough to hold it.
      expect(a.ly).toBeGreaterThan(row.cardH + 10);
      expect(row.height).toBeGreaterThanOrEqual(a.ly + 6);
      const ys = [...a.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(row.cardH);
      // It leaves and arrives within its cards' bottoms.
      const xs = [...a.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[1]));
      const from = row.cards.find((c) => c.id === a.from)!;
      const to = row.cards.find((c) => c.id === a.to)!;
      expect(xs[0]).toBeGreaterThan(from.x + from.w / 2);
      expect(xs[xs.length - 1]).toBeLessThan(to.x + to.w / 2);
      expect(a.head).toMatch(/^M[\d.]+,[\d.]+ L/);
    }
    // Arcs whose spans overlap never share a lane.
    const span = (a: (typeof arcs)[number]) => [screens.findIndex((s) => s.id === a.from), screens.findIndex((s) => s.id === a.to)].sort((x, y) => x - y);
    for (const a of arcs)
      for (const b of arcs) {
        if (a === b) continue;
        const [a0, a1] = span(a);
        const [b0, b1] = span(b);
        if (a0 < b1 && b0 < a1) expect(a.ly).not.toBe(b.ly);
      }
    // No two arcs share a port on a card.
    const starts = arcs.map((a) => a.d.split(" ")[0]);
    expect(new Set(starts).size).toBe(starts.length);
    const ends = arcs.map((a) => a.d.split(" ").pop());
    expect(new Set(ends).size).toBe(ends.length);
    // The move to the next card is a straight line through the gutter, its head at the next card.
    const next = row.arrows.find((a) => a.kind === "next")!;
    expect(next.d).toMatch(/^M[\d.]+,([\d.]+) L[\d.]+,\1$/);
  });

  it("draws a move to the next card through the gutter and the others under the row, each arc in its own lane", () => {
    const checkout = filterAtlas(atlas, NO_FILTERS).find((r) => r.area.key === "checkout")!;
    const plats: Platform[] = ["ios", "android", "web"];
    const areaOf = (id: string) => atlas.screens.find((s) => s.id === id)?.area;
    const row = layoutRow(checkout.screens, plats, atlas.flows, areaOf);
    expect(row.cards.map((c) => c.x)).toEqual([0, 1, 2, 3].map((i) => i * (cardWidth(plats) + GUTTER)));
    const cart = byName("Cart").id;
    const next = row.arrows.find((a) => a.from === cart);
    expect(next?.kind).toBe("next");
    // Account: Orders goes back to Profile, and Profile on to Wishlist past Orders: two arcs.
    const account = filterAtlas(atlas, NO_FILTERS).find((r) => r.area.key === "account")!;
    const arcs = layoutRow(account.screens, plats, atlas.flows, areaOf).arrows.filter((a) => a.kind === "arc");
    expect(arcs.length).toBeGreaterThanOrEqual(1);
    expect(new Set(arcs.map((a) => a.ly)).size).toBe(arcs.length);
    // A move into another area is listed on the card, never drawn across the page.
    const products = filterAtlas(atlas, NO_FILTERS).find((r) => r.area.key === "products")!;
    const out = layoutRow(products.screens, plats, atlas.flows, areaOf).out;
    expect([...out.values()].flat().map((o) => o.area)).toContain("checkout");
    // Filtered down to Product detail alone, its move to Reviews stays in Products: no "leads to Products".
    const alone = layoutRow([byName("Product detail")], plats, atlas.flows, areaOf).out;
    expect([...alone.values()].flat().map((o) => o.area)).toEqual(["checkout"]);
  });

  it("crops a screenshot from its top, the way the onboarding map's cards do", () => {
    expect(framePosition(400, 900, 100, 100)).toBe("50% 0%");
    expect(framePosition(1280, 800, 100, 200)).toBe("50% 0%");
  });
});

/** An atlas of `n` screens in areas of ten, each on all three platforms, every fifth flowing on
 * past the next screen: the shape of the performance fixture (`--screens 200`). */
function wide(n: number): Atlas {
  const screens: AtlasScreen[] = Array.from({ length: n }, (_, i) => ({
    ...byName("Home"),
    id: `screen:s${i}`,
    name: `Screen ${i}`,
    area: `a${Math.floor(i / 10)}`,
    route: `/s/${i}`,
    nodes: [`screen:s${i}`],
  }));
  const flows = screens.flatMap((s, i) => [
    ...(i + 1 < n ? [{ from: s.id, to: screens[i + 1].id, label: 'Tap "Next"', count: 2, seen: true }] : []),
    ...(i % 5 === 0 && i + 3 < n ? [{ from: s.id, to: screens[i + 3].id, label: 'Tap "Skip"', count: 1, seen: false }] : []),
  ]);
  const areas = Array.from({ length: Math.ceil(n / 10) }, (_, a) => ({ key: `a${a}`, name: `Area ${a}`, summary: null, screens: screens.filter((s) => s.area === `a${a}`).map((s) => s.id), differs: 0, seen: 10 }));
  return { ...atlas, screens, flows, areas, counts: { ...atlas.counts, screens: n } };
}

describe("at scale", () => {
  it.each([10, 50, 200])("filters and lays out %i screens in a few milliseconds", (n) => {
    const big = wide(n);
    const plats = shownPlatforms(big, NO_FILTERS);
    const areaOf = new Map(big.screens.map((s) => [s.id, s.area]));
    const t = performance.now();
    for (let pass = 0; pass < 10; pass++) {
      const rows = filterAtlas(big, { ...NO_FILTERS, q: pass % 2 ? "screen" : "" });
      for (const r of rows) layoutRow(r.screens, plats, big.flows, (id) => areaOf.get(id));
    }
    const each = (performance.now() - t) / 10;
    expect(filterAtlas(big, NO_FILTERS).reduce((k, r) => k + r.screens.length, 0)).toBe(n);
    expect(each).toBeLessThan(n <= 50 ? 20 : 60);
  });
});

describe("words", () => {
  it("say a cost and a move plainly", () => {
    expect(moveWords('Tap "Add to cart"')).toBe("Tap Add to cart");
  });
});

describe("a mixed stack (SwiftUI on iPad, Flutter on Android, Next.js)", () => {
  const mixed = parseAtlas(folio);
  const screen = (name: string) => mixed.screens.find((s) => s.name === name)!;

  it("says unknown as not matched yet, never as missing or different", () => {
    for (const s of mixed.screens) expect(presenceOf(s, "android")).not.toBe("absent");
    expect(presenceWords(presenceOf(screen("Reader"), "android"), "android")).toBe("No Android match found");
    expect(presenceWords(presenceOf(screen("Highlights"), "web"), "web")).toBe("Not in the Web code");
    expect(presenceWords(presenceOf(screen("Search"), "ios"), "ios")).toBe("Not seen on iOS yet");
    expect(screen("Welcome to Folio").similarity?.badge).toBe("unmatched");
  });

  it("keeps only real differences under Differs, on every platform and between the phones", () => {
    const n = (f: typeof NO_FILTERS) => filterAtlas(mixed, f).flatMap((r) => r.screens.map((s) => s.name));
    expect(n({ ...NO_FILTERS, differs: true })).toEqual(["Book detail", "Highlights"]);
    // Reader is not matched on Android yet: no difference between the phones.
    expect(n({ ...NO_FILTERS, platforms: ["ios", "android"], differs: true })).toEqual(["Book detail"]);
    expect(mixed.counts).toMatchObject({ screens: 10, differs: 2, same: 5, unmatched: 1, unchecked: 2 });
  });

  it("reads an older atlas without presence as unknown, never absent", () => {
    const old = parseAtlas({ ...folio, screens: folio.screens.map((s) => ({ ...s, presence: undefined })) });
    const reader = old.screens.find((s) => s.name === "Reader")!;
    expect(presenceOf(reader, "android")).toBe("unknown");
    expect(presenceOf(reader, "ios")).toBe("seen");
  });
});

describe("device frames", () => {
  const mixed = parseAtlas(folio);

  it("draws an iPad-first app's iOS column as an iPad, and Juniper's as phones", () => {
    expect(shapesOf(mixed)).toEqual({ ios: "tablet", android: "phone", web: "browser" });
    expect(shapesOf(atlas)).toEqual({ ios: "phone", android: "phone", web: "browser" });
    const plats: Platform[] = ["ios", "android", "web"];
    expect(cardWidth(plats, shapesOf(mixed))).toBeGreaterThan(cardWidth(plats));
    expect(mixed.screens.find((s) => s.name === "Reader")?.variants.ios?.device).toMatchObject({ kind: "tablet", landscape: true });
  });

  it("crops a screenshot of the frame's shape from the top and shows any other whole", () => {
    // An iPad screenshot in an iPad frame (154 x 208 inside): cropped, from the top.
    expect(frameFit(1032, 1376, 154, 208)).toEqual({ fit: "cover", position: "50% 0%" });
    // The same iPad screenshot in a phone frame, or one on its side in an upright frame: whole.
    expect(frameFit(1032, 1376, 98, 210).fit).toBe("contain");
    expect(frameFit(1376, 1032, 154, 208).fit).toBe("contain");
    // A phone in a phone frame stays cropped (its status bar's worth of difference).
    expect(frameFit(1179, 2556, 98, 210).fit).toBe("cover");
    expect(frameFit(0, 0, 98, 210).fit).toBe("cover");
  });
});

describe("holes in what the code says", () => {
  it("reads as an ellipsis, never a star", () => {
    expect(displayText("* pages")).toBe("… pages");
    expect(displayText("Article image: *")).toBe("Article image: …");
    expect(displayText("Last * opened")).toBe("Last … opened");
    expect(displayText("* *")).toBe("");
    expect(displayText("Rated 4*5")).toBe("Rated 4*5");
    // From the owner's apps: a plural glued to its word, and Swift's grammar agreement.
    expect(displayText("* page*, ready to share or print.")).toBe("… page, ready to share or print.");
    expect(displayText("Needs * more photo*")).toBe("Needs … more photo");
    expect(displayText("^[* verification](inflect: true)")).toBe("… verification");
  });

  it("gives a wireframe its words without its own name, from an older atlas too", () => {
    expect(wireWords({ name: "Search", code_texts: ["Search", "Titles, authors or topics", "Recent searches"] })).toEqual(["Titles, authors or topics", "Recent searches"]);
    expect(wireWords({ name: "Book detail", code_texts: ["Article image: *", "* pages", "*", "Start reading"] })).toEqual(["Article image: …", "… pages", "Start reading"]);
  });
});

describe("an area's header", () => {
  it("says one count, never the code map's own count beside it", () => {
    expect(areaSummary("3 screens: overview")).toBeNull();
    expect(areaSummary("1 screen")).toBeNull();
    expect(areaSummary("Lists, details and reviews")).toBe("Lists, details and reviews");
    expect(areaCountWords(5, 5, 3, 1)).toBe("5 screens · 3 seen live · 1 differs");
    expect(areaCountWords(2, 5, 2, 0)).toBe("2 of 5 screens · 2 seen live");
    expect(areaCountWords(1, 1, 0, 0)).toBe("1 screen · none seen live yet");
    // A screen never seen live does not "differ": one platform's code only lacks it.
    expect(areaCountWords(5, 5, 2, 1, 4)).toBe("5 screens · 2 seen live · 1 differs · 4 not on every platform");
    const mixed = parseAtlas(folio);
    expect(mixed.areas.find((a) => a.key === "account")?.summary).toBeNull();
  });
});

describe("the live fill-in", () => {
  const running = (targets: string[], platform: Platform | null = "ios") =>
    parseAtlas({ ...folio, refresh: { ...folio.refresh, state: "running", targets, platform } });

  it("marks the frames the pass is about to capture, never one it already has", () => {
    const a = running(["screen:search", "screen:library"]);
    const search = a.screens.find((s) => s.name === "Search")!;
    expect([...capturing(a)]).toEqual([[search.id, "ios"]]);
    expect(passProgress(a)).toEqual({ seen: 1, total: 2 });
  });

  it("marks nothing when no pass runs or it said nothing of its aim", () => {
    expect(capturing(parseAtlas(folio)).size).toBe(0);
    expect(capturing(running([])).size).toBe(0);
    expect(passProgress(running([]))).toEqual({ seen: 0, total: 0 });
  });
});

describe("Fill in a platform's unseen screens (A2)", () => {
  it("counts the screens not seen there, skips sign-in walls and says what it does", () => {
    const base = parseAtlas(juniper);
    const help = base.screens.find((s) => s.name === "Help")!;
    const a: Atlas = { ...base, screens: base.screens.map((s) => (s === help ? { ...s, blocked_reason: "a sign-in Embodent has no account for" } : s)), refresh: { ...base.refresh, fill_most: 25 } };
    const plan = fillPlan(a, "android");
    expect(plan).toEqual({ platform: "android", unseen: 3, blocked: 1, visits: 2 });
    const words = fillWords(plan, a.refresh);
    expect(words.label).toBe("Fill in Android · 2 screens not seen");
    expect(words.detail).toBe(
      "Embodent opens the app on Android and visits those 2 screens, about 10 minutes. 1 behind a sign-in Embodent has no account for is skipped: add sign-in hints to the app's target to reach it.",
    );
    expect(fillPlan({ ...a, refresh: { ...a.refresh, fill_most: 1 } }, "android").visits).toBe(1);
  });
});

