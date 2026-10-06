/**
 * Full-QA round 2 (portal-settings-etc fixer):
 *  - B14c: a project override / cap change made in Metrics clears the Shell's
 *    "Budget paused" chip at once (announceBudgetChange), not on its 60 s poll;
 *  - M13: budget token figures (which include prompt cache) say "incl. cache".
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetScope, ContainerBudgets } from "../../pages/agents/budget/budgetModel";

vi.mock("../../state/SnapshotProvider", async (orig) => {
  const real = await orig<typeof import("../../state/SnapshotProvider")>();
  const snap = {
    container: { id: "c1", name: "orcha-web" },
    agents: [{ id: "h1", alias: "hussein", kind: "human", status: "idle", member_role: "owner" }],
    tasks: [],
  };
  return {
    ...real,
    useSnapshot: () => ({ snap, cid: "c1", identity: { login: "hussein" } }),
    actingHuman: () => snap.agents[0],
    useActingAuthority: () => ({ pending: false, reason: null, canWrite: true }),
  };
});
vi.mock("../../pages/agents/agentModel", async (orig) => {
  const real = await orig<typeof import("../../pages/agents/agentModel")>();
  return { ...real, grantDenied: () => null };
});

import { BudgetBars } from "./BudgetBars";
import { projectPauseLine, useContainerBudgets } from "../../pages/agents/budget/budgetModel";

/** The Shell's ProjectBudgetChip, reduced to its data path (same hook + line):
 *  importing Shell here would bypass the SnapshotProvider mock (import cycle). */
function ChipProbe() {
  const { data } = useContainerBudgets("c1");
  const line = projectPauseLine(data);
  return line ? <span data-testid="project-budget-chip">Budget paused</span> : null;
}

const OVR = { active: false, granted_by: null, granted_at: null, note: null };
const usage = (o: Partial<BudgetScope["usage"]> = {}): BudgetScope["usage"] => ({
  spend_usd: 0, metered_runs: 0, unmetered_runs: 0, unmetered_tokens: 0, tokens: 0, runs: 0, in_flight_runs: 0, ...o,
});
const paused = (): ContainerBudgets => ({
  period: "2026-09",
  starts_at: "2026-09-01T00:00:00+00:00",
  resets_at: "2026-10-01T00:00:00+00:00",
  project: {
    limits: { usd: null, tokens: 100_000 }, usage: usage({ tokens: 110_852, unmetered_runs: 2, unmetered_tokens: 110_852, runs: 2 }),
    state: "exceeded", usd_ratio: null, token_ratio: 1.1, limits_reached: ["tokens"], paused: true, override: OVR,
    updated_at: null, reason: "Project token cap reached — new runs are paused until Oct 1.",
  },
  agents: [],
});
const overridden = (): ContainerBudgets => {
  const d = paused();
  d.project = { ...d.project, paused: false, override: { active: true, granted_by: "h1", granted_at: "2026-09-29T00:00:00Z", note: null }, reason: null };
  return d;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("B14c: project budget writes refresh the Shell chip immediately", () => {
  it("granting the override clears 'Budget paused' without waiting for the poll", async () => {
    let current = paused();
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") { current = overridden(); }
      return { ok: true, status: 200, json: async () => current } as Response;
    }) as unknown as typeof fetch;
    render(
      <MemoryRouter>
        <ChipProbe />
        <BudgetBars cid="c1" />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("project-budget-chip")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Override this month" }));
    fireEvent.click(screen.getByRole("button", { name: "Grant override" }));
    await waitFor(() => expect(screen.queryByTestId("project-budget-chip")).toBeNull());
  });
});

describe("M13: budget token figures are labelled as including cache", () => {
  it("the token cap line and the not-metered line say incl. cache", async () => {
    const d = paused();
    d.project = { ...d.project, limits: { usd: 50, tokens: 200_000 }, usage: usage({ spend_usd: 1, metered_runs: 1, tokens: 119_000, unmetered_runs: 2, unmetered_tokens: 111_000, runs: 3 }), state: "ok", paused: false, usd_ratio: 0.02, token_ratio: 0.6 };
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => d }) as Response) as unknown as typeof fetch;
    render(<MemoryRouter><BudgetBars cid="c1" /></MemoryRouter>);
    await screen.findByText("Monthly budgets");
    const row = document.querySelector(".bb-row")!;
    expect(row.textContent).toContain("119k of 200k tokens · incl. cache");
    expect(row.textContent).toContain("+ 2 runs not metered (111k tokens incl. cache)");
  });
});

describe("M02b / M11: Metrics table + insight evidence", () => {
  it("tokensReported: zero tokens on real runs is 'not reported', never 0", async () => {
    const { tokensReported } = await import("./MetricsPage");
    expect(tokensReported({ runs: 3, tokens_in: 0, tokens_out: 0 })).toBe(false);
    expect(tokensReported({ runs: 3, tokens_in: 10, tokens_out: 0 })).toBe(true);
    expect(tokensReported({ runs: 0, tokens_in: 0, tokens_out: 0 })).toBe(true);
    expect(tokensReported({ runs: 3, tokens_in: 10, tokens_out: 5, runs_with_tokens: 0 })).toBe(false);
    expect(tokensReported({ runs: 3, tokens_in: 0, tokens_out: 0, runs_with_tokens: 2 })).toBe(true);
  });

  it("fmtEvidence: short labels, no raw ids or task title", async () => {
    const { fmtEvidence } = await import("./MetricsPage");
    const r = fmtEvidence({ task_id: "ab0cfb45-1111", task_title: "Set up CI", task_cost_usd: 1.25, window_cost_usd: 1.67, fraction: 0.749 });
    expect(r.items).toEqual(["Task cost $1.25", "Window total $1.67", "Share of spend 74.9%"]);
    expect(r.items.join(" ")).not.toMatch(/ab0cfb45|Set up CI|usd/i);
  });
});
