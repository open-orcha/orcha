/**
 * mapSnapshot mapping fidelity — Vitest port of the node-harness cases that
 * lived in tests/test_d1_data_adapter.py (pre-D7 fallbacks + D7 enriched
 * shapes). Complements foundation.test.ts, which spot-checks the same adapter.
 */
import { describe, expect, it } from "vitest";
import { mapSnapshot, mapThread } from "./client";

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

describe("mapSnapshot — request detail passthrough (PI-10)", () => {
  const base = { container: { id: "c" }, agents: [], tasks: [] };
  it("keeps the backend detail object unchanged", () => {
    const d = { proposed_alias: "mira", reason: "needs a designer" };
    const s = mapSnapshot({ ...base, requests: [{ id: "r1", type: "roster", status: "open", detail: d }] } as any);
    expect(s.requests[0].detail).toEqual(d);
  });
  it("missing or non-object detail -> null (never invented)", () => {
    const s = mapSnapshot({ ...base, requests: [{ id: "r1", status: "open" }, { id: "r2", status: "open", detail: "x" }] } as any);
    expect(s.requests[0].detail).toBeNull();
    expect(s.requests[1].detail).toBeNull();
  });
});

describe("mapSnapshot — current_task never the root objective (screen review: live agents)", () => {
  const base = {
    container: { id: "c1" },
    tasks: [
      { id: "root", title: "Ship the Orcha V2 portal", status: "in_progress", is_root: true, assignees: ["lead"] },
      { id: "t9", title: "Fix race in wake scheduler", status: "in_progress", assignees: ["lead"] },
    ],
    requests: [],
  };
  it("a backend current_task pointing at the root task yields to the active run's task", () => {
    const m = mapSnapshot({
      ...base,
      agents: [{
        id: "a1", alias: "lead", kind: "ai", status: "working",
        current_task: { task_id: "root", title: "Ship the Orcha V2 portal" },
        active_run: { run_id: "r1", task_id: "t9", task_title: "Fix race in wake scheduler" },
      }],
    });
    expect(m.agents[0].current_task).toEqual({ task_id: "t9", title: "Fix race in wake scheduler" });
  });
  it("the derived fallback skips is_root tasks", () => {
    const m = mapSnapshot({ ...base, agents: [{ id: "a1", alias: "lead", kind: "ai", status: "working" }] });
    expect(m.agents[0].current_task?.task_id).toBe("t9");
  });
  it("an agent only on the root task has no current task", () => {
    const m = mapSnapshot({ ...base, tasks: [base.tasks[0]], agents: [{ id: "a1", alias: "lead", kind: "ai", status: "idle" }] });
    expect(m.agents[0].current_task).toBeNull();
  });
});

describe("mapThread — named authors, never a bare dash", () => {
  const msg = (o: Record<string, unknown>) => ({ message_id: "m", body: "b", created_at: "t", ...o });
  it("a human message resolves to the author's alias, or the project's only human", () => {
    const agents = [{ id: "h1", alias: "hussein", kind: "human" }, { id: "a1", alias: "Frame", kind: "ai" }] as never;
    expect(mapThread([msg({ is_human: true, author_id: "h1" })], agents)[0].from).toBe("hussein");
    expect(mapThread([msg({ is_human: true, author_id: null })], agents)[0].from).toBe("hussein");
  });
  it("several humans and no author → the generic 'human' (never a guess)", () => {
    const agents = [{ id: "h1", alias: "a", kind: "human" }, { id: "h2", alias: "b", kind: "human" }] as never;
    expect(mapThread([msg({ is_human: true, author_id: null })], agents)[0].from).toBe("human");
  });
  it("an agent author that no longer resolves reads 'unknown agent'; no author is 'system'", () => {
    expect(mapThread([msg({ is_human: false, author_id: "gone" })], [])[0].from).toBe("unknown agent");
    expect(mapThread([msg({ is_human: false, author_id: null })], [])[0].from).toBe("system");
  });
});

describe("UR-08 — requests from/to a retired agent", () => {
  const base = {
    container: { id: "c1", name: "Orcha", status: "active" },
    agents: [
      { id: "h1", alias: "owner", kind: "human", status: "idle" },
      { id: "a1", alias: "Vizzy", kind: "ai", status: "idle" },
    ],
    tasks: [],
  };
  it("an id missing from the roster reads 'retired agent', never 'human'", () => {
    const m = mapSnapshot({
      ...base,
      requests: [{ id: "r1", type: "task", status: "open", requester_id: "gone", target_id: "gone2", payload: "x" }],
    });
    expect(m.requests[0].from).toBe("retired agent");
    expect(m.requests[0].to).toBe("retired agent");
  });
  it("prefers the backend's joined aliases when present", () => {
    const m = mapSnapshot({
      ...base,
      requests: [{ id: "r1", type: "task", status: "open", requester_id: "gone", requester_alias: "Orbit", target_id: "a1", payload: "x" }],
    });
    expect(m.requests[0].from).toBe("Orbit");
    expect(m.requests[0].to).toBe("Vizzy");
  });
  it("a null target is still the human lane", () => {
    const m = mapSnapshot({ ...base, requests: [{ id: "r1", type: "info", status: "open", requester_id: "a1", target_id: null, payload: "x" }] });
    expect(m.requests[0].to).toBe("human");
  });
});
