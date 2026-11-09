import { describe, expect, it } from "vitest";
import { charterCounts, composeResult, featureOutcomes, grade, journeyOutcomes, nextSteps, scoreFindings, verdictLine, walkCounts } from "./compose";
import type { CharterItem, ExplorationBriefing, ResultFinding } from "./explorations";

const finding = (id: string, severity: ResultFinding["severity"], over: Partial<ResultFinding> = {}): ResultFinding => ({ fingerprint: id, lens: "works", severity, title: `F ${id}`, source: "agent", ref_id: id, ...over });
const mission = (id: string, status: CharterItem["status"], over: Partial<CharterItem> = {}): CharterItem => ({ id, title: `M ${id}`, why: "why", lens: "works", status, ...over });

describe("the score", () => {
  it("takes each distinct finding's penalty off 100, floored at 0", () => {
    expect(scoreFindings([finding("a", "major"), finding("a", "major"), finding("b", "minor")])).toBe(80);
    expect(scoreFindings([finding("a", "blocker"), finding("b", "blocker"), finding("c", "blocker")])).toBe(0);
    expect(scoreFindings([finding("a", "cosmetic")])).toBe(99);
  });

  it("grades in bands, and a lens nobody covered is unknown", () => {
    expect([grade(80, true), grade(79, true), grade(50, true), grade(49, true), grade(100, false)]).toEqual(["good", "fair", "fair", "poor", "unknown"]);
  });

  it("takes 10 off the overall for each blocked mission", () => {
    const r = composeResult({ lenses: ["works"], charter: [mission("m1", "covered"), mission("m2", "blocked")], briefing: null, findings: [], flows: [], screens: 3, steps: 9, durationS: 60 });
    expect(r.score).toBe(90);
    expect(r.lenses).toEqual([{ lens: "works", score: 100, grade: "good", findings: 0 }]);
  });

  it("leaves a lens unknown until something touched it", () => {
    const r = composeResult({ lenses: ["works", "usable"], charter: [mission("m1", "covered")], briefing: null, findings: [], flows: [], screens: 0, steps: 1, durationS: 1 });
    expect(r.lenses.map((l) => l.grade)).toEqual(["good", "unknown"]);
  });
});

describe("the verdict line", () => {
  it("says bugs, walks and missions the way the charter says them", () => {
    const counts = charterCounts([mission("m1", "covered"), mission("m2", "bug")]);
    expect(verdictLine([finding("a", "major")], [], counts, [], walkCounts([{ name: "x", status: "failed" }]))).toBe("1 bug, 1 serious · 1 of 1 flow walked: 1 failed · 1 of 2 missions covered, 1 found a bug");
  });

  it("says when nothing was found, and leaves the missions out while only the walks ran", () => {
    expect(verdictLine([], [], charterCounts([mission("m1", "planned")]), [], walkCounts([{ name: "x", status: "passed" }]))).toBe("No bugs found · 1 of 1 flow walked: 1 passed");
  });

  it("does not count cosmetic findings as bugs", () => {
    expect(verdictLine([finding("a", "cosmetic")], [], charterCounts([]), [])).toBe("No bugs found");
  });
});

describe("next steps", () => {
  it("guards a mission that found a bug with a scenario, and fixes the serious findings it left", () => {
    const steps = nextSteps([mission("m1", "bug", { finding_ids: ["a"], note: "It broke" })], [finding("a", "major"), finding("b", "blocker"), finding("c", "minor")]);
    expect(steps).toEqual([
      { kind: "scenario", title: "Add a scenario: M m1", detail: "It broke", finding: "a" },
      { kind: "fix", title: "Fix: F b", finding: "b" },
    ]);
  });
});

describe("journeys and features", () => {
  const briefing = { journeys: [{ id: "j1", name: "Sign up", steps: [] }, { id: "j2", name: "Unrelated", steps: [] }] } as unknown as ExplorationBriefing;

  it("reads a journey's outcome from its missions and skips one without any", () => {
    expect(journeyOutcomes(briefing, [mission("m1", "bug", { journey_id: "j1", note: "Stuck" })])).toEqual([{ id: "j1", name: "Sign up", outcome: "failed", broke_at: "Stuck" }]);
  });

  it("says how far a feature got: explored, partly or not reached", () => {
    const targets = [{ key: "Sign in", name: "Sign in" }, { key: "Feed", name: "Feed" }, { key: "Search", name: "Search" }];
    const charter = [mission("a", "covered", { feature: "Sign in" }), mission("b", "covered", { feature: "Feed" }), mission("c", "blocked", { feature: "Feed", note: "No account" })];
    const out = featureOutcomes(targets, charter, [], []);
    expect(out.map((f) => f.outcome)).toEqual(["explored", "partly", "not_reached"]);
    expect(out[1]).toMatchObject({ checked: ["M b"], left: ["M c"], note: "No account" });
  });

  it("composes feature outcomes for the features the charter names", () => {
    const r = composeResult({ lenses: ["works"], charter: [mission("a", "covered", { feature: "Sign in" })], briefing: null, findings: [], flows: [], screens: 0, steps: 1, durationS: 1 });
    expect(r.features?.map((f) => f.name)).toEqual(["Sign in"]);
  });
});
