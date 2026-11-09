import { describe, expect, it } from "vitest";
import {
  baselineOf,
  buildRunScreens,
  buildSlowest,
  deltaText,
  fmtMetric,
  heatByScreen,
  heatOf,
  median,
  percentile,
  type PerfSampleRow,
} from "./perf";
import { PERF_DEFAULTS, mergePerfSettings, normalisePerfSettings, validatePerfChange } from "./perf-settings";

const S = PERF_DEFAULTS;

function sample(over: Partial<PerfSampleRow>): PerfSampleRow {
  return {
    run_id: "r1", screen_key: "seen-orders", screen_label: "Order history", platform: "ios", device: "iPhone 17 Pro",
    device_class: "iPhone 17 Pro", metric: "appear", value: 1200, step_seq: 2, noise: null, created_at: "2026-10-20T09:00:00Z", ...over,
  };
}

describe("baseline maths (as screen_perf.baseline)", () => {
  it("median and nearest-rank p90", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([1, 2, 3], 90)).toBe(3);
  });
  it("takes the newest N", () => {
    expect(baselineOf([1300, 1200, 1100, 9000, 9000], 3)).toEqual({ median: 1200, p90: 1300, n: 3 });
  });
});

describe("formatting", () => {
  it("reads seconds, MB and percent", () => {
    expect(fmtMetric("appear", 3400)).toBe("3.4 s");
    expect(fmtMetric("heap", 18.46)).toBe("18.5 MB");
    expect(fmtMetric("cpu", 41.6)).toBe("42%");
    expect(fmtMetric("lcp", null)).toBe("–");
    expect(deltaText(1.83)).toBe("+183% vs usual");
    expect(deltaText(-0.2)).toBe("20% faster than usual");
    expect(deltaText(null)).toBeNull();
  });
});

describe("the run page", () => {
  it("compares each metric with the screen's history and puts filed screens first", () => {
    const run = [sample({ run_id: "now", value: 3400 }), sample({ run_id: "now", screen_key: "seen-profile", screen_label: "Profile", value: 600 })];
    const history = Array.from({ length: 6 }, (_, i) => sample({ run_id: `old${i}`, value: 1200 }));
    const screens = buildRunScreens(run, history, [{ seq: 4, title: "Order history takes 3.4 s", severity: "minor", screen_key: "seen-orders", metric: "appear", reason: "regression", confidence: "high" }], S);
    expect(screens.map((s) => s.label)).toEqual(["Order history", "Profile"]);
    const cell = screens[0].cells.appear!;
    expect(cell.baseline).toEqual({ median: 1200, p90: 1200, n: 6 });
    expect(cell.delta).toBeCloseTo(1.833, 2);
    expect(cell.over).toBe(true);
    expect(screens[1].cells.appear!.baseline).toBeNull(); // no history yet
  });

  it("counts a run's noisy samples but compares its clean ones", () => {
    const run = [sample({ run_id: "now", value: 900 }), sample({ run_id: "now", value: 5000, noise: "under_load" })];
    const [s] = buildRunScreens(run, [], [], S);
    expect(s.cells.appear!.value).toBe(900);
    expect(s.noise).toEqual(["under_load"]);
  });
});

describe("Slowest screens", () => {
  const runs = (key: string, values: number[], platform = "ios") =>
    values.map((v, i) => sample({ run_id: `${key}-${i}`, screen_key: key, screen_label: key, value: v, platform, created_at: `2026-10-${String(10 + i).padStart(2, "0")}T09:00:00Z` }));

  it("ranks slow first, with trend, usual time and the open issue", () => {
    const rows = [...runs("orders", [1200, 1150, 1250, 1200, 3400]), ...runs("profile", [600, 610, 590, 600]), ...runs("cart", [1100, 1150, 1120, 1300])];
    const screens = buildSlowest(rows, [{ id: "i1", title: "Order history takes 3.4 s", status: "needs_review", dedupe_key: "perf:ios:orders" }], S);
    expect(screens.map((s) => [s.key, s.heat])).toEqual([["orders", "slow"], ["cart", "warm"], ["profile", "ok"]]);
    expect(screens[0].trend).toEqual([1200, 1150, 1250, 1200, 3400]);
    expect(screens[0].baseline?.median).toBe(1200);
    expect(screens[0].issue?.id).toBe("i1");
    expect(screens[0].budget).toBe(1500);
  });

  it("leaves noise out and ranks the web by LCP", () => {
    const rows = [
      ...runs("/checkout", [1000, 1100, 1050], "web").map((r) => ({ ...r, metric: "lcp" as const, device_class: "desktop" })),
      sample({ platform: "web", device_class: "desktop", screen_key: "/checkout", metric: "lcp", value: 9000, noise: "under_load", created_at: "2026-10-30T00:00:00Z" }),
    ];
    const [s] = buildSlowest(rows, [], S);
    expect(s.metric).toBe("lcp");
    expect(s.latest).toBe(1050);
    expect(s.budget).toBe(2500);
  });

  it("heat: over budget, regressed or an open issue is slow; two thirds is warm", () => {
    expect(heatOf({ latest: 1600, budget: 1500, delta: null, issue: null }, S)).toBe("slow");
    expect(heatOf({ latest: 800, budget: 1500, delta: 0.6, issue: null }, S)).toBe("slow");
    expect(heatOf({ latest: 1100, budget: 1500, delta: 0, issue: null }, S)).toBe("warm");
    expect(heatOf({ latest: 400, budget: 1500, delta: 0, issue: { id: "i", title: "t", status: "acknowledged" } }, S)).toBe("slow");
    expect(heatOf({ latest: 400, budget: 1500, delta: 0, issue: { id: "i", title: "t", status: "resolved" } }, S)).toBe("ok");
    // +127% but only 70 ms: under the "and by at least" line, a fast screen stays fast
    expect(heatOf({ latest: 125, budget: 1500, delta: 1.27, issue: null }, S)).toBe("ok");
  });

  it("the map overlay keeps one mark per screen on the chosen platform", () => {
    const rows = [...runs("orders", [1200, 1200, 1200, 1300]), ...runs("orders", [400, 400, 400], "android")];
    const all = buildSlowest(rows, [], S);
    expect(heatByScreen(all, "android").get("orders")?.platform).toBe("android");
    expect(heatByScreen(all, null).get("orders")?.platform).toBe("ios");
  });
});

describe("settings (as screen_perf.settings)", () => {
  it("normalises and validates with the Python words", () => {
    expect(normalisePerfSettings({ regression_pct: 5000, budgets: { appear_ms: 900 } })).toEqual({ ...PERF_DEFAULTS, budgets: { ...PERF_DEFAULTS.budgets, appear_ms: 900 } });
    expect(validatePerfChange({ regression_pct: 1 })).toEqual({ ok: false, error: "regression_pct must be a number from 5 to 1000." });
    expect(validatePerfChange({ nope: 1 })).toEqual({ ok: false, error: "Unknown setting: nope." });
    expect(validatePerfChange({ pr_gate: "yes" })).toEqual({ ok: false, error: "pr_gate must be true or false." });
    expect(validatePerfChange({})).toEqual({ ok: false, error: "Send at least one setting." });
    expect(validatePerfChange({ budgets: { launch_ms: 2000 }, pr_note: true })).toEqual({ ok: true, value: { budgets: { launch_ms: 2000 }, pr_note: true } });
    expect(mergePerfSettings({ budgets: { appear_ms: 900 } }, { budgets: { launch_ms: 2000 } })).toEqual({ budgets: { appear_ms: 900, launch_ms: 2000 } });
  });
});
