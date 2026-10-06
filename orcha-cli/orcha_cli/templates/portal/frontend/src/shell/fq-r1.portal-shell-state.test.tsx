/**
 * fullqa r1 (portal-shell-state): VD-09 (one "working"/"waiting" rule on the
 * sidebar), VD-10 (project budget stop visible in the header) and VD-15
 * (calm embedded identity: avatar only, no uppercase "ACTING AS").
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Snapshot } from "../types";
import { liveAgents, projectAgents, remoteProjectAgents } from "./liveAgents";
import { agentPresence } from "../pages/agents/presence";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { ActingChip, ProjectBudgetChip } from "./Shell";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe("VD-09 one working rule (sidebar == roster)", () => {
  const pixel = {
    id: "p1", alias: "Pixel", kind: "ai", status: "idle", last_active: null, current_task: null, active_run: null,
    running_run: { run_id: "r1", task_title: "Polish icons", lease_live: false, started_at: "2026-09-29T10:00:00Z" },
  } as unknown as Agent;
  const snap = { agents: [pixel] } as unknown as Snapshot;

  it("a running run whose lease lapsed is Working on the roster AND in the sidebar", () => {
    expect(agentPresence(pixel, { snap }).k).toBe("working");
    const rows = projectAgents(snap, 3).rows;
    expect(rows.map((r) => [r.alias, r.state, r.fragment])).toEqual([["Pixel", "working", "Polish icons"]]);
    expect(liveAgents(snap)[0].task).toBe("Polish icons");
  });

  it("another project's awaiting_request agent reads 'waiting', never 'needs review'", () => {
    const { rows } = remoteProjectAgents([{ alias: "Atlas", status: "awaiting_request", task_title: "Map flow" } as never], 1);
    expect(rows[0].state).not.toBe("review");
    expect(rows[0].fragment).toBe("waiting");
    // with a running run it is Working (presence ranks the run first)
    const run = remoteProjectAgents([{ alias: "Atlas", status: "awaiting_request", task_title: "Map flow", started_at: "2026-09-29T10:00:00Z" } as never], 1);
    expect(run.rows[0].fragment).toBe("Map flow");
    // real review states still read needs review
    expect(remoteProjectAgents([{ alias: "Q", status: "needs_verification" } as never], 1).rows[0].fragment).toBe("needs review");
  });
});

const rawSnap = {
  container: { id: "c1", name: "P", status: "active", wakes_enabled: true },
  agents: [{ id: "h1", alias: "hussein-owner", kind: "human", status: "idle", member_role: "owner" }],
  tasks: [],
  requests: [],
};
const scope = (paused: boolean) => ({
  limits: { usd: 11, tokens: null },
  usage: { spend_usd: 11.5, metered_runs: 3, unmetered_runs: 0, unmetered_tokens: 0, tokens: 0, runs: 3, in_flight_runs: 0 },
  state: paused ? "exceeded" : "ok", usd_ratio: 1.05, token_ratio: null, limits_reached: paused ? ["usd"] : [],
  paused, override: { active: false, granted_by: null, granted_at: null, note: null }, updated_at: null,
  reason: paused ? "Project monthly budget reached ($11.50 of $11.00) — paused for new runs" : null,
});
let projectPaused = true;
beforeEach(() => {
  projectPaused = true;
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const u = String(input);
    if (u === "/api/containers") return Promise.resolve(ok([{ id: "c1", status: "active" }]));
    if (u.endsWith("/budgets")) {
      return Promise.resolve(ok({ period: "2026-09", starts_at: "2026-09-01", resets_at: "2026-10-01", project: scope(projectPaused), agents: [] }));
    }
    return Promise.resolve(ok(rawSnap));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mount(node: React.ReactNode) {
  render(<MemoryRouter><SnapshotProvider pollMs={60_000}>{node}</SnapshotProvider></MemoryRouter>);
  await act(async () => { await new Promise((r) => setTimeout(r, 1_700)); });
}

describe("VD-10 project budget stop in the header", () => {
  it("shows one 'Budget paused' chip with the reason as tooltip, linking to Metrics budgets", async () => {
    await mount(<ProjectBudgetChip />);
    const chip = await screen.findByTestId("project-budget-chip");
    expect(chip.textContent).toContain("Budget paused");
    expect(chip.getAttribute("title")).toMatch(/Project monthly budget reached/);
    expect(chip.getAttribute("href")).toBe("/metrics?cid=c1#mxBudgets");
  });
  it("renders nothing when the project cap is not pausing", async () => {
    projectPaused = false;
    await mount(<ProjectBudgetChip />);
    expect(screen.queryByTestId("project-budget-chip")).toBeNull();
  });
});

describe("VD-15 embedded acting chip is calm", () => {
  it("shows the avatar only — the name lives in the tooltip, no uppercase label", async () => {
    await mount(<ActingChip />);
    const chip = screen.getByTestId("acting-chip");
    expect(chip.textContent || "").not.toMatch(/acting as/i);
    expect(chip.querySelector(".lbl")).toBeNull();
    expect(chip.getAttribute("title")).toBe("Acting as hussein-owner");
    expect(chip.getAttribute("aria-label")).toBe("Acting as hussein-owner");
  });
});
