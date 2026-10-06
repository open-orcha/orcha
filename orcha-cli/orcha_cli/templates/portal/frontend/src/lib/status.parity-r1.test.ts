/**
 * Parity round 1 (lib/status.ts): statuses the backend emits that used to
 * render raw — a paused project (SG-06), rate_limited / orphaned runs and a
 * not_ready task (tasks r1) — get real labels.
 */
import { describe, expect, it } from "vitest";
import { statusClass, statusMeta } from "./status";

describe("statusMeta", () => {
  it("paused project is a warning, not unknown", () => {
    expect(statusMeta("paused")).toEqual({ l: "Paused", c: "s-warn" });
  });
  it("run / task states that rendered raw", () => {
    expect(statusMeta("rate_limited").l).toBe("Rate limited");
    expect(statusMeta("orphaned")).toEqual({ l: "Orphaned", c: "s-bad" });
    expect(statusMeta("not_ready").l).toBe("On hold");
  });
  it("unmapped keys still pass through raw (StatusIcon contract); empty stays 'unknown'", () => {
    expect(statusMeta("some_new_state")).toEqual({ l: "some_new_state", c: "s-idle" });
    expect(statusMeta(null).l).toBe("unknown");
    expect(statusClass("paused")).toBe("s-warn");
  });
  it("existing labels are unchanged", () => {
    expect(statusMeta("needs_verification").l).toBe("Needs verification");
    expect(statusMeta("active")).toEqual({ l: "Active", c: "s-ok" });
  });
});
