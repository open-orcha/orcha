import { describe, expect, it } from "vitest";
import { tookSeconds } from "./model";

describe("tookSeconds", () => {
  it("is the start to the finish, as the live clock and History say it", () => {
    // saucedemo's deep dive on Login: 16:17:23 to 16:25:32 is 8 min 9 s; the explorer's own
    // 443.8 s (7 min 24 s) is the report's Explored figure, not how long the job took.
    const e = { started_at: "2026-11-04T16:17:23.330Z", finished_at: "2026-11-04T16:25:32.319Z", result: { duration_s: 443.8 } };
    expect(tookSeconds(e)).toBe(489);
  });
  it("falls back to the result's count, then the run's, without both timestamps", () => {
    expect(tookSeconds({ started_at: "2026-11-04T16:17:23Z", finished_at: null, result: { duration_s: 443.8 } })).toBe(443.8);
    expect(tookSeconds({ started_at: null, finished_at: null, result: null }, { duration_s: 300 })).toBe(300);
    expect(tookSeconds({ started_at: null, finished_at: null, result: null })).toBeNull();
  });
});
