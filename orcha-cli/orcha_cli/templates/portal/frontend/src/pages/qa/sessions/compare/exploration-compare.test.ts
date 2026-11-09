import { describe, expect, it } from "vitest";
import { compareResults, notComparableReason, orderPair } from "./exploration-compare";
import type { ExplorationResult, ResultFinding } from "../explorations";

function finding(fingerprint: string, over: Partial<ResultFinding> = {}): ResultFinding {
  return { fingerprint, lens: "works", severity: "minor", title: fingerprint, source: "agent", ...over };
}

function result(over: Partial<ExplorationResult> = {}): ExplorationResult {
  return {
    verdict: "",
    score: 70,
    lenses: [{ lens: "works", score: 70, grade: "fair", findings: 0 }],
    charter: { total: 5, covered: 3, partial: 1, blocked: 1, bug: 1 },
    findings: [],
    screens: 6,
    steps: 40,
    duration_s: 480,
    study_s: 90,
    next: [],
    ...over,
  };
}

describe("compareResults", () => {
  it("splits findings into fixed, new and still there by fingerprint, most serious first", () => {
    const a = result({
      findings: [finding("f1", { severity: "minor" }), finding("f2", { severity: "blocker" }), finding("f3"), finding("f1")],
    });
    const b = result({ findings: [finding("f3", { title: "f3 again" }), finding("f4", { severity: "major" }), finding("f5", { severity: "blocker" })] });
    const c = compareResults(a, b);
    expect(c.fixed.map((f) => f.fingerprint)).toEqual(["f2", "f1"]);
    expect(c.added.map((f) => f.fingerprint)).toEqual(["f5", "f4"]);
    expect(c.persisting.map((f) => f.title)).toEqual(["f3 again"]);
    expect(c.unchecked).toEqual([]);
  });

  it("a finding on a screen B never reached is unchecked, not fixed", () => {
    const a = result({ findings: [finding("far", { screen: "/far" }), finding("near", { screen: "/near" })] });
    const b = result({ findings: [finding("other", { screen: "/near" })] });
    const c = compareResults(a, b);
    expect(c.fixed.map((f) => f.fingerprint)).toEqual(["near"]);
    expect(c.unchecked.map((f) => f.fingerprint)).toEqual(["far"]);
  });

  it("a finding under a lens B did not pick is unchecked, not fixed", () => {
    const a = result({
      lenses: [
        { lens: "works", score: 70, grade: "fair", findings: 1 },
        { lens: "accessible", score: 40, grade: "poor", findings: 1 },
      ],
      findings: [finding("a11y", { lens: "accessible", source: "measured" }), finding("bug")],
    });
    const b = result({ score: 90, lenses: [{ lens: "works", score: 90, grade: "good", findings: 0 }] });
    const c = compareResults(a, b);
    expect(c.fixed.map((f) => f.fingerprint)).toEqual(["bug"]);
    expect(c.unchecked.map((f) => f.fingerprint)).toEqual(["a11y"]);
    expect(c.lenses).toEqual([
      { lens: "works", a: 70, b: 90, delta: 20, gradeA: "fair", gradeB: "good" },
      { lens: "accessible", a: 40, b: null, delta: null, gradeA: "poor", gradeB: null },
    ]);
    expect(c.score).toEqual({ a: 70, b: 90, delta: 20 });
  });

  it("lists lenses in the canonical order whichever side has them", () => {
    const a = result({ lenses: [{ lens: "fast", score: 50, grade: "fair", findings: 0 }] });
    const b = result({ lenses: [{ lens: "copy", score: 80, grade: "good", findings: 0 }, { lens: "works", score: 60, grade: "fair", findings: 0 }] });
    expect(compareResults(a, b).lenses.map((l) => l.lens)).toEqual(["works", "copy", "fast"]);
  });

  it("charter, journeys, screens and steps deltas", () => {
    const a = result({
      journeys: [
        { id: "j1", name: "Owner adds a truck", outcome: "failed", broke_at: "Save" },
        { id: "j2", name: "Driver logs fuel", outcome: "passed" },
      ],
    });
    const b = result({
      charter: { total: 6, covered: 5, partial: 0, blocked: 0, bug: 1 },
      journeys: [
        { id: "j1", name: "Owner adds a truck", outcome: "passed" },
        { id: "j2", name: "Driver logs fuel", outcome: "passed" },
        { id: "j3", name: "Owner reads the review", outcome: "blocked" },
      ],
      screens: 9,
      steps: 35,
    });
    const c = compareResults(a, b);
    expect(c.charter.covered).toEqual({ a: 3, b: 5, delta: 2 });
    expect(c.charter.blocked).toEqual({ a: 1, b: 0, delta: -1 });
    expect(c.journeys.passed).toEqual({ a: 1, b: 2, delta: 1 });
    expect(c.journeys.changes).toEqual([
      { name: "Owner adds a truck", a: "failed", b: "passed" },
      { name: "Owner reads the review", a: null, b: "blocked" },
    ]);
    expect(c.screens).toEqual({ a: 6, b: 9, delta: 3 });
    expect(c.steps.delta).toBe(-5);
  });
});

describe("notComparableReason / orderPair", () => {
  it("says why a pair cannot be compared", () => {
    const ok = { name: "A", status: "done" as const, result: result() };
    expect(notComparableReason(ok, ok)).toBeNull();
    expect(notComparableReason(ok, { name: "Legacy", status: "done", result: null })).toMatch(/before explorations had scores/);
    expect(notComparableReason({ name: "Live", status: "exploring", result: null }, ok)).toMatch(/still running/);
    expect(notComparableReason(ok, { name: "Broke", status: "failed", result: null })).toMatch(/did not finish/);
  });

  it("puts the earlier exploration first", () => {
    const x = { created_at: "2026-10-02T00:00:00Z", id: "x" };
    const y = { created_at: "2026-10-01T00:00:00Z", id: "y" };
    expect(orderPair(x, y).map((e) => e.id)).toEqual(["y", "x"]);
  });
});
