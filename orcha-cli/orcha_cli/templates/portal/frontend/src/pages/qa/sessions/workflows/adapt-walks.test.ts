import { describe, expect, it } from "vitest";
import type { QaFlow, QaWalk, SessionDetail } from "../../qaApi";
import { walksPayloadOf } from "./adapt-walks";
import { currentWalk, unwalkedQueue, walkFindingsOf, walkHeadline, walkPosition } from "./workflows";

const flow = (id: string, over: Partial<QaFlow> = {}): QaFlow => ({ id, platform: "ios", key: id, name: `Flow ${id}`, persona: "A parent", criticality: "medium", status: "queued", steps: [{ text: "Open" }, { text: "Save" }], created_at: "2026-11-01T00:00:00Z", ...over });
const walk = (over: Partial<QaWalk>): QaWalk => ({ id: "w1", session_id: "s1", flow_id: "a", status: "walking", blocked_kind: null, reason: null, steps: [], scenario_id: null, started_at: "2026-11-02T00:00:00Z", ended_at: null, ...over });
const detail = (over: Partial<SessionDetail["session"]>, walks: QaWalk[] = [], findings: SessionDetail["findings"] = []): SessionDetail => ({
  session: { id: "s1", kind: "explore", platform: "ios", task_id: null, agent_id: null, device_name: null, app_id: null, status: "running", budget_minutes: 10, goal: null, report_md: null, started_at: "2026-11-02T00:00:00Z", ended_at: null, last_seen_at: null, ...over },
  walks,
  findings,
  steps_count: 0,
  drafts: [],
  verdicts: [],
});

describe("walksPayloadOf", () => {
  it("numbers a walk's steps from 1 and ranks the queue as it stands", () => {
    const step = { index: 0, text: "Open", reached: true, result: "ok", checked: ["Home shown"], finding_id: null, frame_id: "fr1", seq: 3, screen_key: "Home", at: null };
    const d = detail({}, [walk({ steps: [step] as never })]);
    const p = walksPayloadOf(d, [flow("a", { status: "walking", criticality: "high" }), flow("b", { rank_reasons: ["never walked"] })]);
    expect(p.flows.map((f) => [f.rank, f.criticality])).toEqual([[1, "high"], [2, "normal"]]);
    const w = currentWalk(p.walks);
    expect(w?.steps[0]).toMatchObject({ index: 1, frame: "fr1", screen_id: "Home", checked: ["Home shown"] });
    expect(walkHeadline(p.flows[0].name, walkPosition(p.flows[0], w as NonNullable<typeof w>))).toBe("Walking: Flow a, step 2 of 2");
  });

  it("finds a walk's finding by its id and by the number on its step", () => {
    const f = { id: "fd1", title: "Save does nothing", severity: "trivial" } as SessionDetail["findings"][number];
    const step = { index: 1, text: "Save", reached: false, result: "no", checked: [], finding_id: "fd1", frame_id: null, seq: null, screen_key: null, at: null };
    const d = detail({ status: "done", ended_at: "2026-11-03T00:00:00Z" }, [walk({ status: "failed", steps: [step] as never, finding_ids: ["fd1"] })], [f]);
    const p = walksPayloadOf(d, [flow("a")]);
    expect(walkFindingsOf(p.walks[0], p.findings).found.map((x) => x.title)).toEqual(["Save does nothing"]);
    expect(p.findings.fd1.severity).toBe("cosmetic");
  });

  it("an ended session speaks only for the flows queued before it ended, as it left them", () => {
    const d = detail({ status: "done", ended_at: "2026-11-03T00:00:00Z" }, [walk({ flow_id: "a", status: "abandoned" })]);
    const p = walksPayloadOf(d, [flow("a", { status: "passed" }), flow("b", { status: "passed" }), flow("late", { created_at: "2026-11-04T00:00:00Z" })]);
    expect(p.flows.map((f) => [f.flow_key, f.status])).toEqual([["a", "queued"], ["b", "queued"]]);
    expect(unwalkedQueue(p.flows, p.walks, false, p.explorer_joined)).toEqual({ waiting: 2, stopped: 1, joined: true });
  });

  it("keeps a walk whose flow the queue no longer lists", () => {
    const p = walksPayloadOf(detail({}, [walk({ flow_id: "gone", flow_name: "Old flow" })]), []);
    expect(p.flows.map((f) => f.name)).toEqual(["Old flow"]);
  });
});
