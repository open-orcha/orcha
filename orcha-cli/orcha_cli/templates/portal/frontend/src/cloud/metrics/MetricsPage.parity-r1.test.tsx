/**
 * Metrics — wave-4 / parity r1:
 *  - a drilldown for an agent that isn't in the project (stale link / retired)
 *    says "Agent not found" with a way back, never a fabricated "$0.00 · 0 runs"
 *    page followed by the whole project's insights;
 *  - the drilldown's "How to reduce spending" only lists suggestions about THIS
 *    agent (or tasks it spent on); none → "No suggestions for <alias>".
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { MetricsPage, insightsForAgent, type Insight } from "./MetricsPage";

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

describe("insightsForAgent", () => {
  it("keeps this agent's rules and rules about its tasks; drops other agents and window-wide rules", () => {
    const out = insightsForAgent(INSIGHTS, "a1", "forge", ["t1", null])!.map((i) => i.id);
    expect(out).toEqual(["cold-context:a1", "context-bloat:t1"]);
    expect(insightsForAgent(null, "a1", "forge", [])).toBeNull();
  });
});

describe("agent drilldown", () => {
  it("a 404 (agent not in this project) shows 'Agent not found' + All agents, and no insights card", async () => {
    window.location.hash = "#/metrics?agent=00000000-0000-0000-0000-000000000000";
    stub(() => json({ detail: "agent not found" }, 404));
    mount();
    expect(await screen.findByText("Agent not found")).toBeInTheDocument();
    expect(screen.queryByText("How to reduce spending")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /All agents/ }));
    await waitFor(() => expect(window.location.hash).not.toMatch(/agent=/));
  });

  it("an anonymous 200 for an id the project doesn't know is treated as not found (never fabricated)", async () => {
    window.location.hash = "#/metrics?agent=ghost";
    stub(() => json(spendFor(null)));
    mount();
    expect(await screen.findByText("Agent not found")).toBeInTheDocument();
  });

  it("a known agent's insights are scoped to it", async () => {
    window.location.hash = "#/metrics?agent=a1";
    stub(() => json(spendFor("forge")));
    mount();
    expect(await screen.findByText("forge cold context")).toBeInTheDocument();
    expect(screen.getByText("Task Mine burns context")).toBeInTheDocument();
    expect(screen.queryByText(/Agent reviewer/)).toBeNull();
    expect(screen.queryByText("Window-wide cache churn")).toBeNull();
    expect(screen.queryByText(/Someone else's task/)).toBeNull();
  });

  it("no matching insight → 'No suggestions for <alias>' with a link back to the summary", async () => {
    window.location.hash = "#/metrics?agent=a1";
    stub(() => json(spendFor("forge")), [INSIGHTS[1], INSIGHTS[4]]);
    mount();
    const empty = await waitFor(() => {
      const el = document.querySelector("#mxInsEmptyAgent");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(empty).toHaveTextContent("No suggestions for forge.");
    fireEvent.click(screen.getByRole("button", { name: "See the project summary" }));
    await waitFor(() => expect(window.location.hash).not.toMatch(/agent=/));
  });
});
