import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addedTiles,
  areasHeadline,
  countNote,
  chartAreas,
  daysSince,
  depthGrew,
  growthMode,
  growthSteps,
  linePlot,
  longDate,
  mapAreas,
  nowSegments,
  overallSegments,
  pointsWords,
  remeasureWords,
  shortDate,
  timelapseFrames,
  untestedAreas,
} from "./growth-model";
import { parseGrowth, type GrowthArea } from "./types";

const side = (pct: number | null, screens: number, covered: number, yours: number) => ({
  pct, screens, covered, by_your_tests: yours, by_orcha: covered - yours, variations: 0, evidence: pct === null ? "unknown" : "known",
});

const REPORT = {
  project_id: "p",
  computed_at: "2026-10-27T12:00:00Z",
  fresh_days: 30,
  baseline: { id: "b1", day: "2026-10-02", taken_at: "2026-10-02T09:00:00Z", trigger: "onboarding", reason: null, app_build: "2.4.0", evidence_version: 1, same_rules: true, superseded_at: null },
  history: [{ id: "b1", day: "2026-10-02", taken_at: "2026-10-02T09:00:00Z", trigger: "onboarding" }],
  now: {
    totals: { screens: 20, covered: 17, pct: 85, by_your_tests: 8, by_orcha: 9, at_risk: 1, unknown: 0, evidence: "known", live_screens: 3, flows: { your_tests: 8, orcha: 9 } },
    areas: [{ key: "checkout", name: "Checkout", screens: 20, covered: 17, pct: 85, evidence: "known" }],
    screens: [{ id: "screen:pay", name: "Pay", area: "checkout", state: "at_risk", reason: "Only ‘Pay by card’ reaches it, and it failed 2 days ago." }],
    flows: [],
  },
  growth: {
    since: "2026-10-02T09:00:00Z",
    headline: "Coverage: 40% → 85% since Oct 2 (+45 points). Embodent added 9 scenarios.",
    lines: [],
    overall: { key: "all", name: "All screens", before: side(40, 20, 8, 8), now: side(85, 20, 17, 8), points: 45, added: { scenarios: 9, variations: 27, screens_reached: 3 } },
    areas: [
      { key: "checkout", name: "Checkout", before: side(40, 20, 8, 8), now: side(85, 20, 17, 8), points: 45, added: { scenarios: 9, variations: 27, screens_reached: 3 } },
      { key: "search", name: "Search", before: side(null, 0, 0, 0), now: side(null, 0, 0, 0), points: null, added: { scenarios: 0, variations: 0, screens_reached: 0 } },
    ],
  },
  series: [
    { day: "2026-10-02", kind: "baseline", pct: 40, areas: { checkout: 40 } },
    { day: "2026-10-15", kind: "point", pct: 60, areas: { checkout: 60 } },
    { day: "2026-10-27", kind: "now", pct: 85, areas: { checkout: 85, search: null } },
  ],
  weekly: "This week: coverage 85% (+10 points); Embodent added 2 scenarios.",
  payoff: {
    headline: "x",
    areas: [],
    weekly: null,
    pct: 85,
    screens: 20,
    points: 45,
    since: "2026-10-02T09:12:00.000Z",
    added: { scenarios: 12, variations: 30, screens_reached: 1 },
  },
  variations: { pending: [{ scenario_id: "s1", name: "Book a stay", rows: [{ id: "v1", scenario_id: "s1", technique: "empty", label: "Guest name left empty", values: { guest_name: "" } }] }], applied: 2, candidates: [] },
};

describe("coverage growth view model", () => {
  const r = parseGrowth(REPORT);

  it("parses the report and keeps unknown as null, never 0", () => {
    expect(r.baseline?.trigger).toBe("onboarding");
    expect(r.growth?.areas[1].points).toBeNull();
    expect(r.growth?.areas[1].now.pct).toBeNull();
    expect(r.now.screens[0].state).toBe("at_risk");
    expect(r.variations.pending[0].rows[0].technique).toBe("empty");
    expect(parseGrowth({}).growth).toBeNull();
  });

  it("keeps the payoff contract Release health and the weekly summary read", () => {
    expect(r.payoff).toEqual({
      headline: "x",
      areas: [],
      weekly: null,
      pct: 85,
      screens: 20,
      points: 45,
      since: "2026-10-02T09:12:00.000Z",
      added: { scenarios: 12, variations: 30, screens_reached: 1 },
    });
    // Before a baseline: no points, no date, nothing added (null, never 0).
    const none = parseGrowth({ payoff: { headline: "Coverage now: 33% of 3 screens. No baseline yet.", areas: [], weekly: null, pct: 33, screens: 3 } }).payoff;
    expect([none.pct, none.points, none.since, none.added]).toEqual([33, null, null, null]);
  });

  it("says points in words, with a real minus sign and no em dash", () => {
    expect(pointsWords(45)).toBe("+45 points");
    expect(pointsWords(-1)).toBe("−1 point");
    expect(pointsWords(0)).toBe("No change");
    expect(pointsWords(null)).toBe("Evidence unknown");
    expect(shortDate("2026-10-02T09:00:00Z")).toBe("Oct 2");
  });

  it("splits the now bar into your tests and what Embodent covers on top", () => {
    expect(nowSegments(r.growth!.areas[0].now)).toEqual({ yours: 40, orcha: 45 });
    expect(nowSegments(r.growth!.areas[1].now)).toEqual({ yours: 0, orcha: 0 });
  });

  it("keeps an area whose evidence is unknown in the chart, so it is said, not hidden", () => {
    expect(chartAreas(r.growth).map((a) => a.key)).toEqual(["checkout", "search"]);
  });

  it("folds the areas nothing covers into one line once another area is covered", () => {
    const area = (key: string, covered: number): GrowthArea => ({ key, name: key, before: side(covered ? 50 : 0, 4, covered, covered), now: side(covered ? 50 : 0, 4, covered, covered), points: 0, added: { scenarios: 0, variations: 0, screens_reached: 0 }, new: false }) as GrowthArea;
    const g = { ...r.growth!, areas: [area("profile", 2), area("about-us", 0), area("all-agents", 0)] };
    expect(chartAreas(g).map((a) => a.key)).toEqual(["profile"]);
    expect(untestedAreas(g).map((a) => a.key)).toEqual(["about-us", "all-agents"]);
    // Nothing covered anywhere: every area stays on the chart and none is folded away.
    const none = { ...g, areas: [area("about-us", 0), area("all-agents", 0)] };
    expect(chartAreas(none).map((a) => a.key)).toEqual(["about-us", "all-agents"]);
    expect(untestedAreas(none)).toEqual([]);
  });

  it("marks where the screen count changed only when points could not be recounted (#467)", () => {
    const series = [
      { day: "2026-10-27", kind: "baseline" as const, pct: 38, areas: {}, oldCount: true },
      { day: "2026-10-28", kind: "point" as const, pct: 46, areas: {}, oldCount: true },
      { day: "2026-10-29", kind: "point" as const, pct: 47, areas: {} },
      { day: "2026-10-30", kind: "now" as const, pct: 52, areas: {} },
    ];
    const plot = linePlot(series, null, 300, 100, 0);
    expect(plot.countX).toBe(plot.points[2].x);
    expect(plot.countAt).toBe(2);
    expect(countNote({ day: "2026-10-29", oldCount: ["2026-10-27", "2026-10-28"] })).toBe(
      "Screen counting changed on Oct 29; points before this use the old count.",
    );
    // Recounted (or one count throughout): nothing to mark, nothing to say.
    expect(linePlot(series.map((p) => ({ ...p, oldCount: false })), null, 300, 100, 0).countX).toBeNull();
    expect(countNote({ day: "2026-10-29", oldCount: [] })).toBeNull();
    expect(countNote(null)).toBeNull();
    // The report says so: parsed from the Python report's `count` and each point's `old_count`.
    const parsed = parseGrowth({ ...REPORT, series: [{ day: "2026-10-27", kind: "baseline", pct: 38, areas: {}, old_count: true }], count: { day: "2026-10-29", recounted: 0, old_count: ["2026-10-27"] } });
    expect(parsed.series[0].oldCount).toBe(true);
    expect(parsed.count).toEqual({ day: "2026-10-29", recounted: 0, oldCount: ["2026-10-27"] });
    // The route serves it parsed and the page parses it again: nothing is lost.
    const twice = parseGrowth(JSON.parse(JSON.stringify(parsed)));
    expect(twice.count).toEqual(parsed.count);
    expect(twice.series[0].oldCount).toBe(true);
  });

  it("plots the line from the baseline, skipping days without a figure", () => {
    const all = linePlot(r.series, null, 100, 100, 0);
    expect(all.points.map((p) => [p.pct, p.kind])).toEqual([[40, "baseline"], [60, "point"], [85, "now"]]);
    expect(all.baselineX).toBe(0);
    expect(all.points[2].y).toBeCloseTo(15);
    expect(linePlot(r.series, "search", 100, 100).points).toEqual([]);
    // A baseline taken today, then today's figure: both in the middle, the baseline marked.
    const today = linePlot(
      [
        { day: "2026-10-27", kind: "baseline", pct: 45, areas: {} },
        { day: "2026-10-27", kind: "now", pct: 47, areas: {} },
      ],
      null,
      100,
      100,
      0,
    );
    expect(today.points.map((p) => [p.x, p.kind, p.pct])).toEqual([[50, "baseline", 45], [50, "now", 47]]);
    expect(today.baselineX).toBe(50);
  });

  it("names what Embodent added and the steps of the live view", () => {
    expect(addedTiles(r.growth).map((t) => `${t.value} ${t.label}`)).toEqual(["9 scenarios", "27 data variations", "3 screens reached"]);
    expect(growthSteps({ screens: 20, flows: 6 })[0].label).toBe("Reading 20 screens from the map");
  });

  it("picks the state to draw", () => {
    expect(growthMode(r)).toBe("growth");
    expect(growthMode({ ...r, baseline: null, growth: null })).toBe("no_baseline");
    expect(growthMode(parseGrowth({ now: { totals: { screens: 0 }, areas: [] } }))).toBe("no_map");
  });
});

describe("the modernized Growth view", () => {
  const r = parseGrowth(REPORT);

  it("plays the time-lapse over stored days only, and says which areas rose", () => {
    const frames = timelapseFrames(r.series);
    expect(frames.map((f) => [f.day, f.kind, f.pct])).toEqual([
      ["2026-10-02", "baseline", 40],
      ["2026-10-15", "point", 60],
      ["2026-10-27", "now", 85],
    ]);
    expect(frames[0].rose).toEqual([]);
    expect(frames[1].rose).toEqual(["checkout"]);
    // A day without a figure is skipped, never drawn as 0.
    expect(timelapseFrames([{ day: "2026-10-03", kind: "point", pct: null, areas: {} }])).toEqual([]);
  });

  it("lays the mini map out from the areas with screens, biggest first", () => {
    expect(mapAreas(r).map((a) => a.key)).toEqual(["checkout"]);
  });

  it("splits the headline meter into your tests and Embodent, with the baseline's tick", () => {
    expect(overallSegments(r)).toEqual({ yours: 40, orcha: 45, before: 40 });
  });

  it("says what Measure again changed, in words", () => {
    expect(remeasureWords(45, 45)).toEqual({ text: "Measured: no change since the last time", tone: "same" });
    expect(remeasureWords(45, 47).text).toBe("Measured: +2 points since the last time");
    expect(remeasureWords(45, 44)).toEqual({ text: "Measured: −1 point since the last time", tone: "down" });
    expect(remeasureWords(null, null).tone).toBe("unknown");
  });

  it("finds the flows whose data depth grew after rows were added", () => {
    const flow = (id: string, partitions: number) => ({ id, depth: { partitions } });
    expect(depthGrew([flow("a", 1), flow("b", 2)], [flow("a", 4), flow("b", 2), flow("c", 3)])).toEqual({ a: 1 });
  });

  it("reads the map's headline for project Home, and dates and days for the header", () => {
    expect(areasHeadline("19 of 55 areas tested. 36 never tested. 2 failing.")).toEqual({ covered: 19, total: 55, rest: "36 never tested. 2 failing." });
    expect(areasHeadline("7 of 55 areas covered. 48 never tested. 6 covered but failing.")).toEqual({ covered: 7, total: 55, rest: "48 never tested. 6 covered but failing." });
    expect(areasHeadline("No feature areas mapped yet.")).toBeNull();
    const now = Date.parse("2026-10-27T12:00:00Z");
    expect(daysSince("2026-10-06T08:40:00Z", now)).toBe(21);
    expect(daysSince("nonsense", now)).toBeNull();
    expect(longDate("2026-10-06T08:40:00Z", now)).toBe("Oct 6");
    expect(longDate("2025-12-30T08:40:00Z", now)).toBe("Dec 30, 2025");
    // #461: on the viewer's clock, with a fixed clock at 01:33 UTC on Oct 29, in New York.
    const ny = "America/New_York";
    const taken = "2026-10-29T01:33:00.000Z";
    expect(shortDate(taken, ny)).toBe("Oct 28");
    expect(shortDate(taken, "UTC")).toBe("Oct 29");
    expect(shortDate("2026-10-29", ny)).toBe("Oct 29"); // a chart day is already the person's
    expect(daysSince(taken, Date.parse("2026-10-29T03:00:00Z"), ny)).toBe(0); // 23:00 the same evening
    expect(daysSince(taken, Date.parse("2026-10-29T05:00:00Z"), ny)).toBe(1); // 01:00 the next day, 3.5 hours later
    expect(longDate("2026-01-01T02:00:00Z", Date.parse("2026-03-01T12:00:00Z"), ny)).toBe("Dec 31, 2025");
    expect(growthSteps(null, "freeze").at(-1)?.label).toBe("Freezing it as the baseline");
  });
});

describe("the Growth copy", () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsx") || (f.endsWith(".ts") && !f.endsWith(".test.ts")));
  it.each(files)("%s names Embodent, never AI, and has no em dash", (f) => {
    const src = readFileSync(join(dir, f), "utf8");
    // Visible text: JSX text and string literals (comments may say anything about the code).
    const strings = [...src.matchAll(/"([^"\n]*)"|`([^`]*)`|>([^<>{}\n]+)</g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
    for (const s of strings) {
      expect(s).not.toMatch(/\bAI\b/);
      expect(s).not.toContain("—");
    }
  });
});
