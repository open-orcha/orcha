import { describe, expect, it } from "vitest";
import type { Criterion } from "../types";
import {
  criterionTitle,
  displayCriterionText,
  filledCriterionText,
  isEventsCriterion,
  isWarningCriterion,
  judgeDisputed,
  parseCriteria,
  rollupVerdicts,
  scenarioVerdict,
} from "./verdict";

function c(text: string, outcome: Criterion["outcome"]): Criterion {
  return { text, outcome, from_step: null, to_step: null };
}

describe("isWarningCriterion / displayCriterionText", () => {
  it("detects the trailing [warning] marker case-insensitively", () => {
    expect(isWarningCriterion("Shows a toast [warning]")).toBe(true);
    expect(isWarningCriterion("Shows a toast [WARNING]")).toBe(true);
    expect(isWarningCriterion("Shows a toast")).toBe(false);
  });

  it("strips the marker for display", () => {
    expect(displayCriterionText("Shows a toast [warning]")).toBe(
      "Shows a toast",
    );
    expect(displayCriterionText("Shows a toast")).toBe("Shows a toast");
  });
});

describe("parseCriteria", () => {
  it("accepts legacy plain strings", () => {
    expect(parseCriteria(["a", "b"])).toEqual([
      { text: "a", outcome: null, from_step: null, to_step: null },
      { text: "b", outcome: null, from_step: null, to_step: null },
    ]);
  });

  it("parses the full object shape, ignoring bad outcomes", () => {
    const parsed = parseCriteria([
      {
        text: "Sign-in works",
        outcome: "pass",
        from_step: 1,
        to_step: 3,
        expected: "logged in",
        actual: "logged in",
        evidence_seq: 4,
        finding_seq: null,
      },
      { text: "bogus", outcome: "not-a-real-outcome" },
    ]);
    expect(parsed[0]).toMatchObject({
      text: "Sign-in works",
      outcome: "pass",
      from_step: 1,
      to_step: 3,
      expected: "logged in",
      actual: "logged in",
      evidence_seq: 4,
    });
    expect(parsed[1].outcome).toBeNull();
  });

  it("returns [] for non-arrays", () => {
    expect(parseCriteria(null)).toEqual([]);
    expect(parseCriteria(undefined)).toEqual([]);
    expect(parseCriteria("nope")).toEqual([]);
  });
});

describe("scenarioVerdict", () => {
  it("is running while any criterion is running", () => {
    const criteria = [c("a", "pass"), c("b", "running")];
    expect(scenarioVerdict(criteria).verdict).toBe("running");
  });

  it("is failed when a critical criterion fails", () => {
    const criteria = [c("a", "pass"), c("b", "fail")];
    expect(scenarioVerdict(criteria).verdict).toBe("failed");
  });

  it("is warning when only a [warning] criterion fails", () => {
    const criteria = [c("a", "pass"), c("b [warning]", "fail")];
    expect(scenarioVerdict(criteria).verdict).toBe("warning");
  });

  it("is failed when both a critical and a warning criterion fail", () => {
    const criteria = [c("a", "fail"), c("b [warning]", "fail")];
    expect(scenarioVerdict(criteria).verdict).toBe("failed");
  });

  it("is passed when every critical criterion passes, warning ones pending", () => {
    const criteria = [c("a", "pass"), c("b [warning]", "pass")];
    expect(scenarioVerdict(criteria).verdict).toBe("passed");
  });

  it("is unprocessable when every criterion is blocked", () => {
    const criteria = [c("a", "blocked"), c("b", "blocked")];
    expect(scenarioVerdict(criteria).verdict).toBe("unprocessable");
  });

  it("is unprocessable when a critical criterion never resolved", () => {
    const criteria = [c("a", "pass"), c("b", "blocked")];
    expect(scenarioVerdict(criteria).verdict).toBe("unprocessable");
  });

  it("falls back to the result outcome when there are no criteria", () => {
    expect(scenarioVerdict([], "pass").verdict).toBe("passed");
    expect(scenarioVerdict([], "running").verdict).toBe("running");
    expect(scenarioVerdict([], "warning").verdict).toBe("warning");
    expect(scenarioVerdict([], "blocked").verdict).toBe("unprocessable");
    expect(scenarioVerdict([], null).verdict).toBe("unprocessable");
  });

  it("counts passed/total", () => {
    const criteria = [c("a", "pass"), c("b", "pass"), c("c", "fail")];
    const v = scenarioVerdict(criteria);
    expect(v.passed).toBe(2);
    expect(v.total).toBe(3);
  });
});

describe("rollupVerdicts", () => {
  it("tallies verdicts by kind", () => {
    const counts = rollupVerdicts([
      "passed",
      "passed",
      "failed",
      "warning",
      "unprocessable",
      "running",
    ]);
    expect(counts).toEqual({
      passed: 2,
      warning: 1,
      failed: 1,
      inconclusive: 0,
      unprocessable: 1,
      needs_setup: 0,
      running: 1,
      total: 6,
    });
  });
});

describe("scenarioVerdict after an aborted run", () => {
  it("treats running criteria as blocked once the scenario outcome is terminal", () => {
    const criteria: Criterion[] = [
      { text: "a", outcome: "pass", from_step: 1, to_step: 1 },
      { text: "b", outcome: "running", from_step: 2, to_step: null },
    ];
    expect(scenarioVerdict(criteria, "running").verdict).toBe("running");
    expect(scenarioVerdict(criteria, "blocked").verdict).not.toBe("running");
    expect(scenarioVerdict(criteria, "fail").verdict).not.toBe("running");
  });
});

describe("tracking-events criteria", () => {
  it("parses the source and event rows", () => {
    const [c] = parseCriteria([
      {
        text: "Tracking events: network: track",
        outcome: "fail",
        source: "events",
        events: [
          { expectation: "network: track", warning: false, matched: true, at: 12, event: "POST /track" },
          { expectation: "console: buy [warning]", warning: true, matched: false, at: null, event: null },
          "junk",
        ],
      },
    ]);
    expect(isEventsCriterion(c)).toBe(true);
    expect(criterionTitle(c)).toBe("Tracking events");
    expect(c.events).toEqual([
      { expectation: "network: track", warning: false, matched: true, at: 12, event: "POST /track" },
      { expectation: "console: buy [warning]", warning: true, matched: false, at: null, event: null },
    ]);
  });

  it("leaves ordinary criteria alone", () => {
    const [c] = parseCriteria([{ text: "Cart shows total [warning]", outcome: "pass" }]);
    expect(isEventsCriterion(c)).toBe(false);
    expect(c.events).toBeNull();
    expect(criterionTitle(c)).toBe("Cart shows total");
  });
});

describe("inconclusive verdicts", () => {
  it("parseCriteria keeps inconclusive, explanation and evidence_frame", () => {
    const [c] = parseCriteria([{ text: "t", outcome: "inconclusive", explanation: "still loading a spinner", evidence_frame: 7 }]);
    expect(c.outcome).toBe("inconclusive");
    expect(c.explanation).toBe("still loading a spinner");
    expect(c.evidence_frame).toBe(7);
  });

  it("scenarioVerdict: inconclusive unless a critical criterion failed", () => {
    const crit = (outcome: "pass" | "fail" | "inconclusive") => ({ text: "c", outcome, from_step: null, to_step: null });
    expect(scenarioVerdict([crit("pass"), crit("inconclusive")]).verdict).toBe("inconclusive");
    expect(scenarioVerdict([crit("fail"), crit("inconclusive")]).verdict).toBe("failed");
    expect(scenarioVerdict([], "inconclusive").verdict).toBe("inconclusive");
  });
});

describe("result records", () => {
  it("a result with criteria nobody reported is never passed (#223, adb82ed9: 1 of 5)", () => {
    const declared = ["Offers Temperature", "Shows the reading", "Unit switch converts", "Save Temperature"];
    const criteria = parseCriteria([
      ...declared.map((text, i) => ({ text, criterion_index: i, outcome: "inconclusive", not_reported: true })),
      { text: "Timeline shows it", criterion_index: 4, outcome: "pass", proof: "checked+judged" },
    ]);
    expect(criteria[0].not_reported).toBe(true);
    expect(criteria[4].criterion_index).toBe(4);
    const v = scenarioVerdict(criteria, "inconclusive");
    expect(v).toMatchObject({ verdict: "inconclusive", passed: 1, total: 5, notReported: 4 });
  });

  it("an unreported [warning] criterion makes a passing scenario a warning", () => {
    const criteria = parseCriteria([
      { text: "Opens", outcome: "pass" },
      { text: "Shows a toast [warning]", outcome: "inconclusive", not_reported: true },
    ]);
    expect(scenarioVerdict(criteria, "warning").verdict).toBe("warning");
  });

  it("parses the judge's second opinion, which the run page used to drop (#234)", () => {
    const [c] = parseCriteria([{ text: "Open the All Properties page", outcome: "pass", proof: "judged",
      judge: { criterion_met: 0.18, agrees: false, confidence: 0.82 } }]);
    expect(c.judge).toEqual({ criterion_met: 0.18, agrees: false, confidence: 0.82 });
  });

  it("flags a pass only the agent's word proves that the judge scored unmet (#234, a99f242f)", () => {
    const judge = { criterion_met: 0.18, agrees: false, confidence: 0.82 };
    const base = { text: "Open the All Properties page", from_step: null, to_step: null };
    expect(judgeDisputed({ ...base, outcome: "pass", proof: "judged", judge })).toBe(true);
    expect(judgeDisputed({ ...base, outcome: "pass", proof: "checked+judged", judge })).toBe(false);
    expect(judgeDisputed({ ...base, outcome: "pass", proof: "judged", judge: { ...judge, criterion_met: 0.6 } })).toBe(false);
    expect(judgeDisputed({ ...base, outcome: "fail", proof: "judged", judge })).toBe(false);
    expect(judgeDisputed({ ...base, outcome: "pass", source: "replayed", judge })).toBe(false);
    expect(judgeDisputed({ ...base, outcome: "pass", source: "replay+judge", judge })).toBe(false);
    // #377: a re-checked criterion keeps the judge's probability for the run page.
    const [rechecked] = parseCriteria([{ ...base, outcome: "pass", source: "replay+judge", judge: { criterion_met: 0.92, verify: true, min_confidence: 0.7 } }]);
    expect(rechecked.rechecked_p).toBe(0.92);
    expect(rechecked.judge).toBeNull();
    const criteria = parseCriteria([{ ...base, outcome: "pass", proof: "judged", judge }, { ...base, outcome: "pass", proof: "judged" }]);
    // Still a pass: the judge never changes an outcome, the page counts it apart.
    expect(scenarioVerdict(criteria, "pass")).toMatchObject({ verdict: "passed", passed: 2, disputed: 1 });
  });
});

describe("an Examples row's criteria show the row's values (#283)", () => {
  const stored = [
    { text: 'The New Book screen\'s PAPER section offers the "{{paper}}" paper card', reported_text: 'The New Book screen\'s PAPER section offers the "Music" paper card', outcome: "pass" },
    { text: 'Opening "Weekly Review" shows the paper ticked as "{{paper}}" under Page Actions > Book Paper', reported_text: "The paper shows as Music", outcome: "pass" },
    { text: "The cover preview caption says {{pages}} pages will be created [warning]", reported_text: "The cover preview caption says 12 pages will be created", outcome: "warning" },
    { text: "Create stays disabled until a name is typed", reported_text: "Create stays disabled", outcome: "pass" },
  ];

  it("fills the template from the reported line, and only when that line is the template", () => {
    const [a, b, c, d] = parseCriteria(stored as never);
    expect(criterionTitle(a)).toBe('The New Book screen\'s PAPER section offers the "Music" paper card');
    expect(a.text).toContain("{{paper}}"); // still the scenario's line, for matching
    expect(criterionTitle(b)).toContain('"{{paper}}"'); // a reworded report never replaces it
    expect(criterionTitle(c)).toBe("The cover preview caption says 12 pages will be created");
    expect(isWarningCriterion(c.text)).toBe(true);
    expect(d.shown_text).toBeNull();
  });

  it("treats regex characters in the template as text", () => {
    expect(filledCriterionText("Total is $ {{n}} (incl. VAT)", "Total is $ 12.50 (incl. VAT)")).toBe("Total is $ 12.50 (incl. VAT)");
    expect(filledCriterionText("Total is $ {{n}} (incl. VAT)", "Total is $ 12.50 incl VAT")).toBeNull();
  });
});

describe("a criterion the run never reached (needs setup, #280)", () => {
  it("is not_run, and its never-evaluated checks are not failures", () => {
    const [c] = parseCriteria([{
      text: "A wrong password says the credentials do not match", outcome: "needs_setup", not_run: true,
      checks: [{ expression: 'text ~"do not match"', outcome: "fail", actual: "not evaluated" }, { expression: 'text "Welcome"', outcome: "fail", actual: "absent" }],
    }] as never);
    expect(c.not_run).toBe(true);
    expect(c.checks?.map((k) => k.outcome)).toEqual(["not_run", "fail"]);
  });
});
