// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { withScenarios } from "../test-wrap";
import { ScenarioHealthBadge } from "./badge";
import { resetHealthStore } from "./health-store";
import type { HealthFlag } from "./types";

const flag = (kind: HealthFlag["kind"], extra: Partial<HealthFlag> = {}): HealthFlag => ({ scenario_id: "s1", kind, reason: `${kind} reason`, action: "open", ...extra });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => resetHealthStore());

describe("ScenarioHealthBadge (#188)", () => {
  it("renders nothing for a healthy scenario", () => {
    const { container } = render(withScenarios(h(ScenarioHealthBadge, { scenarioId: "s1", flags: [] })));
    expect(container.innerHTML).toBe("");
  });

  it("shows the most urgent open flag, the others as +N, every reason in the tooltip", () => {
    const { container } = render(withScenarios(h(ScenarioHealthBadge, { scenarioId: "s1", flags: [flag("duplicate"), flag("suspicious"), flag("never_passed")] })));
    const pill = container.querySelector("[data-scenario-health-badge]")!;
    expect(pill.getAttribute("data-scenario-health-badge")).toBe("suspicious");
    expect(pill.textContent).toContain("suspicious");
    expect(pill.textContent).toContain("+2");
    expect(pill.getAttribute("title")).toBe("suspicious: suspicious reason\nduplicate: duplicate reason\nnever passed: never_passed reason");
  });

  it("leaves dismissed and flaky flags out", () => {
    const { container } = render(withScenarios(h(ScenarioHealthBadge, { scenarioId: "s1", flags: [flag("suspicious", { dismissed_at: "2026-10-16" }), flag("flaky")] })));
    expect(container.innerHTML).toBe("");
  });

  it("says retired for a retired (archived) scenario", () => {
    const { container } = render(withScenarios(h(ScenarioHealthBadge, { scenarioId: "s1", archivedAt: "2026-10-16", flags: [flag("suspicious")] })));
    expect(container.querySelector("[data-scenario-health-badge]")!.getAttribute("data-scenario-health-badge")).toBe("retired");
  });

  it("looks its scenario up through one batched request for every badge on screen", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ flags: [{ scenario_id: "s2", kind: "env_failing", reason: "qa-run exited 3", action: "fix_env" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(withScenarios(h("div", null, h(ScenarioHealthBadge, { scenarioId: "s1" }), h(ScenarioHealthBadge, { scenarioId: "s2" }))));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/containers/c1/qa/scenario-health/flags?ids=s1%2Cs2");
    const pills = container.querySelectorAll("[data-scenario-health-badge]");
    expect(pills).toHaveLength(1);
    expect(pills[0].getAttribute("data-scenario-health-badge")).toBe("env_failing");
  });
});
