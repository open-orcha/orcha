/**
 * Metrics — Linear pass (D5/D8/D10/D12): window pills in the panel toolbar,
 * one compact summary card, Initiatives-style agent table with a run-health
 * chip derived from REAL failed-run counts, D8 status glyphs in the drilldown,
 * and missing cost stated once, honestly.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { HEALTH_RULE, MetricsPage, runHealth } from "./MetricsPage";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [], tasks: [], requests: [],
};
const agg = {
  days: 7,
  totals: { runs: 30, runs_with_cost: 20, est_cost_usd: 12.34, sandbox_seconds: 60, tokens_in: 1500, tokens_out: 900, tasks_completed: 1, tasks_verified: 0 },
  daily: [{ date: "2026-08-01", runs: 10, est_cost_usd: 4 }, { date: "2026-08-02", runs: 20, est_cost_usd: 8.34 }],
  per_agent: [
    { agent_id: "a1", alias: "forge", model: "claude-sonnet", runs: 20, ok_runs: 20, failed_runs: 0, sandbox_seconds: 30, tokens_in: 100, tokens_out: 50, est_cost_usd: 12.34 },
    { agent_id: "a2", alias: "scout", model: null, runs: 10, ok_runs: 5, failed_runs: 5, sandbox_seconds: 30, tokens_in: 1400, tokens_out: 850, est_cost_usd: 0 },
  ],
};
const spend = {
  agent: { id: "a1", alias: "forge", model: "claude-opus-5", reasoning_effort: "high" },
  window: "all",
  totals: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 3000, cache_creation_input_tokens: 200, total_tokens: 4700, total_cost_usd: 7.5, runs: 4, runs_with_cost: 4 },
  tasks: [
    { task_id: "t1", title: "Verify me", status: "needs_verification", runs: 2, input_tokens: 500, output_tokens: 250, cache_read_input_tokens: 1500, cache_creation_input_tokens: 100, total_tokens: 2350, total_cost_usd: 4, runs_with_cost: 2, first_run_at: null, last_run_at: null },
    { task_id: null, title: "Conversation (no task)", status: null, runs: 2, input_tokens: 500, output_tokens: 250, cache_read_input_tokens: 1500, cache_creation_input_tokens: 100, total_tokens: 2350, total_cost_usd: 3.5, runs_with_cost: 2, first_run_at: null, last_run_at: null },
  ],
};

const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
function stub(over: { agg?: unknown } = {}) {
  const urls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.includes("/metrics/agents/")) return json(spend);
    if (url.includes("/metrics/insights")) return json({ window: "all", insights: [] });
    if (url.includes("/metrics?days=")) return json(over.agg ?? agg);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return urls;
}
function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <MetricsPage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
beforeEach(() => { localStorage.clear(); window.location.hash = "#/metrics"; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("runHealth — derived from the real failed-run ratio", () => {
  it("never claims health without runs; prints the Initiatives verdict with the literal count in the tooltip", () => {
    expect(runHealth({ runs: 0, ok_runs: 0, failed_runs: 0 })).toMatchObject({ health: "no_data", label: "No runs" });
    expect(runHealth({ runs: 10, ok_runs: 10, failed_runs: 0 })).toMatchObject({ health: "on_track", label: "On track" });
    expect(runHealth({ runs: 48, ok_runs: 44, failed_runs: 4 })).toMatchObject({ health: "at_risk", label: "At risk" });
    expect(runHealth({ runs: 22, ok_runs: 15, failed_runs: 7 })).toMatchObject({ health: "off_track", label: "Off track" });
    // a lone failure in a long window is not "at risk" (review r2: 70/71 read At risk)
    expect(runHealth({ runs: 71, ok_runs: 70, failed_runs: 1 })).toMatchObject({ health: "on_track", label: "On track" });
    expect(runHealth({ runs: 100, ok_runs: 96, failed_runs: 4 }).health).toBe("on_track");
    // boundaries: 5% → at risk, 20% → off track
    expect(runHealth({ runs: 20, ok_runs: 19, failed_runs: 1 }).health).toBe("at_risk");
    expect(runHealth({ runs: 10, ok_runs: 8, failed_runs: 2 }).health).toBe("off_track");
    expect(runHealth({ runs: 100, ok_runs: 81, failed_runs: 19 }).health).toBe("at_risk");
    // the literal counts + the rule ride in the tooltip
    expect(runHealth({ runs: 71, ok_runs: 70, failed_runs: 1 }).title).toBe("70 of 71 runs succeeded · 1 failed — " + HEALTH_RULE);
    expect(runHealth({ runs: 48, ok_runs: 44, failed_runs: 4 }).title).toMatch(/^44 of 48 runs succeeded · 4 failed — /);
  });
});

describe("Metrics — Linear layout", () => {
  it("window pills and the cost explainer live in the panel toolbar", async () => {
    const urls = stub();
    mount();
    await screen.findByText("forge");
    const bar = screen.getByRole("toolbar", { name: "Metrics filters" });
    const pills = within(bar).getByRole("radiogroup", { name: "Metrics window" });
    expect(within(pills).getAllByRole("radio").map((r) => r.textContent)).toEqual(["7 days", "30 days"]);
    expect(within(bar).getByRole("button", { name: "How cost is estimated" })).toBeInTheDocument();
    fireEvent.click(within(pills).getByRole("radio", { name: "30 days" }));
    await waitFor(() => expect(urls).toContain("/api/containers/c1/metrics?days=30"));
  });

  it("agent rows: model stacked under the name, health chip, ok / total runs, cost bar only when known", async () => {
    stub();
    mount();
    const forge = (await screen.findByText("forge")).closest("tr")!;
    expect(within(forge).getByText("Sonnet")).toHaveAttribute("title", "claude-sonnet");
    expect(forge.querySelector('[data-health="on_track"]')).toHaveTextContent("On track");
    expect(forge.querySelector(".mx-c-runs")).toHaveTextContent("20 / 20");
    expect(forge.querySelector(".mx-costbar")).toBeTruthy();
    const scout = screen.getByText("scout").closest("tr")!;
    const off = scout.querySelector('[data-health="off_track"]')!;
    expect(off).toHaveTextContent("Off track");
    expect(off.getAttribute("title")).toContain("5 failed"); // literal count rides in the tooltip
    expect(within(scout).getByText("not reported")).toBeInTheDocument();
    expect(scout.querySelector(".mx-costbar")).toBeNull();
    // no legacy Model column; Health column is sortable
    expect(screen.queryByRole("columnheader", { name: "Model" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Health/ }));
    expect(screen.getByRole("columnheader", { name: /Health/ })).toHaveAttribute("aria-sort", "descending");
    const names = Array.from(document.querySelectorAll("tr[data-agent] .nm")).map((n) => n.textContent);
    expect(names).toEqual(["scout", "forge"]); // worst failure ratio first
  });

  it("summary is one card (figures + sparkline); no-cost caption is stated once", async () => {
    stub({
      agg: {
        ...agg,
        totals: { ...agg.totals, runs_with_cost: 0, est_cost_usd: 0 },
        per_agent: agg.per_agent.map((a) => ({ ...a, est_cost_usd: 0 })),
      },
    });
    mount();
    expect(await screen.findByText("Not reported")).toHaveClass("is-unknown");
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary.querySelector(".mx-spark")).toBeTruthy();
    // one-line caption; the full sentence is its tooltip (stated once)
    expect(screen.getAllByTitle("No run reported cost — tokens are the usage signal").length).toBe(1);
    expect(screen.getByText("see tokens")).toBeInTheDocument();
    expect(screen.getByText(/sorted by tokens/)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("drilldown: circular back button + spend pills in the toolbar, D8 status glyphs, token mix", async () => {
    stub();
    mount();
    fireEvent.click((await screen.findByText("forge")).closest("tr")!);
    expect(await screen.findByRole("heading", { name: "forge" })).toBeInTheDocument();
    const bar = screen.getByRole("toolbar", { name: "Spend filters" });
    expect(within(bar).getByRole("radiogroup", { name: "Spend window" })).toBeInTheDocument();
    const back = within(bar).getByRole("button", { name: "Back to metrics" });
    expect(back.className).toMatch(/outline/);
    // status as the shared glyph (label = exact STAT label, not the enum)
    const row = screen.getByText("Verify me").closest("tr")!;
    expect(row.querySelector('[data-status="needs_verification"]')).toBeTruthy();
    expect(screen.queryByText("needs_verification")).toBeNull();
    expect(screen.getByText("No task")).toBeInTheDocument();
    // token mix: four labelled figures (the legend) + a part-to-whole bar
    const mix = screen.getByRole("group", { name: "Token mix" });
    expect(within(mix).getByText("1K")).toBeInTheDocument();
    expect(within(mix).getByText("3K")).toBeInTheDocument();
    expect(mix.querySelectorAll(".mx-mixseg").length).toBe(4);
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByText("Cost & activity by agent")).toBeInTheDocument());
  });
});
