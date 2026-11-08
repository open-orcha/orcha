// @vitest-environment jsdom
/** The canvas mounts with every layer. jsdom has no layout, so React Flow draws no edges and the
 * camera cannot fit; geometry is `layout.test.ts`'s job. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppMapView } from "./app-map-view";
import { installFlowEnv, removeFlowEnv } from "./kit/testEnv";
import { withPage } from "./test-wrap";
import { parseCrawlQueue, queueMarks } from "./live-reveal";
import { RENTALS_MAP_JSON } from "./fixture";
import { scaleMap } from "./scale-fixture";
import { parseAppMap } from "./types";

const errors: unknown[] = [];

beforeEach(() => {
  errors.length = 0;
  installFlowEnv();
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
});
afterEach(() => {
  cleanup();
  removeFlowEnv();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

describe("AppMapView", () => {
  it("mounts the screens, data-flow and tests layers and opens a flow in the panel", async () => {
    const { container } = render(withPage(createElement(AppMapView, { map: parseAppMap(RENTALS_MAP_JSON) })));
    await settle();
    expect(container.querySelectorAll("[data-map-region]")).toHaveLength(4);
    expect(container.querySelectorAll("[data-map-screen]")).toHaveLength(11);

    fireEvent.click(container.querySelector('[data-map-layer="data"]')!);
    await settle();
    // The seven screens with a data edge, six endpoints and four entities.
    expect(container.querySelectorAll("[data-map-pill]")).toHaveLength(17);
    expect(container.querySelectorAll('[data-map-pill="endpoint"]')).toHaveLength(6);

    fireEvent.click(container.querySelector('[data-map-layer="tests"]')!);
    await settle();
    expect([...container.querySelectorAll("[data-map-flow]")].map((e) => e.getAttribute("data-map-flow"))).toEqual(["book-a-viewing", "sign-in"]);
    fireEvent.click(container.querySelector('[data-map-flow="sign-in"]')!);
    await settle();
    expect(container.querySelector("[data-map-panel]")?.getAttribute("data-map-panel")).toBe("flow:sign-in");

    // The evidence chips never all go off.
    for (const s of ["code", "tests", "live"]) fireEvent.click(container.querySelector(`[data-map-evidence-chip="${s}"]`)!);
    expect([...container.querySelectorAll("[data-map-evidence-chip]")].map((e) => e.getAttribute("aria-pressed"))).toEqual(["true", "true", "true"]);
    expect(errors).toEqual([]);
  });

  it("draws a big map on the page's platform and opens a summary card in place", async () => {
    const big = scaleMap();
    const { container } = render(withPage(createElement(AppMapView, { map: big }), { platform: "android" }));
    await settle();
    const root = container.querySelector("[data-app-map]")!;
    expect(root.getAttribute("data-platform")).toBe("android");
    // The page picks the platform: the canvas has no switch of its own.
    expect(container.querySelector("[data-map-platforms]")).toBeNull();
    // Twelve features, then the small ones and the 38 screens no feature claims as summary cards, last.
    const regions = [...container.querySelectorAll("[data-map-region]")].map((e) => e.getAttribute("data-map-region"));
    expect(regions).toHaveLength(14);
    expect(regions).toEqual(expect.arrayContaining(["~areas", "~other"]));

    // Picking the summary card flies close to it (a 1400 x 900 canvas); "Show" opens it in place.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON() {} } as DOMRect);
    fireEvent.click(container.querySelector('[data-map-region="~other"]')!);
    await settle();
    expect(root.getAttribute("data-lod")).toBe("near");
    const before = container.querySelectorAll("[data-map-screen]").length;
    expect(before).toBe(180 - 72 - 38);
    fireEvent.click(container.querySelector('[data-map-region-open="~other"]')!);
    await settle();
    expect(container.querySelectorAll("[data-map-screen]").length).toBe(before + 38);
    expect(container.querySelector('[data-map-region-fold="~other"]')).not.toBeNull();
    expect(errors).toEqual([]);
  });

  it("outlines a planned crawl's next targets and rings the current one with its budget", async () => {
    const soon = new Date(Date.now() + 18_000).toISOString();
    const queue = parseCrawlQueue({
      total: 4,
      done: 1,
      targets: [
        { key: "saved", status: "explored" },
        { key: "map-search", status: "current", phase: "reach", budget_s: 30, phase_started_at: new Date().toISOString(), deadline_at: soon },
        { key: "conversation", status: "queued" },
        { key: "profile", status: "queued" },
      ],
    });
    const map = parseAppMap(RENTALS_MAP_JSON);
    const { container } = render(withPage(createElement(AppMapView, { map, reveal: { fresh: new Set<string>(), follow: null, queue: queueMarks(queue) } })));
    await settle();
    const role = (key: string) => container.querySelector(`[data-map-screen="${key}"]`)?.getAttribute("data-crawl-role") ?? null;
    expect([role("map-search"), role("conversation"), role("profile"), role("saved")]).toEqual(["current", "next", "next", null]);
    expect(container.querySelector('[data-map-screen="profile"]')?.getAttribute("data-crawl-order")).toBe("2");
    expect(container.querySelector('[data-map-screen="map-search"] [data-crawl-now]')?.textContent).toMatch(/^Now · 0:1[78]$/);
    const left = Number(container.querySelector('[data-map-screen="map-search"] [data-crawl-budget]')?.getAttribute("data-crawl-budget"));
    expect(left).toBeGreaterThanOrEqual(17);
    expect(errors).toEqual([]);
  });
});
