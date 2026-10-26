/**
 * GH #148/#149: the fused 4-rung AutonomySwitch is split into two independent
 * controls — V2: both live in the header "Execution controls" popover (S-12/S-13) — Notifier (binary, wakes_enabled) and Autonomy (3-level,
 * autonomy_level). Port of the vanilla app-autonomy.js / app-shell.js split:
 * the two controls must POST to their own endpoints without touching the
 * other field, and never render as a single 4-rung radiogroup.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { HomePage } from "../pages/home/HomePage";
import { execChipState, wakesDetail, wakesObserved } from "./Shell";

interface Call { url: string; method: string; body: unknown }

type SnapOpts = { wakes_enabled?: boolean; autonomy_level?: string; last_wake_scan_at?: string | null };
const rawSnap = (opts: SnapOpts = {}) => ({
  container: {
    id: "c1", name: "Orcha", status: "active",
    autonomy_level: opts.autonomy_level ?? "plan",
    wakes_enabled: opts.wakes_enabled ?? true,
    ...("last_wake_scan_at" in opts ? { last_wake_scan_at: opts.last_wake_scan_at } : {}),
  },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
});

function stubFetch(opts: SnapOpts = {}): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1/wakes")) return json({ wakes_enabled: !(opts.wakes_enabled ?? true) });
    if (url.startsWith("/api/containers/c1/autonomy")) return json({ autonomy_level: "pr" });
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(opts));
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <HomePage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

/** V2: the two controls live in the header's Execution controls popover. */
async function openExec() {
  await waitFor(() => expect(document.getElementById("execBtn")).toBeTruthy());
  fireEvent.click(document.getElementById("execBtn")!);
  await waitFor(() => expect(document.getElementById("notifTop")).toBeTruthy());
}

describe("Shell — Notifier / Autonomy split (GH #148/#149)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the wake switch without a project autonomy control", async () => {
    stubFetch(); mount(); await openExec();
    expect(document.getElementById("notifTop")!.getAttribute("role")).toBe("group");
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(document.getElementById("autTop")).toBeNull();
    expect(screen.getByText(/Autonomy is set on each task/)).toBeInTheDocument();
  });

  it("labels the remaining execution control Wakes", async () => {
    stubFetch(); mount(); await openExec();
    expect(Array.from(document.querySelectorAll(".aut-lab")).map(n => n.textContent)).toEqual(["Wakes"]);
  });

  it("Notifier click posts to /wakes only, leaving autonomy_level untouched in the body", async () => {
    const calls = stubFetch({ wakes_enabled: true, autonomy_level: "pr" });
    mount();
    await openExec();
    fireEvent.click(document.getElementById("notifTop")!.querySelector(".seg")!);
    // running -> paused is destructive, confirm modal first
    fireEvent.click(screen.getByRole("button", { name: /Pause all wakes/i }));
    await waitFor(() => {
      const w = calls.find((c) => c.url === "/api/containers/c1/wakes");
      expect(w).toBeTruthy();
      expect(w!.method).toBe("POST");
      expect(w!.body).toEqual({ enabled: false, actor_agent_id: "h1" });
    });
    expect(calls.some((c) => c.url === "/api/containers/c1/autonomy")).toBe(false);
  });

  it("legacy autonomy values never expose a project write", async () => {
    const calls = stubFetch({ autonomy_level: "full" }); mount(); await openExec();
    expect(screen.queryByRole("radio", { name: "Full" })).toBeNull();
    expect(document.getElementById("autTop")).toBeNull();
    expect(calls.filter(c => c.method !== "GET")).toEqual([]);
  });

  it("paused wakes still use task authority and never expose project presets", async () => {
    stubFetch({ wakes_enabled: false, autonomy_level: "plan" }); mount(); await openExec();
    expect(document.getElementById("notifTop")!.textContent).toContain("Off");
    expect(document.getElementById("autTop")).toBeNull();
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByText("Eligible tasks resume waking with their own OFF/ON settings.")).toBeVisible();
  });
});

describe("V2 header — Execution controls summary + persistent paused indicator", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("the chip shows observed wake state and explains task authority", async () => {
    stubFetch({ wakes_enabled: true, autonomy_level: "pr" });
    mount();
    await waitFor(() => expect(document.getElementById("execBtn")?.getAttribute("title")).toMatch(/^Execution —/));
    expect(document.getElementById("execBtn")!.getAttribute("title")).not.toContain("Autonomy:");
    expect(document.getElementById("execBtn")!.textContent).not.toContain("Build to PR");
    fireEvent.click(document.getElementById("execBtn")!);
    const dlg = await screen.findByRole("dialog", { name: "Execution controls" });
    expect(dlg.querySelector(".v2-exec-note")).toBeNull();
    expect(dlg.querySelector(".v2-exec-info")!.getAttribute("title")).toMatch(/does not stop runs already in flight/);
  });

  it("paused: the danger Execution chip is the ONE paused marker (no chip, stripe or bar)", async () => {
    stubFetch({ wakes_enabled: false, autonomy_level: "plan" });
    mount();
    await waitFor(() => expect(document.getElementById("execBtn")?.textContent).toContain("Paused"));
    expect(document.getElementById("execBtn")!.className).toContain("is-paused");
    expect(screen.queryByText(/Wakes paused/)).toBeNull();
    expect(document.getElementById("pausebar")).toBeNull();
    expect(document.querySelectorAll(".v2-header.paused").length).toBe(0);
  });
});

describe("Execution truthfulness — chip (observed) vs switch (config) never contradict", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  const now = Date.parse("2026-09-28T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("execChipState / wakesObserved map every notifier state", () => {
    expect(execChipState({ wakes_enabled: false }, now)).toBe("Paused");
    expect(execChipState({ wakes_enabled: true, last_wake_scan_at: ago(30_000) }, now)).toBe("Running");
    expect(execChipState({ wakes_enabled: true, last_wake_scan_at: ago(12 * 60_000) }, now)).toBe("Not running");
    expect(execChipState({ wakes_enabled: true, last_wake_scan_at: null }, now)).toBe("No wake service");
    expect(execChipState({ wakes_enabled: true }, now)).toBe("Wakes on");
    expect(wakesObserved({ wakes_enabled: true, last_wake_scan_at: ago(12 * 60_000) }, now)).toBe("On, but no wake scan in 12m");
    expect(wakesObserved({ wakes_enabled: true, last_wake_scan_at: null }, now)).toMatch(/no wake service/);
    expect(wakesObserved({ wakes_enabled: false }, now)).toMatch(/^Off/);
    expect(wakesObserved({ wakes_enabled: true, last_wake_scan_at: ago(20_000) }, now)).toMatch(/^On · wake service active/);
  });

  it("stale scan + wakes enabled: nothing on screen says Running", async () => {
    stubFetch({ wakes_enabled: true, last_wake_scan_at: new Date(Date.now() - 12 * 60_000).toISOString() });
    mount();
    await openExec();
    const chip = document.getElementById("execBtn")!;
    expect(chip.textContent).toContain("Not running");
    const sw = document.querySelector<HTMLElement>("#notifTop [role=switch]")!;
    expect(sw.textContent).toContain("On");
    expect(sw.getAttribute("aria-label")).toBe("Agent wakes: On");
    expect(document.getElementById("notifDesc")!.textContent).toMatch(/^No wake scan in 1[12]m · not running$/);
    const dlg = screen.getByRole("dialog", { name: "Execution controls" });
    expect(dlg.textContent).not.toMatch(/Running/);
    expect(chip.textContent).not.toMatch(/\bRunning\b/);
  });

  it("a legacy level is never presented as current execution authority", async () => {
    stubFetch({ autonomy_level: "supervised" }); mount(); await openExec();
    expect(screen.getByRole("dialog", { name: "Execution controls" }).textContent).not.toContain("supervised");
    expect(document.getElementById("execBtn")!.getAttribute("title")).not.toContain("supervised");
    expect(document.getElementById("autTop")).toBeNull();
  });

  it("a known level renders no Custom segment", async () => {
    stubFetch({ wakes_enabled: true, autonomy_level: "pr" });
    mount();
    await openExec();
    expect(document.querySelector("#autTop .seg.custom")).toBeNull();
  });

  it("wakesDetail never repeats the switch's On/Off word (review m1)", () => {
    const now = Date.parse("2026-01-01T00:10:00Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(wakesDetail({ wakes_enabled: true, last_wake_scan_at: ago(53_000) }, now)).toBe("Wake service active · last scan 53s ago");
    expect(wakesDetail({ wakes_enabled: true, last_wake_scan_at: ago(3 * 60_000) }, now)).toBe("No wake scan in 3m · not running");
    expect(wakesDetail({ wakes_enabled: false }, now)).not.toMatch(/^(On|Off)\b/);
    expect(wakesDetail({ wakes_enabled: true, last_wake_scan_at: null }, now)).toBe("No wake service has run yet");
  });
});
