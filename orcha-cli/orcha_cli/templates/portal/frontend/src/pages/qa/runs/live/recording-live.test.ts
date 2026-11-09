import { describe, expect, it } from "vitest";
import { LIVE_ABSENT_MS, LIVE_FAST_MS, LIVE_SLOW_MS, liveFramePath, nextLiveDelay, parseLiveMeta } from "./recording-live";

describe("parseLiveMeta", () => {
  it("reads the portal's live state", () => {
    expect(parseLiveMeta("run-1", { n: 12, cmd_seq: 4, at: 1 })).toEqual({ path: liveFramePath("run-1"), n: 12, cmdSeq: 4 });
    expect(liveFramePath("run-1")).toBe("/api/qa/sessions/run-1/live/frame");
    // Before any command ran.
    expect(parseLiveMeta("run-1", { n: 1 })).toEqual({ path: "/api/qa/sessions/run-1/live/frame", n: 1, cmdSeq: 0 });
  });

  it("rejects anything else", () => {
    expect(parseLiveMeta("run-1", null)).toBeNull();
    expect(parseLiveMeta("run-1", { n: 0, cmd_seq: 1 })).toBeNull(); // only the seq, no frame yet
    expect(parseLiveMeta("run-1", { n: "3" })).toBeNull();
  });
});

describe("nextLiveDelay", () => {
  it("reads fast while frames come, backs off while the screen is still", () => {
    expect(nextLiveDelay(LIVE_SLOW_MS, true, true)).toBe(LIVE_FAST_MS);
    const later = nextLiveDelay(LIVE_FAST_MS, false, true);
    expect(later).toBeGreaterThan(LIVE_FAST_MS);
    let d = LIVE_FAST_MS;
    for (let i = 0; i < 20; i++) d = nextLiveDelay(d, false, true);
    expect(d).toBe(LIVE_SLOW_MS);
    expect(nextLiveDelay(LIVE_FAST_MS, false, false)).toBe(LIVE_ABSENT_MS);
  });
});
