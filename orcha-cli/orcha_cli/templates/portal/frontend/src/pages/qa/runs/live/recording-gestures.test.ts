import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LONG_PRESS_MS,
  MAX_SWIPE_MS,
  MIN_SWIPE_MS,
  TYPE_IDLE_MS,
  TypeBuffer,
  WHEEL_GESTURE_IDLE_MS,
  WheelBatcher,
  clampSlide,
  gestureToCommand,
  holdDuration,
  keyToInput,
  screenScale,
  wheelPixels,
  wheelToSwipe,
  type Command,
} from "./recording-gestures";

const PHONE = { width: 402, height: 874 };
const PAGE = { width: 1280, height: 800 };

describe("gestureToCommand", () => {
  it("is a tap when the pointer stayed put, a long press once it was held", () => {
    expect(gestureToCommand([{ x: 100, y: 200, t: 0 }, { x: 104, y: 205, t: 120 }])).toEqual({ kind: "tap", args: { x: 100, y: 200 } });
    expect(gestureToCommand([{ x: 100, y: 200, t: 0 }, { x: 101, y: 201, t: LONG_PRESS_MS + 230 }])).toEqual({
      kind: "long_press",
      args: { x: 100, y: 200, duration_ms: LONG_PRESS_MS + 230 },
    });
  });

  it("never reads a stall before the page saw the press as a hold (D108)", () => {
    // A click whose mousedown sat 10 s on a busy main thread: the release arrives right after
    // the page finally handled the press, 10 s after the press's own timestamp.
    const stalled = [{ x: 100, y: 200, t: 1_000 }, { x: 100, y: 200, t: 11_005 }];
    expect(gestureToCommand(stalled, { pressSeenAt: 11_000 })).toEqual({ kind: "tap", args: { x: 100, y: 200 } });
    // A real hold on an idle page still is one, timed from the press.
    const held = [{ x: 100, y: 200, t: 1_000 }, { x: 100, y: 200, t: 1_900 }];
    expect(gestureToCommand(held, { pressSeenAt: 1_004 })).toEqual({ kind: "long_press", args: { x: 100, y: 200, duration_ms: 896 } });
    expect(holdDuration(0, 300)).toBe(300);
    expect(holdDuration(0, 300, 500)).toBe(0);
    expect(holdDuration(10, 300, 5)).toBe(290);
  });

  it("is a swipe with the real points, timed from when the pointer started moving", () => {
    // Held still for 400 ms, then flicked up 300 points in 80 ms: a fast swipe, not a slow one.
    const flick = [
      { x: 200, y: 700, t: 0 },
      { x: 200, y: 698, t: 400 },
      { x: 200, y: 600, t: 430 },
      { x: 200, y: 400, t: 480 },
    ];
    expect(gestureToCommand(flick)).toEqual({ kind: "swipe", args: { x1: 200, y1: 700, x2: 200, y2: 400, duration_ms: 80 } });
    // A careful drag over two seconds plays over two seconds.
    const slow = [
      { x: 50, y: 500, t: 0 },
      { x: 50, y: 470, t: 1000 },
      { x: 50, y: 440, t: 2000 },
    ];
    expect(gestureToCommand(slow)).toMatchObject({ kind: "swipe", args: { duration_ms: 2000 } });
  });

  it("keeps a swipe's speed within what the device can play", () => {
    expect(gestureToCommand([{ x: 0, y: 500, t: 0 }, { x: 0, y: 100, t: 1 }])).toMatchObject({ args: { duration_ms: MIN_SWIPE_MS } });
    expect(gestureToCommand([{ x: 0, y: 500, t: 0 }, { x: 0, y: 100, t: 60_000 }])).toMatchObject({ args: { duration_ms: MAX_SWIPE_MS } });
    expect(gestureToCommand([])).toBeNull();
  });
});

describe("wheel deltas", () => {
  it("converts line and page deltas to pixels", () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 53, deltaMode: 0 }, PAGE)).toEqual({ dx: 0, dy: 53 });
    expect(wheelPixels({ deltaX: 1, deltaY: 3, deltaMode: 1 }, PAGE)).toEqual({ dx: 16, dy: 48 });
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, PAGE)).toEqual({ dx: 0, dy: 800 });
  });

  it("scales a mirror drawn smaller so the content moves with the fingers", () => {
    expect(screenScale(PAGE, { width: 640, height: 400 })).toEqual({ x: 2, y: 2 });
  });

  it("plays a wheel on a phone as a swipe the other way, kept on screen", () => {
    expect(wheelToSwipe({ x: 200, y: 400 }, 0, 300, PHONE)).toEqual({
      kind: "swipe",
      args: { x1: 200, y1: 400, x2: 200, y2: 100, duration_ms: 300 },
    });
    expect(wheelToSwipe({ x: 200, y: 400 }, 0, 900, PHONE).args).toMatchObject({ y2: 0 });
  });

  it("caps the slide inside the box", () => {
    expect(clampSlide({ x: 0, y: -900 }, { width: 640, height: 400 })).toEqual({ x: 0, y: -240 });
  });
});

describe("WheelBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("on the web sends a flick as one command once the wheel rests", () => {
    const sent: Command[] = [];
    const b = new WheelBatcher("web", () => PAGE, (c) => sent.push(c));
    b.push({ x: 640, y: 300 }, 0, 40.4);
    vi.advanceTimersByTime(30);
    b.push({ x: 641, y: 301 }, 0, 40.4);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(WHEEL_GESTURE_IDLE_MS);
    expect(sent).toEqual([{ kind: "swipe", args: { x: 640, y: 300, dx: 0, dy: 81 } }]);
    // The fraction left over (80.8 sent as 81) carries into the next batch.
    b.push({ x: 650, y: 310 }, 0, 10.2);
    vi.advanceTimersByTime(WHEEL_GESTURE_IDLE_MS);
    expect(sent[1]).toEqual({ kind: "swipe", args: { x: 650, y: 310, dx: 0, dy: 10 } });
  });

  it("keeps sending during a long scroll instead of waiting for it to stop", () => {
    const sent: Command[] = [];
    const b = new WheelBatcher("web", () => PAGE, (c) => sent.push(c));
    for (let i = 0; i < 50; i++) {
      b.push({ x: 1, y: 1 }, 0, 10);
      vi.advanceTimersByTime(20);
    }
    // 1 s of scrolling: one batch per WHEEL_BATCH_MS, not one per event.
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.length).toBeLessThanOrEqual(5);
    b.flush();
    expect(sent.reduce((n, c) => n + Number(c.args.dy), 0)).toBe(500);
  });

  it("drops the trackpad's drift on the minor axis", () => {
    const sent: Command[] = [];
    const b = new WheelBatcher("web", () => PAGE, (c) => sent.push(c));
    b.push({ x: 1, y: 1 }, 23, 161);
    b.flush();
    expect(sent).toEqual([{ kind: "swipe", args: { x: 1, y: 1, dx: 0, dy: 161 } }]);
  });

  it("on a phone waits for the wheel to rest and sends one swipe", () => {
    const sent: Command[] = [];
    const b = new WheelBatcher("ios", () => PHONE, (c) => sent.push(c));
    b.push({ x: 200, y: 600 }, 0, 100);
    vi.advanceTimersByTime(WHEEL_GESTURE_IDLE_MS - 10);
    b.push({ x: 201, y: 590 }, 0, 100);
    vi.advanceTimersByTime(WHEEL_GESTURE_IDLE_MS - 10);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([{ kind: "swipe", args: { x1: 200, y1: 600, x2: 200, y2: 400, duration_ms: 300 } }]);
  });

  it("flushes on demand and sends nothing for a zero delta", () => {
    const sent: Command[] = [];
    const b = new WheelBatcher("web", () => PAGE, (c) => sent.push(c));
    b.push({ x: 1, y: 1 }, 0.2, -0.3);
    b.flush();
    expect(sent).toEqual([]);
  });
});

describe("typing into the screen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("maps keys to text, presses or nothing", () => {
    expect(keyToInput({ key: "a" }, "web")).toEqual({ type: "text", text: "a" });
    expect(keyToInput({ key: " " }, "ios")).toEqual({ type: "text", text: " " });
    expect(keyToInput({ key: "Enter" }, "ios")).toEqual({ type: "press", key: "enter" });
    expect(keyToInput({ key: "Backspace" }, "web")).toEqual({ type: "press", key: "backspace" });
    expect(keyToInput({ key: "Backspace" }, "android")).toBeNull();
    expect(keyToInput({ key: "c", metaKey: true }, "web")).toBeNull();
    expect(keyToInput({ key: "Shift" }, "web")).toBeNull();
  });

  it("sends typed characters as one command once typing pauses", () => {
    const sent: Command[] = [];
    const pending: string[] = [];
    const t = new TypeBuffer((c) => sent.push(c), (p) => pending.push(p));
    t.add("q");
    t.add("u");
    vi.advanceTimersByTime(TYPE_IDLE_MS - 1);
    t.add("r");
    expect(t.backspace()).toBe(true);
    t.add("a");
    vi.advanceTimersByTime(TYPE_IDLE_MS);
    expect(sent).toEqual([{ kind: "type", args: { text: "qua" } }]);
    expect(pending.at(-1)).toBe("");
    expect(t.backspace()).toBe(false);
  });
});
