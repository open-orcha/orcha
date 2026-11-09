import { describe, expect, it } from "vitest";
import { LEGIBLE_ZOOM, autoArrangeScenarios, categoryColumns, initialViewport, layoutScenarios, maxRows } from "./scenario-layout";

describe("large projects wrap tall columns (#140)", () => {
  const roots = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, category: "Login", name: `r${String(i).padStart(2, "0")}`, position: null }));
  const dependents = Array.from({ length: 19 }, (_, i) => ({ id: `d${i}`, category: "Login", name: `d${i}`, position: null, depends_on: [`r${i}`] }));

  it("caps rows near sqrt(1.2n) and never below 6", () => {
    expect(maxRows(5)).toBe(6);
    expect(maxRows(49)).toBe(8);
    expect(maxRows(200)).toBe(16);
  });

  it("wraps a 30-root depth column into sub-columns and keeps dependents to their right", () => {
    const pos = layoutScenarios([...roots, ...dependents]);
    const ys = [...pos.values()].map((p) => p.y);
    expect(Math.max(...ys)).toBeLessThan(8 * 154);
    const connectedRootXs = roots.slice(0, 19).map((r) => pos.get(r.id)!.x);
    expect(new Set(connectedRootXs).size).toBe(3);
    for (const d of dependents) expect(pos.get(d.id)!.x).toBeGreaterThan(Math.max(...connectedRootXs));
  });

  it("wraps a tall category column too, without overlapping the next category", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, category: "A", position: null }));
    const pos = layoutScenarios([...many, { id: "b", category: "B", position: null }]);
    const aXs = new Set(many.map((m) => pos.get(m.id)!.x));
    expect(aXs.size).toBe(Math.ceil(20 / maxRows(21)));
    expect(pos.get("b")!.x).toBeGreaterThan(Math.max(...aXs));
    expect(pos.get("b")!.y).toBe(0);
  });
});

describe("initialViewport", () => {
  it("fits and centres a small map", () => {
    const v = initialViewport([{ x: 0, y: 0 }, { x: 320, y: 0 }], 1200, 700)!;
    expect(v.zoom).toBe(1);
    expect(v.x).toBeCloseTo((1200 - 580) / 2);
  });

  it("stays at a legible zoom anchored top-left when the map cannot fit (phone width)", () => {
    const pts = Array.from({ length: 8 }, (_, i) => ({ x: i * 320, y: 0 }));
    const v = initialViewport(pts, 390, 600)!;
    expect(v.zoom).toBe(LEGIBLE_ZOOM);
    expect(v.x).toBe(24);
    expect(v.y).toBe(24);
  });

  it("never shrinks node text below legible: a 49-scenario project opens readable at the top-left (#140)", () => {
    const roots = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, category: "Login", name: `r${i}`, position: null }));
    const deps = Array.from({ length: 19 }, (_, i) => ({ id: `d${i}`, category: "Form", name: `d${i}`, position: null, depends_on: [`r${i}`] }));
    const pos = layoutScenarios([...roots, ...deps]);
    // The canvas beside the sidebar on a 1440px window: the whole map would fit only near 0.45.
    const v = initialViewport(pos.values(), 1180, 690)!;
    expect(v.zoom).toBeGreaterThanOrEqual(0.8);
    const minX = Math.min(...[...pos.values()].map((p) => p.x));
    const minY = Math.min(...[...pos.values()].map((p) => p.y));
    expect(v.x + minX * v.zoom).toBe(24);
    expect(v.y + minY * v.zoom).toBe(24);
  });

  it("still fits a mid-size map whole when it stays legible", () => {
    const pts = Array.from({ length: 6 }, (_, i) => ({ x: (i % 3) * 320, y: Math.floor(i / 3) * 154 }));
    const v = initialViewport(pts, 1180, 690)!;
    expect(v.zoom).toBe(1);
  });

  it("returns null with no nodes or no size", () => {
    expect(initialViewport([], 800, 600)).toBeNull();
    expect(initialViewport([{ x: 0, y: 0 }], 0, 0)).toBeNull();
  });
});

describe("layoutScenarios — no dependencies (category columns)", () => {
  it("keeps an existing position untouched", () => {
    const positions = layoutScenarios([{ id: "a", category: "Smoke", position: { x: 42, y: 7 } }]);
    expect(positions.get("a")).toEqual({ x: 42, y: 7 });
  });

  it("assigns columns by category in first-seen order", () => {
    const positions = layoutScenarios([
      { id: "a", category: "Smoke", position: null },
      { id: "b", category: "Workflow", position: null },
      { id: "c", category: "Smoke", position: null },
    ]);
    const a = positions.get("a")!;
    const b = positions.get("b")!;
    const c = positions.get("c")!;
    // a and c share a column (same x), b is in the next column.
    expect(a.x).toBe(c.x);
    expect(b.x).toBeGreaterThan(a.x);
    // a and c stack vertically within the column.
    expect(c.y).toBeGreaterThan(a.y);
  });

  it("treats a null category as General", () => {
    const positions = layoutScenarios([
      { id: "a", category: null, position: null },
      { id: "b", category: "General", position: null },
    ]);
    expect(positions.get("a")!.x).toBe(positions.get("b")!.x);
  });

  it("uses the category-column strategy when no scenario has any dependency", () => {
    const positions = layoutScenarios([
      { id: "a", category: "Smoke", position: null, depends_on: [] },
      { id: "b", category: "Smoke", position: null, depends_on: [] },
    ]);
    // Same category, no deps -> stacked in one column.
    expect(positions.get("a")!.x).toBe(positions.get("b")!.x);
    expect(positions.get("a")!.y).not.toBe(positions.get("b")!.y);
  });
});

describe("layoutScenarios — dependency layering (left -> right by depth)", () => {
  it("puts a root (no deps) in the first column and its dependent in the next", () => {
    const positions = layoutScenarios([
      { id: "root", category: "A", position: null, depends_on: [] },
      { id: "child", category: "A", position: null, depends_on: ["root"] },
    ]);
    const root = positions.get("root")!;
    const child = positions.get("child")!;
    expect(root.x).toBeLessThan(child.x);
  });

  it("places a chain of dependencies strictly left -> right, one column per depth", () => {
    const positions = layoutScenarios([
      { id: "a", category: "A", position: null, depends_on: [] },
      { id: "b", category: "A", position: null, depends_on: ["a"] },
      { id: "c", category: "A", position: null, depends_on: ["b"] },
      { id: "d", category: "A", position: null, depends_on: ["c"] },
    ]);
    const xs = ["a", "b", "c", "d"].map((id) => positions.get(id)!.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(xs[2]).toBeLessThan(xs[3]);
  });

  it("depth is 1 + max over all in-set dependencies (diamond shape)", () => {
    // root -> {left, right} -> merge
    const positions = layoutScenarios([
      { id: "root", category: "A", position: null, depends_on: [] },
      { id: "left", category: "A", position: null, depends_on: ["root"] },
      { id: "right", category: "A", position: null, depends_on: ["root"] },
      { id: "merge", category: "A", position: null, depends_on: ["left", "right"] },
    ]);
    const root = positions.get("root")!;
    const left = positions.get("left")!;
    const right = positions.get("right")!;
    const merge = positions.get("merge")!;
    expect(left.x).toBe(right.x);
    expect(left.x).toBeGreaterThan(root.x);
    expect(merge.x).toBeGreaterThan(left.x);
    expect(merge.x).toBeGreaterThan(right.x);
  });

  it("a dependency on an id outside the set does not push depth (treated as depth 0)", () => {
    const positions = layoutScenarios([
      { id: "a", category: "A", position: null, depends_on: ["missing-id"] },
    ]);
    const b = layoutScenarios([{ id: "b", category: "A", position: null, depends_on: [] }]);
    // Both should land in the first column (x = 0) since "missing-id" isn't in-set.
    expect(positions.get("a")!.x).toBe(0);
    expect(b.get("b")!.x).toBe(0);
  });

  it("tolerates a cycle by breaking the back edge instead of infinite-looping", () => {
    const positions = layoutScenarios([
      { id: "a", category: "A", position: null, depends_on: ["b"] },
      { id: "b", category: "A", position: null, depends_on: ["a"] },
    ]);
    // Both resolve to finite, defined positions.
    expect(positions.get("a")).toBeDefined();
    expect(positions.get("b")).toBeDefined();
    expect(Number.isFinite(positions.get("a")!.x)).toBe(true);
    expect(Number.isFinite(positions.get("b")!.x)).toBe(true);
  });

  it("tolerates a longer cycle (3-node) without infinite recursion", () => {
    const positions = layoutScenarios([
      { id: "a", category: "A", position: null, depends_on: ["c"] },
      { id: "b", category: "A", position: null, depends_on: ["a"] },
      { id: "c", category: "A", position: null, depends_on: ["b"] },
    ]);
    for (const id of ["a", "b", "c"]) {
      const p = positions.get(id)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("orders nodes within a column by category then name", () => {
    const positions = layoutScenarios([
      { id: "root", category: "A", name: "Root", position: null, depends_on: [] },
      { id: "z-dep", category: "Zebra", name: "Zebra dep", position: null, depends_on: ["root"] },
      { id: "a-dep", category: "Alpha", name: "Alpha dep", position: null, depends_on: ["root"] },
    ]);
    // Both dependents share depth 1 (same x); "Alpha" category sorts before "Zebra".
    const alpha = positions.get("a-dep")!;
    const zebra = positions.get("z-dep")!;
    expect(alpha.x).toBe(zebra.x);
    expect(alpha.y).toBeLessThan(zebra.y);
  });

  it("orders nodes within a column by name when categories tie", () => {
    const positions = layoutScenarios([
      { id: "root", category: "A", name: "Root", position: null, depends_on: [] },
      { id: "b-dep", category: "Same", name: "Bravo", position: null, depends_on: ["root"] },
      { id: "a-dep", category: "Same", name: "Alpha", position: null, depends_on: ["root"] },
    ]);
    const alpha = positions.get("a-dep")!;
    const bravo = positions.get("b-dep")!;
    expect(alpha.y).toBeLessThan(bravo.y);
  });

  it("stacks nodes within a column with a small vertical gap (~24px beyond node height)", () => {
    const positions = layoutScenarios([
      { id: "root", category: "A", name: "Root", position: null, depends_on: [] },
      { id: "a-dep", category: "A", name: "Alpha", position: null, depends_on: ["root"] },
      { id: "b-dep", category: "A", name: "Bravo", position: null, depends_on: ["root"] },
    ]);
    const a = positions.get("a-dep")!;
    const b = positions.get("b-dep")!;
    expect(Math.abs(b.y - a.y)).toBeGreaterThan(100);
  });

  it("spaces columns by depth at a fixed step (~320px)", () => {
    const positions = layoutScenarios([
      { id: "root", category: "A", position: null, depends_on: [] },
      { id: "child", category: "A", position: null, depends_on: ["root"] },
    ]);
    const root = positions.get("root")!;
    const child = positions.get("child")!;
    expect(child.x - root.x).toBe(320);
  });

  it("groups fully disconnected nodes (no edges at all) into a trailing column", () => {
    const positions = layoutScenarios([
      { id: "root", category: "A", position: null, depends_on: [] },
      { id: "child", category: "A", position: null, depends_on: ["root"] },
      { id: "lonely", category: "B", position: null, depends_on: [] },
    ]);
    const root = positions.get("root")!;
    const child = positions.get("child")!;
    const lonely = positions.get("lonely")!;
    // "lonely" has no dependents and no dependencies -> trailing column, after "child"'s depth.
    expect(lonely.x).toBeGreaterThan(child.x);
    expect(lonely.x).toBeGreaterThan(root.x);
  });

  it("a node with dependents but no dependencies is depth 0, not disconnected", () => {
    // "root" is at depth 0 and IS the target of an edge, so it must stay
    // in the depth-based layout, not be treated as an isolated/trailing node.
    const positions = layoutScenarios([
      { id: "root", category: "A", position: null, depends_on: [] },
      { id: "child", category: "A", position: null, depends_on: ["root"] },
    ]);
    expect(positions.get("root")!.x).toBe(0);
  });

  it("orders multiple disconnected nodes by category then name within the trailing column", () => {
    const positions = layoutScenarios([
      { id: "root", category: "A", position: null, depends_on: [] },
      { id: "child", category: "A", position: null, depends_on: ["root"] },
      { id: "lonely-z", category: "Zebra", name: "Z", position: null, depends_on: [] },
      { id: "lonely-a", category: "Alpha", name: "A", position: null, depends_on: [] },
    ]);
    const lonelyZ = positions.get("lonely-z")!;
    const lonelyA = positions.get("lonely-a")!;
    expect(lonelyZ.x).toBe(lonelyA.x);
    expect(lonelyA.y).toBeLessThan(lonelyZ.y);
  });

  it("keeps a saved position even when other scenarios need dependency layering", () => {
    const positions = layoutScenarios([
      { id: "pinned", category: "A", position: { x: 999, y: 999 }, depends_on: [] },
      { id: "root", category: "A", position: null, depends_on: [] },
      { id: "child", category: "A", position: null, depends_on: ["root"] },
    ]);
    expect(positions.get("pinned")).toEqual({ x: 999, y: 999 });
  });

  it("a dependency on itself does not create a self-referencing depth loop", () => {
    const positions = layoutScenarios([
      { id: "a", category: "A", position: null, depends_on: ["a"] },
    ]);
    expect(positions.get("a")).toEqual({ x: 0, y: 0 });
  });
});

describe("autoArrangeScenarios", () => {
  it("ignores saved positions and recomputes everything", () => {
    const positions = autoArrangeScenarios([
      { id: "root", category: "A", position: { x: 5000, y: 5000 }, depends_on: [] },
      { id: "child", category: "A", position: { x: 1, y: 1 }, depends_on: ["root"] },
    ]);
    const root = positions.get("root")!;
    const child = positions.get("child")!;
    expect(root).not.toEqual({ x: 5000, y: 5000 });
    expect(child.x).toBeGreaterThan(root.x);
  });

  it("falls back to category columns when nothing has a dependency", () => {
    const positions = autoArrangeScenarios([
      { id: "a", category: "Smoke", position: { x: 10, y: 10 } },
      { id: "b", category: "Workflow", position: { x: 20, y: 20 } },
    ]);
    expect(positions.get("a")!.x).toBe(0);
    expect(positions.get("b")!.x).toBeGreaterThan(0);
  });
});

describe("categoryColumns", () => {
  it("lists categories in first-seen order, deduplicated", () => {
    expect(
      categoryColumns([
        { id: "a", category: "Smoke", position: null },
        { id: "b", category: "Workflow", position: null },
        { id: "c", category: "Smoke", position: null },
      ]),
    ).toEqual(["Smoke", "Workflow"]);
  });
});

describe("layoutScenarios overlap avoidance", () => {
  it("moves auto-positioned nodes off a saved position in the same column", () => {
    // "a" was dragged to exactly where the grid would put the first auto node.
    const positions = layoutScenarios([
      { id: "a", category: "Smoke", position: { x: 0, y: 0 } },
      { id: "b", category: "Smoke", position: null },
      { id: "c", category: "Smoke", position: null },
    ]);
    expect(positions.get("a")).toEqual({ x: 0, y: 0 });
    const b = positions.get("b")!;
    const c = positions.get("c")!;
    expect(b.y).toBeGreaterThanOrEqual(130);
    expect(c.y).toBeGreaterThanOrEqual(130);
    expect(Math.abs(b.y - c.y)).toBeGreaterThanOrEqual(130);
  });

  it("also avoids saved positions in the layered layout", () => {
    const positions = layoutScenarios([
      { id: "root", category: "Smoke", position: { x: 320, y: 0 } },
      { id: "child", category: "Smoke", position: null, depends_on: ["root"] },
      { id: "other", category: "Smoke", position: null },
    ]);
    const child = positions.get("child")!;
    const other = positions.get("other")!;
    for (const p of [child, other]) {
      const collides = Math.abs(p.x - 320) < 300 && Math.abs(p.y - 0) < 130;
      expect(collides).toBe(false);
    }
  });
});
