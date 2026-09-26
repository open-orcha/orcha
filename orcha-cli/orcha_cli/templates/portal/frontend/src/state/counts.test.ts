/**
 * Authoritative sidebar counts (GH count-mismatch fix): the Shell's
 * Tasks/Requests nav counts and the attn-card prefer the snapshot's
 * task_open_total / request_open_total when non-null; open backends omit them
 * (mapped to null) and the counts fall back to today's list-computed values.
 */
import { describe, expect, it } from "vitest";
import { mapSnapshot } from "../api/client";
import { attnCardCounts, attnItems, navCounts } from "./SnapshotProvider";

const AGENTS = [
  { id: "h", alias: "kedar", kind: "human", status: "idle" },
  { id: "a", alias: "Frame", kind: "ai", status: "working" },
];
const RAW = {
  container: { id: "c", status: "active", autonomy_level: "plan" },
  agents: AGENTS,
  tasks: [
    { id: "t1", title: "V", status: "needs_verification", assignees: ["Frame"] },
    { id: "t2", title: "W", status: "in_progress", assignees: ["Frame"] },
  ],
  requests: [
    { id: "r1", type: "info", status: "open", requester_id: "a", target_id: null },
    { id: "r2", type: "info", status: "closed", requester_id: "a", target_id: null },
  ],
};

describe("navCounts", () => {
  it("open backend (totals absent → null): falls back to computed counts", () => {
    const snap = mapSnapshot(RAW);
    expect(snap.task_open_total).toBeNull();
    expect(navCounts(snap)).toEqual({ tasks: 1, requests: 1 }); // 1 needs_verification, 1 open
  });

  it("prefers authoritative totals when non-null", () => {
    const snap = mapSnapshot({ ...RAW, task_open_total: 12, request_open_total: 5 });
    expect(navCounts(snap)).toEqual({ tasks: 12, requests: 5 });
  });

  it("a total of 0 is authoritative (non-null), not a falsy fallback", () => {
    const snap = mapSnapshot({ ...RAW, task_open_total: 0, request_open_total: 0 });
    expect(navCounts(snap)).toEqual({ tasks: 0, requests: 0 });
  });

  it("null snapshot → zeros", () => {
    expect(navCounts(null)).toEqual({ tasks: 0, requests: 0 });
  });
});

describe("attnCardCounts", () => {
  it("open backend: identical to today's attnItems-derived card numbers", () => {
    const snap = mapSnapshot(RAW);
    const a = attnItems(snap);
    const c = attnCardCounts(snap, a);
    expect(c.verify).toBe(a.verifs.length);
    expect(c.esc).toBe(a.escs.length);
    expect(c.total).toBe(a.count);
  });

  it("prefers authoritative totals when non-null", () => {
    const snap = mapSnapshot({ ...RAW, task_open_total: 7, request_open_total: 3 });
    const a = attnItems(snap);
    const c = attnCardCounts(snap, a);
    expect(c.verify).toBe(7);
    expect(c.esc).toBe(3);
    expect(c.total).toBe(a.plans.length + 7 + 3);
  });
});
