/**
 * Bottom-follow regression tests for the run-feed log scroller.
 *
 * The bug: `.log` has `scroll-behavior: smooth`, so `el.scrollTop = el.scrollHeight`
 * animates asynchronously — the next atBottom read saw a mid-animation position and
 * the feed permanently stopped following. Every painted log ended stuck at the TOP
 * (boot noise) and a live stream never followed its own lines.
 *
 * These tests simulate the real geometry (content growing past the 440px max-height
 * cap, instant pins) and assert the follow contract: pinned logs stay pinned across
 * appends of ANY row height, a reader scrolling away detaches, and returning to the
 * bottom re-attaches.
 */
import { describe, expect, it, vi } from "vitest";
import { nearBottom, pinToBottom } from "./logScroll";
import { appendLine } from "../pages/agents/runlog";

/** A fake .log with max-height geometry: clientHeight caps at 440, content grows. */
function fakeLog(cap = 440) {
  const el = {
    content: 0, // total content height
    scrollTop: 0,
    get scrollHeight() {
      return Math.max(this.content, Math.min(this.content, cap));
    },
    get clientHeight() {
      return Math.min(this.content, cap);
    },
    scrollTo(opts: ScrollToOptions) {
      // instant pin: land exactly at the bottom, like a real instant scroll
      this.scrollTop = Math.max(0, (opts.top ?? 0) - this.clientHeight);
      this.lastBehavior = opts.behavior;
    },
    lastBehavior: undefined as ScrollBehavior | undefined,
    grow(px: number) {
      this.content += px;
    },
  };
  return el;
}

describe("pinToBottom", () => {
  it("scrolls instantly (never the CSS smooth behavior)", () => {
    const el = fakeLog();
    el.grow(1000);
    pinToBottom(el as unknown as HTMLElement);
    expect(el.lastBehavior).toBe("instant");
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
  });

  it("falls back to a direct scrollTop assignment without scrollTo (jsdom)", () => {
    const el = { scrollHeight: 500, scrollTop: 0 };
    pinToBottom(el);
    expect(el.scrollTop).toBe(500);
  });
});

describe("nearBottom", () => {
  it("is true within 36px of the bottom, false beyond", () => {
    const el = { scrollHeight: 1000, clientHeight: 440, scrollTop: 560 };
    expect(nearBottom(el)).toBe(true); // exactly at bottom
    el.scrollTop = 525; // 35px away
    expect(nearBottom(el)).toBe(true);
    el.scrollTop = 524; // 36px away
    expect(nearBottom(el)).toBe(false);
  });
});

describe("follow contract (appendLine order: read atBottom, insert, pin)", () => {
  function appendRow(el: ReturnType<typeof fakeLog>, rowHeight: number) {
    const atBottom = nearBottom(el as unknown as HTMLElement);
    el.grow(rowHeight);
    if (atBottom) pinToBottom(el as unknown as HTMLElement);
  }

  it("stays pinned across the max-height crossover and tall rows", () => {
    const el = fakeLog();
    // batch-paint 30 rows of 60px each (taller than the 36px heuristic —
    // the exact case the smooth-scroll race used to detach on)
    for (let i = 0; i < 30; i++) appendRow(el, 60);
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight); // at the bottom
    expect(nearBottom(el as unknown as HTMLElement)).toBe(true);
  });

  it("detaches when the reader scrolls away, re-attaches at the bottom", () => {
    const el = fakeLog();
    for (let i = 0; i < 20; i++) appendRow(el, 60);
    // reader scrolls up to re-read something
    el.scrollTop = 100;
    const before = el.scrollTop;
    appendRow(el, 60);
    expect(el.scrollTop).toBe(before); // NOT yanked back down
    // reader returns to the bottom
    pinToBottom(el as unknown as HTMLElement);
    appendRow(el, 60);
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight); // following again
  });
});

describe("appendLine (runlog engine)", () => {
  function geometryLog(cap = 440) {
    const el = document.createElement("div");
    let scrollTop = 0;
    // per-row synthetic height: jsdom has no layout, so derive content height
    // from the child count (24px per row).
    Object.defineProperty(el, "scrollHeight", { get: () => el.children.length * 24 });
    Object.defineProperty(el, "clientHeight", { get: () => Math.min(el.children.length * 24, cap) });
    Object.defineProperty(el, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });
    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      scrollTop = Math.max(0, (opts.top ?? 0) - Math.min(el.children.length * 24, cap));
    });
    Object.defineProperty(el, "scrollTo", { value: scrollTo });
    return { el, scrollTo };
  }

  it("renders the classified row and pins a followed log instantly", () => {
    const { el, scrollTo } = geometryLog();
    for (let i = 0; i < 30; i++) appendLine(el, { type: "narrate", label: "log", text: "line " + i });
    expect(el.children.length).toBe(30);
    expect(el.children[0].textContent).toContain("line 0");
    // pinned exactly at the bottom after a batch paint past the height cap
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: el.scrollHeight, behavior: "instant" });
  });

  it("does not yank a reader who scrolled away from the bottom", () => {
    const { el } = geometryLog();
    for (let i = 0; i < 30; i++) appendLine(el, { type: "narrate", label: "log", text: "line " + i });
    el.scrollTop = 0; // reader jumps to the top
    appendLine(el, { type: "done", label: "run-complete", text: "exited" });
    expect(el.scrollTop).toBe(0);
  });

  it("caps the feed at 400 rows", () => {
    const { el } = geometryLog();
    for (let i = 0; i < 410; i++) appendLine(el, { type: "narrate", label: "log", text: "line " + i });
    expect(el.children.length).toBe(400);
    expect(el.children[0].textContent).toContain("line 10");
  });
});
