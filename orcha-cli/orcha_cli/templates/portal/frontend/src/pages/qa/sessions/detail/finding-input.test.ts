import { describe, expect, it } from "vitest";
import type { ExplorationResult } from "../explorations";
import type { Finding } from "../explorations";
import { nextStepFinding, nextStepInput } from "./finding-input";

/** A Next step drafts from (and a Fix card opens) the finding it came from. */

const result = {
  findings: [
    { fingerprint: "fp1", lens: "works", severity: "major", title: "Pumping amount has no upper bound", source: "agent", ref_id: "rf1", step_seq: 9 },
    { fingerprint: "fp2", lens: "works", severity: "major", title: "Feeding amount over 50 oz is accepted", source: "agent", ref_id: "rf2" },
    { fingerprint: "m1", lens: "accessible", severity: "minor", title: "Low contrast ×3", source: "measured" },
  ],
  next: [],
} as unknown as ExplorationResult;

describe("nextStepFinding", () => {
  it("takes the finding a step names", () => {
    expect(nextStepFinding({ kind: "scenario", title: "Add a scenario: Log a feeding", finding: "fp2" }, result)?.fingerprint).toBe("fp2");
  });

  it("matches a Fix step by its finding's title on older results", () => {
    expect(nextStepFinding({ kind: "fix", title: "Fix: Pumping amount has no upper bound" }, result)?.fingerprint).toBe("fp1");
  });

  it("falls back to shared words, and to none", () => {
    expect(nextStepFinding({ kind: "scenario", title: "Add a scenario: Feeding amount over 50 oz", detail: "75 oz accepted" }, result)?.fingerprint).toBe("fp2");
    expect(nextStepFinding({ kind: "scenario", title: "Add a scenario: Sign in with a passkey" }, result)).toBeNull();
  });

  it("ignores a named finding that is not in the result", () => {
    expect(nextStepFinding({ kind: "fix", title: "Fix: Pumping amount has no upper bound", finding: "gone" }, result)?.fingerprint).toBe("fp1");
  });
});

describe("nextStepInput", () => {
  const run = { id: "rf2", run_id: "r1", seq: 4, expected: "Over 50 oz is refused", actual: "75 oz was saved", note: null, repro_to_step: 12 } as unknown as Finding;

  it("drafts from the finding's run record: expected, actual, repro and a link to the run's finding", () => {
    const input = nextStepInput(
      { kind: "scenario", title: "Add a scenario: Log a feeding", finding: "fp2" },
      result,
      new Map([["rf2", run]]),
      { rf2: ["Tap Add new entry", "Tap Feeding"] },
      "e1",
      "ios",
    );
    expect(input).toMatchObject({
      title: "Feeding amount over 50 oz is accepted",
      expected: "Over 50 oz is refused",
      actual: "75 oz was saved",
      repro: ["Tap Add new entry", "Tap Feeding"],
      platform: "ios",
      source: { kind: "finding", run_id: "r1", seq: 4 },
    });
  });

  it("keeps the step itself when no finding matches", () => {
    const input = nextStepInput({ kind: "scenario", title: "Add a scenario: Sign in with a passkey", detail: "Never tried" }, result, new Map(), {}, "e1", "web");
    expect(input).toMatchObject({ title: "Sign in with a passkey", note: "Never tried", source: { kind: "next_step", exploration_id: "e1" } });
  });
});
