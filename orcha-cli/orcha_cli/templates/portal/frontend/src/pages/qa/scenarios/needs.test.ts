import { describe, expect, it } from "vitest";
import { needsError, needsFromText, needsToText, needsWarning, parseNeeds } from "./needs";

describe("the Needs line", () => {
  it("splits on commas, keeps a quoted comma, and drops repeats", () => {
    expect(parseNeeds('reset, fixture "a, b", reset').map((n) => n.text)).toEqual(["reset", 'fixture "a, b"']);
    expect(needsFromText("")).toBeNull();
    expect(needsToText(["reset", "writes"])).toBe("reset, writes");
  });

  it("refuses too many or too long, and warns on a near miss", () => {
    expect(needsError(Array.from({ length: 13 }, (_, i) => `need ${i}`).join(", "))).toBe("At most 12 needs.");
    expect(needsError("x".repeat(81))).toMatch(/longer than 80/);
    expect(needsWarning("purchses sandbox")).toMatch(/Did you mean "purchases sandbox"/);
    expect(needsWarning("a blue car")).toBeNull();
  });
});
