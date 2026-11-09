import { describe, expect, it } from "vitest";
import { humanizeAgentProse, humanizeCheckText, humanizeLocator } from "./humanize-locator";

describe("humanizeLocator", () => {
  it("drops silent roles and turns value= into words", () => {
    expect(humanizeLocator('GenericElement "10/16" value="total 6" vs Total Events 3')).toBe(
      '"10/16" showing "total 6" vs Total Events 3',
    );
    expect(humanizeLocator('StaticText "Hi"')).toBe('"Hi"');
  });

  it("names controls after the label and strips element indexes", () => {
    expect(humanizeLocator('Button "Next" [4]')).toBe('"Next" button');
    expect(humanizeLocator('TextField "Email"')).toBe('"Email" field');
  });

  it("reads a check line without its element type", () => {
    expect(humanizeLocator('StaticText "Nothing tracked yet."')).toBe('"Nothing tracked yet."');
    expect(humanizeLocator('text "Saved" visible')).toBe('"Saved" visible');
    expect(humanizeLocator('Button "Add" enabled')).toBe('"Add" button enabled');
  });

  it("leaves prose and unknown words alone", () => {
    expect(humanizeLocator('Tap "Save" in the text editor')).toBe('Tap "Save" in the text editor');
    expect(humanizeLocator("Plain sentence.")).toBe("Plain sentence.");
  });
});

describe("humanizeCheckText", () => {
  it("rewrites the check runner's failure line", () => {
    const raw =
      'Home shows seven leftover routines; no errors\ncheck failed: StaticText "Nothing tracked yet." — no StaticText "Nothing tracked yet." on screen after 5.3s; nearest: StaticText "QA 2. Tap to note." [5], StaticText "QA 3. Tap to note." [6], StaticText "QA 4. Tap to note." [7], StaticText "QA 5. Tap to note." [8], Button "Add" [9]';
    expect(humanizeCheckText(raw)).toBe(
      'Home shows seven leftover routines; no errors\nCheck failed: "Nothing tracked yet." was not on screen after 5.3s. Closest on screen: "QA 2. Tap to note.", "QA 3. Tap to note.", "QA 4. Tap to note." and 2 more.',
    );
  });

  it("rewrites a step result", () => {
    expect(humanizeCheckText('fail: no Button "Next" on screen after 5.3s; nearest: Button "Start tracking" [4]')).toBe(
      'fail: "Next" button was not on screen after 5.3s. Closest on screen: "Start tracking" button.',
    );
    expect(humanizeCheckText('check failed: text "Keep my data" — no text "Keep my data" on screen after 5.0s')).toBe(
      'Check failed: "Keep my data" was not on screen after 5.0s',
    );
  });
});

describe("humanizeAgentProse", () => {
  it("drops memory plumbing sentences and internal names", () => {
    const raw =
      "The original run saw seven QA routines, which points to leftover app data, not an app defect. The `not_a_bug` memory could not be saved because `remember` needs an active recorded session.";
    expect(humanizeAgentProse(raw)).toBe(
      "The original run saw seven QA routines, which points to leftover app data, not an app defect.",
    );
    expect(humanizeAgentProse("Marked as `not_a_bug`.")).toBe("Marked as not a bug.");
  });

  it("points at Suggestions instead of a file and keeps line breaks", () => {
    expect(humanizeAgentProse("Line one.\n\nSuggestions: see suggestions.json (charts).")).toBe(
      "Line one.\n\nSuggestions: see Suggestions (charts).",
    );
  });
});

describe("humanizeCheckText: a late check's hint to the agent", () => {
  it("drops the evidence_frame instruction and speaks of the agent, not to it", () => {
    const reason =
      "it held at step 5 until your next action removed it, and the criterion was reported after that action; report a criterion with evidence_frame 5 (the screen that shows it)";
    expect(humanizeCheckText(reason)).toBe(
      "it held at step 5 until the agent's next action removed it, and the criterion was reported after that action",
    );
  });
});
