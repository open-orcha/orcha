import { describe, expect, it } from "vitest";
import { stepKey } from "./useInboxKeys";

describe("stepKey", () => {
  const keys = ["a", "b", "c"];
  it("starts at the first row when nothing (or a stale key) is selected", () => {
    expect(stepKey(keys, null, true)).toBe("a");
    expect(stepKey(keys, "zzz", false)).toBe("a");
  });
  it("moves and clamps at both ends", () => {
    expect(stepKey(keys, "a", true)).toBe("b");
    expect(stepKey(keys, "c", true)).toBe("c");
    expect(stepKey(keys, "b", false)).toBe("a");
    expect(stepKey(keys, "a", false)).toBe("a");
  });
  it("empty list → null", () => {
    expect(stepKey([], null, true)).toBeNull();
  });
});
