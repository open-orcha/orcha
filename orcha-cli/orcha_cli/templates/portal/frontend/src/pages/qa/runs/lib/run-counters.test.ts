import { describe, expect, it } from "vitest";
import {
  budgetShare,
  clockWithBudget,
  criteriaPassedLabel,
  elapsedSince,
  fmtClock,
  readingLabel,
  runClockStart,
  runCounters,
  scenarioProgress,
  scenarioProgressLabel,
  stepBreakdown,
  stepBreakdownLine,
} from "./run-counters";

describe("runCounters (#170: one source for every surface)", () => {
  const steps = [
    { seq: 1, kind: "screen", screen_hash: "a", frame_path: "r/f/1.jpg" },
    { seq: 2, kind: "tap" },
    { seq: 3, kind: "screen", screen_hash: "b", frame_path: "r/f/3.jpg" },
    { seq: 4, kind: "wait" },
    { seq: 5, kind: "screen", screen_hash: "a", frame_path: null },
    { seq: 6, kind: "type" },
  ];

  it("counts every non-screen step as an action, as runs.step_count does", () => {
    expect(runCounters(steps).actions).toBe(3);
  });

  it("counts distinct screens and keeps the newest frame", () => {
    const c = runCounters(steps);
    expect(c.screens).toBe(2);
    expect(c.latestFrame).toBe("r/f/3.jpg");
  });

  it("lets the stored step count win once the run wrote it", () => {
    expect(runCounters(steps, 15).actions).toBe(15);
    expect(runCounters([], null)).toEqual({ actions: 0, screens: 0, latestFrame: null, firstAtMs: null });
  });

  it("counts screen reads without a hash when no hash is known at all", () => {
    expect(runCounters([{ seq: 1, kind: "screen" }, { seq: 2, kind: "screen" }]).screens).toBe(2);
  });
});

describe("elapsed clock", () => {
  it("ticks in seconds from the start", () => {
    const start = "2026-10-15T10:00:00.000Z";
    expect(fmtClock(elapsedSince(start, Date.parse(start) + 56_400))).toBe("0:56");
    expect(fmtClock(elapsedSince(start, Date.parse(start) + 3_723_000))).toBe("1:02:03");
  });

  it("is unknown before the start and never negative", () => {
    expect(elapsedSince(null, 0)).toBeNull();
    expect(elapsedSince("2026-10-15T10:00:00Z", Date.parse("2026-10-15T09:00:00Z"))).toBe(0);
    expect(fmtClock(null)).toBe("–:––");
  });

  it("starts at the session's first step, not while the device session comes up (#200)", () => {
    // Run 140d8928 on the iPad: the run row at 13:49:05.7, its first screen 72.9 s later.
    const started = "2026-10-19T13:49:05.700Z";
    const steps = [{ seq: 2, kind: "tap", at_ms: 74_000 }, { seq: 1, kind: "screen", at_ms: 72_883 }];
    const start = runClockStart(started, runCounters(steps).firstAtMs);
    expect(start).toBe("2026-10-19T13:50:18.583Z");
    // At 13:50:08 the wall read 1:02 on a tile still "Starting the device session".
    expect(runClockStart(started, runCounters([]).firstAtMs)).toBeNull();
    expect(fmtClock(elapsedSince(start, Date.parse("2026-10-19T13:50:30Z")))).toBe("0:11");
  });

  it("says the budget and how much of it is spent", () => {
    expect(clockWithBudget(56_000, 5)).toBe("0:56 of 5 min");
    expect(budgetShare(150_000, 5)).toBe(0.5);
    expect(budgetShare(900_000, 5)).toBe(1);
    expect(budgetShare(null, 5)).toBe(0);
  });
});

describe("scenarioProgress", () => {
  it("counts a batch child done once its verdict landed, before its request ends", () => {
    const children = [
      { status: "running", run_id: "r1" },
      { status: "running", run_id: "r2" },
      { status: "queued", run_id: null },
    ];
    expect(scenarioProgress({ children, runsWithVerdict: new Set(["r1"]) })).toEqual({ done: 1, total: 3 });
    expect(scenarioProgress({ children: [...children, { status: "completed" }] })).toEqual({ done: 1, total: 4 });
  });

  it("counts a single-session run's verdicts against its scenarios", () => {
    expect(scenarioProgress({ scenarioCount: 3, verdicts: 1 })).toEqual({ done: 1, total: 3 });
    expect(scenarioProgress({ scenarioCount: 3, verdicts: 5 })).toEqual({ done: 3, total: 3 });
    expect(scenarioProgress({ scenarioCount: null, verdicts: 0 })).toBeNull();
  });

  it("reads as N / M scenarios", () => {
    expect(scenarioProgressLabel({ done: 1, total: 3 })).toBe("1 / 3 scenarios");
    expect(scenarioProgressLabel({ done: 0, total: 1 })).toBe("0 / 1 scenario");
  });
});

describe("readingLabel (drafting header)", () => {
  it("never says 0 files", () => {
    expect(readingLabel({ reads: 0 })).toBeNull();
    expect(readingLabel(null)).toBeNull();
    expect(readingLabel({ reads: 0, searches: 4 })).toBe("4 searches");
    expect(readingLabel({ reads: 1, searches: 4 })).toBe("1 file");
    expect(readingLabel({ reads: 12 })).toBe("12 files");
  });
});

describe("stepBreakdown", () => {
  const steps = (actions: number, looks: number) => [
    ...Array.from({ length: actions }, (_, i) => ({ seq: i, kind: i % 2 ? "tap" : "swipe" })),
    ...Array.from({ length: looks }, (_, i) => ({ seq: actions + i, kind: "screen" })),
  ];

  it("splits the Steps tab's count into the header's actions and the replay's screen reads", () => {
    const list = steps(177, 179);
    const b = stepBreakdown(list);
    expect(b).toEqual({ steps: 356, actions: 177, looks: 179 });
    // The header's "177 actions" is the same rule (`runCounters`, `runs.step_count`).
    expect(runCounters(list, null).actions).toBe(b.actions);
    expect(stepBreakdownLine(b)).toBe("356 steps: 177 actions, 179 screen reads");
  });

  it("says only the total when every step is one kind", () => {
    expect(stepBreakdownLine(stepBreakdown(steps(4, 0)))).toBe("4 steps");
    expect(stepBreakdownLine(stepBreakdown(steps(0, 1)))).toBe("1 step");
    expect(stepBreakdownLine(stepBreakdown([]))).toBe("0 steps");
  });

  it("singular parts", () => {
    expect(stepBreakdownLine(stepBreakdown(steps(1, 1)))).toBe("2 steps: 1 action, 1 screen read");
  });
});

describe("criteriaPassedLabel (#170)", () => {
  it("counts out of the scenario's own criteria while verdicts stream in", () => {
    const judged = [{ outcome: "pass" }, { outcome: "fail" }, { outcome: null }];
    expect(criteriaPassedLabel(judged, 5)).toBe("1 of 5 criteria passed");
  });

  it("falls back to the judged criteria without a known count, and never shows fewer", () => {
    expect(criteriaPassedLabel([{ outcome: "pass" }, { outcome: "pass" }])).toBe("2 of 2 criteria passed");
    expect(criteriaPassedLabel([{ outcome: "pass" }, { outcome: "pass" }], 1)).toBe("2 of 2 criteria passed");
    expect(criteriaPassedLabel([{ outcome: "pass" }], 1)).toBe("1 of 1 criterion passed");
  });
});

describe("screens agree with the map", () => {
  it("counts a map screen once, however many hashes it had", () => {
    const steps = [
      { seq: 1, kind: "screen", screen_hash: "a", screen_key: "/about" },
      { seq: 2, kind: "screen", screen_hash: "b", screen_key: "/about" },
      { seq: 3, kind: "screen", screen_hash: "c", screen_key: "/faqs" },
    ];
    expect(runCounters(steps).screens).toBe(2);
  });
});
