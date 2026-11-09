// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortRoot } from "../../map/kit";
import type { QaAuthority } from "../../authority";
import type { Agent } from "../../../../types";
import { LiveDeviceView } from "./LiveDeviceView";
import { livePhase, sameLiveMeta, staleBannerTone, takeoverBlock, toolServerGone, type LiveMeta } from "./recording-live";

const META: LiveMeta = {
  status: "running", n: 3, cmd_seq: 0, at: 1, activity_age_ms: 1000, beat_age_ms: 500, stream: true, screen_w: 390, screen_h: 844,
  takeover: null, inputs: [], notice: null,
};
const HUMAN = { id: "h1", alias: "hussein", kind: "human" } as Agent;
const AUTH: QaAuthority = { can: true, human: HUMAN, reason: null };

function serve(meta: Partial<LiveMeta>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ...META, ...meta }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 390;
      naturalHeight = 844;
      complete = true;
      decode() {
        return Promise.resolve();
      }
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = (props: Partial<Parameters<typeof LiveDeviceView>[0]> = {}) =>
  render(
    <PortRoot refresh={() => {}}>
      <LiveDeviceView sessionId="s1" platform="ios" deviceName="iPhone 17 Pro" auth={AUTH} {...props} />
    </PortRoot>,
  );

describe("LiveDeviceView states", () => {
  it("shows the live frame in the device's bezel, LIVE", async () => {
    serve({});
    const { container } = view();
    await waitFor(() => expect(container.querySelector("[data-live-badge='live']")).toBeTruthy());
    await waitFor(() => expect(container.querySelector("[data-live-frame]")?.getAttribute("src")).toBe("/api/qa/sessions/s1/live/frame?v=3"));
    expect(container.querySelector("[data-device='iphone'],[data-device-frame]")).toBeTruthy();
    expect(screen.getByText("iOS · iPhone 17 Pro")).toBeTruthy();
  });

  it("draws the web in a browser window with its address", async () => {
    serve({});
    const { container } = view({ platform: "web", deviceName: "desktop", address: "shop.example.com/cart" });
    await waitFor(() => expect(container.querySelector("[data-live-frame]")).toBeTruthy());
    expect(container.querySelector("[data-device-frame='browser']")).toBeTruthy();
    expect(container.querySelector("[data-browser-address]")?.textContent).toContain("shop.example.com/cart");
  });

  it("waits for the first screen", async () => {
    serve({ n: 0 });
    const { container } = view();
    await waitFor(() => expect(container.querySelector("[data-live-badge='waiting']")).toBeTruthy());
    expect(screen.getByText("Waiting for the first screen…")).toBeTruthy();
  });

  it("says how long a stalled session has been still", async () => {
    serve({ activity_age_ms: 3 * 60_000 });
    const { container } = view();
    await waitFor(() => expect(container.querySelector("[data-replay-stale-banner]")?.textContent).toContain("No activity for 3 min"));
    expect(container.querySelector("[data-replay-stale-banner]")?.getAttribute("data-tone")).toBe("warning");
  });

  it("says when nothing runs a session any more, and a person can mark it failed", async () => {
    serve({ beat_age_ms: 45_000 });
    const { container } = view();
    await waitFor(() => expect(container.querySelector("[data-run-abandoned]")).toBeTruthy());
    expect(container.querySelector("[data-run-mark-failed]")).toBeTruthy();
    expect(container.querySelector("[data-live-take-over]")?.hasAttribute("disabled")).toBe(true);
  });

  it("ends with the session: Finished, the poll stops and the caller hears", async () => {
    const calls = serve({ status: "done", n: 0 });
    const onEnded = vi.fn();
    const { container } = view({ onEnded, fallbackFrameId: "f9" });
    await waitFor(() => expect(container.querySelector("[data-live-badge='ended']")).toBeTruthy());
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
    const reads = calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(calls.length).toBe(reads);
    await waitFor(() => expect(container.querySelector("[data-live-frame]")?.getAttribute("src")).toBe("/api/qa/frames/f9"));
  });
});

describe("taking the device over", () => {
  it("is not offered to someone who may not decide", async () => {
    serve({});
    const { container } = view({ auth: { can: false, human: null, reason: "View-only" } });
    await waitFor(() => expect(container.querySelector("[data-live-take-over]")).toBeTruthy());
    expect(container.querySelector("[data-live-take-over]")?.hasAttribute("disabled")).toBe(true);
  });

  it("watches only with no authority at all", async () => {
    serve({});
    const { container } = view({ auth: undefined });
    await waitFor(() => expect(container.querySelector("[data-live-badge='live']")).toBeTruthy());
    expect(container.querySelector("[data-live-take-over]")).toBeNull();
  });

  it("shows the screen to drive and the controls to the person driving", async () => {
    serve({ takeover: { by_id: "h1", by: "hussein", since: "now" } });
    const { container } = view();
    await waitFor(() => expect(container.querySelector("[data-recording-frame]")).toBeTruthy());
    expect(container.querySelector("[data-recording-finish]")).toBeTruthy();
    expect(container.querySelector("[data-live-take-over]")).toBeNull();
  });

  it("tells everyone else who is driving", async () => {
    serve({ takeover: { by_id: "h2", by: "maya", since: "now" } });
    const { container } = view();
    await waitFor(() => expect(container.querySelector("[data-live-driven-by]")?.textContent).toContain("maya is driving"));
    expect(container.querySelector("[data-recording-frame]")).toBeNull();
  });
});

describe("live state", () => {
  it("names the phases", () => {
    expect(livePhase(null, "running", false)).toBe("waiting");
    expect(livePhase(META, "running", true)).toBe("live");
    expect(livePhase({ ...META, status: "done" }, "running", true)).toBe("ended");
    expect(livePhase(null, "cancelled", true)).toBe("ended");
    expect(livePhase({ ...META, beat_age_ms: 31_000 }, "running", true)).toBe("abandoned");
  });

  it("does not end a session on an answer that names no status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const onEnded = vi.fn();
    const { container } = view({ onEnded, status: "running" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.querySelector("[data-live-badge='waiting']")).toBeTruthy();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("warns at 2 minutes and alarms at 5", () => {
    expect(staleBannerTone(null)).toBeNull();
    expect(staleBannerTone(1)).toBeNull();
    expect(staleBannerTone(2)).toBe("warning");
    expect(staleBannerTone(5)).toBe("danger");
  });

  it("ignores the clocks when comparing reads, up to the minute", () => {
    expect(sameLiveMeta(META, { ...META, activity_age_ms: 2000, beat_age_ms: 900 })).toBe(true);
    expect(sameLiveMeta(META, { ...META, activity_age_ms: 61_000 })).toBe(false);
    expect(sameLiveMeta(META, { ...META, n: 4 })).toBe(false);
    expect(sameLiveMeta(META, { ...META, beat_age_ms: 31_000 })).toBe(false);
  });

  it("knows a tool server that went quiet from one never heard", () => {
    expect(toolServerGone({ ...META, beat_age_ms: null })).toBe(false);
    expect(toolServerGone({ ...META, beat_age_ms: 31_000 })).toBe(true);
    expect(toolServerGone({ ...META, status: "done", beat_age_ms: 31_000 })).toBe(false);
  });

  it("says why a person cannot take over", () => {
    expect(takeoverBlock("live", META, AUTH)).toBeNull();
    expect(takeoverBlock("live", META, undefined)).toBe("View-only");
    expect(takeoverBlock("live", { ...META, beat_age_ms: null }, AUTH)).toContain("isn’t connected");
    expect(takeoverBlock("live", { ...META, takeover: { by_id: "h2", by: "maya", since: "x" } }, AUTH)).toBe("maya is driving this device.");
    expect(takeoverBlock("ended", META, AUTH)).toBe("The session has ended.");
  });
});
