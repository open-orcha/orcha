// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AppMapRebuilding, plannedBeats, reusedLines } from "./app-map-scenes";

afterEach(cleanup);

describe("the build panel's steps (#467)", () => {
  it("plays only the sources a build reads, and says what it reused and from when", () => {
    const now = new Date("2026-10-29T08:00:00Z");
    const liveOnly = { planned: ["live" as const], reused: { code: "2026-10-28T08:00:00Z", tests: null } };
    expect(plannedBeats(liveOnly).map((b) => b.label)).toEqual(["Reading the runs"]);
    expect(reusedLines(liveOnly, now).map((r) => r.text)).toEqual(["Reused the code read yesterday", "Reused the tests as last read"]);
    // A full build, or one from before builds said their plan: every step, nothing reused.
    const full = { planned: ["code" as const, "tests" as const, "live" as const], reused: {} };
    expect(plannedBeats(full).map((b) => b.key)).toEqual(["code", "tests", "live"]);
    expect(reusedLines(full)).toEqual([]);
    expect(plannedBeats(null).length).toBe(3);
    expect(reusedLines(undefined)).toEqual([]);
  });

  it("never ticks Reading the code for a build that did not read it", () => {
    const build = {
      id: "a1320066", status: "done" as const, started_at: null, finished_at: null, error: null,
      planned: ["live" as const], reused: { code: "2026-10-27T23:36:13Z", tests: "2026-10-27T23:36:14Z" }, ran: { live: true },
    };
    const { container } = render(createElement(AppMapRebuilding, { done: true, build }));
    expect(container.textContent).not.toContain("Reading the code");
    expect(container.querySelector('[data-step="code"]')!.getAttribute("data-step-state")).toBe("reused");
    expect(container.querySelector('[data-step="code"]')!.textContent).toMatch(/^Reused the code read /);
    expect(container.querySelector('[data-step="live"]')!.getAttribute("data-step-state")).toBe("done");
    // A read that failed is said, never ticked.
    const failed = render(createElement(AppMapRebuilding, { done: true, build: { ...build, planned: ["code" as const, "live" as const], ran: { code: false, live: true } } }));
    expect(failed.container.querySelector('[data-step="code"]')!.getAttribute("data-step-state")).toBe("failed");
    expect(failed.container.textContent).toContain("Reading the code: it could not be read");
  });
});
