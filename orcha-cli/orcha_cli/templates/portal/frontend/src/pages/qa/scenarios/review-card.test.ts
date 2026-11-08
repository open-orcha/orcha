import { describe, expect, it } from "vitest";
import type { QaEvidence } from "../qaApi";
import { diffCriteria, evidenceSummary, evidenceTitle, fieldText, filmstrip, lintNotes, statusActions } from "./review-card";

const ev = (criterion_index: number, status: QaEvidence["status"], frame_id: string | null = null): QaEvidence => ({ id: `${criterion_index}${status}`, criterion_index, status, frame_id, code_ref: null, note: null });

describe("the review card", () => {
  it("offers a decision per status, a reason for Pause and Retire", () => {
    expect(statusActions("draft").map((a) => [a.label, a.reason])).toEqual([["Validate", false], ["Retire", true]]);
    expect(statusActions("paused")[0]).toMatchObject({ label: "Resume", to: "validated" });
    expect(statusActions("retired").map((a) => a.to)).toEqual(["draft"]);
  });

  it("heads the card with how much was seen", () => {
    expect(evidenceSummary(["a", "b", "c"], [ev(0, "verified"), ev(1, "unconfirmed")])).toBe("1 of 3 verified on screen");
    expect(evidenceSummary(["a"], [ev(0, "code_only")])).toBe("code only");
    expect(evidenceSummary(["a"], [])).toBeNull();
  });

  it("says what a badge rests on", () => {
    expect(evidenceTitle({ status: "verified", note: "Welcome back", code_ref: "Home.swift:4" })).toBe("Seen: Welcome back · from Home.swift:4");
    expect(evidenceTitle({ status: "code_only", note: null, code_ref: null })).toBe("No screen to check it against");
  });

  it("shows each screen once, verified first, with every criterion it backs", () => {
    expect(filmstrip([ev(1, "unconfirmed", "b"), ev(2, "verified", "a"), ev(3, "unconfirmed", "a"), ev(4, "code_only")])).toEqual([
      { id: "a", criteria: [2, 3], verified: true },
      { id: "b", criteria: [1], verified: false },
    ]);
  });

  it("keeps lint notes to plain words", () => {
    expect(lintNotes([{ rule: "sleep", severity: "warning", message: "Fixed wait.", criterion: 1 }, { severity: "odd", message: "Hm" }, { message: "" }, null])).toEqual([
      { severity: "warning", message: "Fixed wait.", criterion: 1 },
      { severity: "info", message: "Hm", criterion: null },
    ]);
    expect(lintNotes(undefined)).toEqual([]);
  });

  it("diffs criteria and words a proposed value, never as raw data", () => {
    expect(diffCriteria(["A", "B"], ["A", "C"])).toEqual([{ text: "A", mark: "kept" }, { text: "C", mark: "new" }, { text: "B", mark: "removed" }]);
    expect(fieldText([{ criterion_index: 0, line: 'text "Hi"' }])).toBe('text "Hi"');
    expect(fieldText({ plan: "pro" })).toBe("plan = pro");
    expect(fieldText([])).toBe("None");
    expect(fieldText(null)).toBe("None");
  });
});
