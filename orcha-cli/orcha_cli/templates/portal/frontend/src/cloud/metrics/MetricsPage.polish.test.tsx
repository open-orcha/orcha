/**
 * Metrics — polish round 1 (review findings): Initiatives health verdicts,
 * no duplicated scope line (project/window already in header + pill), one-line
 * stat captions with the full sentence as tooltip, a phone sort pill that
 * drives the same sort as the column headers, unified window vocabulary, and
 * the insights window stated only when it differs from the selected pill.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { MetricsPage, costCaptionShort } from "./MetricsPage";

const rawSnap = { container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" }, agents: [], tasks: [], requests: [] };
const agg = {
  days: 7,
  totals: { runs: 30, runs_with_cost: 20, est_cost_usd: 12.34, sandbox_seconds: 60, tokens_in: 1500, tokens_out: 900, tasks_completed: 1, tasks_verified: 0 },
  daily: [{ date: "2026-08-01", runs: 10, est_cost_usd: 4 }, { date: "2026-08-02", runs: 20, est_cost_usd: 8.34 }],
  per_agent: [
    { agent_id: "a1", alias: "forge", model: "claude-sonnet", runs: 20, ok_runs: 20, failed_runs: 0, sandbox_seconds: 30, tokens_in: 100, tokens_out: 50, est_cost_usd: 12.34 },
    { agent_id: "a2", alias: "scout", model: null, runs: 10, ok_runs: 9, failed_runs: 1, sandbox_seconds: 90, tokens_in: 1400, tokens_out: 850, est_cost_usd: 0 },
  ],
};
const spend = {
  agent: { id: "a1", alias: "forge", model: "claude-opus-5", reasoning_effort: null },
  window: "all",
  totals: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 15, total_cost_usd: 1, runs: 1, runs_with_cost: 1 },
  tasks: [{ task_id: "t1", title: "Only task", status: "completed", runs: 1, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 15, total_cost_usd: 1, runs_with_cost: 1, first_run_at: null, last_run_at: null }],
};
const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
function stub() {
  const urls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.includes("/metrics/agents/")) return json(spend);
    if (url.includes("/metrics/insights")) return json({ window: "7d", insights: [] });
    if (url.includes("/metrics?days=")) return json(agg);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return urls;
}
const mount = () => render(
  <ToastProvider><SnapshotProvider><HashRouter><MetricsPage /></HashRouter></SnapshotProvider></ToastProvider>,
);
const names = () => Array.from(document.querySelectorAll("tr[data-agent] .nm")).map((n) => n.textContent);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Metrics polish r1", () => {
  it("costCaptionShort is one short, honest line", () => {
    expect(costCaptionShort({ runs: 0, runs_with_cost: 0 })).toBe("no runs");
    expect(costCaptionShort({ runs: 5, runs_with_cost: 0 })).toBe("see tokens");
    expect(costCaptionShort({ runs: 285, runs_with_cost: 150 })).toBe("from 150 of 285 runs");
    expect(costCaptionShort({ runs: 4, runs_with_cost: 4 })).toBe("all runs reported");
  });

  it("no visible scope line: project + window live in the header/pill, scope stays for AT and in the ⓘ popover", async () => {
    stub();
    mount();
    await screen.findByText("forge");
    const scope = document.getElementById("mxScope")!;
    expect(scope).toHaveClass("v2-sr");
    expect(scope).toHaveTextContent("last 7 days (UTC calendar days)");
    fireEvent.click(screen.getByRole("button", { name: "How cost is estimated" }));
    const pop = await screen.findByRole("dialog", { name: "How cost is estimated" });
    expect(within(pop).getByText(/UTC calendar days/)).toBeInTheDocument();
  });

  it("health column prints the verdict; failures are never a check/‘No failures’ label", async () => {
    stub();
    mount();
    const scout = (await screen.findByText("scout")).closest("tr")!;
    const chip = scout.querySelector("[data-health]")!;
    expect(chip).toHaveAttribute("data-health", "at_risk");
    expect(chip).toHaveTextContent("At risk");
    expect(chip.getAttribute("title")).toContain("9 of 10 runs succeeded · 1 failed");
    expect(screen.queryByText(/No failures/)).toBeNull();
  });

  it("phone sort pill drives the same sort as the column headers", async () => {
    stub();
    mount();
    await screen.findByText("forge");
    expect(names()).toEqual(["forge", "scout"]); // default: est. cost desc
    const pill = screen.getByRole("button", { name: /Sort\s+Est\. cost/ });
    fireEvent.click(pill);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Compute" }));
    await waitFor(() => expect(names()).toEqual(["scout", "forge"]));
    expect(screen.getByRole("columnheader", { name: /Compute/ })).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(screen.getByRole("button", { name: /Sort\s+Compute/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Ascending" }));
    await waitFor(() => expect(names()).toEqual(["forge", "scout"]));
    expect(screen.getByRole("columnheader", { name: /Compute/ })).toHaveAttribute("aria-sort", "ascending");
  });

  it("drilldown: window pills use the same vocabulary; insights window shown only when it differs", async () => {
    const urls = stub();
    mount();
    fireEvent.click((await screen.findByText("forge")).closest("tr")!);
    await screen.findByRole("heading", { name: "forge" });
    const pills = screen.getByRole("radiogroup", { name: "Spend window" });
    expect(within(pills).getAllByRole("radio").map((r) => r.textContent)).toEqual(["5 hours", "7 days", "30 days", "All time"]);
    // carried 7 days → insights also 7 days → no extra window note
    expect(within(pills).getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
    const insH = await screen.findByRole("heading", { name: "How to reduce spending" });
    expect(insH.parentElement!.querySelector(".count")).toBeNull();
    // Spend-by-task header count is just the number (window is on the pill)
    expect(screen.getByRole("heading", { name: "Spend by task" }).parentElement!.querySelector(".count")).toHaveTextContent(/^1$/);
    fireEvent.click(within(pills).getByRole("radio", { name: "5 hours" }));
    await waitFor(() => expect(urls).toContain("/api/containers/c1/metrics/insights?window=7d"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "How to reduce spending" }).parentElement!.querySelector(".count")).toHaveTextContent("last 7 days"));
  });
});
