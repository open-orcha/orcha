/**
 * QA regressions for the metrics page:
 *  - finding 13: a slow 7-day response that lands AFTER the user switched to
 *    30 days must never render under the 30-day toggle (request token).
 *  - finding 19: a per-task drilldown row whose runs recorded no cost reads
 *    "not reported", never "$0.00", even when another task has a real cost.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { MetricsPage } from "./MetricsPage";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

function mx(days: number, runs: number, cost: number) {
  return {
    days,
    totals: {
      runs, runs_with_cost: runs, est_cost_usd: cost, sandbox_seconds: 60,
      tokens_in: 10, tokens_out: 10, tasks_completed: 0, tasks_verified: 0,
    },
    daily: [{ date: "2026-08-04", runs, est_cost_usd: cost }],
    per_agent: [{
      agent_id: "a1", alias: "forge", model: null, runs, ok_runs: runs, failed_runs: 0,
      sandbox_seconds: 60, tokens_in: 10, tokens_out: 10, est_cost_usd: cost,
    }],
  };
}

const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;

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

describe("QA 13 — stale range response", () => {
  it("a 7-day response landing after the switch to 30 days is discarded", async () => {
    let release7: (() => void) | null = null;
    let sevenCalls = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      if (url.includes("/metrics?days=7")) {
        sevenCalls += 1;
        if (sevenCalls === 1) return json(mx(7, 7, 7.77)); // first paint
        // the refresh that is in flight when the user toggles: hold it open
        await new Promise<void>((res) => { release7 = res; });
        return json(mx(7, 7, 7.77));
      }
      if (url.includes("/metrics?days=30")) return json(mx(30, 30, 30.3));
      if (url.startsWith("/api/containers/c1")) return json(rawSnap);
      return json({});
    }) as unknown as typeof fetch;

    mount();
    await screen.findAllByText("$7.77");
    // re-mount-free way to get a 7-day request in flight: toggle 30 → 7 → 30
    fireEvent.click(screen.getByText("30 days"));
    await screen.findAllByText("$30.30");
    fireEvent.click(screen.getByText("7 days"));
    await waitFor(() => expect(release7).not.toBeNull());
    fireEvent.click(screen.getByText("30 days")); // switch while 7-day is in flight
    await screen.findAllByText("$30.30");
    release7!();
    await new Promise((r) => setTimeout(r, 20));
    // the late 7-day payload must not replace the 30-day one
    expect(screen.queryAllByText("$7.77")).toHaveLength(0);
    expect(screen.getAllByText("$30.30").length).toBeGreaterThan(0);
    expect(screen.getByText(/last 30 days \(UTC calendar days\)/)).toBeInTheDocument();
  });
});

describe("QA 19 — unknown per-task cost is never $0.00", () => {
  it("renders 'not reported' for a task whose runs recorded no cost", async () => {
    const spend = {
      agent: { id: "a1", alias: "forge", model: null, reasoning_effort: null },
      window: "all",
      totals: {
        input_tokens: 30, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        total_tokens: 60, total_cost_usd: 2, runs: 3, runs_with_cost: 1,
      },
      tasks: [
        {
          task_id: "t1", title: "Priced task", status: "done", runs: 1, runs_with_cost: 1,
          input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          total_tokens: 20, total_cost_usd: 2, first_run_at: null, last_run_at: null,
        },
        {
          task_id: "t2", title: "Subscription task", status: "done", runs: 2, runs_with_cost: 0,
          input_tokens: 20, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          total_tokens: 40, total_cost_usd: 0, first_run_at: null, last_run_at: null,
        },
      ],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      if (url.includes("/metrics/agents/a1/spend")) return json(spend);
      if (url.includes("/metrics/insights")) return json({ window: "all", insights: [] });
      if (url.includes("/metrics?days=")) return json(mx(7, 3, 2));
      if (url.startsWith("/api/containers/c1")) return json(rawSnap);
      return json({});
    }) as unknown as typeof fetch;
    mount();
    fireEvent.click((await screen.findByText("forge")).closest("tr")!);
    const unpriced = (await screen.findByText("Subscription task")).closest("tr")!;
    expect(within(unpriced).queryByText("$0.00")).toBeNull();
    expect(within(unpriced).getByText("not reported")).toBeInTheDocument();
    const priced = screen.getByText("Priced task").closest("tr")!;
    expect(within(priced).getByText("$2.00")).toBeInTheDocument();
  });
});

describe("QA — a non-member sees one calm line, not a 403 wall", () => {
  const forbidden = () => ({ ok: false, status: 403, json: async () => ({ detail: "You are not a member of this project" }) }) as unknown as Response;

  it("summary: a 403 on metrics + insights shows no 'temporarily unavailable', no HTTP 403, no Retry", async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      if (url.includes("/metrics")) return forbidden();
      if (url.startsWith("/api/containers/c1")) return json(rawSnap);
      return json({});
    }) as unknown as typeof fetch;
    mount();
    await waitFor(() => {
      expect(seen.some((u) => u.includes("/metrics?days="))).toBe(true);
      expect(seen.some((u) => u.includes("/metrics/insights"))).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 20));
    const body = document.body.textContent || "";
    expect(body).not.toMatch(/temporarily unavailable/);
    expect(body).not.toContain("HTTP 403");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(document.querySelector("#mxBody")?.textContent).toBe("");
    expect(screen.queryByText("How to reduce spending")).toBeNull();
  });

  it("a non-403 failure still shows the error with a Retry", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      if (url.includes("/metrics")) return ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;
      if (url.startsWith("/api/containers/c1")) return json(rawSnap);
      return json({});
    }) as unknown as typeof fetch;
    mount();
    await screen.findByText("Metrics are temporarily unavailable");
    await screen.findByText(/Insights are temporarily unavailable/);
    expect(screen.getAllByRole("button", { name: /Retry/ }).length).toBeGreaterThanOrEqual(2);
  });

  it("drilldown: a 403 on spend + insights shows neither error nor Retry", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      if (url.includes("/metrics/agents/a1/spend") || url.includes("/metrics/insights")) return forbidden();
      if (url.includes("/metrics?days=")) return json(mx(7, 3, 2));
      if (url.startsWith("/api/containers/c1")) return json(rawSnap);
      return json({});
    }) as unknown as typeof fetch;
    mount();
    fireEvent.click((await screen.findByText("forge")).closest("tr")!);
    await screen.findByRole("button", { name: "Back to metrics" });
    await new Promise((r) => setTimeout(r, 20));
    const body = document.body.textContent || "";
    expect(body).not.toMatch(/temporarily unavailable/);
    expect(body).not.toContain("HTTP 403");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });
});
