/**
 * Metrics → Monthly budgets (GET /api/containers/{cid}/budgets): spend-vs-budget bars.
 * Tripwires: project cap first, then budgeted agents; unmetered months read "Not metered"
 * (never $0); partly-metered rows say how many runs were not metered; an agent drilldown
 * narrows to that agent; empty and older-server states.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BudgetBars } from "./BudgetBars";
import type { AgentBudgetStatus, BudgetScope, ContainerBudgets } from "../../pages/agents/budget/budgetModel";

const OVR = { active: false, granted_by: null, granted_at: null, note: null };
const usage = (o: Partial<BudgetScope["usage"]> = {}): BudgetScope["usage"] => ({
  spend_usd: 0, metered_runs: 0, unmetered_runs: 0, unmetered_tokens: 0, tokens: 0, runs: 0, in_flight_runs: 0, ...o,
});
const agent = (o: Partial<AgentBudgetStatus>): AgentBudgetStatus => ({
  agent_id: "x", alias: "x", limits: { usd: null, tokens: null }, usage: usage(), state: "none",
  usd_ratio: null, token_ratio: null, limits_reached: [], paused: false, override: OVR, updated_at: null,
  blocked_by: null, reason: null, ...o,
});

const PAYLOAD: ContainerBudgets = {
  period: "2026-09",
  starts_at: "2026-09-01T00:00:00+00:00",
  resets_at: "2026-10-01T00:00:00+00:00",
  project: {
    limits: { usd: 200, tokens: null }, usage: usage({ spend_usd: 120, metered_runs: 30, runs: 30 }), state: "ok",
    usd_ratio: 0.6, token_ratio: null, limits_reached: [], paused: false, override: OVR, updated_at: null, reason: null,
  },
  agents: [
    agent({
      agent_id: "a1", alias: "forge", limits: { usd: 50, tokens: 1_000_000 },
      usage: usage({ spend_usd: 51, metered_runs: 9, unmetered_runs: 3, unmetered_tokens: 40_000, tokens: 800_000, runs: 12 }),
      state: "exceeded", usd_ratio: 1.02, token_ratio: 0.8, paused: true, blocked_by: "agent",
      reason: "Monthly budget reached ($51.00 of $50.00) — paused for new runs until Oct 1.",
    }),
    agent({
      agent_id: "a2", alias: "scout", limits: { usd: 20, tokens: null },
      usage: usage({ unmetered_runs: 5, unmetered_tokens: 300_000, tokens: 300_000, runs: 5 }),
      state: "ok", usd_ratio: 0,
    }),
    agent({ agent_id: "a3", alias: "idle-one" }),
  ],
};

function stub(body: unknown, status = 200) {
  global.fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response) as unknown as typeof fetch;
}
const mount = (agentId?: string) =>
  render(
    <MemoryRouter>
      <BudgetBars cid="c1" agentId={agentId} />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BudgetBars", () => {
  it("renders the project cap and each budgeted agent with honest figures", async () => {
    stub(PAYLOAD);
    mount();
    expect(await screen.findByText("Monthly budgets")).toBeTruthy();
    expect(screen.getByText(/September 2026 · resets Oct 1 \(UTC\)/)).toBeTruthy();
    const rows = document.querySelectorAll(".bb-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Whole project");
    expect(rows[0].textContent).toContain("$120.00 of $200.00 · 60%");
    // forge: overspent, paused, token bar too, partly unmetered called out
    expect(rows[1].textContent).toContain("$51.00 of $50.00 · 102%");
    expect(rows[1].textContent).toContain("800k of 1M tokens");
    expect(rows[1].textContent).toContain("+ 3 runs not metered (40k tokens incl. cache)");
    expect(rows[1].textContent).toContain("Paused");
    expect(rows[1].querySelectorAll('[role="meter"]')).toHaveLength(2);
    // scout: nothing metered → "Not metered", never $0.00
    expect(rows[2].textContent).toContain("Not metered · limit $20.00");
    expect(rows[2].textContent).not.toContain("$0.00");
    expect(screen.getByText("1 agent has no budget.")).toBeTruthy();
    // agent names deep-link to their Configuration tab
    expect(screen.getByRole("link", { name: "forge" }).getAttribute("href")).toBe("/agents?agent=forge&tab=config");
  });

  it("drilldown: narrows to one agent", async () => {
    stub(PAYLOAD);
    mount("a1");
    await screen.findByText("Monthly budgets");
    const rows = document.querySelectorAll(".bb-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("forge");
  });

  it("empty state points to the agent Configuration tab", async () => {
    stub({ ...PAYLOAD, project: { ...PAYLOAD.project, limits: { usd: null, tokens: null }, state: "none" }, agents: [agent({ agent_id: "a3" })] });
    mount();
    expect(await screen.findByText(/No monthly budgets set/)).toBeTruthy();
  });

  it("older server (404) or a foreign payload renders nothing", async () => {
    stub({ detail: "Not Found" }, 404);
    const { container } = mount();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.querySelector(".bb")).toBeNull();
    cleanup();
    stub({ totals: {} });
    const again = mount();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(again.container.querySelector(".bb")).toBeNull();
  });
});
