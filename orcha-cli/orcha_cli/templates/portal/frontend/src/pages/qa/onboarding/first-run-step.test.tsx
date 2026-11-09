import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstRunStep } from "./first-run-step";
import { runPlacement, runsOnSummary, type SummaryPlan } from "./runs-on-summary";
import { initialState, stateFromFound, validateFirstRun, type WizardState } from "./state";
import type { FoundSheet } from "./contract";

const FOUND = { repo: { path: "/w/app", name: "app" }, platforms: [{ kind: "ios", app_id: "com.a" }, { kind: "web", app_id: "http://localhost:3000" }], environments: [], tests: [], ci: [], defaults: {} } as unknown as FoundSheet;
const two = (over: Partial<WizardState> = {}): WizardState => ({ ...stateFromFound(initialState(), FOUND), firstRunTargetKey: "detected:ios:0", ...over });
const one = (over: Partial<WizardState> = {}) => two({ targets: two().targets.filter((t) => t.kind === "ios"), ...over });
const PLAN: SummaryPlan = { placement: runPlacement({ kind: "ios", device: { kind: "ios", name: "iPhone 17 Pro" } }), minutes: 20 };

afterEach(cleanup);

describe("onboarding First run", () => {
  it("exploratory: the budget and the focus, the full dialog a click away", () => {
    const onMore = vi.fn();
    const { container } = render(<FirstRunStep state={one()} set={vi.fn()} plans={[PLAN]} onMore={onMore} />);
    expect(container.querySelector("[data-onboarding-first-exploration]")).not.toBeNull();
    expect(container.querySelector("#onb-scenario")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(onMore).toHaveBeenCalled();
  });

  it("scenarios keep the scenario file and the Runs on summary", () => {
    const { container } = render(<FirstRunStep state={one({ mode: "scenarios" })} set={vi.fn()} plans={[{ ...PLAN, minutes: null, file: "scenarios/smoke.md" }]} onMore={vi.fn()} />);
    expect(container.querySelector("[data-onboarding-first-exploration]")).toBeNull();
    expect(container.querySelector("#onb-scenario")).not.toBeNull();
    expect(container.querySelector("[data-runs-on-platform='ios']")?.textContent).toContain("smoke.md");
  });

  it("says one platform, or all of them, only when there are several", () => {
    const set = vi.fn();
    const { container, rerender } = render(<FirstRunStep state={one()} set={set} plans={[PLAN]} onMore={vi.fn()} />);
    expect(container.querySelector("[data-first-run-scope]")).toBeNull();
    rerender(<FirstRunStep state={two()} set={set} plans={[PLAN]} onMore={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "All platforms (2)" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("radio", { name: "All platforms (2)" }));
    expect(set).toHaveBeenCalledWith("firstRunScope", "all");
    expect(container.querySelector("[data-first-run-target='web']")).not.toBeNull();
    rerender(<FirstRunStep state={two({ firstRunScope: "all" })} set={set} plans={[PLAN]} onMore={vi.fn()} />);
    expect(container.querySelector("[data-first-run-target='web']")).toBeNull();
  });

  it("the Runs on summary names the device, or says it is the default", () => {
    expect(runsOnSummary([PLAN])).toBe("Runs on: iOS · iPhone 17 Pro (local)");
    expect(runPlacement({ kind: "android" })).toMatchObject({ device: "Any running emulator", isDefault: true });
    expect(runPlacement({ kind: "web", device: { kind: "web", viewport: "mobile" } }).device).toBe("Mobile browser (390×844)");
    expect(runPlacement({ kind: "ios", device: { kind: "web", viewport: "mobile" } }).isDefault).toBe(true);
  });

  it("a time budget has its limits; a scenarios run has none", () => {
    expect(validateFirstRun(one({ minutes: "20" }))).toBeNull();
    expect(validateFirstRun(one({ minutes: "2" }))).toBe("Give it between 5 and 240 minutes.");
    expect(validateFirstRun(one({ minutes: "abc" }))).toBe("Give it between 5 and 240 minutes.");
    expect(validateFirstRun(one({ minutes: "2", mode: "scenarios" }))).toBeNull();
  });
});
