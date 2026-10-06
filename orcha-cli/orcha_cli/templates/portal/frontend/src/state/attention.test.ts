/**
 * The ONE "Needs you" definition (docs/orcha-v2-architecture.md §3):
 * plan / verify / request kinds, autonomy gating, escalated requests,
 * reviewer / other-human exclusion from the badge, truncation → partial,
 * and unknown (null) before the first snapshot.
 */
import { describe, expect, it } from "vitest";
import { mapSnapshot } from "../api/client";
import { attentionLabel, openWorkCounts, selectAttention } from "./attention";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "member" },
  { id: "h2", alias: "maya", kind: "human", status: "idle", member_role: "member" },
  { id: "a1", alias: "Atlas", kind: "ai", status: "working" },
];
const planMsg = { message_id: "m1", author_id: "a1", author_alias: "Atlas", is_human: false, body: "PLAN", created_at: "2026-09-01T10:00:00Z" };

function snap(level: string, extra: Record<string, unknown> = {}) {
  return mapSnapshot({
    container: { id: "c1", status: "active", autonomy_level: level },
    agents: AGENTS,
    tasks: [
      { id: "tp", title: "Plan me", status: "in_progress", assignees: ["Atlas"], plan_decision: null, messages: [planMsg], started_at: "2026-09-01T09:00:00Z" },
      { id: "tv", title: "Verify me", status: "needs_verification", assignees: ["Atlas"], created_at: "2026-09-02T00:00:00Z" },
      { id: "tv2", title: "Maya's review", status: "needs_verification", assignees: ["Atlas"], reviewer_agent_id: "h2", reviewer: { agent_id: "h2", alias: "maya" }, created_at: "2026-09-01T00:00:00Z" },
      { id: "tb", title: "Blocked", status: "blocked", assignees: ["Atlas"] },
      { id: "td", title: "Decided plan", status: "in_progress", assignees: ["Atlas"], plan_decision: { decision: "approve" }, messages: [planMsg] },
    ],
    requests: [
      { id: "r-open-null", type: "info", status: "open", requester_id: "a1", target_id: null, payload: { question: "Which port?" }, created_at: "2026-09-03T00:00:00Z" },
      { id: "r-open-me", type: "info", status: "open", requester_id: "a1", target_id: "h1", payload: "for kedar", created_at: "2026-09-04T00:00:00Z" },
      { id: "r-open-maya", type: "info", status: "open", requester_id: "a1", target_id: "h2", payload: "for maya", created_at: "2026-09-04T00:00:00Z" },
      { id: "r-open-ai", type: "info", status: "open", requester_id: "h1", target_id: "a1", payload: "to agent" },
      { id: "r-esc", type: "info", status: "escalated", requester_id: "a1", target_id: "a1", payload: "stuck", created_at: "2026-09-02T00:00:00Z" },
      { id: "r-ans", type: "info", status: "answered", requester_id: "h1", target_id: "a1", payload: "done?" },
    ],
    task_total: 5,
    request_total: 6,
    task_open_total: 99, // open-work totals must NOT leak into attention
    request_open_total: 42,
    ...extra,
  });
}

const keys = (a: ReturnType<typeof selectAttention>) => a.items.map((i) => i.key);

describe("selectAttention", () => {
  it("null snapshot → unknown count (null), never 0", () => {
    const a = selectAttention(null, "h1");
    expect(a.count).toBeNull();
    expect(a.items).toEqual([]);
    expect(attentionLabel(a)).toBe("");
  });

  it("plan level: plans + verifications + human-facing/escalated requests; blocked & decided are not attention", () => {
    const a = selectAttention(snap("plan"), "h1");
    expect(keys(a)).toEqual([
      "plan:tp",
      "verify:tv2", "verify:tv", // oldest first within a kind
      "request:r-esc", "request:r-open-null", "request:r-open-me", "request:r-open-maya",
    ]);
    expect(a.items.find((i) => i.key === "request:r-open-null")!.title).toBe("Which port?");
    expect(a.items.find((i) => i.key === "plan:tp")!.agentAlias).toBe("Atlas");
    expect(a.items.find((i) => i.key === "plan:tp")!.href).toBe("/tasks?task=tp");
    expect(a.items.find((i) => i.key === "request:r-esc")!.href).toBe("/requests?req=r-esc");
  });

  it("badge counts unique entities and excludes items assigned to another human", () => {
    const a = selectAttention(snap("plan"), "h1");
    const other = a.items.filter((i) => i.assignedToOther).map((i) => i.key);
    expect(other.sort()).toEqual(["request:r-open-maya", "verify:tv2"]);
    expect(a.count).toBe(5); // tp, tv, r-esc, r-open-null, r-open-me
  });

  it("the other human sees the mirror image", () => {
    const a = selectAttention(snap("plan"), "h2");
    expect(a.items.filter((i) => i.assignedToOther).map((i) => i.key).sort()).toEqual(["request:r-open-me"]);
    expect(a.count).toBe(6);
  });

  it("owners see every review normally (lib/reviewer rule)", () => {
    const s = snap("plan");
    s.agents.find((x) => x.id === "h1")!.member_role = "owner";
    const a = selectAttention(s, "h1");
    expect(a.items.find((i) => i.key === "verify:tv2")!.assignedToOther).toBe(false);
  });

  it("pr level: no plan approvals (agents proceed); verifications still gate", () => {
    const a = selectAttention(snap("pr"), "h1");
    expect(keys(a).some((k) => k.startsWith("plan:"))).toBe(false);
    expect(keys(a)).toContain("verify:tv");
  });

  it("full level: neither plans nor verifications; requests still need a human", () => {
    const a = selectAttention(snap("full"), "h1");
    expect(keys(a).every((k) => k.startsWith("request:"))).toBe(true);
    expect(a.count).toBe(3);
  });

  it("escalated requests count even when targeted at an agent (GAP-04)", () => {
    expect(keys(selectAttention(snap("plan"), "h1"))).toContain("request:r-esc");
  });

  it("answered requests the acting human asked are follow-ups, not badge items", () => {
    const a = selectAttention(snap("plan"), "h1");
    expect(a.followUps.map((r) => r.id)).toEqual(["r-ans"]);
    expect(keys(a)).not.toContain("request:r-ans");
  });

  it("partial when the server totals exceed the capped lists", () => {
    expect(selectAttention(snap("plan"), "h1").partial).toBe(false);
    const a = selectAttention(snap("plan", { task_total: 1500 }), "h1");
    expect(a.partial).toBe(true);
    expect(attentionLabel(a)).toBe("5+");
    expect(selectAttention(snap("plan", { request_total: 2000 }), "h1").partial).toBe(true);
  });

  it("no acting human: items with an assigned human are someone else's", () => {
    const a = selectAttention(snap("plan"), null);
    expect(a.items.find((i) => i.key === "verify:tv2")!.assignedToOther).toBe(true);
    expect(a.items.find((i) => i.key === "request:r-open-me")!.assignedToOther).toBe(true);
    expect(a.items.find((i) => i.key === "verify:tv")!.assignedToOther).toBe(false);
  });

  it("items carry the project cid for cross-page consumers", () => {
    expect(selectAttention(snap("plan"), "h1").items.every((i) => i.projectCid === "c1")).toBe(true);
  });
});

describe("openWorkCounts (nav counts ≠ attention)", () => {
  it("authoritative open totals win", () => {
    expect(openWorkCounts(snap("plan"))).toEqual({ tasks: 99, requests: 42 });
  });
  it("old backends fall back to non-terminal tasks / open requests", () => {
    const s = snap("plan", { task_open_total: null, request_open_total: null });
    expect(openWorkCounts(s)).toEqual({ tasks: 5, requests: 4 });
  });
  it("the fallback never counts the project's root task (parity r2)", () => {
    const s = snap("plan", { task_open_total: null, request_open_total: null });
    const withRoot = { ...s, tasks: [...(s.tasks ?? []), { ...(s.tasks ?? [])[0], id: "root", is_root: true, status: "in_progress" }] } as typeof s;
    expect(openWorkCounts(withRoot).tasks).toBe(5);
  });
  it("unknown before the first snapshot", () => {
    expect(openWorkCounts(null)).toEqual({ tasks: null, requests: null });
  });
});

describe("request titles are human-readable (D4)", () => {
  const withPayload = (payload: unknown, type = "info") => mapSnapshot({
    container: { id: "c1", autonomy_level: "plan" },
    agents: AGENTS,
    tasks: [],
    requests: [{ id: "r1", type, status: "open", requester_id: "a1", target_id: null, payload }],
  });
  const title = (p: unknown, type?: string) => selectAttention(withPayload(p, type), "h1").items[0].title;
  it("uses summary/question/title fields, never JSON", () => {
    expect(title({ question: "Which port?" })).toBe("Which port?");
    expect(title('{"summary":"API shape for /metrics"}')).toBe("API shape for /metrics");
    expect(title({ foo: 1 })).not.toMatch(/[{}]/);
  });
  it("falls back to the humanised request type", () => {
    expect(title(null, "plan_review")).toBe("Plan review request");
    expect(title({ n: 1 }, "info")).toBe("Info request");
  });
});
