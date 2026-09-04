/**
 * ISS-68 frontend-lazy tests, ported from the pytest node harness that used to
 * eval static/data.js (tests/test_iss68_frontend_lazy.py): the snapshot no
 * longer ships each task's full thread — the adapter maps message_summary
 * {count,last} + plan_message (thread empty), and threadOf() lazy-fetches +
 * maps the full thread from /api/tasks/{tid}/messages.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../types";
import { mapSnapshot, threadOf } from "./client";

describe("ISS-68 mapSnapshot trims the thread, keeps summary + plan", () => {
  it("maps message_summary and plan_message with an empty eager thread", () => {
    const m = mapSnapshot({
      container: { id: "c1", status: "active" },
      agents: [{ id: "a1", alias: "Frame", kind: "ai", status: "working" }],
      tasks: [
        {
          id: "t1", title: "X", status: "in_progress", priority: 50, assignees: ["Frame"],
          message_summary: { count: 3, last: { body: "latest note", created_at: "t", is_human: false, author_alias: "Frame" } },
          plan_message: { body: "PLAN: do X", author_alias: "Frame", at: "t0" },
        },
      ],
      requests: [],
    });
    const t = m.tasks[0];
    expect(Array.isArray(t.thread) && t.thread.length === 0).toBe(true); // trimmed snapshot -> no eager thread
    expect(t.message_summary.count).toBe(3);
    expect(t.message_summary.last?.body).toBe("latest note");
    expect(t.plan_message?.body).toBe("PLAN: do X");
    expect(t.plan_message?.author_alias).toBe("Frame");
    expect(typeof threadOf).toBe("function"); // the lazy fetch is exposed
  });
});

describe("ISS-68 threadOf fetches and maps the lazy thread", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GETs /api/tasks/{tid}/messages and maps to the page thread shape", async () => {
    let fetched: string | null = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      fetched = String(input);
      return {
        ok: true,
        json: async () => ({
          task_id: "t1",
          messages: [
            { message_id: "m1", author_id: "a1", author_alias: "Frame", is_human: false, body: "hello", created_at: "t" },
            { message_id: "m2", author_id: null, author_alias: null, is_human: true, body: "hi back", created_at: "t2" },
          ],
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const agents = [{ id: "a1", alias: "Frame", kind: "ai" }] as unknown as Agent[];
    const thread = await threadOf("t1", agents);
    expect(fetched).toMatch(/\/api\/tasks\/t1\/messages/);
    expect(thread).toHaveLength(2);
    expect(thread[0].from).toBe("Frame");
    expect(thread[1].from).toBe("human");
    expect(thread[1].is_human).toBe(true);
  });
});
