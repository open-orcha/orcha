import { describe, expect, it } from "vitest";
import { parseExploration } from "../test-rows";
import type { Exploration } from "../explorations";
import { dayGroups, exploreStats, formatSeconds, frameIndexFor, measuredWords, ranSeconds, routeOf, routeSize, spread } from "./home-model";

function row(o: Record<string, unknown>): Exploration {
  return parseExploration({ project_id: "p", lenses: '["works"]', targets: "[]", charter: "[]", status: "done", created_at: "2026-10-26T10:00:00Z", ...o });
}

const finding = (fingerprint: string, severity: string, feature?: string) => ({ fingerprint, severity, feature, lens: "works", title: `Bug ${fingerprint}`, source: "agent" });

describe("Explore home model", () => {
  it("formats how long something ran", () => {
    expect(formatSeconds(42)).toBe("42 s");
    expect(formatSeconds(211)).toBe("3 min 31 s");
    expect(formatSeconds(720)).toBe("12 min");
    expect(formatSeconds(3900)).toBe("1 h 5 min");
    expect(ranSeconds(row({ started_at: "2026-10-27T20:41:22.900Z", finished_at: "2026-10-27T20:44:53.414Z" }))).toBeCloseTo(210.5, 0);
    expect(ranSeconds(row({ result: JSON.stringify({ duration_s: 420 }) }))).toBe(420);
    expect(ranSeconds(row({}))).toBeNull();
  });

  it("counts each issue once across explorations, and the time only of the ones that ran", () => {
    const stats = exploreStats([
      row({ id: "a", result: JSON.stringify({ findings: [finding("f1", "minor"), finding("f2", "major")] }), started_at: "2026-10-26T10:00:00Z", finished_at: "2026-10-26T10:02:00Z" }),
      row({ id: "b", result: JSON.stringify({ findings: [finding("f1", "major")] }), started_at: "2026-10-26T11:00:00Z", finished_at: "2026-10-26T11:01:00Z" }),
      row({ id: "c", status: "exploring", started_at: "2026-10-26T12:00:00Z" }),
      row({ id: "d", archived_at: "2026-10-27T00:00:00Z", result: JSON.stringify({ findings: [finding("f9", "blocker")] }) }),
    ]);
    expect(stats.explorations).toBe(3);
    expect(stats.live).toBe(1);
    expect(stats.issues).toBe(2);
    expect(stats.bySeverity).toEqual({ major: 2 });
    expect(stats.seconds).toBe(180);
    expect(stats.timed).toBe(2);
  });

  it("counts real findings as issues and measured checks apart: 260 contrast misses are not 260 bugs", () => {
    const measured = Array.from({ length: 260 }, (_, i) => ({ ...finding(`m${i}`, i < 19 ? "major" : "minor"), source: "measured" }));
    const stats = exploreStats([row({ id: "a", result: JSON.stringify({ findings: measured }) })]);
    expect(stats.issues).toBe(0);
    expect(stats.bySeverity).toEqual({});
    expect(stats.measured).toBe(260);
    expect(measuredWords(1)).toBe("1 measured check");
  });

  it("folds repeated screens of a route, and keeps every screenshot when the fingerprint is blind", () => {
    const told = routeOf([
      { seq: 3, frame_path: "r/0003.jpg", screen_hash: "b" },
      { seq: 1, frame_path: "r/0001.jpg", screen_hash: "a" },
      { seq: 2, frame_path: "r/0002.jpg", screen_hash: "a" },
      { seq: 4, frame_path: null, screen_hash: "b" },
      { seq: 5, frame_path: "r/0005.jpg", screen_hash: "a" },
    ]);
    expect(told.frames.map((f) => f.seq)).toEqual([1, 3, 5]);
    expect(told.screens).toBe(2);
    expect(told.captured).toBe(4);
    expect(routeSize(told)).toBe("2 screens");

    const blind = routeOf([1, 2, 3].map((seq) => ({ seq, frame_path: `r/${seq}.jpg`, screen_hash: "same" })));
    expect(blind.frames).toHaveLength(3);
    expect(blind.screens).toBeNull();
    expect(routeSize(blind)).toBe("3 screenshots");
  });

  it("spreads a long route keeping its ends, and pins a step to the screen it happened on", () => {
    expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([1, 5, 9]);
    const frames = [{ seq: 1, path: "a" }, { seq: 10, path: "b" }, { seq: 20, path: "c" }];
    expect(frameIndexFor(frames, 15)).toBe(1);
    expect(frameIndexFor(frames, 0)).toBe(0);
    expect(frameIndexFor(frames, 99)).toBe(2);
  });

  it("groups the history by day, newest first as given", () => {
    const now = Date.parse("2026-10-27T15:00:00");
    const groups = dayGroups(
      [
        { id: "x", created_at: new Date("2026-10-27T09:00:00").toISOString() },
        { id: "y", created_at: new Date("2026-10-27T08:00:00").toISOString() },
        { id: "z", created_at: new Date("2026-10-26T20:00:00").toISOString() },
        { id: "w", created_at: new Date("2026-10-20T20:00:00").toISOString() },
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["Today", ["x", "y"]],
      ["Yesterday", ["z"]],
      ["Tue, Oct 20", ["w"]],
    ]);
  });




});
