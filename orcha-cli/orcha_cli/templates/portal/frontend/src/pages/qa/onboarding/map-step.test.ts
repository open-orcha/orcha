// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OnboardingMap } from "./contract";
import { fixture, fixtureAt } from "./fixtures";
import { liveStageText } from "./live-pass";
import { MapStep } from "./map-step";

vi.mock("./map-stage", () => ({ MapStage: () => h("div", { "data-map-stage": "" }) }));
vi.mock("@/components/projects/live-device-peek", () => ({ LiveDevicePeek: ({ runId }: { runId: string }) => h("aside", { "data-live-peek": runId }) }));
vi.mock("@/components/live/use-live-run", () => ({ useLiveRun: () => ({ liveSteps: [], isLive: true }) }));
vi.mock("@/components/shell/return-back", () => ({ useWithReturn: () => (href: string) => href }));
vi.mock("@/lib/db/browser", () => {
  const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => Promise.resolve({ data: [] }) };
  return { getBrowserClient: () => ({ from: () => chain }) };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The code and the tests are mapped; the live pass is offered (pending). */
const offered = (): OnboardingMap => {
  const m = fixtureAt(fixture("small"), { phase: "tests" });
  m.phases.live = { state: "pending", estimate_usd: 3.95 };
  return m;
};

function renderStep(map: OnboardingMap, extra: Partial<Parameters<typeof MapStep>[0]> = {}) {
  const onAct = vi.fn();
  render(
    h(MapStep, {
      load: { kind: "ready", map },
      planRef: { current: null },
      busy: null,
      device: "any booted simulator",
      livePass: true,
      onAct,
      onRetry: () => undefined,
      onClassic: () => undefined,
      ...extra,
    }),
  );
  return onAct;
}

describe("the live pass waits for a click (#454)", () => {
  it("shows no money, never starts by itself, and starts on Run", async () => {
    vi.useFakeTimers();
    const onAct = renderStep(offered(), { building: { local: true } });
    const offer = document.querySelector("[data-onboarding-live='offer']") as HTMLElement;
    expect(offer.textContent).toContain("Next: a high-level map on any booted simulator");
    expect(offer.textContent).not.toMatch(/\$|API prices|charged/);
    expect(offer.textContent).toContain("Embodent does not build your code: it opens the build already installed on");
    expect(offer.textContent).toContain("It starts when you click Run.");
    expect(offer.textContent).not.toMatch(/Starts in/);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run the high-level map" }));
    expect(onAct).toHaveBeenCalledWith("run_live", { depth: "overview" });
  });

  it("says before it starts when the build reaches production, or when Embodent cannot tell", () => {
    renderStep(offered(), { backendLine: { tone: "production", text: "This build talks to Supabase at abcdefghijklmnopqrst.supabase.co, a production system: the pass is read-only." } });
    expect(document.querySelector("[data-onboarding-live-backend='production']")?.textContent).toContain("a production system: the pass is read-only.");
    cleanup();
    renderStep(offered(), { backendLine: { tone: "unknown", text: "Embodent could not tell which backend this build talks to." } });
    expect(document.querySelector("[data-onboarding-live-backend='unknown']")).not.toBeNull();
  });

  it("turned off on We found, it is skipped when its turn comes", () => {
    const onAct = renderStep(offered(), { livePass: false });
    expect(onAct).toHaveBeenCalledWith("skip_live");
  });
});

describe("while the app compiles the card says so, not 'Waiting for a device' (#454)", () => {
  const running = (stage: NonNullable<OnboardingMap["live_run"]>["stage"], runId?: string): OnboardingMap => {
    const m = fixtureAt(fixture("small"), { phase: "live", progress: 0.1 });
    m.live_run = { request_id: "r1", status: "running", depth: "overview", targets: 4, reached: 0, platform: "ios", stage, ...(runId ? { run_id: runId } : {}) };
    return m;
  };

  it("names each stage before the device shows the app", () => {
    expect(liveStageText({ request_id: "r", status: "queued", depth: "overview", targets: 4, reached: 0 }, "any booted simulator")?.title).toBe("Waiting for a device");
    expect(liveStageText({ request_id: "r", status: "running", depth: "overview", targets: 4, reached: 0, stage: "building" }, "x", { local: true })).toEqual({
      title: "Building the app",
      detail: "Compiling it in your local checkout, with its dependencies installed there. This can take a few minutes; the device shows once the app is installed.",
    });
    expect(liveStageText({ request_id: "r", status: "running", depth: "overview", targets: 4, reached: 0, stage: "installing" }, "iPhone 17 Pro")?.title).toBe("Installing the app");
    expect(liveStageText({ request_id: "r", status: "running", depth: "overview", targets: 4, reached: 0, stage: "mapping", run_id: "run-1" }, "x")).toBeNull();
    expect(liveStageText({ request_id: "r", status: "running", depth: "overview", targets: 4, reached: 0, run_id: "run-1" }, "x")).toBeNull();
  });

  it("the banner and the side panel say Building the app while it compiles", () => {
    window.localStorage.setItem("orcha.qa.onboarding.liveRunPanel", "open");
    renderStep(running("building"), { building: { local: true } });
    const card = document.querySelector("[data-onboarding-live='running']") as HTMLElement;
    expect(card.getAttribute("data-onboarding-live-stage")).toBe("building");
    expect(card.textContent).toContain("Building the app");
    expect(card.textContent).not.toContain("Waiting for a device");
    const panel = document.querySelector("[data-onboarding-live-panel='waiting']") as HTMLElement;
    expect(panel.textContent).toContain("Building the app…");
    expect(panel.querySelector("[data-onboarding-live-panel-stage='building']")).not.toBeNull();
    expect(document.querySelector("[data-live-peek]")).toBeNull();
    window.localStorage.removeItem("orcha.qa.onboarding.liveRunPanel");
  });
});
