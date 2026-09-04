/**
 * GH #148/#149: the fused 4-rung AutonomySwitch is split into two independent
 * topbar controls — Notifier (binary, wakes_enabled) and Autonomy (3-level,
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

interface Call { url: string; method: string; body: unknown }

const rawSnap = (opts: { wakes_enabled?: boolean; autonomy_level?: string } = {}) => ({
  container: {
    id: "c1", name: "Orcha", status: "active",
    autonomy_level: opts.autonomy_level ?? "plan",
    wakes_enabled: opts.wakes_enabled ?? true,
  },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
});

function stubFetch(opts: { wakes_enabled?: boolean; autonomy_level?: string } = {}): Call[] {
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

describe("Shell — Notifier / Autonomy split (GH #148/#149)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders two separate control groups, not one fused 4-rung radiogroup", async () => {
    stubFetch();
    mount();
    await waitFor(() => expect(document.getElementById("notifTop")).toBeTruthy());
    expect(document.getElementById("autTop")).toBeTruthy();
    // no single radiogroup carries both a Paused/Running rung and a level rung
    expect(document.querySelector('[role="radiogroup"][aria-label="Container autonomy"]')).toBeNull();
    expect(document.getElementById("notifTop")!.getAttribute("role")).toBe("group");
    expect(document.getElementById("autTop")!.getAttribute("role")).toBe("radiogroup");
  });

  it("labels the two groups Notifier and Autonomy", async () => {
    stubFetch();
    mount();
    await waitFor(() => expect(document.getElementById("notifTop")).toBeTruthy());
    const labels = Array.from(document.querySelectorAll(".aut-lab")).map((n) => n.textContent);
    expect(labels).toContain("Notifier");
    expect(labels).toContain("Autonomy");
  });

  it("Notifier click posts to /wakes only, leaving autonomy_level untouched in the body", async () => {
    const calls = stubFetch({ wakes_enabled: true, autonomy_level: "pr" });
    mount();
    await waitFor(() => expect(document.getElementById("notifTop")).toBeTruthy());
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

  it("Autonomy rung click posts to /autonomy only, leaving wakes_enabled untouched in the body", async () => {
    const calls = stubFetch({ wakes_enabled: true, autonomy_level: "plan" });
    mount();
    await waitFor(() => expect(document.getElementById("autTop")).toBeTruthy());
    const prSeg = Array.from(document.getElementById("autTop")!.querySelectorAll(".seg"))
      .find((s) => s.textContent?.includes("Build to PR"))!;
    fireEvent.click(prSeg);
    fireEvent.click(screen.getByRole("button", { name: /Set Build to PR/i }));
    await waitFor(() => {
      const a = calls.find((c) => c.url === "/api/containers/c1/autonomy");
      expect(a).toBeTruthy();
      expect(a!.method).toBe("POST");
      expect(a!.body).toEqual({ level: "pr", actor_agent_id: "h1" });
    });
    expect(calls.some((c) => c.url === "/api/containers/c1/wakes")).toBe(false);
  });

  it("Autonomy control stays rendered (dimmed) while the notifier is paused, not merged into it", async () => {
    stubFetch({ wakes_enabled: false, autonomy_level: "plan" });
    mount();
    await waitFor(() => expect(document.getElementById("notifTop")).toBeTruthy());
    expect(document.getElementById("notifTop")!.textContent).toContain("Paused");
    // autonomy levels are still present/selectable, just visually de-emphasized
    expect(document.getElementById("autTop")!.className).toContain("dimmed");
    expect(document.getElementById("autTop")!.textContent).toContain("Plan-only");
  });
});
