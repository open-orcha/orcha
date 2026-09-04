/**
 * MetricsPage — renders the aggregate from GET /api/containers/{cid}/metrics
 * (stat tiles, daily bars, per-agent table) and re-fetches on the 7/30-day
 * range toggle. fetch is stubbed; snapshot flows through the real
 * SnapshotProvider, matching foundation.test.ts style.
 *
 * Also covers the agent spend drilldown (agent_spend_routes wire): click-through
 * from a per-agent row, rendering from a stubbed .../spend + .../insights
 * response, and window-switch refetch.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { costCaption, fmtDuration, fmtTokens, fmtUsd, MetricsPage } from "./MetricsPage";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

const payload7 = {
  days: 7,
  totals: {
    runs: 9, runs_with_cost: 6, est_cost_usd: 12.34, sandbox_seconds: 5400,
    tokens_in: 1500, tokens_out: 900, tasks_completed: 4, tasks_verified: 2,
  },
  daily: [
    { date: "2026-07-29", runs: 0, est_cost_usd: 0 },
    { date: "2026-07-30", runs: 4, est_cost_usd: 5.5 },
    { date: "2026-08-04", runs: 5, est_cost_usd: 6.84 },
  ],
  per_agent: [
    {
      agent_id: "a1", alias: "forge", model: "claude-sonnet", runs: 6, ok_runs: 5,
      failed_runs: 1, sandbox_seconds: 3600, tokens_in: 1200, tokens_out: 700,
      est_cost_usd: 10.0,
    },
    {
      agent_id: "a2", alias: "scout", model: null, runs: 3, ok_runs: 3,
      failed_runs: 0, sandbox_seconds: 1800, tokens_in: 300, tokens_out: 200,
      est_cost_usd: 2.34,
    },
  ],
};

const spendAll = {
  agent: { id: "a1", alias: "forge", model: "claude-opus-5", reasoning_effort: "high" },
  window: "all",
  totals: {
    input_tokens: 1200, output_tokens: 700, cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 100, total_tokens: 6000, total_cost_usd: 10.0, runs: 6,
  },
  tasks: [
    {
      task_id: "t1", title: "Ship feature", status: "in_progress", runs: 5,
      input_tokens: 1000, output_tokens: 600, cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 100, total_tokens: 5700, total_cost_usd: 9.5,
      first_run_at: "2026-08-01T00:00:00Z", last_run_at: "2026-08-03T00:00:00Z",
    },
    {
      task_id: null, title: "Conversation & drains", status: null, runs: 1,
      input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0, total_tokens: 300, total_cost_usd: 0.5,
      first_run_at: "2026-08-02T00:00:00Z", last_run_at: "2026-08-02T00:00:00Z",
    },
  ],
};
const spend5h = { ...spendAll, window: "5h", totals: { ...spendAll.totals, runs: 1 }, tasks: [] };

const insights7d = {
  window: "7d",
  insights: [
    {
      id: "cold-context:a1", severity: "high", title: "forge rewarms context every wake",
      detail: "Cache reads make up only 12% of input+cache-read tokens.",
      evidence: { agent_alias: "forge", cache_hit_ratio: 0.12, runs: 6 },
      action: "Batch this agent's work into fewer, longer sessions.",
    },
    {
      id: "concentration:t1", severity: "info", title: "“Ship feature” is 63% of this window's spend",
      detail: "$9.50 of $15.00 total window spend came from a single task.",
      evidence: { task_title: "Ship feature", fraction: 0.63 },
      action: "Not necessarily a problem — just worth knowing where the dollars went.",
    },
  ],
};

function stubFetch(): string[] {
  const urls: string[] = [];
  const json = (data: unknown) =>
    ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.includes("/metrics/agents/a1/spend") && url.includes("window=5h")) return json(spend5h);
    if (url.includes("/metrics/agents/a1/spend")) return json(spendAll);
    if (url.includes("/metrics/insights")) return json(insights7d);
    if (url.includes("/metrics?days=30")) return json({ ...payload7, days: 30 });
    if (url.includes("/metrics?days=7")) return json(payload7);
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

describe("MetricsPage (aggregate endpoint render)", () => {
  beforeEach(() => { localStorage.clear(); window.location.hash = "#/metrics"; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("fetches /api/containers/c1/metrics?days=7 and renders tiles, bars & table", async () => {
    const urls = stubFetch();
    mount();
    // KPI tiles
    expect(await screen.findByText("$12.34")).toBeInTheDocument();
    // caption appears twice: the Est. cost tile sub AND the agent-table card count
    expect(screen.getAllByText("estimated · 6 of 9 runs reported cost").length).toBe(2);
    expect(screen.getByText("1h 30m")).toBeInTheDocument(); // 5400s sandbox compute
    expect(screen.getByText("4 done")).toBeInTheDocument();
    expect(screen.getByText("2 human-verified")).toBeInTheDocument();
    expect(urls).toContain("/api/containers/c1/metrics?days=7");
    // daily bars: one column per day, honest zero bar (no .mx-bar for 0 runs)
    const cols = document.querySelectorAll(".mx-col");
    expect(cols.length).toBe(3);
    expect(cols[0].querySelector(".mx-bar")).toBeNull();
    expect(cols[2].querySelector(".mx-bar")).toBeTruthy();
    // per-agent table — rows are clickable (open the spend drilldown), not links
    expect(screen.getByText("forge")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    const agentRow = screen.getByText("forge").closest("tr");
    expect(agentRow?.getAttribute("role")).toBe("button");
    expect(agentRow?.getAttribute("data-agent")).toBe("a1");
  });

  it("range toggle re-fetches with days=30", async () => {
    const urls = stubFetch();
    mount();
    await screen.findByText("$12.34");
    fireEvent.click(screen.getByText("30 days"));
    await waitFor(() => expect(urls).toContain("/api/containers/c1/metrics?days=30"));
    expect(screen.getByText("last 30 days")).toBeInTheDocument();
  });
});

describe("agent spend drilldown (agent_spend_routes wire)", () => {
  beforeEach(() => { localStorage.clear(); window.location.hash = "#/metrics"; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("clicking a per-agent row opens the drilldown and fetches spend + insights", async () => {
    const urls = stubFetch();
    mount();
    const row = await screen.findByText("forge");
    fireEvent.click(row.closest("tr")!);

    await waitFor(() => expect(urls).toContain("/api/containers/c1/metrics/agents/a1/spend?window=all"));
    await waitFor(() => expect(urls).toContain("/api/containers/c1/metrics/insights?window=all"));

    // agent header: alias, model chip, effort chip
    expect(await screen.findByRole("heading", { name: "forge" })).toBeInTheDocument();
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument();
    expect(screen.getByText("high effort")).toBeInTheDocument();

    // totals strip (In / Out / Cache read / Cache write / Total / $ / runs)
    expect(screen.getByText("1.2K")).toBeInTheDocument(); // input_tokens
    expect(screen.getByText("$10.00")).toBeInTheDocument();

    // per-task table: title links to /tasks?task=, synthetic conversation row present
    const taskLink = screen.getByText("Ship feature").closest("a");
    expect(taskLink?.getAttribute("href")).toBe("/tasks?task=t1");
    expect(screen.getByText("Conversation & drains")).toBeInTheDocument();

    // back link returns to the aggregate view
    fireEvent.click(screen.getByText("← Back to metrics"));
    await waitFor(() => expect(screen.getByText("Cost & activity by agent")).toBeInTheDocument());
  });

  it("window switch on the drilldown refetches spend (insights has no 5h window, maps to 7d)", async () => {
    const urls = stubFetch();
    mount();
    const row = await screen.findByText("forge");
    fireEvent.click(row.closest("tr")!);
    await screen.findByRole("heading", { name: "forge" });
    await waitFor(() => expect(urls).toContain("/api/containers/c1/metrics/agents/a1/spend?window=all"));
    urls.length = 0; // only care about post-switch fetches from here

    fireEvent.click(screen.getByText("5h"));
    await waitFor(() =>
      expect(urls).toContain("/api/containers/c1/metrics/agents/a1/spend?window=5h"));
    // insights has no 5h window — 5h maps to the 7d insights window, never a literal ?window=5h
    await waitFor(() => expect(urls).toContain("/api/containers/c1/metrics/insights?window=7d"));
    expect(urls).not.toContain("/api/containers/c1/metrics/insights?window=5h");
  });

  it("renders insights with severity, evidence and action", async () => {
    stubFetch();
    mount();
    const row = await screen.findByText("forge");
    fireEvent.click(row.closest("tr")!);

    expect(await screen.findByText("forge rewarms context every wake")).toBeInTheDocument();
    expect(screen.getByText(/Cache reads make up only 12%/)).toBeInTheDocument();
    expect(screen.getByText(/Batch this agent's work into fewer, longer sessions\./)).toBeInTheDocument();
    expect(screen.getByText("“Ship feature” is 63% of this window's spend")).toBeInTheDocument();
  });

  it("honest empty state when the agent has no measured runs in the window", async () => {
    const urls: string[] = [];
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      if (url.includes("/metrics/agents/a1/spend")) {
        return json({ ...spendAll, totals: { ...spendAll.totals, runs: 0 }, tasks: [] });
      }
      if (url.includes("/metrics/insights")) return json({ window: "7d", insights: [] });
      if (url.includes("/metrics?days=7")) return json(payload7);
      if (url.startsWith("/api/containers/c1")) return json(rawSnap);
      return json({});
    }) as unknown as typeof fetch;
    mount();
    const row = await screen.findByText("forge");
    fireEvent.click(row.closest("tr")!);

    expect(await screen.findByText("No measured runs in this window")).toBeInTheDocument();
    expect(screen.getByText(/No insights yet/)).toBeInTheDocument();
  });
});

describe("metrics formatters (metrics-state.js parity)", () => {
  it("fmtUsd: sub-cent 4dp, sub-$1000 2dp, thousands rounded", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.004)).toBe("$0.0040");
    expect(fmtUsd(12.345)).toBe("$12.35");
    expect(fmtUsd(1234.5)).toBe("$1,235");
  });
  it("fmtTokens: K/M with trailing .0 trimmed", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1500)).toBe("1.5K");
    expect(fmtTokens(2000000)).toBe("2M");
  });
  it("fmtDuration ladders d/h/m/s", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(59)).toBe("59s");
    expect(fmtDuration(150)).toBe("2m 30s");
    expect(fmtDuration(5400)).toBe("1h 30m");
    expect(fmtDuration(90000)).toBe("1d 1h");
  });
  it("costCaption is honest about coverage", () => {
    expect(costCaption({ runs: 0, runs_with_cost: 0 } as never)).toBe("no runs in this window");
    expect(costCaption({ runs: 1, runs_with_cost: 1 } as never)).toBe("estimated · 1 of 1 run reported cost");
  });
});
