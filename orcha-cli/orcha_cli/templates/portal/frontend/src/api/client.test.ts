/**
 * mapSnapshot mapping fidelity — Vitest port of the node-harness cases that
 * lived in tests/test_d1_data_adapter.py (pre-D7 fallbacks + D7 enriched
 * shapes). Complements foundation.test.ts, which spot-checks the same adapter.
 */
import { describe, expect, it } from "vitest";
import { mapSnapshot } from "./client";

describe("mapSnapshot — real shape with pre-D7 fallbacks", () => {
  const m = mapSnapshot({
    container: { id: "c1", name: "Orcha", status: "active" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "Frame", kind: "ai", status: "working" },
    ],
    tasks: [
      {
        id: "t1", title: "X", status: "in_progress", priority: 50, assignees: ["Frame"], created_by_agent_id: "h1",
        messages: [{ message_id: "m1", author_id: "a1", author_alias: "Frame", is_human: false, body: "plan", created_at: "t" }],
      },
      { id: "t2", title: "Y", status: "needs_verification", priority: 20, assignees: ["Frame"] },
    ],
    requests: [
      {
        id: "r1", type: "info", requester_id: "a1", target_id: null, status: "open",
        priority: 30, payload: "q", parent_request_id: null, chain_depth: 0, spawned_task_id: "t1",
      },
    ],
  });

  it("maps agents byAlias and the first assignee", () => {
    expect(m.agents.length).toBe(2);
    expect(m.byAlias["kedar"].kind).toBe("human");
    expect(m.tasks[0].assignee).toBe("Frame");
  });
  it("missing model -> null (the page shows —)", () => {
    expect(m.agents[0].model).toBeNull();
  });
  it("plan/runs fall back with no D7 dependency", () => {
    expect(m.tasks[0].plan_decision).toBeNull();
    expect(Array.isArray(m.tasks[0].runs)).toBe(true);
    expect(m.tasks[0].runs_summary).toBeNull();
  });
  it("maps the thread and request endpoints to aliases", () => {
    expect(m.tasks[0].thread[0].from).toBe("Frame");
    expect(m.requests[0].from).toBe("Frame");
  });
  it("a null request target resolves to the human", () => {
    expect(m.requests[0].to).toBe("human");
  });
  it("pre-D7 minimal task_link {task_id} from spawned_task_id; no chain parent -> null", () => {
    expect(m.requests[0].task_link?.task_id).toBe("t1");
    expect(m.requests[0].in_service_of).toBeNull();
  });
  it("keeps the raw requester/target ids the shell classifies by (D1 review P2)", () => {
    expect(m.requests[0].requester_id).toBe("a1");
    expect(m.requests[0].target_id).toBeNull();
  });
  it("derives current_task from the in_progress assignment", () => {
    expect(m.agents.find((a) => a.alias === "Frame")?.current_task?.task_id).toBe("t1");
  });
});

describe("mapSnapshot — consumes the D7 enriched shapes", () => {
  // D7 (PR #74): agent current_task = {task_id,title}, task plan_decision object
  // + runs SUMMARY {count,latest} (not an array), request task_link resolved.
  const m = mapSnapshot({
    container: { id: "c1", status: "active" },
    agents: [
      {
        id: "a1", alias: "Frame", kind: "ai", status: "working", model: "claude-opus-4-8",
        wake_enabled: true, last_active: "t", prompt_preview: "You are Frame, frontend engineer",
        current_task: { task_id: "t1", title: "X" },
      },
    ],
    tasks: [
      {
        id: "t1", title: "X", status: "in_progress", priority: 50, assignees: ["Frame"],
        plan_decision: { decision: "approve", reason: "go", actor: "kedar", at: "t" },
        runs: { count: 3, latest: { status: "exited", exit_code: 0, started_at: "t", ended_at: "t" } },
      },
    ],
    requests: [
      {
        id: "r1", type: "info", requester_id: "a1", target_id: null, status: "open", priority: 30,
        payload: "q", spawned_task_id: "t1", task_link: { task_id: "t1", title: "X", status: "in_progress" },
      },
    ],
  });

  it("passes the resolved current_task through", () => {
    expect(m.agents[0].current_task?.task_id).toBe("t1");
    expect(m.agents[0].current_task?.title).toBe("X");
  });
  it("surfaces the plan_decision object (ISS-41 suppress)", () => {
    expect(m.tasks[0].plan_decision?.decision).toBe("approve");
    expect(m.tasks[0].plan_decision?.reason).toBe("go");
  });
  it("never mistakes the runs SUMMARY for the per-run array", () => {
    expect(Array.isArray(m.tasks[0].runs)).toBe(true);
    expect(m.tasks[0].runs.length).toBe(0);
    expect(m.tasks[0].runs_summary?.count).toBe(3);
    expect(m.tasks[0].runs_summary?.latest?.status).toBe("exited");
  });
  it("prefers D7's resolved task_link object", () => {
    expect(m.requests[0].task_link?.title).toBe("X");
    expect(m.requests[0].task_link?.status).toBe("in_progress");
  });
  it("carries model, wake_enabled and prompt_preview (#81, D3 persona)", () => {
    expect(m.agents[0].model).toBe("claude-opus-4-8");
    expect(m.agents[0].wake_enabled).toBe(true);
    expect(m.agents[0].prompt_preview).toBe("You are Frame, frontend engineer");
  });
});
