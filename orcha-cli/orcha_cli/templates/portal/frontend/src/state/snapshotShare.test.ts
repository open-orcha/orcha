/**
 * Structural sharing across snapshot polls: an idle poll (same content, fresh JSON) must
 * hand consumers the SAME arrays/rows so identity-memoized components (conversation
 * Bubbles, StreamText) skip their render; a changed row gets a fresh identity, and so does
 * the list that contains it — while its unchanged siblings keep theirs.
 */
import { describe, expect, it } from "vitest";
import { mapSnapshot } from "../api/client";
import { jsonEqual, shareList, shareSnapshot } from "./SnapshotProvider";

const raw = () => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "atlas", kind: "ai", role: "Architect", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
  ],
  tasks: [
    { id: "t1", title: "One", status: "open", priority: "p2", assignees: ["atlas"], thread: [{ body: "hi", is_human: true }] },
    { id: "t2", title: "Two", status: "in_progress", priority: "p1", assignees: [] },
  ],
  requests: [{ id: "r1", status: "open", title: "Approve?" }],
});

describe("jsonEqual", () => {
  it("compares JSON-shaped values deeply", () => {
    expect(jsonEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(jsonEqual({ a: [1, { b: null }] }, { a: [1, { b: 0 }] })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});

describe("shareList", () => {
  it("returns the previous array when every row is content-equal and in order", () => {
    const prev = [{ id: 1, v: "a" }, { id: 2, v: "b" }];
    expect(shareList(prev, [{ id: 1, v: "a" }, { id: 2, v: "b" }])).toBe(prev);
  });
  it("keeps unchanged rows and gives changed / new rows (and the list) a fresh identity", () => {
    const prev = [{ id: 1, v: "a" }, { id: 2, v: "b" }];
    const changed = { id: 2, v: "B" };
    const added = { id: 3, v: "c" };
    const out = shareList(prev, [{ id: 1, v: "a" }, changed, added]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(changed);
    expect(out[2]).toBe(added);
  });
  it("matches rows by id across a reorder (new array, same rows)", () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const out = shareList(prev, [{ id: 2 }, { id: 1 }]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[1]);
    expect(out[1]).toBe(prev[0]);
  });
  it("a removed row changes the list identity", () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const out = shareList(prev, [{ id: 1 }]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
  });
});

describe("shareSnapshot", () => {
  it("an idle poll re-uses tasks / agents / requests / byAlias / container", () => {
    const a = mapSnapshot(raw());
    const b = mapSnapshot(raw());
    expect(b.tasks).not.toBe(a.tasks); // fresh JSON every poll
    const s = shareSnapshot(a, b);
    expect(s).not.toBe(a); // a poll landed: the snapshot object itself is fresh
    expect(s.tasks).toBe(a.tasks);
    expect(s.agents).toBe(a.agents);
    expect(s.requests).toBe(a.requests);
    expect(s.byAlias).toBe(a.byAlias);
    expect(s.container).toBe(a.container);
  });
  it("a changed task gets a new identity; its siblings and the untouched lists keep theirs", () => {
    const a = mapSnapshot(raw());
    const r = raw();
    r.tasks[1].status = "needs_verification";
    const s = shareSnapshot(a, mapSnapshot(r));
    expect(s.tasks).not.toBe(a.tasks);
    expect(s.tasks[0]).toBe(a.tasks[0]);
    expect(s.tasks[1]).not.toBe(a.tasks[1]);
    expect(s.tasks[1].status).toBe("needs_verification");
    expect(s.agents).toBe(a.agents);
    expect(s.requests).toBe(a.requests);
  });
  it("a changed agent rebuilds byAlias over the shared rows", () => {
    const a = mapSnapshot(raw());
    const r = raw();
    r.agents[0].status = "working";
    const s = shareSnapshot(a, mapSnapshot(r));
    expect(s.agents).not.toBe(a.agents);
    expect(s.agents[1]).toBe(a.agents[1]);
    expect(s.byAlias).not.toBe(a.byAlias);
    expect(s.byAlias.kedar).toBe(a.agents[1]);
    expect(s.byAlias.atlas.status).toBe("working");
  });
  it("the first snapshot passes through untouched", () => {
    const b = mapSnapshot(raw());
    expect(shareSnapshot(null, b)).toBe(b);
  });
});
