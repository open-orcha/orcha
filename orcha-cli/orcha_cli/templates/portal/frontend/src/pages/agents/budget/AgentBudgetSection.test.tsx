/**
 * Agent Configuration → Budget (budget_routes). Tripwires:
 *   - honest money: runs that reported no dollar figure read "not metered", never $0;
 *   - paused state shows the SERVER's reason and says in-flight runs were not stopped;
 *   - editing PUTs the acting human + parsed limits (blank = no limit), bad input is refused;
 *   - one-time override PUTs override:"grant" with the note; revoke PUTs override:"revoke";
 *   - read-only for viewers / members without manage_autonomy (no edit controls);
 *   - an older server without the route (404) renders nothing.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../../../components/ui";
import { AgentBudgetPanel, BudgetPausedChip } from "./AgentBudgetSection";
import { budgetHealth, fmtTok, meterPct, parseLimit, type AgentBudget } from "./budgetModel";

const BASE: AgentBudget = {
  agent_id: "a1",
  alias: "forge",
  period: "2026-09",
  starts_at: "2026-09-01T00:00:00+00:00",
  resets_at: "2026-10-01T00:00:00+00:00",
  limits: { usd: 50, tokens: null },
  usage: { spend_usd: 41.1, metered_runs: 10, unmetered_runs: 0, unmetered_tokens: 0, tokens: 120000, runs: 10, in_flight_runs: 0 },
  state: "warning",
  usd_ratio: 0.822,
  token_ratio: null,
  limits_reached: [],
  paused: false,
  override: { active: false, granted_by: null, granted_at: null, note: null },
  updated_at: null,
  blocked_by: null,
  reason: null,
  project: {
    limits: { usd: null, tokens: null },
    usage: { spend_usd: 41.1, metered_runs: 10, unmetered_runs: 0, unmetered_tokens: 0, tokens: 120000, runs: 10, in_flight_runs: 0 },
    state: "none", usd_ratio: null, token_ratio: null, limits_reached: [], paused: false,
    override: { active: false, granted_by: null, granted_at: null, note: null }, updated_at: null,
  },
};

let puts: { url: string; body: Record<string, unknown> }[] = [];

function stub(get: unknown, opts: { status?: number; after?: unknown } = {}) {
  puts = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      puts.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, json: async () => opts.after ?? get } as Response;
    }
    const status = opts.status ?? 200;
    return { ok: status < 400, status, json: async () => (status < 400 ? get : { detail: "Not Found" }) } as Response;
  }) as unknown as typeof fetch;
}

function mount(props: Partial<Parameters<typeof AgentBudgetPanel>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AgentBudgetPanel agentId="a1" alias="forge" actorId="h1" denied={null} {...props} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("budget model", () => {
  it("parses limits: blank = no limit, junk / negative refused", () => {
    expect(parseLimit("", false)).toBeNull();
    expect(parseLimit("$1,250.456", false)).toBe(1250.46);
    expect(parseLimit("2e6", true)).toBe(2000000);
    expect(parseLimit("-1", false)).toBeUndefined();
    expect(parseLimit("abc", true)).toBeUndefined();
  });
  it("health comes from the real verdict — never a default 'On track'", () => {
    expect(budgetHealth({ state: "none", paused: false, override: BASE.override })).toBeNull();
    expect(budgetHealth({ state: "warning", paused: false, override: BASE.override })?.label).toBe("Near limit");
    expect(budgetHealth({ state: "exceeded", paused: true, override: BASE.override })?.label).toBe("Paused");
    expect(budgetHealth({ state: "exceeded", paused: false, override: { ...BASE.override, active: true } })?.label).toBe("Over · override");
  });
  it("meter caps overspend at a full bar; formats tokens compactly", () => {
    expect(meterPct(2.5)).toBe(100);
    expect(meterPct(0.5)).toBe(50);
    expect(meterPct(null)).toBe(0);
    expect(fmtTok(1_250_000)).toBe("1.3M");
    expect(fmtTok(12_400)).toBe("12k");
  });
});

describe("AgentBudgetPanel", () => {
  it("shows month-to-date spend against the limit with a meter and the 80% health chip", async () => {
    stub(BASE);
    mount();
    expect(await screen.findByText(/\$41\.10 of \$50\.00 · 82%/)).toBeTruthy();
    expect(screen.getByRole("meter", { name: /spend against budget/i }).getAttribute("aria-valuenow")).toBe("82");
    expect(screen.getByText("Near limit")).toBeTruthy();
    expect(screen.getByText(/September 2026 · resets Oct 1 \(UTC\)/)).toBeTruthy();
  });

  it("never shows unmetered spend as $0", async () => {
    stub({
      ...BASE,
      state: "ok",
      usd_ratio: 0,
      usage: { ...BASE.usage, spend_usd: 0, metered_runs: 0, unmetered_runs: 7, unmetered_tokens: 900000, tokens: 900000, runs: 7 },
    });
    mount();
    expect(await screen.findByText(/Not metered · limit \$50\.00/)).toBeTruthy();
    expect(screen.queryByText(/\$0\.00 of/)).toBeNull();
    const note = document.getElementById("bdgUnmetered")!;
    expect(note.textContent).toMatch(/7 runs · 900k tokens not metered — not counted as \$0/);
    expect(note.textContent).toMatch(/add a token cap/);
  });

  it("paused: the server's reason, in-flight runs not stopped, raise + override actions", async () => {
    const reason = "Monthly budget reached ($51.00 of $50.00) — paused for new runs until Oct 1. Runs in progress were not stopped.";
    stub({ ...BASE, state: "exceeded", usd_ratio: 1.02, paused: true, blocked_by: "agent", reason, usage: { ...BASE.usage, spend_usd: 51, in_flight_runs: 1 } });
    mount();
    await screen.findByText("Paused for new runs");
    const alert = document.getElementById("bdgPaused")!;
    expect(alert.textContent).toContain("Paused for new runs");
    expect(alert.textContent).toContain(reason);
    expect(screen.getByText(/1 run in progress — not stopped by the budget/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Raise budget" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Override this month" }));
    fireEvent.change(screen.getByLabelText("Override reason"), { target: { value: "release week" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant override" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toBe("/api/agents/a1/budget");
    expect(puts[0].body).toEqual({ actor_agent_id: "h1", override: "grant", note: "release week" });
  });

  it("project cap pause names the project and offers no per-agent override", async () => {
    stub({ ...BASE, state: "ok", paused: true, blocked_by: "project", reason: "Project monthly budget reached ($100.00 of $100.00)" });
    mount();
    expect((await screen.findByText(/project budget reached/)).textContent).toContain("Paused for new runs");
    expect(screen.queryByRole("button", { name: "Override this month" })).toBeNull();
    // KG-5 / B14: the project cap's controls are one link away (Metrics → Monthly budgets)
    const link = screen.getByRole("link", { name: "Manage project budget" });
    expect(link.getAttribute("href")).toBe("/metrics#mxBudgets");
  });

  it("project cap pause for a read-only viewer links to view (not manage) the project budget", async () => {
    stub({ ...BASE, state: "ok", paused: true, blocked_by: "project", reason: "Project monthly budget reached" });
    mount({ denied: "Your role is viewer (read-only)", actorId: "h1" });
    expect((await screen.findByRole("link", { name: "View project budget" })).getAttribute("href")).toBe("/metrics#mxBudgets");
  });

  it("a saved budget announces the change so roster chips re-read at once", async () => {
    stub(BASE, { after: { ...BASE, limits: { usd: 80, tokens: null }, state: "ok", usd_ratio: 0.51 } });
    const heard = vi.fn();
    window.addEventListener("orcha:budget-changed", heard);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Monthly limit in US dollars"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    window.removeEventListener("orcha:budget-changed", heard);
  });

  it("edits: PUTs parsed limits with the acting human; blank clears; bad input refused", async () => {
    stub(BASE, { after: { ...BASE, limits: { usd: 80, tokens: 2000000 }, state: "ok", usd_ratio: 0.51, token_ratio: 0.06 } });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const usd = screen.getByLabelText("Monthly limit in US dollars") as HTMLInputElement;
    expect(usd.value).toBe("50");
    fireEvent.change(usd, { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(puts).toHaveLength(0);

    fireEvent.change(usd, { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("Monthly token cap"), { target: { value: "2000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ actor_agent_id: "h1", monthly_limit_usd: 80, monthly_limit_tokens: 2000000 });
    expect(await screen.findByText(/2M tokens · 6%/)).toBeTruthy();
  });

  it("override active: says until when, and can be revoked", async () => {
    stub({ ...BASE, state: "exceeded", usd_ratio: 1.3, paused: false, override: { active: true, granted_by: "h1", granted_at: "2026-09-20T00:00:00Z", note: "launch" } });
    mount();
    expect((await screen.findByText(/One-time override active until Oct 1/)).textContent).toContain("launch");
    expect(screen.getByText("Over · override")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke override" }));
    await waitFor(() => expect(puts[0]?.body).toEqual({ actor_agent_id: "h1", override: "revoke" }));
  });

  it("no budget: explains it and offers Set budget to an authorized human only", async () => {
    stub({ ...BASE, limits: { usd: null, tokens: null }, state: "none", usd_ratio: null });
    mount();
    expect(await screen.findByText("No monthly budget")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set budget" })).toBeTruthy();
  });

  it("read-only for a viewer / member without manage_autonomy", async () => {
    stub({ ...BASE, state: "exceeded", usd_ratio: 1.1, paused: true, blocked_by: "agent", reason: "Monthly budget reached" });
    mount({ denied: "Requires the owner role or the manage_autonomy permission" });
    expect(await screen.findByText("Read-only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Raise budget" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Override this month" })).toBeNull();
  });

  it("renders nothing on a server without the budgets route", async () => {
    stub(null, { status: 404 });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".bdg")).toBeNull());
  });
});

describe("BudgetPausedChip", () => {
  it("only renders when paused, with the reason as its tooltip", () => {
    const { container, rerender } = render(<BudgetPausedChip status={{ paused: false, reason: null }} />);
    expect(container.textContent).toBe("");
    rerender(<BudgetPausedChip status={{ paused: true, reason: "Monthly budget reached" }} />);
    expect(screen.getByText("Budget paused").closest("[title]")?.getAttribute("title")).toBe("Monthly budget reached");
  });
});
