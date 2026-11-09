import { describe, expect, it } from "vitest";
import type { RunDoc } from "./api";
import { frameAt, playbackTimes } from "./replay/run-video";
import { resultsOf, stepsOf, theaterOf } from "./adapt";

const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 10, 0, s)).toISOString();
const session = { id: "s1", kind: "check", platform: "ios", task_id: null, agent_id: "a", device_name: "iPhone 17 Pro", app_id: "com.acme", status: "done", budget_minutes: null, goal: null, report_md: null, started_at: at(0), ended_at: at(30), last_seen_at: at(30) };
const step = (seq: number, kind: string, args: Record<string, unknown>, s: number, frame: string | null = null) => ({ seq, kind, args, result: "ok", screen_key: null, screen_hash: null, frame_id: frame, at: at(s) });
const scenario = { id: "sc1", name: "Sign in", category: "Auth", persona: null, description: null, criteria: ["Form opens", "Home shows"], tags: null, platform: "ios", source: null, status: "validated", status_reason: null, walk_id: null, session_id: null, task_id: null, created_at: null, updated_at: null };
const verdict = (i: number, v: string, n: string | null = null) => ({ id: `v${i}`, session_id: "s1", scenario_id: "sc1", criterion_index: i, verdict: v, note: n, frame_ids: [`f${i}`], created_at: at(i) });
const doc = (over: Partial<RunDoc> = {}) => ({
  session,
  walks: [],
  findings: [],
  steps_count: 5,
  drafts: [],
  verdicts: [verdict(0, "pass"), verdict(1, "fail", "It stayed on the form")],
  steps: [step(1, "screen", { title: "Sign in" }, 1, "f0"), step(2, "note", { verdict: "pass", scenario_id: "sc1", criterion_index: 0 }, 2, "f0"), step(3, "tap", {}, 3), step(4, "screen", { title: "Sign in" }, 4, "f1"), step(5, "note", { verdict: "fail", scenario_id: "sc1", criterion_index: 1 }, 5, "f1")],
  logs: [],
  scenarios: [scenario],
  feedback: [],
  ...over,
}) as unknown as RunDoc;

describe("the run document", () => {
  it("never lets a passing Examples row hide a failing one", () => {
    const sc = { id: "s1", name: "Budget", criteria: ["Shows the filter"] };
    const v = (id: string, example_row: number, verdict: string) => ({ id, session_id: "r", scenario_id: "s1", criterion_index: 0, example_row, verdict, note: id, frame_ids: [], created_at: id });
    const doc = { session: { id: "r", status: "done" }, scenarios: [sc], steps: [], verdicts: [v("a", 0, "fail"), v("b", 1, "pass")] } as unknown as Parameters<typeof resultsOf>[0];
    const [row] = resultsOf(doc, [], new Map());
    expect(row.outcome).toBe("fail");
  });

  it("a run in line says Waiting and claims no device until it holds one", () => {
    const queued = theaterOf(doc({ verdicts: [], session: { ...session, status: "running", ended_at: null, queued_at: at(0), claimed_at: null } as never }));
    expect(queued.header.verdictResult).toBe("Waiting");
    expect(queued.header.deviceLabel).toBeNull();
    const holding = theaterOf(doc({ verdicts: [], session: { ...session, status: "running", ended_at: null, queued_at: at(0), claimed_at: at(1) } as never }));
    expect(holding.header.verdictResult).not.toBe("Waiting");
    expect(holding.header.deviceLabel).toBe("iPhone 17 Pro");
  });

  it("times each step from the session's start and keeps one frame per screen", () => {
    const steps = stepsOf(doc().steps, at(0));
    expect(steps.map((s) => s.at_ms)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(steps.filter((s) => s.frame_path).map((s) => s.seq)).toEqual([1, 4]);
  });

  it("rolls verdicts up by scenario, the newest per criterion, each spanning its own steps", () => {
    const t = theaterOf(doc({ verdicts: [verdict(0, "fail", "no"), verdict(0, "pass"), verdict(1, "fail", "It stayed on the form")] as never }));
    const [r] = t.detail.scenarioResults;
    expect(r.outcome).toBe("fail");
    const items = r.criteria as { outcome: string; from_step: number; to_step: number; actual?: string }[];
    expect(items.map((c) => c.outcome)).toEqual(["pass", "fail"]);
    expect(items[1].actual).toBe("It stayed on the form");
    expect(items[0].to_step).toBeLessThan(items[1].to_step);
  });

  it("leaves a scenario out of a finished run when it has no verdict, and keeps it while running", () => {
    const quiet = doc({ verdicts: [] });
    expect(resultsOf(quiet, [], new Map())).toEqual([]);
    const live = doc({ verdicts: [], session: { ...session, status: "running", ended_at: null } as never });
    const rows = resultsOf(live, [], new Map());
    expect(rows[0].outcome).toBe("running");
    expect((rows[0].criteria as { outcome: string | null }[]).map((c) => c.outcome)).toEqual(["running", null]);
  });

  it("does not call a scenario passed when a criterion was never reported", () => {
    const t = theaterOf(doc({ verdicts: [verdict(0, "pass")] as never }));
    expect(t.detail.scenarioResults[0].outcome).toBe("inconclusive");
  });

  it("shows no scenarios tab default on an exploration, and counts open findings only", () => {
    const f = { id: "f1", session_id: "s1", task_id: null, severity: "major", title: "Crash", detail: null, expected: "ok", actual: "crash", frame_ids: ["f1"], screen_key: "Home", status: "open", filed_task_id: null, created_at: at(1) };
    const t = theaterOf(doc({ session: { ...session, kind: "explore" } as never, verdicts: [], scenarios: [], findings: [f, { ...f, id: "f2", status: "dismissed" }] as never }));
    expect(t.defaultTab).toBe("steps");
    expect(t.detail.run.mode).toBe("exploratory");
    expect(t.detail.run.counts).toEqual({ major: 1 });
    expect(t.detail.findings[0].fix_prompt).toContain("Expected: ok");
  });

  it("explains an abandoned run in place of the live state", () => {
    const t = theaterOf(doc({ session: { ...session, status: "abandoned", result: { reason: "the tool server stopped." } } as never }));
    expect(t.abandonedReason).toBe("the tool server stopped.");
    expect(t.live).toBe(false);
    expect(t.detail.abandoned).toBe(true);
  });
});

describe("the page a step stood on", () => {
  it("is never a note's title: the address bar shows a page", () => {
    const steps = stepsOf([step(1, "note", { title: "The nav jumps taller" }, 1), step(2, "tap", { url: "http://a.test/cart" }, 2)], at(0));
    expect(steps[0].foreground).toBeNull();
    expect(steps[1].foreground).toBe("http://a.test/cart");
  });
});

describe("the frame player", () => {
  it("holds each frame for its real gap, capping long waits", () => {
    expect(playbackTimes([{ atMs: 0 }, { atMs: 1000 }, { atMs: 60000 }, { atMs: 60500 }])).toEqual([0, 1000, 4000, 4500]);
  });
  it("finds the frame on screen at a played time", () => {
    const t = [0, 1000, 4000];
    expect([0, 999, 1000, 3999, 9000].map((x) => frameAt(t, x))).toEqual([0, 0, 1, 1, 2]);
  });
});

describe("the way back", () => {
  it("links an exploration's run to it, a drafter as a drafter, and a check run to nothing", () => {
    expect(theaterOf(doc()).exploration).toBeNull();
    const explore = theaterOf(doc({ session: { ...session, kind: "explore" } as never, verdicts: [], scenarios: [] }));
    expect(explore.exploration).toMatchObject({ id: "s1", role: "explorer" });
    const draft = theaterOf(doc({ session: { ...session, kind: "draft" } as never, verdicts: [], scenarios: [] }));
    expect(draft.exploration?.role).toBe("drafter");
  });
});
