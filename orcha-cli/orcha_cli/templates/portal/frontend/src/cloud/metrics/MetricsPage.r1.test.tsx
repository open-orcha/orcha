/**
 * V2 screen-quality round 1 (metrics): retry on load failure, no-cost caption +
 * token default sort, cost-bar honesty, shared status labels, drilldown cost
 * disclosure, readable insight evidence and deep links, Segmented range control.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import {
  MetricsPage, NO_COST_CAPTION, costBarPct, costCaption, fmtEvidence, insightLink, spendCostCaption,
} from "./MetricsPage";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [], tasks: [], requests: [],
};
const agg = {
  days: 7,
  totals: { runs: 9, runs_with_cost: 6, est_cost_usd: 12.34, sandbox_seconds: 60, tokens_in: 1500, tokens_out: 900, tasks_completed: 1, tasks_verified: 0 },
  daily: [{ date: "2026-08-01", runs: 0, est_cost_usd: 0 }, { date: "2026-08-02", runs: 9, est_cost_usd: 12.34 }],
  per_agent: [
    { agent_id: "a1", alias: "forge", model: "claude-sonnet", runs: 6, ok_runs: 6, failed_runs: 0, sandbox_seconds: 30, tokens_in: 100, tokens_out: 50, est_cost_usd: 12.34 },
    { agent_id: "a2", alias: "scout", model: null, runs: 3, ok_runs: 3, failed_runs: 0, sandbox_seconds: 30, tokens_in: 1400, tokens_out: 850, est_cost_usd: 0 },
  ],
};
const spend = {
  agent: { id: "a1", alias: "forge", model: "claude-opus-5", reasoning_effort: null },
  window: "all",
  totals: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 20, total_cost_usd: 7.5, runs: 48, runs_with_cost: 38 },
  tasks: [
    { task_id: "t1", title: "Waiting task", status: "awaiting_human", runs: 2, input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 10, total_cost_usd: 1, runs_with_cost: 2, first_run_at: null, last_run_at: null },
    { task_id: "t2", title: "Broken task", status: "failed", runs: 1, input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 10, total_cost_usd: 1, runs_with_cost: 1, first_run_at: null, last_run_at: null },
    { task_id: null, title: "Conversation (no task)", status: null, runs: 1, input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 5, total_cost_usd: 0, runs_with_cost: 0, first_run_at: null, last_run_at: null },
  ],
};

const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

function stub(opts: { metrics?: () => Response; agg?: unknown } = {}) {
  const urls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.includes("/metrics/agents/")) return json(spend);
    if (url.includes("/metrics/insights")) return json({ window: "all", insights: [] });
    if (url.includes("/metrics?days=")) return opts.metrics ? opts.metrics() : json(opts.agg ?? agg);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return urls;
}
function mount() {
  return render(<ToastProvider><SnapshotProvider><HashRouter><MetricsPage /></HashRouter></SnapshotProvider></ToastProvider>);
}

beforeEach(() => { localStorage.clear(); window.location.hash = "#/metrics"; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("metrics r1 — page behavior", () => {
  it("load failure shows human copy + Retry that refetches; raw status kept as detail", async () => {
    let fail = true;
    const urls = stub({ metrics: () => (fail ? json({}, 500) : json(agg)) });
    mount();
    expect(await screen.findByText("Metrics are temporarily unavailable")).toBeInTheDocument();
    expect(screen.getByText("HTTP 500")).toBeInTheDocument();
    fail = false;
    const before = urls.filter((u) => u.includes("/metrics?days=")).length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("forge");
    expect(urls.filter((u) => u.includes("/metrics?days=")).length).toBe(before + 1);
  });

  it("range is a Segmented radiogroup; arrow keys switch the window", async () => {
    const urls = stub();
    mount();
    await screen.findByText("forge");
    const group = screen.getByRole("radiogroup", { name: "Metrics window" });
    const seven = within(group).getByRole("radio", { name: "7 days" });
    expect(seven).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(seven, { key: "ArrowRight" });
    await waitFor(() => expect(urls).toContain("/api/containers/c1/metrics?days=30"));
  });

  it("no cost reported → caption says tokens are the signal and default sort is by tokens", async () => {
    stub({
      agg: {
        ...agg,
        totals: { ...agg.totals, runs_with_cost: 0, est_cost_usd: 0 },
        per_agent: agg.per_agent.map((a) => ({ ...a, est_cost_usd: 0 })),
      },
    });
    mount();
    expect(await screen.findByTitle(NO_COST_CAPTION)).toBeInTheDocument();
    const names = Array.from(document.querySelectorAll("tr[data-agent] .nm")).map((n) => n.textContent);
    expect(names).toEqual(["scout", "forge"]); // scout has more tokens
    expect(screen.getByRole("columnheader", { name: /Tokens/ })).toHaveAttribute("aria-sort", "descending");
  });

  it("missing model reads 'Model not recorded'; zero-run days draw a tick, not a bar", async () => {
    stub();
    mount();
    await screen.findByText("forge");
    expect(screen.getByText("Model not recorded")).toBeInTheDocument();
    const cols = document.querySelectorAll(".mx-col");
    expect(cols[0].querySelector(".mx-tick")).toBeTruthy();
    expect(cols[0].querySelector(".mx-bar")).toBeNull();
    // unknown-cost row (scout, partial window) draws no cost bar
    const scout = screen.getByText("scout").closest("tr")!;
    expect(scout.querySelector(".mx-costbar")).toBeNull();
    const forge = screen.getByText("forge").closest("tr")!;
    expect(forge.querySelector(".mx-costbar")).toBeTruthy();
  });

  it("drilldown: shared status labels, partial cost disclosure, 'No task' for conversation", async () => {
    stub();
    mount();
    fireEvent.click((await screen.findByText("forge")).closest("tr")!);
    await screen.findByRole("heading", { name: "forge" });
    expect(screen.getByText("Needs human")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("awaiting_human")).toBeNull();
    expect(screen.getByText("partial · 38 of 48 runs")).toHaveAttribute("title", "partial · 38 of 48 runs reported cost");
    expect(screen.getByText("No task")).toBeInTheDocument();
    expect(screen.getByText("Waiting task").closest("a")).toHaveAttribute("href", expect.stringContaining("/tasks?task=t1"));
    expect(screen.getByRole("radiogroup", { name: "Spend window" })).toBeInTheDocument();
  });
});

describe("metrics r1 — helpers", () => {
  it("costCaption: zero reported → tokens caption", () => {
    expect(costCaption({ runs: 5, runs_with_cost: 0 } as never)).toBe(NO_COST_CAPTION);
  });
  it("costBarPct: null when unknown or under 1%", () => {
    expect(costBarPct(0, 100, false)).toBeNull();
    expect(costBarPct(0.004, 142, true)).toBeNull();
    expect(costBarPct(50, 100, true)).toBe(50);
    expect(costBarPct(0, 0, true)).toBeNull();
  });
  it("spendCostCaption discloses partial / none", () => {
    expect(spendCostCaption({ runs: 48, runs_with_cost: 38, total_cost_usd: 71.5 })).toBe("partial · 38 of 48 runs reported cost");
    expect(spendCostCaption({ runs: 4, runs_with_cost: 4, total_cost_usd: 1 })).toBeNull();
    expect(spendCostCaption({ runs: 4, runs_with_cost: 0, total_cost_usd: 0 })).toBe("no run reported a cost");
    expect(spendCostCaption({ runs: 0, total_cost_usd: 0 })).toBeNull();
  });
  it("fmtEvidence: readable labels, percents, never [object Object]", () => {
    const r = fmtEvidence({ agent_alias: "forge", cache_hit_ratio: 0.12, runs: 6, input_tokens: 4_000_000, runs_without_cost: 22, cost_usd: 3.5, detail: { a: 1 } });
    expect(r.items).toEqual(["Agent forge", "Cache hit 12%", "Runs 6", "Input tokens 4M", "Runs without cost 22", "Cost $3.50"]);
    expect(r.items.join(" ")).not.toContain("[object Object]");
    expect(r.nested).toEqual({ detail: { a: 1 } });
  });
  it("insightLink deep-links actions", () => {
    expect(insightLink({ id: "i3", action: "Add a price for gpt-5 in Settings › Models & providers.", evidence: {} }))
      .toEqual({ to: "/settings#tab=provider-keys", label: "Open Models & providers" });
    expect(insightLink({ id: "context-bloat:t9", action: "Narrow the task's scope", evidence: {} })?.to).toBe("/tasks?task=t9");
    expect(insightLink({ id: "cold-context:a1", action: "Batch work", evidence: { agent_alias: "forge" } })?.to).toBe("/agents?agent=forge");
    expect(insightLink({ id: "cache-write-churn:window", action: "Tighten session cadence", evidence: {} })).toBeNull();
  });
});
