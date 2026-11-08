/**
 * The onboarding flow on Embodent's routes: a person's first look reads the folder, We found shows
 * what it found and confirm saves it, the map steps follow the row, and a viewer only reads.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ToastProvider } from "../../../components/ui";
import { SnapshotProvider } from "../../../state/SnapshotProvider";
import type { QaAuthority } from "../authority";
import { OnboardingFlow, stepOfPhase } from "./OnboardingFlow";

const HUMAN = { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" };
const FORGE = { id: "a1", alias: "forge", kind: "ai", role: "QA", status: "idle" };
const AUTH: QaAuthority = { can: true, human: HUMAN as never, reason: null };

const phase = (state: string, extra: object = {}) => ({ state, ...extra });
const pending = { found: phase("pending"), code_map: phase("pending"), tests: phase("pending"), live: phase("pending"), coverage: phase("pending"), bring_in: phase("pending"), first_run: phase("pending"), done: phase("pending") };
const FOUND = {
  repo: { path: "/work/truckline", name: "truckline" },
  platforms: [{ kind: "ios", app_id: "com.truckline.app", stack: "Native iOS", path: "ios" }, { kind: "web", path: "web" }],
  environments: [{ name: "Local", base_url: "http://localhost:5173" }],
  tests: [{ framework: "xcuitest", count: 3, path: "ios/Tests" }],
  defaults: {},
};
const base = { project_id: "c1", container_id: "c1", phase: "found", state: "idle", phases: pending, found: {}, options: {}, error: null, unavailable: null, screens: [], edges: [], files: [], gaps: [], summary: {}, bring_in: {}, first_test: null, smoke: null, live_run: null, billing: { run: null, draft: null } };
const foundRow = { ...base, phase: "found", state: "waiting", phases: { ...pending, found: phase("done") }, found: FOUND };
const liveOffer = {
  ...foundRow, phase: "live", phases: { ...pending, found: phase("done"), code_map: phase("done"), tests: phase("done"), live: phase("pending", { estimate_usd: 0.4 }) },
  screens: [{ id: "ios:Home", name: "Home", platform: "ios", source: "code", files: ["ios/Home.swift"], endpoints: [], coverage: "none", tests: [], scenarios: [], risk: { score: 40, reasons: ["Reached first"] } }],
  summary: { screens: 1, covered_by_tests: 0, uncovered: 1, untested_critical: [] },
};

const IPHONE = { kind: "ios", name: "iPhone 17 Pro", udid: "U1", runtime: "iOS 26.5", state: "booted" };

interface Call { url: string; method: string; body: any }
let calls: Call[] = [];
let row: object;

function stub(respond?: (c: Call) => { status: number; body: unknown } | null) {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { url, method, body };
    calls.push(call);
    const res = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;
    const over = respond?.(call);
    if (over) return res(over.body, over.status);
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1/qa/devices")) return res({ devices: [IPHONE], available: true });
    if (url === "/api/containers/c1/tasks") return res({ task_id: "t1" }, 201);
    if (url === "/api/containers/c1/qa/onboarding" && method === "GET") return res(row);
    if (url === "/api/containers/c1/qa/onboarding") {
      if (body.action === "start") row = foundRow;
      return res({ project_id: "c1", phase: "found", state: "running", phases: { ...pending, found: phase("running") } }, 202);
    }
    if (url.startsWith("/api/containers/c1")) return res({ container: { id: "c1", name: "Acme", status: "active" }, agents: [HUMAN, FORGE], tasks: [], requests: [] });
    return res({});
  }) as unknown as typeof fetch;
}

function mount(auth: QaAuthority = AUTH, cbs: { onManual?: () => void } = {}) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter>
          <OnboardingFlow cid="c1" auth={auth} onManual={cbs.onManual ?? (() => undefined)} onOpenMap={() => undefined} onRunQa={() => undefined} />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const posts = () => calls.filter((c) => c.method === "POST");
const onboardingPosts = () => posts().filter((c) => c.url.endsWith("/qa/onboarding"));

beforeEach(() => {
  row = base;
  stub();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

describe("OnboardingFlow", () => {
  it("names the six steps and opens where the row says", () => {
    expect(stepOfPhase("found", false)).toBe("connect");
    expect(stepOfPhase("found", true)).toBe("found");
    expect(stepOfPhase("live", true)).toBe("map");
    expect(stepOfPhase("coverage", true)).toBe("coverage");
    expect(stepOfPhase("bring_in", true)).toBe("bring_in");
    expect(stepOfPhase("bring_in", true, false)).toBe("coverage");
    expect(stepOfPhase("first_run", true)).toBe("first_run");
    expect(stepOfPhase("done", true)).toBe("first_run");
  });

  it("reads the folder on its own, shows what it found, and confirm saves it — nobody types a bundle id", async () => {
    mount();
    await waitFor(() => expect(onboardingPosts()[0]?.body).toMatchObject({ action: "start", actor_agent_id: "h1" }));
    const rail = screen.getByRole("navigation", { name: "Onboarding steps" });
    expect(rail.textContent).toContain("We found");
    const next = await screen.findByRole("button", { name: "Continue" });
    await waitFor(() => expect(next).toBeEnabled());
    expect(document.querySelector("[data-detected-platforms]")?.textContent).toContain("iOS (ios, com.truckline.app)");
    fireEvent.click(next);
    await screen.findByRole("heading", { name: "Here is what we found" });
    const platforms = document.querySelector("[data-found-row='platforms']") as HTMLElement;
    expect(within(platforms).getByText("com.truckline.app")).toBeInTheDocument();
    expect(within(platforms).getByText("Native iOS")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    await screen.findByText("forge");
    fireEvent.click(screen.getByRole("button", { name: "Save and map" }));
    await waitFor(() => expect(onboardingPosts().some((c) => c.body.action === "confirm")).toBe(true));
    const confirm = onboardingPosts().find((c) => c.body.action === "confirm")!;
    expect(confirm.body.options.platforms).toEqual([
      { kind: "ios", app_id: "com.truckline.app", app_name: null, device_name: null },
      { kind: "web", app_id: "http://localhost:5173", app_name: null, device_name: "desktop" },
    ]);
    expect(confirm.body.options).toMatchObject({ live: "ask", agent_id: "a1" });
  });

  it("a reopened row waiting for Save and map lands on We found, never a stuck Map step", async () => {
    row = { ...foundRow, phase: "code_map", state: "waiting" };
    mount();
    await screen.findByRole("heading", { name: "Here is what we found" });
    expect(screen.getByRole("button", { name: "Save and map" })).toBeEnabled();
    expect(screen.queryByText("Getting ready to map your app")).toBeNull();
  });

  it("a first run with nothing to run still has a way forward", async () => {
    const done = phase("done");
    row = { ...foundRow, phase: "first_run", state: "waiting", phases: { ...pending, found: done, code_map: done, tests: done, live: done, coverage: done, bring_in: phase("skipped") }, screens: liveOffer.screens, summary: liveOffer.summary };
    const onOpenMap = vi.fn();
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter>
            <OnboardingFlow cid="c1" auth={AUTH} onManual={() => undefined} onOpenMap={onOpenMap} onRunQa={() => undefined} />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    await screen.findByText("Nothing to run yet");
    fireEvent.click(screen.getByRole("button", { name: "Go to Quality" }));
    expect(onOpenMap).toHaveBeenCalled();
  });

  it("keeps Save and map one click away when a confirm fails", async () => {
    row = foundRow;
    stub((c) => (c.method === "POST" && c.body?.action === "confirm" ? { status: 409, body: { detail: "Pick a platform." } } : null));
    mount();
    await screen.findByRole("heading", { name: "Here is what we found" });
    fireEvent.click(screen.getByRole("button", { name: "Save and map" }));
    await screen.findByText("Pick a platform.");
    await screen.findByRole("heading", { name: "Here is what we found" });
    expect(screen.getByRole("button", { name: "Save and map" })).toBeEnabled();
  });

  it("offers the booted simulator and saves the picked device by its name", async () => {
    row = foundRow;
    mount();
    await screen.findByRole("heading", { name: "Here is what we found" });
    const edit = document.querySelector("[data-found-edit='device']") as HTMLElement;
    fireEvent.click(edit);
    fireEvent.click(await waitFor(() => {
      const option = document.querySelector("[data-device-option='ios:U1']") as HTMLElement;
      expect(option).not.toBeNull();
      return option;
    }));
    await waitFor(() => expect(document.querySelector("[data-found-row='device']")?.textContent).toContain("iPhone 17 Pro"));
    fireEvent.click(screen.getByRole("button", { name: "Save and map" }));
    await waitFor(() => expect(onboardingPosts().some((c) => c.body.action === "confirm")).toBe(true));
    const confirm = onboardingPosts().find((c) => c.body.action === "confirm")!;
    expect(confirm.body.options.platforms[0]).toMatchObject({ kind: "ios", device_name: "iPhone 17 Pro" });
  });

  it("a reload brings back what was edited, and Start over forgets it", async () => {
    row = foundRow;
    sessionStorage.setItem("orcha:qa-onboarding:c1", JSON.stringify({ targets: [], touched: true, deviceKeys: { ios: "ios:U1" }, livePass: false }));
    mount();
    await screen.findByRole("heading", { name: "Here is what we found" });
    await screen.findByText("Picked up where you left off before the page reloaded.");
    await waitFor(() => expect(document.querySelector("[data-found-row='device']")?.textContent).toContain("iPhone 17 Pro"));
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.queryByText("Picked up where you left off before the page reloaded.")).toBeNull();
    expect(document.querySelector("[data-found-row='device']")?.textContent).toContain("Any booted simulator");
    expect(sessionStorage.getItem("orcha:qa-onboarding:c1")).toBeNull();
  });

  it("the live pass waits for Run on the Map step", async () => {
    row = liveOffer;
    mount();
    const run = await screen.findByRole("button", { name: "Run the high-level map" });
    expect(document.querySelector("[data-onboarding-live='offer']")?.textContent).toContain("Next: a high-level map on");
    expect(screen.getByRole("button", { name: "See coverage" })).toBeDisabled();
    expect(document.querySelector("[data-onboarding-gate]")?.textContent).toBe("Run the live pass, or skip it to go on.");
    fireEvent.click(run);
    await waitFor(() => expect(onboardingPosts()[0]?.body).toMatchObject({ action: "run_live", options: { depth: "overview" } }));
  });

  it("a live pass goes straight to its run page at the click, with no session yet, and keeps the way back", async () => {
    window.history.pushState({}, "", "/");
    row = { ...liveOffer, options: {} };
    stub();
    let at = "";
    const Where = () => { const l = useLocation(); at = l.pathname + l.search; return null; };
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter initialEntries={["/qa?view=onboarding&step=map"]}>
            <Where />
            <OnboardingFlow cid="c1" auth={AUTH} onManual={() => undefined} onOpenMap={() => undefined} onRunQa={() => undefined} />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Run the high-level map/ }));
    await waitFor(() => expect(at).toContain("view=run"));
    const url = new URL(at, "http://x");
    expect(url.searchParams.get("pass")).toBe("live");
    expect(url.searchParams.get("from")).toBe("?view=onboarding&step=map&after=live");
    // the project's QA agent is on the run, though nobody picked one
    expect(calls.find((c) => c.body?.action === "run_live")?.body.options.agent_id).toBe("a1");
  });

  it("when the folder can't be read it says so and offers the Apps form", async () => {
    row = { ...base, unavailable: "This portal can't read the project folder." };
    const onManual = vi.fn();
    mount(AUTH, { onManual });
    fireEvent.click(await screen.findByRole("button", { name: "Set the app by hand" }));
    expect(onManual).toHaveBeenCalled();
    expect(onboardingPosts()).toHaveLength(0);
    expect(screen.getByText("This portal can't read the project folder.")).toBeInTheDocument();
  });

  it("a viewer reads: no write is sent, and the reason shows", async () => {
    row = foundRow;
    mount({ can: false, human: null, reason: "Your role is viewer (read-only)" });
    await screen.findByRole("heading", { name: "Here is what we found" });
    expect(screen.getByText("Your role is viewer (read-only)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and map" })).toBeDisabled();
    expect(onboardingPosts()).toHaveLength(0);
  });
});
