/**
 * Metrics — parity r2: scoping the drilldown's insights (r1) must not lose the
 * project-wide list. The summary keeps "How to reduce spending" with EVERY
 * insight (other agents', task rules, the window-wide cache rule), which is
 * where the drilldown's "See the project summary" link sends you.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { MetricsPage, type Insight } from "./MetricsPage";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "a1", alias: "forge", kind: "ai", status: "idle" }],
  tasks: [], requests: [],
};
const agg = {
  days: 7,
  totals: { runs: 1, runs_with_cost: 1, est_cost_usd: 1, sandbox_seconds: 1, tokens_in: 1, tokens_out: 1, tasks_completed: 0, tasks_verified: 0 },
  daily: [],
  per_agent: [{ agent_id: "a1", alias: "forge", model: null, runs: 1, ok_runs: 1, failed_runs: 0, sandbox_seconds: 1, tokens_in: 1, tokens_out: 1, est_cost_usd: 1 }],
};
const spendFor = (alias: string | null) => ({
  agent: { id: "a1", alias, model: null, reasoning_effort: null },
  window: "all",
  totals: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 0, total_cost_usd: 0, runs: 0, runs_with_cost: 0 },
  tasks: [{ task_id: "t1", title: "Mine", status: "done", runs: 1, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 0, total_cost_usd: 0, runs_with_cost: 0, first_run_at: null, last_run_at: null }],
});
const ins = (id: string, title: string, evidence: Record<string, unknown> = {}): Insight =>
  ({ id, severity: "medium", title, detail: "d", evidence, action: "a" });
const INSIGHTS: Insight[] = [
  ins("cold-context:a1", "forge cold context", { agent_alias: "forge" }),
  ins("heavy-model-small-talk:a9", "Opus for trivial review · Agent reviewer", { agent_alias: "reviewer" }),
  ins("context-bloat:t1", "Task Mine burns context", { task_id: "t1" }),
  ins("concentration:t7", "Someone else's task is 60%", { task_id: "t7" }),
  ins("cache-write-churn:window", "Window-wide cache churn", {}),
];

const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
function stub(spend: () => Response, insights: Insight[] = INSIGHTS) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.includes("/metrics/agents/")) return spend();
    if (url.includes("/metrics/insights")) return json({ window: "all", insights });
    if (url.includes("/metrics?days=")) return json(agg);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
}
const mount = () => render(<ToastProvider><SnapshotProvider><HashRouter><MetricsPage /></HashRouter></SnapshotProvider></ToastProvider>);

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("summary insights", () => {
  it("the summary lists every insight, including window-wide ones the drilldown drops", async () => {
    window.location.hash = "#/metrics";
    stub(() => json(spendFor("forge")));
    mount();
    expect(await screen.findByText("How to reduce spending")).toBeInTheDocument();
    for (const i of INSIGHTS) expect(await screen.findByText(i.title)).toBeInTheDocument();
    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls).toContain("/api/containers/c1/metrics/insights?window=7d");
  });

  it("30 days asks for the all-time window and says so", async () => {
    window.location.hash = "#/metrics?window=30d";
    stub(() => json(spendFor("forge")));
    mount();
    expect(await screen.findByText("Window-wide cache churn")).toBeInTheDocument();
    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls).toContain("/api/containers/c1/metrics/insights?window=all");
    expect(screen.getByText("all time")).toBeInTheDocument();
  });

  it("the drilldown's empty link lands on a summary that shows the other agents' insights", async () => {
    window.location.hash = "#/metrics?agent=a1";
    stub(() => json(spendFor("forge")), [INSIGHTS[1], INSIGHTS[4]]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "See the project summary" }));
    await waitFor(() => expect(window.location.hash).not.toMatch(/agent=/));
    expect((await screen.findAllByText(/Agent reviewer/)).length).toBeGreaterThan(0);
    expect(screen.getByText("Window-wide cache churn")).toBeInTheDocument();
  });
});
