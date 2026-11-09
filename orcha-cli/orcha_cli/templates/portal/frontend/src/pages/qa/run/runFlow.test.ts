import { describe, expect, it } from "vitest";
import type { QaSession } from "../qaApi";
import { elapsed, fromOnboarding, isQueued, KIND_LINE, liveOfPass, liveOfSession, liveRunHref, onboardingFrom, parsePass, pillWords, runHref, runningPass, showing, waitingDevice } from "./runFlow";

const session = (over: Partial<QaSession> = {}) => ({ id: "s1", kind: "map", platform: "ios", device_name: "iPhone 17 Pro", status: "running", goal: null, started_at: "2026-11-05T10:00:00Z", queued_at: null, claimed_at: null, result: null, ...over }) as QaSession;
const at = Date.parse("2026-11-05T10:03:12Z");

describe("the run's address", () => {
  it("keeps where a person came from, and names web runs", () => {
    const href = runHref({ id: "s1", platform: "web" }, "?view=map");
    const p = new URL(href, "http://x").searchParams;
    expect([p.get("view"), p.get("session"), p.get("sub"), p.get("platform"), p.get("from")]).toEqual(["sessions", "s1", "run", "web", "?view=map"]);
    expect(new URL(runHref({ id: "s1", platform: "ios" }, null), "http://x").searchParams.has("platform")).toBe(false);
  });
  it("from onboarding it returns to the exact step and names the pass it waits on", () => {
    const from = onboardingFrom("?view=onboarding&step=bring_in", "bring_in");
    expect(from).toBe("?view=onboarding&step=bring_in&after=bring_in");
    expect(fromOnboarding(from)).toBe(true);
    expect(fromOnboarding("?view=map")).toBe(false);
    expect(fromOnboarding(null)).toBe(false);
  });
  it("reads only the passes it knows", () => {
    expect(parsePass("live")).toBe("live");
    expect(parsePass("coverage")).toBeNull();
  });
});

describe("what is live", () => {
  it("bringing tests in has no task, so it is no run", () => {
    expect(runningPass({ bring_in: { state: "running", task_id: null } })).toBeNull();
    expect(runningPass({ bring_in: { state: "running", task_id: "t1" } })).toBe("bring_in");
    expect(runningPass({ live: { state: "done", task_id: "t1" } })).toBeNull();
    expect(runningPass(null)).toBeNull();
  });
  it("a claimed session holds its device; a queued one holds nothing yet", () => {
    expect(isQueued(session({ queued_at: "x" }))).toBe(true);
    expect(isQueued(session({ queued_at: "x", claimed_at: "y" }))).toBe(false);
    expect(liveOfSession(session({ queued_at: "x", claimed_at: "y" })).waiting).toBe(false);
  });
  it("a pass with no session is found again through its own address", () => {
    const run = liveOfPass("live", { task_id: "t1", started_at: "2026-11-05T10:00:00Z" });
    expect(run.sessionId).toBeNull();
    expect(pillWords(run, at)).toBe("Mapping · 3:12");
    const href = liveRunHref(run, "?view=map");
    expect(href).toContain("view=run");
    expect(href).toContain("pass=live");
    expect(showing(run, "?view=run&pass=live")).toBe(true);
    expect(showing(run, "?view=map")).toBe(false);
  });
});

describe("the pill's words", () => {
  it("counts up while it runs", () => expect(pillWords(liveOfSession(session()), at)).toBe("Mapping · 3:12"));
  it("a busy device reads as waiting, never as a failure", () => {
    const run = liveOfSession(session({ queued_at: "x", result: { waiting_device: "iPhone 17 Pro" } }));
    expect(pillWords(run, at)).toBe("Waiting for iPhone 17 Pro");
    expect(run.waiting).toBe(true);
  });
  it("waiting for an agent says so", () => expect(pillWords(liveOfSession(session({ queued_at: "x" })), at)).toBe("Mapping · waiting to start"));
  it("hides the device field a web run does not have", () => expect(liveOfSession(session({ platform: "web", device_name: "desktop" })).device).toBeNull());
  it("reads only a named device", () => {
    expect(waitingDevice(session({ result: { waiting_device: "" } }))).toBeNull();
    expect(waitingDevice(session({ result: "x" }))).toBeNull();
  });
  it("runs past an hour, and never invents a time", () => {
    expect(elapsed("2026-11-05T08:00:00Z", at)).toBe("2:03:12");
    expect(elapsed(null, at)).toBe("");
  });
});

describe("copy", () => {
  it("each card is one line and names no product", () => {
    for (const line of Object.values(KIND_LINE)) {
      expect(line.length).toBeLessThanOrEqual(40);
      expect(line).not.toMatch(/orcha|verdikt/i);
    }
  });
});
