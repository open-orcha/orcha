/**
 * Parity round 2 — integration-owner cross-file follow-ups:
 *   - the request read-model maps the backend's new close columns
 *     (closed_by_alias / close_decision) into closed_by / close_reason;
 *   - Overview "Updates" credits a pre-escalation answer to the agent that gave
 *     it (same rule as Activity › Events, pages/activity/events.ts);
 *   - the Tasks activity names the verifier on "[verification …]" lines now the
 *     backend attributes them (parseThreadMarker verify_approved);
 *   - the sidebar can nest ANOTHER project's working agents from
 *     GET /api/containers `live_agents` (remoteProjectAgents);
 *   - reviewFor names the reviewer by alias, like every other chip.
 */
import { describe, expect, it } from "vitest";
import { mapSnapshot } from "./api/client";
import { activityEvents } from "./pages/home/HomePage";
import { parseThreadMarker } from "./pages/tasks/TaskDetail";
import { remoteProjectAgents } from "./shell/liveAgents";
import { reviewFor } from "./lib/reviewer";
import type { Agent, OrchaRequest } from "./types";

const AGENTS = [
  { id: "h1", alias: "hussein", kind: "human", status: "idle" },
  { id: "a1", alias: "lead", kind: "ai", status: "idle" },
  { id: "a2", alias: "backend-dev", kind: "ai", status: "idle" },
];

describe("request close fields (backend REQUEST_CLOSE_COLUMNS)", () => {
  const raw = (extra: Record<string, unknown>) => ({
    container: { id: "c1", name: "p" },
    agents: AGENTS,
    tasks: [],
    requests: [{ id: "r1", type: "info", status: "closed", requester_id: "a1", target_id: "h1", payload: { q: "x" }, created_at: "2026-09-01T00:00:00Z", ...extra }],
  });

  it("maps closer, reason and time from a json object", () => {
    const r = mapSnapshot(raw({ closed_by_alias: "hussein", close_decision: { reason: "Duplicate of the auth task", actor: "hussein", at: "2026-09-02T00:00:00Z" } })).requests[0];
    expect(r.closed_by).toBe("hussein");
    expect(r.close_reason).toBe("Duplicate of the auth task");
    expect(r.closed_at).toBe("2026-09-02T00:00:00Z");
  });

  it("accepts a json string and falls back to the decision actor", () => {
    const r = mapSnapshot(raw({ closed_by_alias: null, close_decision: JSON.stringify({ reason: "  done  ", actor: "lead", at: null }) })).requests[0];
    expect(r.closed_by).toBe("lead");
    expect(r.close_reason).toBe("done");
  });

  it("is all-null on an old backend", () => {
    const r = mapSnapshot(raw({})).requests[0];
    expect([r.closed_by, r.close_reason, r.closed_at]).toEqual([null, null, null]);
  });
});

describe("Overview updates: answer credit across an escalation", () => {
  const base: OrchaRequest = {
    id: "r1", type: "task", status: "answered", priority: null, requester_id: "a1", target_id: "h1",
    from: "lead", to: "hussein", payload: { title: "Ship it" }, response: { ok: true }, rejection_reason: null,
    in_service_of: null, chain_depth: 0, task_link: null, escalated: true, escalated_at: "2026-09-01T02:00:00Z",
    escalated_from: "backend-dev", created_at: "2026-09-01T00:00:00Z", responded_at: "2026-09-01T01:00:00Z", expires_at: null,
  };
  const answerWho = (r: OrchaRequest) => activityEvents([], [r]).find((e) => e.kind === "answer")?.who;

  it("an answer given BEFORE the escalation belongs to the agent", () => {
    expect(answerWho(base)).toBe("backend-dev");
  });
  it("an answer given AFTER the escalation belongs to the human", () => {
    expect(answerWho({ ...base, responded_at: "2026-09-01T03:00:00Z" })).toBe("hussein");
  });
  it("a request never escalated credits its target", () => {
    expect(answerWho({ ...base, escalated: false, escalated_from: null, escalated_at: null })).toBe("hussein");
  });
});

describe("verification markers", () => {
  it("parses the approved marker the backend now attributes", () => {
    expect(parseThreadMarker("[verification approved] Looks great")).toEqual({ kind: "verify_approved", feedback: "Looks great" });
  });
  it("still parses the rejected marker", () => {
    expect(parseThreadMarker("[verification rejected] Tests fail")).toEqual({ kind: "verify_rejected", feedback: "Tests fail" });
  });
});

describe("remoteProjectAgents (GET /api/containers live_agents)", () => {
  it("builds rows from the list, working and review, with the server total as `more`", () => {
    const { rows, more } = remoteProjectAgents(
      [
        { alias: "lead", status: "working", task_title: "Wire auth", started_at: "2026-09-01T00:00:00Z", last_active: "2026-09-01T00:01:00Z" },
        { alias: "qa-bot", status: "awaiting_request", task_title: null, started_at: null, last_active: null },
      ],
      5,
    );
    expect(rows.map((r) => [r.alias, r.state, r.fragment])).toEqual([
      ["lead", "working", "Wire auth"],
      // VD-09: awaiting_request is the roster's neutral "waiting", never "needs review"
      ["qa-bot", "working", "waiting"],
    ]);
    expect(rows[0].agent.active_run?.task_title).toBe("Wire auth");
    expect(more).toBe(3);
  });
  it("is empty for an old backend without the field", () => {
    expect(remoteProjectAgents(undefined, undefined)).toEqual({ rows: [], more: 0 });
  });
  it("respects the cap", () => {
    const list = ["a", "b", "c", "d"].map((alias) => ({ alias, status: "working" }));
    const out = remoteProjectAgents(list, 4, 3);
    expect(out.rows).toHaveLength(3);
    expect(out.more).toBe(1);
  });
});

describe("reviewFor names the reviewer by alias", () => {
  it("returns the alias, not the GitHub login", () => {
    const h = { id: "h1", alias: "amina", kind: "human", member_role: "member" } as unknown as Agent;
    expect(reviewFor({ reviewer: { alias: "sam", github_login: "sam-gh" }, reviewer_agent_id: "h2" }, h)).toBe("sam");
  });
});
