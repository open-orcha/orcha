import { describe, expect, it } from "vitest";
import { draftingRequestStatus } from "./adapt";
import { draftAreas } from "./drafting-workspace";

describe("the drafting page's model", () => {
  it("lists the drafts by area, biggest first, and folds the rest into Other", () => {
    const d = (category: string | null, n: number) => Array.from({ length: n }, () => ({ category }));
    expect(draftAreas([...d("Auth", 3), ...d(null, 1), ...d("Feed", 2)], null)).toEqual([["Auth", 3], ["Feed", 2], ["Other", 1]]);
    expect(draftAreas([...d("A", 5), ...d("B", 4), ...d("C", 3)], null, 2)).toEqual([["A", 5], ["Other", 7]]);
  });

  it("reads a session's status as a job's", () => {
    expect(["running", "done", "failed", "abandoned", "cancelled"].map(draftingRequestStatus)).toEqual(["running", "completed", "failed", "failed", "cancelled"]);
  });
});
