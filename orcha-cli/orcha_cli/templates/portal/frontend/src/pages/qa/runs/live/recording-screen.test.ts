// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TYPE_IDLE_MS, WHEEL_BATCH_MS } from "./recording-gestures";
import { RecordingScreen } from "./recording-screen";

const RUN = { id: "run-1", screen_w: 1280, screen_h: 800 };

function setup(kind: "web" | "ios" = "web") {
  const onInput = vi.fn();
  const view = render(
    createElement(RecordingScreen, {
      framePath: "frame-1",
      frameSeq: 1,
      kind,
      run: RUN,
      interactive: true,
      onInput,
    }),
  );
  const img = view.container.querySelector("[data-recording-frame]") as HTMLImageElement;
  const box = view.container.querySelector("[data-recording-screen='live']") as HTMLDivElement;
  // Drawn at half size: 640x400 on the page for a 1280x800 screen. Points come from the box,
  // not the image, which slides while a drag or scroll is on its way.
  box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(box, "clientWidth", { value: 640 });
  Object.defineProperty(box, "clientHeight", { value: 400 });
  // The slid image's own rect must never be used for points (a drag would end where it began).
  img.getBoundingClientRect = () => ({ left: 0, top: -100, width: 640, height: 400, right: 640, bottom: 300, x: 0, y: -100, toJSON: () => ({}) });
  return { onInput, img, box };
}

// This jsdom has no PointerEvent, and a plain Event carries no coordinates.
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}
window.PointerEvent ??= TestPointerEvent as unknown as typeof PointerEvent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RecordingScreen gestures", () => {
  it("sends a click as a tap at the screen point", () => {
    const { onInput, img } = setup();
    fireEvent.pointerDown(img, { button: 0, clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(img, { button: 0, clientX: 101, clientY: 51, pointerId: 1 });
    expect(onInput).toHaveBeenCalledWith({ kind: "tap", args: { x: 200, y: 100 } }, { x: 0, y: 0 });
  });

  it("sends a drag as a swipe from start to end and slides the frame with it", () => {
    const { onInput, img } = setup();
    fireEvent.pointerDown(img, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(img, { clientX: 300, clientY: 200, pointerId: 1 });
    expect(img.getAttribute("data-recording-slide")).toBe("0,-100");
    fireEvent.pointerUp(img, { clientX: 300, clientY: 150, pointerId: 1 });
    const [command, slide] = onInput.mock.calls[0];
    expect(command).toMatchObject({ kind: "swipe", args: { x1: 600, y1: 600, x2: 600, y2: 300 } });
    expect(slide).toEqual({ x: 0, y: -100 });
  });

  it("scrolls by the wheel's real delta, scaled to the screen, in batches", () => {
    const { onInput, box } = setup();
    fireEvent.wheel(box, { deltaY: 30, deltaMode: 0, clientX: 320, clientY: 200 });
    fireEvent.wheel(box, { deltaY: 20, deltaMode: 0, clientX: 320, clientY: 200 });
    expect(onInput).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(WHEEL_BATCH_MS);
    });
    // 50 displayed pixels on a half-size mirror scroll the page 100 CSS pixels.
    expect(onInput).toHaveBeenCalledWith({ kind: "swipe", args: { x: 640, y: 400, dx: 0, dy: 100 } }, { x: 0, y: -50 });
  });

  it("types into the focused screen and sends the text when typing pauses", () => {
    const { onInput, box } = setup();
    for (const key of ["h", "i"]) fireEvent.keyDown(box, { key });
    expect(onInput).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(TYPE_IDLE_MS);
    });
    expect(onInput).toHaveBeenCalledWith({ kind: "type", args: { text: "hi" } }, { x: 0, y: 0 });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onInput).toHaveBeenLastCalledWith({ kind: "press", args: { key: "enter" } }, { x: 0, y: 0 });
  });

  it("sends typed text before a tap that follows it, in order", () => {
    const { onInput, box, img } = setup();
    fireEvent.keyDown(box, { key: "x" });
    fireEvent.pointerDown(img, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(img, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onInput.mock.calls.map(([c]) => c.kind)).toEqual(["type", "tap"]);
  });

  it("taps at the crosshair after the arrow keys moved it", () => {
    const { onInput, box } = setup();
    fireEvent.keyDown(box, { key: "ArrowRight" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onInput).toHaveBeenCalledWith({ kind: "tap", args: { x: 650, y: 400 } }, { x: 0, y: 0 });
  });
});

describe("RecordingScreen frames", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the live frame it is given over the stored one", () => {
    const view = render(
      createElement(RecordingScreen, {
        framePath: "frame-1",
        frameSeq: 1,
        live: { path: "/api/qa/sessions/run-1/live/frame", n: 2, cmdSeq: 5 },
        kind: "web",
        run: RUN,
        interactive: true,
        onInput: vi.fn(),
      }),
    );
    expect(view.container.querySelector("[data-recording-frame]")?.getAttribute("src")).toBe("/api/qa/sessions/run-1/live/frame?v=2");
  });

  it("keeps the stored frame when nothing is streaming", () => {
    const view = render(
      createElement(RecordingScreen, { framePath: "frame-1", frameSeq: 1, kind: "web", run: RUN, interactive: false, onInput: vi.fn() }),
    );
    expect(view.container.querySelector("[data-recording-frame]")?.getAttribute("src")).toBe("/api/qa/frames/frame-1");
  });
});
