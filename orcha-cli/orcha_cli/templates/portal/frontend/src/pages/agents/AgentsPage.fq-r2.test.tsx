/**
 * Full-QA round 2 (portal-agents):
 *  - KG-6 / B25 / VD-10: a budget-paused agent says "Budget paused" (reason = tooltip) on
 *    its roster row, its board column and the workspace header, and the Configuration
 *    Wake row reads "Paused by budget" instead of a green "Enabled".
 *  - L13b: hasLiveRun follows the workspace rule (a running run needs a checkout; a bare
 *    "working" status is not a run).
 *  - A10: narrow screens get the fill-panel conversation layout (composer on screen).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";
import { hasLiveRun } from "./AgentsBoard";
import type { Agent } from "../../types";

const now = new Date().toISOString();
const QUILL = "a1111111-1111-4111-8111-111111111111";
const ATLAS = "a2222222-2222-4222-8222-222222222222";
const REASON = "Monthly budget reached ($5.60 of $5.00) — paused for new runs until Oct 1.";

const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner" },
    { id: QUILL, alias: "Quill", kind: "ai", role: "Writer", status: "awaiting_request", wake_enabled: true },
    { id: ATLAS, alias: "Atlas", kind: "ai", role: "Planner", status: "idle", wake_enabled: true },
  ],
  tasks: [
    { id: "t1aaaaaa-1", title: "Draft the launch post", status: "ready", assignees: ["Quill"], assignee: "Quill", priority: 50, is_root: false, created_at: now, thread: [], runs: [] },
    { id: "t2aaaaaa-2", title: "Plan the sprint", status: "ready", assignees: ["Atlas"], assignee: "Atlas", priority: 50, is_root: false, created_at: now, thread: [], runs: [] },
  ],
  requests: [],
};

const scope = (paused: boolean) => ({
  limits: { usd: paused ? 5 : null, tokens: null },
  usage: { usd: paused ? 5.6 : 0.4, tokens: 1000, runs: 2, in_flight_runs: 0 },
  state: paused ? "exceeded" : "none",
  usd_ratio: paused ? 1.12 : null,
  token_ratio: null,
  limits_reached: paused ? ["usd"] : [],
  paused,
  override: { active: false, granted_by: null, granted_at: null, note: null },
  updated_at: null,
});
const BUDGETS = {
  period: "2026-09", starts_at: "2026-09-01T00:00:00Z", resets_at: "2026-10-01T00:00:00Z",
  project: scope(false),
  agents: [
    { agent_id: QUILL, alias: "Quill", ...scope(true), blocked_by: "agent", reason: REASON },
    { agent_id: ATLAS, alias: "Atlas", ...scope(false), blocked_by: null, reason: null },
  ],
};

const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
function stubFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1/budgets")) return jsonRes(BUDGETS);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (url.includes("/runs")) return jsonRes({ runs: [] });
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
function mount(path: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("KG-6 / B25: budget-paused agents are visible where the owner looks", () => {
  it("board: the paused agent's column header carries 'Budget paused' with the reason; others do not", async () => {
    stubFetch();
    mount("/agents?view=board");
    const chip = await screen.findByText("Budget paused", {}, { timeout: 3000 });
    const col = chip.closest("section, li, [data-column], .ab-col") as HTMLElement;
    expect(col).toBeTruthy();
    expect(within(col).getByText("Quill")).toBeTruthy();
    // the chip says why it waits — no truncated passive "Waiting" beside it
    expect(within(col).queryByText("Waiting")).toBeNull();
    expect(chip.closest(".v2-health")!.getAttribute("title")).toBe(REASON);
    expect(screen.getAllByText("Budget paused")).toHaveLength(1);
  });

  it("roster row + workspace header show the chip; the Wake row reads 'Paused by budget'", async () => {
    stubFetch();
    mount("/agents?agent=Quill&tab=config");
    await screen.findByText("Paused by budget", {}, { timeout: 3000 });
    const roster = document.getElementById("roster")!;
    const row = roster.querySelector('[data-alias="Quill"]') as HTMLElement;
    expect(within(row).getByText("Budget paused")).toBeTruthy();
    expect(roster.querySelector('[data-alias="Atlas"] .bdg-chip')).toBeNull();
    const header = document.querySelector(".ahead") as HTMLElement;
    expect(within(header).getByText("Budget paused").closest(".v2-health")!.getAttribute("title")).toBe(REASON);
    const wake = screen.getByText("Paused by budget").closest(".wakebadge")!;
    expect(wake.getAttribute("title")).toBe(REASON);
    expect(wake.className).toContain("paused");
  });

  it("an agent that is not paused keeps 'Enabled' and no header chip", async () => {
    stubFetch();
    mount("/agents?agent=Atlas&tab=config");
    await screen.findByText("Enabled", {}, { timeout: 3000 });
    // the roster still marks Quill, the header (Atlas) does not
    await screen.findByText("Budget paused");
    expect(within(document.querySelector(".ahead") as HTMLElement).queryByText("Budget paused")).toBeNull();
    expect(screen.queryByText("Paused by budget")).toBeNull();
  });

  it("the chip clears once the budget answer no longer says paused (budget-changed event)", async () => {
    stubFetch();
    mount("/agents?view=board");
    await screen.findByText("Budget paused", {}, { timeout: 3000 });
    BUDGETS.agents[0] = { ...BUDGETS.agents[0], ...scope(false), blocked_by: null, reason: null };
    await vi.waitFor(
      () => {
        window.dispatchEvent(new Event("orcha:budget-changed"));
        expect(screen.queryByText("Budget paused")).toBeNull();
      },
      { timeout: 4000, interval: 200 },
    );
    BUDGETS.agents[0] = { ...BUDGETS.agents[0], ...scope(true), blocked_by: "agent", reason: REASON };
  });
});

describe("L13b: board Live changes follows the workspace checkout rule", () => {
  const base = { id: "x", alias: "Pixel", kind: "ai", status: "working", active_run: null } as unknown as Agent;
  it("a running run with a worktree → offered", () => {
    expect(hasLiveRun({ ...base, running_run: { run_id: "r1", worktree: "/w/.orcha-worktrees/a", base_cwd: null } } as unknown as Agent)).toBe(true);
  });
  it("a running run with only a base checkout → offered", () => {
    expect(hasLiveRun({ ...base, running_run: { run_id: "r1", worktree: null, base_cwd: "/w" } } as unknown as Agent)).toBe(true);
  });
  it("a running run with neither → not offered (dead link)", () => {
    expect(hasLiveRun({ ...base, running_run: { run_id: "r1", worktree: null, base_cwd: null } } as unknown as Agent)).toBe(false);
  });
  it("an older backend that never sends the checkout fields keeps the entry", () => {
    expect(hasLiveRun({ ...base, running_run: { run_id: "r1" } } as unknown as Agent)).toBe(true);
    expect(hasLiveRun({ ...base, active_run: { run_id: "r1" } } as unknown as Agent)).toBe(true);
  });
  it("a bare 'working' status with no run is not a run", () => {
    expect(hasLiveRun({ ...base, running_run: null } as unknown as Agent)).toBe(false);
  });
});

describe("A10: narrow conversation fills the viewport (composer on screen)", () => {
  const css = readFileSync(resolve(__dirname, "agents.css"), "utf8");
  it("the fill-panel layout also applies at 900px and below, with an uncapped thread", () => {
    const i = css.indexOf("@media (max-width: 900px) {\n  .agents-v2[data-has-agent=\"true\"] .agents-detail:has(");
    expect(i).toBeGreaterThan(-1);
    const block = css.slice(i, css.indexOf("\n}\n", i));
    expect(block).toMatch(/height: calc\(var\(--v2-content-h\) - 2 \* var\(--v2-space-4\)\)/);
    expect(block).toMatch(/\.conv-list \{ flex: 1; min-height: 0; max-height: none; \}/);
  });
  it("at 600px and below the header actions share the back button's line", () => {
    expect(css).toMatch(/\.ahead::before \{ content: ""; order: 3; flex-basis: 100%; height: 0; \}/);
  });
});
