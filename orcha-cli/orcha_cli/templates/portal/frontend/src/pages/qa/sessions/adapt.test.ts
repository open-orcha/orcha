import { describe, expect, it } from "vitest";
import type { QaFinding, QaSession, QaWalk, SessionDetail } from "../qaApi";
import { activityLines, briefingOf, charterOf, endedError, explorationOf, explorationStatus, findingOf, frameKind, liveStateOf, reproOf, resultFindingOf, severityOf, walkCountsOf } from "./adapt";
import type { QaStep } from "./api";

const session = (over: Partial<QaSession> = {}): QaSession => ({
  id: "s1", kind: "explore", platform: "ios", task_id: null, agent_id: null, device_name: null, app_id: null, status: "running", budget_minutes: 20, goal: "Explore sign-up",
  report_md: null, started_at: "2026-11-04T10:00:00Z", ended_at: null, last_seen_at: null, ...over,
});
const finding = (over: Partial<QaFinding> & { end_seq?: number; start_seq?: number } = {}): QaFinding => ({
  id: "f1", session_id: "s1", task_id: null, severity: "major", title: "Save does nothing", detail: null, expected: null, actual: null, frame_ids: [], screen_key: null, status: "open", filed_task_id: null, created_at: "2026-11-04T10:05:00Z", ...over,
});
const step = (seq: number, kind: string, args: Record<string, unknown> = {}, over: Partial<QaStep> = {}): QaStep => ({ seq, kind, args, result: null, screen_key: null, screen_hash: null, frame_id: null, at: null, ...over });

describe("a session's phase comes from what it stored", () => {
  it("studies until the briefing lands, then explores", () => {
    expect(explorationStatus(session())).toBe("studying");
    expect(explorationStatus(session({ briefing: { app_summary: "A notes app" } }))).toBe("exploring");
  });

  it("a map crawl has no briefing and explores from the start; a check run is checking", () => {
    expect(explorationStatus(session({ kind: "map" }))).toBe("exploring");
    expect(explorationStatus(session({ kind: "check" }))).toBe("checking");
  });

  it("a drafting run reads until its first draft", () => {
    expect(explorationStatus(session({ kind: "draft" }), 0)).toBe("studying");
    expect(explorationStatus(session({ kind: "draft" }), 2)).toBe("exploring");
  });

  it("once it ended it is done, stopped or failed, and stopped responding reads as failed", () => {
    expect(explorationStatus(session({ status: "done" }))).toBe("done");
    expect(explorationStatus(session({ status: "cancelled" }))).toBe("cancelled");
    expect(explorationStatus(session({ status: "failed" }))).toBe("failed");
    expect(explorationStatus(session({ status: "abandoned" }))).toBe("failed");
  });

  it("says why it ended", () => {
    expect(endedError(session({ status: "abandoned" }))).toBe("It stopped responding.");
    expect(endedError(session({ status: "failed", result: { error: "TimeoutError: boom" } }))).toBe("TimeoutError: boom");
    expect(endedError(session({ status: "done" }))).toBeNull();
  });
});

describe("the briefing and the charter", () => {
  it("reads a briefing tolerantly and never keeps an unknown field", () => {
    const b = briefingOf({ app_summary: "Notes", personas: [{ name: "Ana", goal: "Keep notes" }, "Sam"], risks: ["Password reset"], journeys: [{ name: "Sign up", steps: [{ text: "Open" }, "Type"] }], nested: { x: 1 } });
    expect(b?.personas).toEqual([{ name: "Ana", goal: "Keep notes" }, { name: "Sam", goal: "" }]);
    expect(b?.risks).toEqual([{ area: "Password reset", why: "" }]);
    expect(b?.journeys).toEqual([{ id: "j1", name: "Sign up", steps: ["Open", "Type"] }]);
    expect(briefingOf(null)).toBeNull();
    expect(briefingOf("text")).toBeNull();
  });

  it("marks the first unsettled mission as the one in hand, the rest as planned", () => {
    const c = charterOf({ missions: [{ title: "A", status: "covered" }, { title: "B", status: "active" }, { title: "C", status: "active" }] }, true);
    expect(c.map((m) => m.status)).toEqual(["covered", "active", "planned"]);
    expect(charterOf([{ title: "A", status: "active" }], false)[0].status).toBe("planned");
  });

  it("keeps a mission's lens and feature when it has them", () => {
    expect(charterOf([{ title: "A", status: "covered", lens: "usable", feature: "Sign in" }, { title: "B", lens: "nonsense" }], true).map((m) => [m.lens, m.feature])).toEqual([["usable", "Sign in"], ["works", undefined]]);
  });
});

describe("findings", () => {
  it("puts Embodent's lightest severity on the five-step scale", () => {
    expect([severityOf("blocker"), severityOf("major"), severityOf("minor"), severityOf("trivial"), severityOf(null)]).toEqual(["blocker", "major", "minor", "cosmetic", "cosmetic"]);
  });

  it("takes a finding's lens and feature from the mission that filed it", () => {
    const f = finding({ frame_ids: ["fr1"], end_seq: 7 });
    expect(resultFindingOf(f, charterOf([{ id: "m1", title: "A", status: "bug", lens: "resilient", feature: "Feed", finding_ids: ["f1"] }], false))).toMatchObject({ fingerprint: "f1", lens: "resilient", feature: "Feed", step_seq: 7, evidence: "fr1", ref_id: "f1" });
    expect(resultFindingOf(f, []).lens).toBe("works");
  });

  it("keeps a web finding's events out of its note", () => {
    expect(findingOf(finding({ detail: "Pressing Pay shows nothing.\nevents since last screen (1):\npageerror: boom" }), 1).note).toBe("Pressing Pay shows nothing.");
  });

  it("writes the steps to reproduce from the actions between a finding's first and last step", () => {
    const f = findingOf(finding({ start_seq: 2, end_seq: 4 }), 1);
    const steps = [step(1, "tap", { target: { label: "Before" } }), step(2, "tap", { target: { label: "Save" } }), step(3, "screen"), step(4, "type", { text: "Hello" }), step(5, "tap")];
    expect(reproOf(f, steps)).toEqual(['tap "Save"', 'type "Hello"']);
  });
});

describe("an exploration from a session", () => {
  it("names it by its kind and day, and keeps the goal as what was asked", () => {
    const e = explorationOf(session(), { findings: [], walks: [] });
    expect(e.name).toMatch(/^Exploration · Nov \d+$/);
    expect(e.goal).toBe("Explore sign-up");
    expect(e.recipe).toBe("explore");
    expect(e.result).toBeNull();
  });

  it("prefers the name the explorer suggested", () => {
    expect(explorationOf(session({ briefing: { suggested_name: "Sign-up sweep" } }), { findings: [], walks: [] }).name).toBe("Sign-up sweep");
  });

  it("composes the result once it is done, leaving dismissed findings out", () => {
    const e = explorationOf(session({ status: "done", ended_at: "2026-11-04T10:10:00Z", result: { screens: 4, steps: 9 } }), { findings: [finding(), finding({ id: "f2", status: "dismissed", severity: "blocker" })], walks: [] });
    expect(e.result).toMatchObject({ screens: 4, steps: 9, duration_s: 600, score: 85, verdict: "1 bug, 1 serious" });
    expect(e.result?.findings.map((f) => f.ref_id)).toEqual(["f1"]);
  });

  it("keeps what a stopped session got done, and has no report for one that did nothing", () => {
    expect(explorationOf(session({ status: "cancelled" }), { findings: [finding()], walks: [] }).result).not.toBeNull();
    expect(explorationOf(session({ status: "cancelled" }), { findings: [], walks: [], steps: 0 }).result).toBeNull();
  });
});

describe("the live state", () => {
  const detail = (over: Partial<SessionDetail> = {}): SessionDetail => ({ session: session(), walks: [], findings: [finding()], steps_count: 3, drafts: [], verdicts: [], ...over });

  it("reads the frames and the studied screens from the steps", () => {
    const live = liveStateOf(detail(), [step(1, "screen", { title: "Home", url: "https://a.io/", anchors: ["Pricing"], texts: ["Welcome"] }, { frame_id: "fr1" }), step(2, "tap"), step(3, "note")]);
    expect(live.frames).toEqual([{ seq: 1, frame_path: "fr1" }]);
    expect(live.screens).toEqual([{ seq: 1, url: "https://a.io/", title: "Home", anchors: ["Pricing"], texts: ["Welcome"], frame_path: "fr1" }]);
    expect(live.steps).toBe(3);
    expect(live.findings[0].qa.id).toBe("f1");
  });

  it("writes the activity log in plain words", () => {
    expect(activityLines([step(1, "screen", { title: "Home" }), step(2, "tap", { target: { label: "Save" } }), step(3, "note", {}, { result: "captured: Save does nothing" })])).toEqual(["Screen: Home", 'tap "Save"', "captured: Save does nothing"]);
  });
});

it("counts walks by outcome, an open one still left", () => {
  const w = (status: QaWalk["status"]) => ({ status }) as QaWalk;
  expect(walkCountsOf([w("passed"), w("failed"), w("unreachable"), w("walking"), w("abandoned")])).toEqual({ total: 5, walked: 3, passed: 1, failed: 1, unreachable: 1, left: 2 });
});

it("frames a phone-sized web session as a phone", () => {
  expect(frameKind({ platform: "web", device_name: "mobile" })).toBe("ios");
  expect(frameKind({ platform: "web", device_name: "desktop" })).toBe("web");
  expect(frameKind({ platform: "android", device_name: null })).toBe("android");
});

describe("what a person keeps, and the queue", () => {
  const row = { id: "s1", kind: "explore", platform: "ios", status: "running", task_id: null, agent_id: null, device_name: null, app_id: null, budget_minutes: null, goal: null, report_md: null, started_at: "2026-11-02T10:00:00Z", ended_at: null, last_seen_at: null } as const;

  it("a queued row is queued until an agent takes it", () => {
    expect(explorationStatus({ ...row, queued_at: "2026-11-02T10:00:00Z" })).toBe("queued");
    expect(explorationStatus({ ...row, queued_at: "2026-11-02T10:00:00Z", claimed_at: "2026-11-02T10:01:00Z" })).toBe("studying");
  });

  it("uses the name a person gave, its series, its archive and its pin", () => {
    const e = explorationOf({ ...row, name: " Sign in pass ", series_id: "s0", archived_at: "2026-11-03T00:00:00Z", pinned_at: "2026-11-03T00:00:00Z", notes: "Again" }, { findings: [], walks: [] });
    expect(e).toMatchObject({ name: "Sign in pass", name_is_custom: true, series_id: "s0", archived_at: "2026-11-03T00:00:00Z", pinned_at: "2026-11-03T00:00:00Z", description: "Again" });
  });

  it("scores what was measured for sure under its lens, and leaves out what needs a look", () => {
    const m = (id: string, confident: boolean) => ({ id, session_id: "s1", fingerprint: id, kind: "low_contrast", severity: "major", summary: id, measured: 2, threshold: 4.5, unit: ":1", rect: null, element_label: null, element_identifier: null, appearance: null, confident, extra: {}, screen_key: "Home", screen_hash: null, frame_id: null, step_seq: 2, created_at: "" });
    const e = explorationOf({ ...row, status: "done", ended_at: "2026-11-02T10:20:00Z" }, { findings: [], walks: [], measured: [m("a", true), m("b", false)] });
    expect(e.lenses).toContain("accessible");
    expect(e.result?.findings.map((f) => [f.fingerprint, f.source, f.lens])).toEqual([["a", "measured", "accessible"]]);
  });

  it("a finding keeps its lens, and always has a fix prompt", () => {
    const f = { id: "f1", session_id: "s1", title: "Save does nothing", severity: "minor", lens: "usable", expected: "It saves", actual: "Nothing", detail: null, screen_key: "Form", status: "open", frame_ids: [] } as never;
    expect(resultFindingOf(f, []).lens).toBe("usable");
    expect(findingOf(f, 1, "ios").fix_prompt).toContain("Save does nothing");
    expect(findingOf({ ...(f as object), fix_prompt: "Wire the button" } as never, 1).fix_prompt).toBe("Wire the button");
  });
});
