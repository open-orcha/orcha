import { describe, expect, it } from "vitest";
import { parseCheck } from "./checks";
import { CHECK_FIX_KIND_LABEL, parseCheckFix, parseCheckRepairs, pendingCheckFixes, replaceCheckLine, replaceInText } from "./check-fixes";

// From the user's runs (#191): a toast the harness checked after it faded (ddd176e5) and a Link
// the drafter wrote as a Button (996feb83).
const TOAST = { expression: 'text "Driver added"', kind: "transient", reason: "held at step 36", proposed: 'text "Driver added" appears', evidence_step: 36 };
const ROLE = { expression: 'Button "Create account"', kind: "role", reason: "a Link", proposed: 'Link "Create account"' };

const checks = { criteria: { "0": ['Button "Create account"'], "4": ['text "Driver added"', 'Button "Add driver"'] }, scenario: [] };

describe("check-fixes", () => {
  it("parses a criterion's check_fix and refuses anything else", () => {
    expect(parseCheckFix(TOAST)).toMatchObject({ kind: "transient", proposed: 'text "Driver added" appears', evidence_step: 36 });
    expect(parseCheckFix({ ...ROLE, proposed: "" })?.proposed).toBeNull();
    expect(parseCheckFix({ expression: "x", kind: "nope" })).toBeNull();
    expect(parseCheckFix(null)).toBeNull();
  });

  it("appears is a check matcher the site accepts", () => {
    expect(parseCheck('text "Driver added" appears within 8s')).toEqual({ ok: true, normalised: 'text "Driver added" appears within 8s' });
  });

  it("offers each correction once, only while the scenario still has the line", () => {
    const rows = [
      { run_id: "new", criteria: [{ check_fix: ROLE }, {}, {}, {}, { check_fix: TOAST }] },
      { run_id: "old", criteria: [{ check_fix: ROLE }] },
    ];
    const fixes = pendingCheckFixes(rows, checks);
    expect(fixes.map((f) => [f.criterion_index, f.proposed, f.run_id, f.seen])).toEqual([
      [0, 'Link "Create account"', "new", 2],
      [4, 'text "Driver added" appears', "new", 1],
    ]);
    // Accepted already (the line changed): nothing to offer for it.
    const accepted = { ...checks, criteria: { ...checks.criteria, "0": ['Link "Create account"'] } };
    expect(pendingCheckFixes(rows, accepted).map((f) => f.criterion_index)).toEqual([4]);
    // Dismissed: gone.
    const gone = pendingCheckFixes(rows, checks, [{ criterion_index: 4, expression: TOAST.expression, proposed: TOAST.proposed }]);
    expect(gone.map((f) => f.criterion_index)).toEqual([0]);
  });

  it("replaces the line in place and keeps the order", () => {
    const r = replaceCheckLine(checks, 4, 'text "Driver added"', 'text "Driver added" appears');
    expect(r.ok && r.checks.criteria["4"]).toEqual(['text "Driver added" appears', 'Button "Add driver"']);
    const missing = replaceCheckLine(checks, 2, 'text "x"', 'text "y"');
    expect(missing.ok && missing.checks.criteria["2"]).toEqual(['text "y"']);
    expect(replaceCheckLine(checks, 0, ROLE.expression, "Bogus").ok).toBe(false);
  });

  it("replaces the line in the panel's textarea text", () => {
    expect(replaceInText('text "Driver added"\nButton "Add driver"', 'text "Driver added"', 'text "Driver added" appears')).toBe(
      'text "Driver added" appears\nButton "Add driver"',
    );
    expect(replaceInText("", 'text "a"', 'text "b"')).toBe('text "b"');
  });
});

// From the 2026-10-19 audit: Snug Log Android "Log a feeding by type", criterion 2 ("Saving with
// "Save Feeding" returns to Today"). An older run (4282407a) proposed `appears`, which would pass
// without proving the return; the newer run repaired the line to `absent` (#165, #226).
describe("check repairs and outdated fixes", () => {
  const FEEDING = { criteria: { "2": ['Button "Save Feeding"'] }, scenario: [] };
  const OLD = { expression: 'Button "Save Feeding"', kind: "transient", reason: "it held at step 18", proposed: 'Button "Save Feeding" appears', evidence_step: 18 };
  const REPAIR = {
    expression: 'Button "Save Feeding"', proposed: 'Button "Save Feeding" absent', kind: "action",
    reason: '"Save Feeding" is the control the criterion acts with; the action leaves its screen, so it is checked as gone',
  };

  it("offers one fix per line, the newest run's, and marks a repair as applied", () => {
    const rows = [
      { run_id: "new", criteria: [{}, {}, { check_repairs: [REPAIR] }] },
      { run_id: "old", criteria: [{}, {}, { check_fix: OLD }] },
    ];
    const fixes = pendingCheckFixes(rows, FEEDING);
    expect(fixes.map((f) => [f.criterion_index, f.proposed, f.applied, f.run_id])).toEqual([[2, 'Button "Save Feeding" absent', true, "new"]]);
  });

  it("parses a run's repairs and never offers a late report", () => {
    expect(parseCheckRepairs([REPAIR, { expression: "x", kind: "nope" }])).toEqual([{ ...REPAIR, evidence_step: null, applied: true }]);
    const late = { expression: 'text "Get Started"', kind: "late", reason: "it held at step 3", proposed: null, evidence_step: 3 };
    const rows = [{ run_id: "r", criteria: [{ check_fix: late }] }];
    expect(pendingCheckFixes(rows, { criteria: { "0": ['text "Get Started"'] }, scenario: [] })).toEqual([]);
  });

  it("keeping a repair that dropped a line removes it", () => {
    const lately = { criteria: { "4": ['text "Nothing tracked yet." absent', 'StaticText "Nothing tracked yet."'] }, scenario: [] };
    const r = replaceCheckLine(lately, 4, 'StaticText "Nothing tracked yet."', "");
    expect(r.ok && r.checks.criteria["4"]).toEqual(['text "Nothing tracked yet." absent']);
    expect(replaceInText('text "Nothing tracked yet." absent\nStaticText "Nothing tracked yet."', 'StaticText "Nothing tracked yet."', "")).toBe(
      'text "Nothing tracked yet." absent',
    );
  });
});

describe("repairs of drafted checks (#165)", () => {
  // Scenario 57ecd489 (`text "with"` from quotes paired the wrong way) and 16bb9ea2 (the
  // "Add Entry" sheet the step leaves), from the workflow A/B's first replays.
  const PROSE = { expression: 'text "with"', proposed: null, kind: "prose", reason: '"with" is words of the criterion, not a label a screen shows' };
  const ORIGIN = {
    expression: 'text "Add Entry"', proposed: 'text "Add Entry" appears', kind: "origin",
    reason: '"Add Entry" is the screen the step is taken on, and the step leaves it; it is checked as it appears, not at the verdict',
  };

  it("offers the run's repair to keep or undo, with a plain label", () => {
    const rows = [{ run_id: "r", criteria: [{ check_repairs: [PROSE, ORIGIN] }] }];
    const have = { criteria: { "0": ['text "Add Entry"', 'StaticText "Feeding"', 'text "with"'] }, scenario: [] };
    const fixes = pendingCheckFixes(rows, have);
    expect(fixes.map((f) => [f.kind, f.proposed, f.applied])).toEqual([["prose", null, true], ["origin", 'text "Add Entry" appears', true]]);
    expect(fixes.map((f) => CHECK_FIX_KIND_LABEL[f.kind])).toEqual(["Criterion wording, not a label", "Screen the step leaves"]);
    const kept = replaceCheckLine(have, 0, 'text "with"', "");
    expect(kept.ok && kept.checks.criteria["0"]).toEqual(['text "Add Entry"', 'StaticText "Feeding"']);
  });
});

describe("an absent line that never held on its criterion's screens (#529)", () => {
  it("is a check fix of its own kind, with a label a person reads", () => {
    const fix = parseCheckFix({ expression: 'text "Wake Up" absent', kind: "unheld", reason: "it never held on this criterion's screens", proposed: null, evidence_step: null });
    expect(fix).toMatchObject({ kind: "unheld", proposed: null });
    expect(CHECK_FIX_KIND_LABEL.unheld).toBe("Never held on its screens");
  });
});
