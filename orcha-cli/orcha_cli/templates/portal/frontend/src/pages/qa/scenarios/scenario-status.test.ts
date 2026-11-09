import { describe, expect, it } from "vitest";
import { countsForCoverage, effectiveStatus, isRetired, statusDetail } from "./scenario-status";

describe("scenario status", () => {
  it("reads the stored status, a missing one as a draft", () => {
    expect(effectiveStatus({ status: "validated" })).toBe("validated");
    expect(effectiveStatus({ status: "paused" })).toBe("paused");
    expect(effectiveStatus({ status: null })).toBe("draft");
    expect(isRetired({ status: "retired" })).toBe(true);
  });

  it("counts validated and paused for coverage, never a draft or a retired one", () => {
    expect(["draft", "validated", "paused", "retired"].filter((status) => countsForCoverage({ status }))).toEqual(["validated", "paused"]);
  });

  it("says the reason only for a status that has one", () => {
    expect(statusDetail({ status: "paused", status_reason: " Flag off " })).toBe("Flag off");
    expect(statusDetail({ status: "draft", status_reason: "old" })).toBe("");
  });
});
