import { describe, expect, it } from "vitest";
import { plainPreview } from "./plainPreview";
import { headline, shortOutcome } from "./NeedsPage";

describe("plainPreview", () => {
  it("separates list items instead of running them together", () => {
    expect(plainPreview("- Extract agents store\n- Extract tasks store")).toBe("Extract agents store; Extract tasks store");
    expect(plainPreview("1. One\n2. Two\n3. Three")).toBe("One; Two; Three");
  });
  it("no doubled punctuation after a lead-in or sentence", () => {
    expect(plainPreview("Steps:\n- A\n- B")).toBe("Steps: A; B");
    expect(plainPreview("Rotate keys.\n- redeploy")).toBe("Rotate keys. redeploy");
  });
  it("drops headings when asked and strips markdown", () => {
    expect(plainPreview("## Plan\n- **Bold** step\n- `code` step", { dropHeadings: true })).toBe("Bold step; code step");
  });
});

describe("Needs detail helpers", () => {
  it("headline keeps the first sentence and cuts long ones at a word", () => {
    expect(headline("Is this ready to ship? More context follows here.")).toBe("Is this ready to ship?");
    const long = "word ".repeat(40).trim();
    const h = headline(long);
    expect(h.endsWith("…")).toBe(true);
    expect(h.length).toBeLessThanOrEqual(111);
  });
  it("shortOutcome keeps the decision word only", () => {
    expect(shortOutcome("Accepted · completed")).toBe("Accepted");
    expect(shortOutcome("Rejected — returned")).toBe("Rejected");
    expect(shortOutcome("Plan approved")).toBe("Plan approved");
  });
});
