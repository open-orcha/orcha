import { describe, expect, it } from "vitest";
import {
  deviceLine,
  ENDED_LINGER_MS,
  EXIT_MS,
  mergeWall,
  moveFocus,
  queuedLine,
  runClockMs,
  screenAspect,
  steadySince,
  waitingLine,
  wallCounts,
  wallLayout,
  wallShape,
  type ShownTile,
  type WallTile,
} from "./live-wall";

function tile(over: Partial<WallTile> = {}): WallTile {
  return {
    key: "run-1",
    href: "/qa",
    runId: "run-1",
            status: "running",
    name: "Checkout",
    project: "Shop",
    kind: "ios",
    device: "iPhone 17 Pro",
    deviceIsDefault: false,
                since: "2026-10-17T10:00:00.000Z",
    actions: 3,
    action: "tap",
    framePath: "run-1/frames/0003.jpg",
    frameSeq: 3,
    phase: null,
    ...over,
  };
}

describe("wallLayout", () => {
  it.each([
    [0, 1, 1],
    [1, 1, 1],
    [2, 2, 1],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
    [7, 3, 3],
    [9, 3, 3],
  ])("%i tiles -> %i x %i, no scroll", (n, cols, rows) => {
    expect(wallLayout(n)).toEqual({ cols, rows, scroll: false });
  });

  it("more than nine scroll in rows of three, four on a very wide stage", () => {
    expect(wallLayout(10)).toEqual({ cols: 3, rows: 4, scroll: true });
    expect(wallLayout(13, { wide: true })).toEqual({ cols: 4, rows: 4, scroll: true });
  });

  it("a phone shows two columns and scrolls past two rows", () => {
    expect(wallLayout(1, { narrow: true })).toEqual({ cols: 1, rows: 1, scroll: false });
    expect(wallLayout(3, { narrow: true })).toEqual({ cols: 2, rows: 2, scroll: false });
    expect(wallLayout(6, { narrow: true })).toEqual({ cols: 2, rows: 3, scroll: true });
  });
});

describe("shape and aspect", () => {
  it("phones are tall, tablets squarer, browsers wide", () => {
    expect(wallShape("ios", false)).toBe("phone");
    expect(wallShape("ios", true)).toBe("tablet");
    expect(wallShape("android", true)).toBe("tablet");
    expect(wallShape("web", true)).toBe("wide");
    expect(wallShape("desktop", false)).toBe("wide");
  });

  it("uses the frame's own size once it is known", () => {
    expect(screenAspect("phone")).toBeLessThan(0.5);
    expect(screenAspect("tablet")).toBeCloseTo(0.75);
    expect(screenAspect("wide")).toBeCloseTo(1.6);
    expect(screenAspect("phone", { w: 1280, h: 800 })).toBeCloseTo(1.6);
    expect(screenAspect("wide", { w: 0, h: 0 })).toBeCloseTo(1.6);
  });
});

describe("lines", () => {
  it("counts running (preparing and finishing included) and queued", () => {
    expect(wallCounts([{ status: "running" }, { status: "preparing" }, { status: "finishing" }, { status: "running" }, { status: "queued" }, { status: "queued" }])).toBe("4 running · 2 queued");
    expect(wallCounts([{ status: "running" }])).toBe("1 running");
  });

  it("says what a tile without a frame is waiting for", () => {
    expect(queuedLine({ device: "iPad Pro 13-inch (M5)", deviceIsDefault: false, kind: "ios" })).toBe("Queued · waiting for iPad Pro 13-inch (M5)");
    expect(queuedLine({ device: "Any booted simulator", deviceIsDefault: true, kind: "ios" })).toBe("Queued · waiting for a device");
    expect(waitingLine({ status: "preparing", phase: "Booting iPad Pro…", device: "iPad", deviceIsDefault: false, kind: "ios" })).toBe("Booting iPad Pro…");
    expect(waitingLine({ status: "preparing", phase: null, device: "iPad", deviceIsDefault: false, kind: "ios" })).toBe("Getting iPad ready…");
    expect(waitingLine({ status: "running", phase: null, device: "Chromium", deviceIsDefault: false, kind: "web" })).toBe("Waiting for the first screen…");
  });
});

describe("clocks (#200)", () => {
  const claim = Date.parse("2026-10-18T01:07:00.000Z");
  const building = tile({
    key: "req:r1",
    runId: null,
        status: "preparing",
    kind: "android",
    since: "2026-10-18T01:07:00.000Z",
    actions: 0,
    framePath: null,
    phase: "Building the Android app",
    phaseSince: "2026-10-18T01:07:00.000Z",
  });

  it("a tile building for six minutes shows the stage's time, and no run clock", () => {
    const now = claim + 6 * 60_000 + 19_000;
    expect(runClockMs(building, now)).toBeNull();
    expect(waitingLine(building, now)).toBe("Building the Android app · 6:19");
  });

  it("the run clock starts at the session's start once the run exists", () => {
    const sessionStart = claim + 6 * 60_000 + 30_000;
    const run = tile({ key: "run-9", runId: "run-9", since: new Date(sessionStart).toISOString(), phase: null, phaseSince: null });
    expect(runClockMs(run, sessionStart)).toBe(0);
    expect(runClockMs(run, sessionStart + 42_000)).toBe(42_000);
  });

  it("a queued tile has no clock, and a stage without a known start has no stage time", () => {
    expect(runClockMs(tile({ status: "queued" }), claim)).toBeNull();
    expect(waitingLine({ ...building, phaseSince: null }, claim)).toBe("Building the Android app");
    expect(waitingLine(building)).toBe("Building the Android app");
  });
});


describe("mergeWall", () => {
  const T0 = 1_000_000;

  it("adds new tiles, updates live ones in place and keeps queued ones last", () => {
    const first = mergeWall([], { tiles: [tile({ key: "q", runId: null, status: "queued" }), tile()], ended: [] }, T0);
    expect(first.map((t) => t.key)).toEqual(["run-1", "q"]);
    const next = mergeWall(first, { tiles: [tile({ actions: 9, framePath: "run-1/frames/0009.jpg" }), tile({ key: "run-2", runId: "run-2" })], ended: [] }, T0 + 1000);
    expect(next.map((t) => t.key)).toEqual(["run-1", "run-2"]);
    expect(next[0]).toMatchObject({ actions: 9, framePath: "run-1/frames/0009.jpg", enteredAt: T0 });
    expect(next[1].enteredAt).toBe(T0 + 1000);
  });


  it("the run clock starts with the session, not with the claim (#200)", () => {
    const claim = "2026-10-17T10:00:00.000Z";
    const runStart = "2026-10-17T10:06:19.000Z";
    const a = mergeWall([], { tiles: [tile({ key: "req:r1", runId: null, status: "preparing", since: claim })], ended: [] }, T0);
    const b = mergeWall(a, { tiles: [tile({ key: "run-9", runId: "run-9", since: runStart })], ended: [] }, T0 + 1000);
    expect(b[0].since).toBe(runStart);
    expect(steadySince({ status: "queued", since: claim, runId: null }, { since: runStart, runId: "run-9" })).toBe(runStart);
    expect(steadySince(null, { since: runStart, runId: "run-9" })).toBe(runStart);
  });

  it("a run's clock never jumps back between polls", () => {
    const first = "2026-10-17T10:00:00.000Z";
    const later = "2026-10-17T10:00:02.000Z";
    expect(steadySince({ status: "running", since: first, runId: "run-9" }, { since: later, runId: "run-9" })).toBe(first);
  });

  it("an ended run stays with its result, then leaves", () => {
    const a = mergeWall([], { tiles: [tile(), tile({ key: "run-2", runId: "run-2" })], ended: [] }, T0);
    const b = mergeWall(a, { tiles: [tile({ key: "run-2", runId: "run-2" })], ended: [{ key: "run-1", result: "failed" }] }, T0 + 1000);
    expect(b.map((t) => t.key)).toEqual(["run-1", "run-2"]);
    expect(b[0]).toMatchObject({ result: "failed", endedAt: T0 + 1000, leaving: false });
    const c = mergeWall(b, { tiles: [tile({ key: "run-2", runId: "run-2" })], ended: [] }, T0 + 1000 + ENDED_LINGER_MS);
    expect(c[0]).toMatchObject({ key: "run-1", result: "failed", leaving: true });
    const d = mergeWall(c, { tiles: [tile({ key: "run-2", runId: "run-2" })], ended: [] }, T0 + 1000 + ENDED_LINGER_MS + EXIT_MS);
    expect(d.map((t) => t.key)).toEqual(["run-2"]);
  });

  it("a request cancelled before it ran just leaves", () => {
    const a = mergeWall([], { tiles: [tile({ key: "req:r1", runId: null, status: "queued" })], ended: [] }, T0);
    expect(mergeWall(a, { tiles: [], ended: [] }, T0 + 1000)).toEqual([]);
  });

  it("an ended tile is not revived by a stale answer", () => {
    const a: ShownTile[] = [{ ...tile(), result: "passed", endedAt: T0, leaving: false, enteredAt: T0 - 5000 }];
    const b = mergeWall(a, { tiles: [tile()], ended: [] }, T0 + 1000);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ result: "passed", endedAt: T0 });
  });
});

describe("moveFocus", () => {
  it("moves through a grid and stays inside it", () => {
    expect(moveFocus(0, "ArrowRight", 3, 6)).toBe(1);
    expect(moveFocus(0, "ArrowLeft", 3, 6)).toBe(0);
    expect(moveFocus(1, "ArrowDown", 3, 6)).toBe(4);
    expect(moveFocus(4, "ArrowDown", 3, 6)).toBe(4);
    expect(moveFocus(4, "ArrowUp", 3, 6)).toBe(1);
    expect(moveFocus(2, "End", 3, 6)).toBe(5);
    expect(moveFocus(5, "Home", 3, 6)).toBe(0);
    expect(moveFocus(0, "ArrowRight", 3, 0)).toBe(-1);
  });
});

describe("deviceLine", () => {
  it("a preparing tile with no device yet is picking one, not on any booted simulator", () => {
    expect(deviceLine(tile({ status: "preparing", device: "Any booted simulator", deviceIsDefault: true }))).toBe("Picking a device…");
    expect(deviceLine(tile({ status: "preparing", device: "iPad Pro 13-inch (M5)" }))).toBe("iPad Pro 13-inch (M5)");
    expect(deviceLine(tile({ status: "queued", device: "Any booted simulator", deviceIsDefault: true }))).toBe("Any booted simulator");
  });
});
