import { describe, expect, it } from "vitest";
import type { Exploration, ExplorationResult } from "../explorations";
import { comparable } from "./compare-page";
import { compareResults } from "./exploration-compare";

const result = (findings: Partial<ExplorationResult["findings"][number]>[]): ExplorationResult =>
  ({ verdict: "", score: 80, lenses: [{ lens: "works", score: 80, grade: "good", findings: 0 }], charter: { total: 0, covered: 0, partial: 0, blocked: 0, bug: 0 }, findings: findings as never, screens: 0, steps: 0, duration_s: 0, study_s: 0, next: [] }) as ExplorationResult;
const session = (r: ExplorationResult) => ({ result: r }) as Exploration;

describe("comparable", () => {
  it("matches an agent's finding across sessions on its lens, screen and title; a measured one on its fingerprint", () => {
    const a = comparable(session(result([{ fingerprint: "id-1", source: "agent", lens: "works", severity: "major", title: "Save  does nothing", screen: "Form" }, { fingerprint: "fp", source: "measured", lens: "works", severity: "minor", title: "Small" }])));
    const b = comparable(session(result([{ fingerprint: "id-2", source: "agent", lens: "works", severity: "major", title: "save does nothing", screen: "Form" }, { fingerprint: "fp", source: "measured", lens: "works", severity: "minor", title: "Small" }])));
    const c = compareResults(a.result as ExplorationResult, b.result as ExplorationResult);
    expect(c.persisting).toHaveLength(2);
    expect(c.fixed).toHaveLength(0);
    expect(c.added).toHaveLength(0);
  });
});
