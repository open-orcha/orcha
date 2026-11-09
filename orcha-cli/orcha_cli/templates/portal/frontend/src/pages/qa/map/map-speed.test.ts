// @vitest-environment jsdom
/** The map's speed overlay: a screen's heat as its card and the legend say it. */
import { cleanup, render, screen } from "@testing-library/react";
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { heatMark, SpeedChip, SpeedLegend } from "./map-speed";
import type { SlowScreen } from "./perf/perf";

afterEach(cleanup);

const slow = { key: "cart", label: "Cart", platform: "ios", device_class: "", device: null, metric: "appear", latest: 3200, latest_run_id: "r", latest_at: "", baseline: { median: 900, p90: 1000, n: 12 }, delta: 2.5, budget: 1500, trend: [], runs: 3, heat: "slow", issue: null } as SlowScreen;

describe("Speed on the map", () => {
  it("says a screen's heat in words beside its time", () => {
    expect(heatMark(slow)).toEqual({ heat: "slow", label: "3.2 s", title: "Slow: 3.2 s, usually 0.9 s" });
  });

  it("counts the chip only once it is on", () => {
    const { rerender } = render(h(SpeedChip, { on: false, onToggle: () => {}, count: null }));
    expect(screen.getByRole("button").textContent).toBe("Speed");
    rerender(h(SpeedChip, { on: true, onToggle: () => {}, count: 7 }));
    expect(screen.getByRole("button").textContent).toBe("Speed7");
  });

  it("teaches when nothing is timed and links to the ranked list", () => {
    const { container, rerender } = render(h(MemoryRouter, null, h(SpeedLegend, { marks: new Map(), href: "/qa?view=map&sub=slowest" })));
    expect(container.textContent).toContain("No screen timed in the last 30 days yet");
    rerender(h(MemoryRouter, null, h(SpeedLegend, { marks: new Map([["cart", heatMark(slow)]]), href: "/qa?view=map&sub=slowest" })));
    expect(container.querySelector("[data-map-speed-list]")?.getAttribute("href")).toBe("/qa?view=map&sub=slowest");
  });
});
