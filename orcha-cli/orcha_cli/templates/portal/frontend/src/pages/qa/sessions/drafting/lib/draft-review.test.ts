import { describe, expect, it } from "vitest";
import { clampIndex, dotState, nextUndecidedIndex, waitingDrafts } from "./draft-review";

describe("dotState", () => {
  it("maps validated to accepted and draft to draft", () => {
    expect(dotState("validated")).toBe("accepted");
    expect(dotState("draft")).toBe("draft");
  });
});

describe("nextUndecidedIndex", () => {
  it("finds the next draft after the current index", () => {
    const statuses = ["validated", "draft", "draft", "validated"] as const;
    expect(nextUndecidedIndex(statuses, 0)).toBe(1);
  });

  it("wraps around to the start", () => {
    const statuses = ["draft", "validated", "validated"] as const;
    expect(nextUndecidedIndex(statuses, 2)).toBe(0);
  });

  it("returns null when everything is accepted", () => {
    const statuses = ["validated", "validated"] as const;
    expect(nextUndecidedIndex(statuses, 0)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(nextUndecidedIndex([], 0)).toBeNull();
  });

  it("skips the current index itself (does not report itself as next)", () => {
    const statuses = ["draft"] as const;
    // Only one card, already at it: no *other* undecided card, but it wraps
    // back onto itself since it is still undecided.
    expect(nextUndecidedIndex(statuses, 0)).toBe(0);
  });
});

describe("clampIndex", () => {
  it("clamps within bounds", () => {
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(10, 5)).toBe(4);
    expect(clampIndex(2, 5)).toBe(2);
  });

  it("returns 0 for an empty list", () => {
    expect(clampIndex(3, 0)).toBe(0);
  });
});

describe("waitingDrafts", () => {
  it("keeps only drafts, oldest first", () => {
    const rows = [
      { id: "b", status: "draft", created_at: "2026-10-05T10:02:00Z" },
      { id: "v", status: "validated", created_at: "2026-10-05T10:00:00Z" },
      { id: "a", status: "draft", created_at: "2026-10-05T10:01:00Z" },
    ] as const;
    expect(waitingDrafts(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
