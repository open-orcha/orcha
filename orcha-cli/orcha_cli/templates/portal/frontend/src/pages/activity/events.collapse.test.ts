import { describe, expect, it } from "vitest";
import { collapseEvents, foldedSameTask, type ProjectEvent } from "./events";

let n = 0;
const ev = (o: Partial<ProjectEvent>): ProjectEvent => ({
  key: "k" + n++, kind: "message", who: "forge", subject: "Fix login", other: null, reqType: null,
  text: "x", at: "2026-09-28T10:00:00Z", href: "/tasks?task=t1", taskId: "t1", requestId: null, ...o,
});

describe("collapseEvents", () => {
  it("folds consecutive comments by the same actor on one task, keeping the newest ('commented 3× on')", () => {
    const out = collapseEvents([ev({ key: "n", text: "newest" }), ev({}), ev({})]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "n", text: "newest" });
    expect(out[0].folded).toHaveLength(2);
    expect(foldedSameTask(out[0])).toBe(true);
  });
  it("folds the same actor across tasks too ('and N more'), newest first", () => {
    const out = collapseEvents([ev({ taskId: "t1" }), ev({ taskId: "t2", subject: "B" })]);
    expect(out).toHaveLength(1);
    expect(out[0].folded!.map((f) => f.subject)).toEqual(["B"]);
    expect(foldedSameTask(out[0])).toBe(false);
  });
  it("never folds across actors, kinds, requests or group boundaries", () => {
    const list = [
      ev({ who: "forge" }), ev({ who: "scout" }), ev({ who: "scout", kind: "decision" }),
      ev({ kind: "request" }), ev({ kind: "request" }), ev({ kind: "answer" }), ev({ kind: "answer" }),
    ];
    expect(collapseEvents(list)).toHaveLength(7);
    const two = [ev({ at: "2026-09-28T10:00:00Z" }), ev({ at: "2026-09-27T10:00:00Z" })];
    expect(collapseEvents(two, (a, b) => a.at.slice(0, 10) === b.at.slice(0, 10))).toHaveLength(2);
  });
});
