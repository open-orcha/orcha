// @vitest-environment jsdom
/**
 * "Replay the slowdown" : the stage is a pure function of the clock, so each moment of the
 * play can be read: both lanes waiting at the tap, the usual one landed while the slow one still
 * waits, then both landed with the gap bracketed and said in words. The dialog plays real times
 * and, under reduced motion, opens on the finished frame with its summary read out.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReplayStage, SlowdownReplay, stopwatch, type ReplaySpec } from "./slowdown-replay";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const spec: ReplaySpec = {
  screen: "Property detail",
  platform: "ios",
  metric: "appear",
  frame: "/api/qa/frames/f1",
  usualMs: 1100,
  usualNote: "median of its last 16 clean samples",
  nowMs: 2400,
  nowLabel: "Latest run",
  nowNote: "Oct 27, 11:46 · iPhone 17 Pro",
};

const stage = (ms: number) => render(h(ReplayStage, { spec, ms })).container;
const clocks = (c: HTMLElement) => [...c.querySelectorAll("[data-replay-clock]")].map((e) => e.textContent);

describe("Replay the slowdown", () => {
  it("starts with both lanes waiting at the tap", () => {
    const c = stage(0);
    expect(clocks(c)).toEqual(["0.00 s", "0.00 s"]);
    expect([...c.querySelectorAll("[data-replay-screen]")].map((e) => e.getAttribute("data-replay-screen"))).toEqual(["loading", "loading"]);
    expect(c.querySelector("[data-replay-landed]")).toBeNull();
  });

  it("lands the usual lane first while the slow one keeps counting", () => {
    const c = stage(1500);
    expect(clocks(c)).toEqual(["1.10 s", "1.50 s"]);
    expect(c.querySelector("[data-replay-landed='usual']")?.textContent).toBe("appeared at 1.10 s");
    expect(c.querySelector("[data-replay-landed='now']")).toBeNull();
    expect(c.querySelector("[data-replay-lane='now']")?.textContent).toContain("waiting for the screen");
    expect(c.querySelector("[data-replay-verdict]")).toBeNull();
  });

  it("ends with both landed and the gap said in words", () => {
    const c = stage(3000);
    expect(clocks(c)).toEqual(["1.10 s", "2.40 s"]);
    expect(c.querySelector("[data-replay-landed='now']")?.textContent).toBe("appeared at 2.40 s");
    expect(c.querySelector("[data-replay-stage]")?.getAttribute("data-replay-done")).toBe("true");
    expect(c.querySelector("[data-replay-verdict]")?.textContent).toBe("Same screen, same action: 1.3 s slower than usual, 2.2× its usual time.");
    // The picture is the screen as Embodent last saw it, in both lanes.
    expect([...c.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([spec.frame, spec.frame]);
  });

  it("says what was timed on the web, and draws the screen when there is no picture of it", () => {
    const c = render(h(ReplayStage, { spec: { ...spec, platform: "web", metric: "settle", frame: null, address: "/checkout-step-two.html" }, ms: 3000 })).container;
    expect(c.querySelector("[data-replay-landed='now']")?.textContent).toBe("settled at 2.40 s");
    expect(c.textContent).toContain("/checkout-step-two.html");
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("[data-replay-verdict]")?.textContent).toContain("Same page, same action");
  });

  it("opens from its trigger and, under reduced motion, rests on the finished frame with its summary", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener: () => {}, removeEventListener: () => {} }));
    const c = render(h(SlowdownReplay, { spec: { ...spec, frame: null }, trigger: (open: () => void) => h("button", { onClick: open, "data-open": "" }, "Replay") })).container;
    expect(document.querySelector("[data-replay-dialog]")).toBeNull();
    fireEvent.click(c.querySelector("[data-open]")!);
    await waitFor(() => expect(document.querySelector("[data-replay-dialog]")).toBeTruthy());
    expect(document.querySelector("dialog h2")?.textContent).toBe("Replay the slowdown: Property detail");
    expect(clocks(document.body)).toEqual(["1.10 s", "2.40 s"]);
    expect(document.querySelector("[data-replay-dialog] [aria-live]")?.textContent).toBe(
      "Property detail usually appeared after 1.1 s. In the latest run it appeared after 2.4 s, 1.3 s slower.",
    );
  });

  it("formats the stopwatch to the hundredth", () => {
    expect(stopwatch(0)).toBe("0.00 s");
    expect(stopwatch(2412)).toBe("2.41 s");
    expect(stopwatch(-5)).toBe("0.00 s");
  });
});
