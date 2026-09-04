/**
 * Snapshot-derived helpers (SnapshotProvider) — Vitest port of the node-harness
 * cases that lived in tests/test_d0_design_system.py, test_d1_data_adapter.py,
 * test_d2_home_dashboard.py, test_d6_live_feed.py and test_b10_plan_approval.py
 * (they eval'd the vanilla app.js/data.js in node; the TS source is exercised
 * directly here, feeding real-shaped raw snapshots through mapSnapshot exactly
 * as the vanilla harnesses fed DA.mapSnapshot).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mapSnapshot } from "../api/client";
import {
  actingHuman,
  agentByAlias,
  attnItems,
  planMessageOf,
  pendingPlan,
} from "./SnapshotProvider";
import type { Task } from "../types";

const AGENTS = [
  { id: "h", alias: "kedar", kind: "human", status: "idle" },
  { id: "a", alias: "Frame", kind: "ai", status: "working" },
  { id: "b", alias: "B", kind: "ai", status: "working" },
];

const agentMsg = (body: string) => ({ message_id: "m1", author_id: "a", author_alias: "Frame", is_human: false, body, created_at: "t" });
const humanMsg = (body: string) => ({ message_id: "m2", author_id: "h", author_alias: "kedar", is_human: true, body, created_at: "t" });

beforeEach(() => localStorage.clear());

describe("attnItems (action-queue logic, D2/ISS-52)", () => {
  it("surfaces only pending, undecided, agent-authored plans — plus verifies and escalations", () => {
    const snap = mapSnapshot({
      container: { id: "c", status: "active" },
      agents: AGENTS,
      tasks: [
        // pending plan: in_progress + agent message + no plan_decision -> COUNTS
        { id: "t1", title: "X", status: "in_progress", assignees: ["Frame"], plan_decision: null, messages: [agentMsg("PLAN")] },
        // decided plan: has a plan_decision -> EXCLUDED
        { id: "t2", title: "Y", status: "in_progress", assignees: ["Frame"], plan_decision: { decision: "approve" }, messages: [agentMsg("PLAN")] },
        // in_progress but no agent plan (only a human note) -> EXCLUDED
        { id: "t3", title: "Z", status: "in_progress", assignees: ["Frame"], plan_decision: null, messages: [humanMsg("hi")] },
        // needs_verification -> verify
        { id: "t4", title: "W", status: "needs_verification", assignees: ["Frame"] },
      ],
      requests: [{ id: "r", type: "info", requester_id: "a", target_id: null, status: "open", priority: 10 }],
    });
    const aq = attnItems(snap);
    expect(aq.plans.map((t) => t.id)).toEqual(["t1"]);
    expect(aq.verifs.map((t) => t.id)).toEqual(["t4"]);
    expect(aq.escs.length).toBe(1);
    expect(aq.count).toBe(3); // 1 plan + 1 verify + 1 escalation
  });

  it("ISS-52: a freshly posted plan surfaces straight from the message-bearing snapshot", () => {
    // the snapshot as it looks right AFTER an agent posts its plan on an
    // in-progress task — no plan_decision yet.
    const snap = mapSnapshot({
      container: { id: "c1", status: "active" },
      agents: AGENTS,
      tasks: [{ id: "t1", title: "Do X", status: "in_progress", priority: 50, assignees: ["Frame"], plan_decision: null, messages: [agentMsg("PLAN: ...")] }],
      requests: [],
    });
    const aq = attnItems(snap);
    expect(aq.plans.map((t) => t.id)).toEqual(["t1"]);
    expect(aq.count).toBe(1);
  });

  it("D1 review P2: an AI→AI open request is NOT counted as a human escalation", () => {
    const count = (target_id: string | null) =>
      attnItems(
        mapSnapshot({
          container: { id: "c", status: "active" },
          agents: AGENTS,
          tasks: [],
          requests: [{ id: "r", type: "info", requester_id: "a", target_id, status: "open", priority: 10 }],
        }),
      ).count;
    expect(count("b")).toBe(0); // AI→AI is NOT a human escalation
    expect(count("h")).toBe(1); // explicit human target counts
    expect(count(null)).toBe(1); // null target (picked human) counts
  });
});

describe("acting-as is data-driven (D0 — never a hardcoded name)", () => {
  const snap = mapSnapshot({
    container: { id: "c1", name: "Orcha" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "h2", alias: "sam", kind: "human", status: "idle" },
      { id: "a1", alias: "Frame", kind: "ai", status: "working" },
    ],
    tasks: [],
    requests: [],
  });

  it("resolves the snapshot's real kind='human' agent", () => {
    expect(actingHuman(snap)?.alias).toBe("kedar");
    expect(actingHuman(snap)?.kind).toBe("human");
  });

  it("honors the persisted per-container selection", () => {
    localStorage.setItem("orcha:actingHuman:c1", "h2");
    expect(actingHuman(snap)?.alias).toBe("sam");
  });

  it("agentByAlias reads the live snapshot", () => {
    expect(agentByAlias(snap, "kedar")?.kind).toBe("human");
    expect(agentByAlias(snap, "Frame")?.kind).toBe("ai");
    expect(agentByAlias(snap, "nobody")).toBeNull();
  });
});

describe("planMessageOf / pendingPlan (B10 — the agent's OPENING plan)", () => {
  it("picks the earliest non-human message, preserving author identity for routing", () => {
    const t = {
      thread: [
        { id: "m0", is_human: true, from: "human", body: "human note", at: "t" },
        { id: "m1", is_human: false, from: "AG2", body: "PLAN: do X then Y", at: "t" },
        { id: "m2", is_human: false, from: "AG2", body: "progress update", at: "t" },
      ],
    } as unknown as Task;
    const pm = planMessageOf(t);
    expect(pm?.from).toBe("AG2");
    expect(pm?.body.startsWith("PLAN:")).toBe(true);
  });

  it("returns null when no agent message exists", () => {
    const t = { thread: [{ id: "m0", is_human: true, from: "human", body: "x", at: "t" }] } as unknown as Task;
    expect(planMessageOf(t)).toBeNull();
  });

  it("ISS-68: uses the trimmed snapshot's plan_message directly when no thread is present", () => {
    const t = { plan_message: { body: "PLAN via summary", author_alias: "AG9", at: "t" }, thread: [] } as unknown as Task;
    const pm = planMessageOf(t);
    expect(pm?.from).toBe("AG9");
    expect(pm?.body).toBe("PLAN via summary");
  });

  it("pendingPlan gates on in_progress + undecided plan_decision + an agent-authored plan", () => {
    const base = { thread: [{ id: "m", is_human: false, from: "AG2", body: "PLAN", at: "t" }] };
    expect(pendingPlan({ ...base, status: "in_progress", plan_decision: null } as unknown as Task)).toBe(true);
    expect(pendingPlan({ ...base, status: "in_progress", plan_decision: { decision: "approve" } } as unknown as Task)).toBe(false);
    expect(pendingPlan({ ...base, status: "needs_verification", plan_decision: null } as unknown as Task)).toBe(false);
    expect(pendingPlan({ status: "in_progress", plan_decision: null, thread: [] } as unknown as Task)).toBe(false);
  });
});
