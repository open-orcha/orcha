// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { costTitle, costWords, parseOnboardingMap, priceWords, subscriptionWords, type OnboardingMap } from "./contract";
import { FIXTURE_LIVE_RUN_ID, fixture, fixtureAt } from "./fixtures";
import { mapBeat } from "./flow";
import {
  PANEL_KEY,
  doneNote,
  failureText,
  liveBannerKind,
  livePercent,
  livePlatformOf,
  screensSeen,
  liveTitle,
  readPanelOpen,
  recentSteps,
  retryDepth,
  waitingForDevice,
  writePanelOpen,
} from "./live-pass";


const liveView: { last: Record<string, unknown> | null } = { last: null };
vi.mock("../runs/live/LiveDeviceView", () => ({
  LiveDeviceView: (props: Record<string, unknown>) => {
    liveView.last = props;
    return null;
  },
}));

afterEach(() => cleanup());

const base = () => fixtureAt(fixture("small"), { phase: "live", progress: 0.55 });

describe("live_run in the contract", () => {
  it("parses a full live_run", () => {
    const m = parseOnboardingMap({
      project_id: "p",
      live_run: { request_id: "r1", status: "running", run_id: "run-1", exploration_id: "e1", depth: "deeper", targets: 9, reached: 4 },
    })!;
    expect(m.live_run).toEqual({ request_id: "r1", status: "running", run_id: "run-1", exploration_id: "e1", depth: "deeper", targets: 9, reached: 4 });
  });

  it("is null when missing, and when it has no request", () => {
    expect(parseOnboardingMap({ project_id: "p" })!.live_run).toBeNull();
    expect(parseOnboardingMap({ project_id: "p", live_run: null })!.live_run).toBeNull();
    expect(parseOnboardingMap({ project_id: "p", live_run: { status: "running" } })!.live_run).toBeNull();
    expect(parseOnboardingMap({ project_id: "p", live_run: ["r1"] })!.live_run).toBeNull();
  });

  it("falls back field by field on garbage", () => {
    const m = parseOnboardingMap({ project_id: "p", live_run: { request_id: "r1", status: 7, run_id: "", depth: "everything", targets: "nine", reached: -3 } })!;
    expect(m.live_run).toEqual({ request_id: "r1", status: "queued", depth: "overview", targets: 0, reached: 0 });
  });

  it("reads the pass's platform and why Embodent chose it", () => {
    const m = parseOnboardingMap({
      project_id: "p",
      found: {
        repo: { name: "ILM-FOR-YOU" },
        platforms: [{ kind: "ios", stack: "Flutter" }, { kind: "android", stack: "Flutter" }],
        unreadable: { ios: "its last iOS run saw 41 screens and could read none of them", web: "x" },
        live_platform: { kind: "android", why: "Mapping on Android: ..." },
      },
      live_run: { request_id: "r1", status: "queued", depth: "overview", targets: 7, reached: 0, platform: "android" },
    })!;
    expect(m.found.unreadable).toEqual({ ios: "its last iOS run saw 41 screens and could read none of them" });
    expect(m.found.live_platform).toEqual({ kind: "android", why: "Mapping on Android: ..." });
    expect(m.live_run?.platform).toBe("android");
    expect(livePlatformOf(m)).toBe("android");
    expect(livePlatformOf({ ...m, live_run: null })).toBe("android");
    expect(livePlatformOf({ ...m, live_run: null, found: { ...m.found, live_platform: undefined } })).toBe("ios");
  });

  it("counts a pass's screens on its own platform only", () => {
    const m = { found: { platforms: [] }, live_run: { platform: "web" }, screens: [{ platform: "ios", source: "live" }, { platform: "web", source: "code" }, { platform: "web", source: "live" }] } as never;
    expect(screensSeen(m)).toBe(1);
  });

  it("round-trips the fixtures", () => {
    const m = base();
    expect(m.live_run).toMatchObject({ run_id: FIXTURE_LIVE_RUN_ID, depth: "overview", status: "running" });
    expect(parseOnboardingMap(JSON.parse(JSON.stringify(m)))).toEqual(expect.objectContaining(m));
  });
});

describe("the live banner", () => {
  const at = (m: OnboardingMap) => liveBannerKind(m, mapBeat(m));

  it("shows the offer, then the pass, then how it ended", () => {
    expect(at(fixtureAt(fixture("small"), { phase: "code_map", progress: 0.5 }))).toBeNull();
    expect(at(fixtureAt(fixture("small"), { phase: "tests" }))).toBe("offer");
    expect(at(base())).toBe("running");
    expect(at(fixtureAt(fixture("small"), { phase: "coverage" }))).toBe("done");
    expect(at(fixtureAt(fixture("small"), { phase: "coverage", livePhase: { state: "failed", note: "step ceiling 400 reached" } }))).toBe("failed");
    expect(at(fixtureAt(fixture("small"), { phase: "coverage", liveSkipped: true }))).toBe("skipped");
  });

  it("counts main areas on the overview and screens when mapping deeper", () => {
    const m = base();
    expect(liveTitle("running", m, "iPhone 17 Pro")).toMatch(/^High-level map on iPhone 17 Pro: \d of 3 main areas seen$/);
    const done = fixtureAt(fixture("small"), { phase: "coverage" });
    expect(liveTitle("done", done, "iPhone 17 Pro")).toBe("High-level map done: 3 of 3 main areas seen");
    const deeper = fixtureAt(fixture("small"), { phase: "live", progress: 0.5, liveRun: { depth: "deeper", targets: 8, reached: 3 } });
    expect(liveTitle("running", deeper, "iPhone 17 Pro")).toBe("Mapping deeper on iPhone 17 Pro: 3 of 8 screens reached");
    expect(livePercent(deeper)).toBe(38);
    const one = fixtureAt(fixture("small"), { phase: "live", progress: 0.5, liveRun: { targets: 1, reached: 1 } });
    expect(liveTitle("running", one, "Pixel 9a")).toBe("High-level map on Pixel 9a: 1 of 1 main area seen");
  });

  it("falls back to screens seen when the backend names no targets", () => {
    const m = fixtureAt(fixture("small"), { phase: "live", progress: 0.5, liveRun: null });
    expect(liveTitle("running", m, "iPhone 17 Pro")).toBe("Live pass on iPhone 17 Pro: 6 of 12 screens seen");
    const zero = fixtureAt(fixture("small"), { phase: "live", progress: 0.5, liveRun: { targets: 0 } });
    expect(liveTitle("running", zero, "iPhone 17 Pro")).toBe("High-level map on iPhone 17 Pro: 6 screens seen so far");
  });

  it("waits for a device until the run exists", () => {
    expect(waitingForDevice(null)).toBe(true);
    expect(waitingForDevice({ request_id: "r", status: "queued", depth: "overview", targets: 4, reached: 0 })).toBe(true);
    expect(waitingForDevice(base().live_run)).toBe(false);
  });

  it("retries at the same depth", () => {
    expect(retryDepth(null)).toBe("overview");
    expect(retryDepth({ request_id: "r", status: "failed", depth: "deeper", targets: 0, reached: 0 })).toBe("deeper");
  });

  it("shows how a pass ended and says a failure in plain words", () => {
    expect(doneNote("Stopped at the time budget: 6 of 7 main areas seen.")).toBe("Stopped at the time budget: 6 of 7 main areas seen");
    expect(doneNote("Stopped at the step guard (2000 steps): 101 screens mapped")).toContain("step guard");
    expect(doneNote("Every main area is already on the map")).toBe("Every main area is already on the map");
    expect(doneNote("The crawl finished; what it saw is on the map")).toBeNull();
    expect(doneNote(undefined)).toBeNull();
    expect(failureText(undefined)).toBe("The device was not reachable");
    expect(failureText("It hit the step limit before it could write its report.")).toBe("It hit the step limit before it could write its report");
    expect(failureText("step ceiling 400 reached")).toBe("It hit the step limit (400 steps) before it could write its report");
    expect(failureText("stalled: no new step for 5 min")).toBe("The device stopped responding for 5 minutes");
    expect(failureText("qa-run timed out after 1500 s")).toBe("It ran out of time after 25 minutes");
    expect(failureText("no booted simulator")).toBe("No booted simulator");
  });
});

describe("what the pass costs", () => {
  it("says the API-price figure, not charged, on a subscription, the estimate on a key", () => {
    const sub = { run: "Claude Code", draft: null };
    expect(costWords(sub, "run", 0.61)).toBe("≈$0.61 at API prices");
    expect(costWords(sub, "run", undefined)).toBe("not charged");
    expect(priceWords(sub, "run", 0.61)).toBe("≈$0.61 at API prices");
    expect(costTitle(sub, "run", 0.61)).toBe("Not charged: this runs on your Claude Code subscription. At API prices it would be $0.61.");
    expect(costTitle(sub, "draft", 0.61)).toBeUndefined();
    expect(subscriptionWords(sub, "run")).toBe("On your Claude Code subscription, not charged");
    expect(subscriptionWords(sub, "run", 0.3)).toBe("On your Claude Code subscription: ≈$0.30 at API prices, not charged");
    expect(costWords(sub, "draft", 0.61)).toBe("about $0.61");
    expect(subscriptionWords(sub, "draft")).toBeNull();
    expect(parseOnboardingMap({ project_id: "p", billing: { run: "Claude Code", draft: 3 } })!.billing).toEqual({ run: "Claude Code", draft: null });
    expect(parseOnboardingMap({ project_id: "p" })!.billing).toEqual({ run: null, draft: null });
  });

  it("the progress track shows the live pass at API prices on a subscription", async () => {
    const { PhaseTrack } = await import("./map-step");
    const at = fixtureAt(fixture("small"), { phase: "tests" });
    const priced = { ...at, phases: { ...at.phases, live: { ...at.phases.live, state: "pending" as const, estimate_usd: 0.61 } } };
    render(h(PhaseTrack, { map: priced }));
    expect(document.querySelector('[data-phase="live"]')!.textContent).toContain("about $0.61");
    cleanup();
    render(h(PhaseTrack, { map: { ...priced, billing: { run: "Claude Code", draft: null } } }));
    const live = document.querySelector('[data-phase="live"]')!.textContent!;
    expect(live).toContain("≈$0.61 at API prices");
    expect(live).not.toContain("not metered");
    expect(document.querySelector('[data-phase="live"] [data-phase-cost]')?.getAttribute("title")).toMatch(/^Not charged: /);
  });
});

describe("the side panel", () => {
  it("is collapsed until the viewer opens it, and survives storage that throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readPanelOpen(storage)).toBe(false);
    writePanelOpen(storage, true);
    expect(store.get(PANEL_KEY)).toBe("open");
    expect(readPanelOpen(storage)).toBe(true);
    writePanelOpen(storage, false);
    expect(readPanelOpen(storage)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readPanelOpen(broken)).toBe(false);
    expect(() => writePanelOpen(broken, true)).not.toThrow();
    expect(readPanelOpen(null)).toBe(false);
  });

  it("lists the newest steps first, live ones over the seeded", () => {
    const steps = recentSteps([{ seq: 1, v: "a" }, { seq: 2, v: "a" }], [{ seq: 2, v: "b" }, { seq: 3, v: "b" }], 2);
    expect(steps).toEqual([{ seq: 3, v: "b" }, { seq: 2, v: "b" }]);
  });

  it("says what a step acted on, as a session records it", async () => {
    const { summarizeStep } = await import("./live-run-panel");
    expect(summarizeStep({ kind: "tap", args: { target: { spec: "e7", label: "Sign in", role: "button" } } })).toBe("tap Sign in");
    expect(summarizeStep({ kind: "tap", args: { target: { spec: "e7" } } })).toBe("tap e7");
    expect(summarizeStep({ kind: "tap", args: { target: "Settings" } })).toBe("tap Settings");
    expect(summarizeStep({ kind: "screen", args: {} })).toBe("screen");
  });

  it("waits for a device before the run exists, then shows the device, the steps and the full run", async () => {
    const { LiveRunPanel } = await import("./live-run-panel");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ steps: [
        { seq: 41, kind: "tap", args: { target: "Settings" }, result: "tapped", frame_id: "f41" },
        { seq: 42, kind: "screen", args: {}, result: null, frame_id: null },
      ] }),
    })));
    const onCollapse = vi.fn();
    const waiting = { request_id: "r", status: "queued", depth: "overview" as const, targets: 4, reached: 0 };
    const panel = (run: typeof waiting & { run_id?: string }) => h(MemoryRouter, null, h(LiveRunPanel, { id: "panel", run, kind: "ios", device: "iPhone 17 Pro", onCollapse }));
    const { rerender } = render(panel(waiting));
    expect(screen.getByRole("status").textContent).toContain("Waiting for a device…");
    fireEvent.click(screen.getByRole("button", { name: /Collapse/ }));
    expect(onCollapse).toHaveBeenCalledOnce();

    rerender(panel({ ...waiting, status: "running", run_id: "run-9" }));
    expect((await screen.findByRole("link", { name: /Open the run/ })).getAttribute("href")).toBe("/qa?view=sessions&session=run-9");
    expect(await screen.findByText("42")).toBeTruthy();
    expect(document.querySelector("[aria-current='step']")?.getAttribute("data-onboarding-live-panel-step")).toBe("42");
    // The live view gets the session and the newest stored frame, until the first live one arrives.
    await waitFor(() => expect(liveView.last).toMatchObject({ sessionId: "run-9", platform: "ios", fallbackFrameId: "f41", fit: true }));
    expect(screen.getByRole("button", { name: /Collapse/ }).getAttribute("aria-controls")).toBe("panel");
  });
});
