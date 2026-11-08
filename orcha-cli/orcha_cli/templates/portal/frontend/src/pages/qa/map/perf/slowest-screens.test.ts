// @vitest-environment jsdom
/**
 * Slowest screens in the DOM with `GET C/perf` faked: the teaching scene when nothing was timed,
 * the "every timing was noise" state seen on a busy Mac, and the live strip of a session timing
 * screens now.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ loadSlowest: vi.fn() }));
vi.mock("./api", () => api);

import { MemoryRouter } from "react-router-dom";
import { PortRoot } from "../kit";
import { PERF_DEFAULTS } from "./perf-settings";
import type { SlowestResponse } from "./perf";
import type { QaNav } from "../../QaPage";
import { SlowestScreens } from "./slowest-screens";

afterEach(() => {
  cleanup();
  api.loadSlowest.mockReset();
});

function serve(body: Partial<SlowestResponse>) {
  const full: SlowestResponse = { screens: [], platforms: [], days: 30, settings: PERF_DEFAULTS, noise: {}, total_samples: 0, running: [], ...body };
  api.loadSlowest.mockResolvedValue(full);
}

const nav = { platform: "ios", nonce: 0, refresh: () => {} } as unknown as QaNav;
const view = () => render(h(MemoryRouter, null, h(PortRoot, { refresh: () => {}, children: h(SlowestScreens, { cid: "p1", nav }) })));

describe("Slowest screens", () => {
  it("teaches with the scene when nothing was timed", async () => {
    serve({});
    const { container } = view();
    await waitFor(() => expect(container.querySelector("[data-perf-scene]")).toBeTruthy());
    expect(container.textContent).toContain("No screens timed yet");
    expect(container.querySelector("[data-slowest-cta]")?.getAttribute("href")).toContain("view=sessions");
  });

  it("says every timing was noise, and why, instead of 'no screens timed'", async () => {
    serve({ total_samples: 197, noise: { under_load: 197 } });
    const { container } = view();
    await waitFor(() => expect(container.textContent).toContain("Every timing so far was noise"));
    expect(container.textContent).toContain("Embodent timed 197 samples in this window and left every one out of the comparison (197 machine under load).");
    expect(container.textContent).toContain("over 1.5 per core never counts");
    expect(container.querySelector("[data-slowest-noise-cta]")?.getAttribute("href")).toContain("sub=budgets");
  });

  it("shows a run timing screens now, with its newest timings", async () => {
    serve({
      running: [{
        run_id: "r-live", platform: "web", device: "Chromium", started_at: null, timed: 4,
        latest: [
          { seq: 1, kind: "tap", at_ms: 300, appear_ms: 1900, settle_ms: 2100, settled: "changed", screen: "Orders · Halden Pottery" },
          { seq: 3, kind: "tap", at_ms: 2400, appear_ms: null, settle_ms: 400, settled: "unchanged", screen: null },
        ],
      }],
    });
    const { container } = view();
    await waitFor(() => expect(container.querySelector("[data-slowest-running='r-live']")).toBeTruthy());
    const strip = container.querySelector("[data-slowest-running='r-live']") as HTMLElement;
    expect(strip.textContent).toContain("Timing a run now");
    expect(strip.textContent).toContain("4 actions timed · Web");
    expect([...strip.querySelectorAll("[data-slowest-tick]")].map((t) => t.textContent)).toEqual(["Orders · Halden Pottery1.9 s", "next screenno change"]);
    expect(strip.querySelector("[data-slowest-watch]")?.getAttribute("href")).toBe("/qa?view=sessions&session=r-live");
    expect(container.textContent).toContain("Timing its first screens now");
  });

  it("ranks a slow screen, links it to the map and offers its replay", async () => {
    serve({
      platforms: ["ios"], total_samples: 12,
      screens: [{
        key: "cart", node: "n-cart", label: "Cart", platform: "ios", device_class: "iPhone 17 Pro", device: "iPhone 17 Pro", metric: "appear", latest: 3200, frame: null,
        baseline: { median: 900, p90: 1100, n: 12 }, budget: 1500, delta: 2.5, trend: [900, 950, 3200], runs: 3,
        heat: "slow", latest_run_id: "r5", latest_at: "2026-10-27T15:00:00Z", issue: null,
      }],
    });
    const { container } = view();
    await waitFor(() => expect(container.querySelector("[data-slow-screen='cart']")).toBeTruthy());
    expect(container.querySelector("[data-slowest-headline]")?.textContent).toBe("Cart got slower");
    const row = container.querySelector("[data-slow-screen='cart']") as HTMLElement;
    expect(row.querySelector("a")?.getAttribute("href")).toBe("/qa?view=map&screen=n-cart");
    expect(container.querySelector("[data-slowest-replay-lead]")).toBeTruthy();
  });
});
