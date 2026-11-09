/** The planned crawl's queue on the Map: reading it safely, which cards it marks, the current target's budget ring and the chip's progress. */
import { describe, expect, it } from "vitest";
import { crawlLine } from "./crawl-chip";
import { budgetLeft, clock, currentTarget, nextFollow, parseCrawlQueue, queueMarks, queueProgress, type CrawlQueue } from "./live-reveal";
import { crawlOf } from "./use-map-crawl";
import type { QaSession } from "../qaApi";

const target = (key: string, status: string, extra: Record<string, unknown> = {}) => ({
  key,
  label: key.replace("/", "") || "Home",
  status,
  way_in: { kind: "route", url: `https://homes.test${key}` },
  origin: "map",
  ...extra,
});

/** 40 targets: 14 finished, the 15th current (reaching, 30 s from 09:10:00), the rest queued. */
function queue40(): CrawlQueue {
  const targets = Array.from({ length: 40 }, (_, i) => {
    const key = `/t${i + 1}`;
    if (i < 10) return target(key, "explored");
    if (i < 12) return target(key, "blocked", { reason: "needs sign-in: the page asks for an account" });
    if (i < 14) return target(key, "skipped", { reason: "not reached within its 30 s budget" });
    if (i === 14) return target(key, "current", { phase: "reach", budget_s: 30, phase_started_at: "2026-10-21T09:10:00Z", deadline_at: "2026-10-21T09:10:30Z" });
    return target(key, "queued");
  });
  const q = parseCrawlQueue({ version: 1, mode: "enforced", platform: "web", total: 40, done: 14, reached: 10, index: 14, current: "/t15", budgets: { reach_s: 30, explore_s: 45, grace_s: 10 }, targets });
  if (!q) throw new Error("the queue did not parse");
  return q;
}

describe("parseCrawlQueue", () => {
  it("reads the queue the tool server writes, as JSON text or decoded", () => {
    const q = queue40();
    expect(q).toMatchObject({ mode: "enforced", platform: "web", total: 40, done: 14, reached: 10, index: 14, current: "/t15", budgets: { reach_s: 30, explore_s: 45, grace_s: 10 } });
    expect(q.targets).toHaveLength(40);
    expect(q.targets[14]).toMatchObject({ key: "/t15", status: "current", phase: "reach", budget_s: 30, way_in: { kind: "route", url: "https://homes.test/t15", hops: null, note: null } });
    expect(parseCrawlQueue(JSON.stringify({ targets: [target("/a", "queued")] }))?.targets[0].key).toBe("/a");
  });

  it("is safe on anything else: no queue, odd targets dropped, odd fields defaulted", () => {
    for (const bad of [null, undefined, 3, "nope", "{", [], {}, { targets: "x" }]) expect(parseCrawlQueue(bad)).toBeNull();
    const q = parseCrawlQueue({
      targets: [
        null,
        { label: "no key" },
        { key: "/a", status: "flying", phase: "explore", way_in: { kind: "teleport", hops: -2 }, overruns: "2", why: ["changed today", 4] },
        target("/b", "explored"),
      ],
    });
    expect(q?.targets.map((t) => t.key)).toEqual(["/a", "/b"]);
    expect(q?.targets[0]).toMatchObject({ status: "queued", phase: null, way_in: { kind: "none", hops: 0 }, overruns: 0, why: ["changed today"], origin: "map" });
    // Counts the queue leaves out come from its targets.
    expect(q).toMatchObject({ mode: "enforced", total: 2, done: 1, reached: 1, budgets: null, current: null });
  });
});

describe("queueMarks", () => {
  it("marks the current target and the next five queued, in queue order", () => {
    const marks = queueMarks(queue40());
    expect([...marks].map(([k, m]) => [k, m.role, m.role === "next" ? m.order : 0])).toEqual([
      ["/t15", "current", 0],
      ["/t16", "next", 1],
      ["/t17", "next", 2],
      ["/t18", "next", 3],
      ["/t19", "next", 4],
      ["/t20", "next", 5],
    ]);
    // Finished targets carry no mark: the map's own state says what became of them.
    expect(marks.has("/t1")).toBe(false);
    expect(marks.has("/t12")).toBe(false);
  });

  it("skips finished targets between queued ones, takes the queue's `current`, and marks nothing without a queue", () => {
    const q = parseCrawlQueue({ current: "/b", targets: [target("/a", "queued"), target("/b", "reached"), target("/c", "explored"), target("/d", "queued")] })!;
    expect(currentTarget(q)).toBeNull(); // `/b` is finished: the queue is between targets
    expect([...queueMarks(q, 2).keys()]).toEqual(["/a", "/d"]);
    const q2 = parseCrawlQueue({ current: "/d", targets: [target("/a", "explored"), target("/d", "queued"), target("/e", "queued")] })!;
    expect([...queueMarks(q2)].map(([k, m]) => [k, m.role])).toEqual([["/d", "current"], ["/e", "next"]]);
    expect(queueMarks(null).size).toBe(0);
  });
});

describe("the current target's budget", () => {
  const now = queue40().targets[14];

  it("counts down from the deadline, as seconds and the share left", () => {
    expect(budgetLeft(now, Date.parse("2026-10-21T09:10:00Z"))).toEqual({ left_s: 30, fraction: 1 });
    expect(budgetLeft(now, Date.parse("2026-10-21T09:10:12Z"))).toEqual({ left_s: 18, fraction: 0.6 });
    expect(budgetLeft(now, Date.parse("2026-10-21T09:11:00Z"))).toEqual({ left_s: 0, fraction: 0 });
    // Never above the budget, even before the phase started.
    expect(budgetLeft(now, Date.parse("2026-10-21T09:09:00Z"))).toEqual({ left_s: 30, fraction: 1 });
  });

  it("falls back to the phase start plus the budget, and has none without either", () => {
    const noDeadline = { ...now, deadline_at: null };
    expect(budgetLeft(noDeadline, Date.parse("2026-10-21T09:10:15Z"))).toEqual({ left_s: 15, fraction: 0.5 });
    expect(budgetLeft({ ...noDeadline, phase_started_at: null }, Date.now())).toBeNull();
    expect(budgetLeft({ ...now, budget_s: null }, Date.now())).toBeNull();
    expect(budgetLeft(null, Date.now())).toBeNull();
    expect(clock(18)).toBe("0:18");
    expect(clock(372)).toBe("6:12");
  });
});

describe("the chip over a planned crawl", () => {
  const crawl = { request_id: "q1", exploration_id: "exp-7", run_id: "run-crawl", status: "running" as const, minutes: 20, started_at: null, clock_started_at: "2026-10-21T09:00:00Z" };

  it("says how far the queue has got and the time left", () => {
    expect(queueProgress(queue40())).toBe("14 of 40 targets");
    expect(crawlLine({ ...crawl, queue: queue40() }, null, Date.parse("2026-10-21T09:13:48Z"))).toBe("Map the app · 14 of 40 targets · 6:12 left");
    expect(crawlLine({ ...crawl, clock_started_at: null, queue: queue40() }, null, 0)).toBe("Map the app · 14 of 40 targets");
    const one = parseCrawlQueue({ total: 1, done: 0, targets: [target("/a", "current")] })!;
    expect(crawlLine({ ...crawl, queue: one }, null, Date.parse("2026-10-21T09:13:48Z"))).toBe("Map the app · 0 of 1 target · 6:12 left");
    // A queued crawl, or one without a queue (yet), says what it said before.
    expect(crawlLine({ ...crawl, status: "queued", queue: queue40() }, null, 0)).toBe("Map the app · Waiting for a worker");
    expect(crawlLine({ ...crawl, clock_started_at: null, queue: null }, null, 0)).toBe("Map the app · Reading");
  });

  it("reads the queue from the running map session", () => {
    const session = { id: "s1", kind: "map", status: "running", platform: "ios", budget_minutes: 20, started_at: "2026-10-21T09:00:00Z" };
    const parsed = crawlOf([{ ...session, crawl_queue: { total: 2, done: 1, targets: [target("/a", "explored"), target("/b", "current")] } } as unknown as QaSession], "ios");
    expect(parsed?.queue).toMatchObject({ total: 2, done: 1, current: null });
    expect(currentTarget(parsed?.queue)?.key).toBe("/b");
    expect(crawlOf([session as unknown as QaSession], "ios")).toMatchObject({ run_id: "s1", minutes: 20, queue: null });
    expect(crawlOf([session as unknown as QaSession], "web")).toBeNull();
  });
});

describe("Follow", () => {
  it("follows whichever moved last: a newly reached screen or the target the queue moved on to", () => {
    let f = nextFollow({ newest: null, current: null, id: null }, null, "screen:/a");
    expect(f.id).toBe("screen:/a");
    f = nextFollow(f, "screen:/x", "screen:/a");
    expect(f.id).toBe("screen:/x");
    f = nextFollow(f, "screen:/x", "screen:/b");
    expect(f.id).toBe("screen:/b");
    expect(nextFollow(f, "screen:/x", "screen:/b")).toBe(f);
    // The queue between targets keeps the last place.
    expect(nextFollow(f, "screen:/x", null).id).toBe("screen:/b");
  });
});
