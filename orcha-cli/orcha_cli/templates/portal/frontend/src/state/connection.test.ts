/** GAP-03 / PI-09: freshness is never reported as "live" on failure or staleness. */
import { describe, expect, it } from "vitest";
import { classifyConnection, STALE_MS } from "./SnapshotProvider";

const T = 1_000_000;
describe("classifyConnection", () => {
  it("nothing loaded yet: polling while trying, offline on error", () => {
    expect(classifyConnection({ error: null, lastOkAt: null, streamOpen: false, now: T })).toEqual({ connection: "polling", stale: false });
    expect(classifyConnection({ error: "boom", lastOkAt: null, streamOpen: true, now: T })).toEqual({ connection: "offline", stale: false });
  });
  it("healthy: live only with the event stream open, else polling", () => {
    expect(classifyConnection({ error: null, lastOkAt: T, streamOpen: true, now: T + 1000 }).connection).toBe("live");
    expect(classifyConnection({ error: null, lastOkAt: T, streamOpen: false, now: T + 1000 }).connection).toBe("polling");
  });
  it("a failed refresh with recent data → reconnecting; with old data → offline + stale", () => {
    expect(classifyConnection({ error: "x", lastOkAt: T, streamOpen: true, now: T + 2000 })).toEqual({ connection: "reconnecting", stale: false });
    expect(classifyConnection({ error: "x", lastOkAt: T, streamOpen: true, now: T + STALE_MS + 1 })).toEqual({ connection: "offline", stale: true });
  });
  it("no error but no fresh data for > STALE_MS (hung requests) is never live", () => {
    expect(classifyConnection({ error: null, lastOkAt: T, streamOpen: true, now: T + STALE_MS + 1 })).toEqual({ connection: "reconnecting", stale: true });
  });
});
