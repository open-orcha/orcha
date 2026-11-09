import { describe, expect, it } from "vitest";
import { groupAreas, humanize, layoutMap, mapHeight, squarify, type LayoutArea, type Rect } from "./map-layout";

const SNUG = ["Today", "Insights", "Family", "Profile", "Settings", "Onboarding"].map(
  (n, i): LayoutArea => ({ key: n.toLowerCase(), name: n, paths: [`snuglog-ios/SnugLog/Views/${n}`], entry: `${n}View`, source: "code", importance: 1 + (i % 3) }),
);
const WIDGETS = ["Small", "Large"].map(
  (n): LayoutArea => ({ key: `${n.toLowerCase()}-widget`, name: `${n} widget`, paths: [`snuglog-ios/SnugLogWidget/Views/${n}WidgetView.swift`], entry: null, source: "code", importance: 1 }),
);

function areas(n: number): LayoutArea[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `a${i}`,
    name: `Area ${i}`,
    paths: [`web/src/app/${["shop", "account", "admin", "blog"][i % 4]}/f${i}/page.tsx`],
    entry: null,
    source: "code",
    importance: 1 + ((i * 7) % 5),
  }));
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

describe("groupAreas", () => {
  it("groups by the first folder after the shared prefix", () => {
    const { groupOf, labels } = groupAreas([...SNUG, ...WIDGETS]);
    expect(groupOf.get("today")).toBe("p:SnugLog");
    expect(groupOf.get("small-widget")).toBe("p:SnugLogWidget");
    expect(labels.get("p:SnugLogWidget")).toBe("Snug Log Widget");
  });

  it("puts areas without paths by route prefix, exploration or hand", () => {
    const { groupOf, labels } = groupAreas([
      ...SNUG,
      { key: "orders", name: "Orders", paths: [], entry: "/orders", source: "exploration", importance: 1 },
      { key: "order-detail", name: "Order", paths: [], entry: "/orders/1", source: "exploration", importance: 1 },
      { key: "counter", name: "Counter", paths: [], entry: "/", source: "exploration", importance: 1 },
      { key: "legal", name: "Legal", paths: [], entry: null, source: "manual", importance: 1 },
    ]);
    expect(groupOf.get("orders")).toBe("r:orders");
    expect(labels.get("r:orders")).toBe("/orders");
    expect(groupOf.get("counter")).toBe("~explored");
    expect(labels.get(groupOf.get("legal")!)).toBe("Added by hand");
  });

  it("keeps one group when every area sits in the same folder", () => {
    const flat = SNUG.map((a) => ({ ...a, paths: [`Views/${a.name}.swift`] }));
    expect(new Set(groupAreas(flat).groupOf.values())).toEqual(new Set(["p:"]));
  });
});

describe("layoutMap", () => {
  it.each([1, 5, 12, 52, 200])("lays out %i areas with no overlaps, all inside the map", (n) => {
    const list = areas(n);
    const { tiles, groups } = layoutMap(list, 1200, 640);
    expect(tiles).toHaveLength(n);
    expect(new Set(tiles.map((t) => t.key)).size).toBe(n);
    for (const t of tiles) {
      expect(t.w).toBeGreaterThan(0);
      expect(t.h).toBeGreaterThan(0);
      expect(t.x).toBeGreaterThanOrEqual(-1e-6);
      expect(t.y).toBeGreaterThanOrEqual(-1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(1200 + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(640 + 1e-6);
    }
    for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) expect(overlap(tiles[i], tiles[j])).toBeLessThan(1e-6);
    // Every tile sits inside its own group's territory.
    for (const t of tiles) {
      const g = groups.find((x) => x.key === t.group)!;
      expect(overlap(t, g)).toBeCloseTo(t.w * t.h, 3);
    }
  });

  it("is deterministic", () => {
    expect(layoutMap(areas(30), 900, 500)).toEqual(layoutMap(areas(30), 900, 500));
  });

  it("gives more important areas more room", () => {
    const list: LayoutArea[] = [
      { key: "big", name: "Big", paths: [], entry: null, source: "code", importance: 6 },
      { key: "small", name: "Small", paths: [], entry: null, source: "code", importance: 1 },
    ];
    const { tiles } = layoutMap(list, 600, 400, { gap: 0 });
    const size = (k: string) => tiles.find((t) => t.key === k)!;
    expect(size("big").w * size("big").h).toBeCloseTo(6 * size("small").w * size("small").h, 0);
  });
});

describe("squarify and helpers", () => {
  it("fills the rectangle exactly", () => {
    const out = squarify([6, 6, 4, 3, 2, 2, 1].map((w, i) => ({ item: i, weight: w })), { x: 0, y: 0, w: 600, h: 400 });
    expect(out.reduce((s, r) => s + r.rect.w * r.rect.h, 0)).toBeCloseTo(240_000, 3);
  });

  it("names folders like people do", () => {
    expect(humanize("SnugLogWidget")).toBe("Snug Log Widget");
    expect(humanize("(app)")).toBe("App");
    expect(humanize("sign-in")).toBe("Sign in");
  });

  it("is wide on desktop and tall on a phone", () => {
    expect(mapHeight(1200, 12)).toBeLessThan(1200);
    expect(mapHeight(358, 12)).toBeGreaterThan(358);
  });
});
