/**
 * Agent Configuration → Performance card: seven figures + sparkline for one agent;
 * honest "Not enough data" / "Not metered"; range pills refetch; humans get no card;
 * older server → no card; error → Retry.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AgentPerformancePayload, PerfMetrics } from "../../../cloud/metrics/performance/performanceModel";

vi.mock("../../../state/SnapshotProvider", () => ({ useSnapshot: () => ({ cid: "c1", snap: null }) }));
import { AgentPerformanceCard } from "./AgentPerformanceCard";

const THIN: PerfMetrics = {
  tasks_verified: 2,
  first_pass_rate: { value: null, numerator: 2, denominator: 2, enough: false },
  rework: { total: 1, human_rejections: 1, manager_send_backs: 0 },
  median_time_to_verified_seconds: { value: null, n: 2, enough: false },
  cost_per_verified_task_usd: { value: null, metered_tasks: 0, unmetered_tasks: 2, total_metered_usd: null, enough: false },
  plan_approval_rate: { value: 1, numerator: 3, denominator: 3, enough: true, approved: 3, rejected: 0 },
  escalations: 0,
};
const PAYLOAD: AgentPerformancePayload = {
  range: "30d", since: null, bucket_days: 1, min_sample: 3, generated_at: "",
  agent: {
    agent_id: "a1", alias: "Forge", model: null, role: "backend", retired: false, metrics: THIN,
    series: [{ start: "2026-09-28T00:00:00+00:00", end: "2026-09-29T00:00:00+00:00", verified: 2, rework: 1 }],
  },
};
function stub(body: unknown, status = 200) {
  const f = vi.fn(async (_u: string) => ({ ok: status < 400, status, json: async () => body }) as Response);
  global.fetch = f as unknown as typeof fetch;
  return f;
}
const mount = (kind: "ai" | "human" = "ai") =>
  render(<MemoryRouter><AgentPerformanceCard agent={{ id: "a1", alias: "Forge", kind } as never} /></MemoryRouter>);
const fig = (id: string) => document.querySelector(`[data-fig="${id}"]`)?.textContent || "";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AgentPerformanceCard", () => {
  it("renders the figures truthfully", async () => {
    const f = stub(PAYLOAD);
    mount();
    expect(await screen.findByText("Verified per day")).toBeTruthy();
    expect(f.mock.calls[0][0]).toBe("/api/containers/c1/metrics/performance/agents/a1?range=7d");
    expect(fig("verified")).toContain("2");
    expect(fig("first_pass")).toContain("Not enough data");
    expect(fig("time")).toContain("Not enough data");
    expect(fig("cost")).toContain("Not metered");
    expect(fig("cost")).not.toContain("$0");
    expect(fig("plan")).toContain("100%");
    expect(fig("rework")).toContain("1 rejected · 0 sent back");
    expect(fig("escalations")).toContain("0");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("2 verified");
    expect(screen.getByRole("link", { name: "Compare agents in Metrics" }).getAttribute("href")).toBe("/metrics#mxPerf");
  });

  it("refetches on range change", async () => {
    const f = stub(PAYLOAD);
    mount();
    await screen.findByText("Verified per day");
    fireEvent.click(screen.getByRole("radio", { name: /30 days/ }));
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).endsWith("range=30d"))).toBe(true));
  });

  it("renders nothing for a human", () => {
    const f = stub(PAYLOAD);
    const { container } = mount("human");
    expect(container.textContent).toBe("");
    expect(f).not.toHaveBeenCalled();
  });

  it("AP-30: a 403 (not a member) hides the card instead of an error with a useless Retry", async () => {
    const f = stub({ detail: "You are not a member of this project" }, 403);
    const { container } = mount();
    await waitFor(() => expect(f).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".apf")).toBeNull());
    expect(container.textContent).not.toContain("not a member");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("AP-29: a 200 non-JSON body reads as a friendly error", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError("Unexpected token '<', \"<html>prox\"... is not valid JSON"); },
    }) as unknown as Response) as unknown as typeof fetch;
    const { container } = mount();
    expect(await screen.findByText(/Unexpected response from the server/)).toBeTruthy();
    expect(container.textContent).not.toContain("Unexpected token");
  });

  it("AP-31: defaults to 7 days, matching the Metrics table", async () => {
    stub(PAYLOAD);
    mount();
    await screen.findByText("Verified per day");
    expect(screen.getByRole("radio", { name: /7 days/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("hides against an older server and retries after an error", async () => {
    stub({ detail: "Not Found" }, 404);
    const { container, unmount } = mount();
    await waitFor(() => expect(container.querySelector(".apf")).toBeNull());
    unmount();
    stub({ detail: "db down" }, 500);
    mount();
    expect(await screen.findByText("db down")).toBeTruthy();
    stub(PAYLOAD);
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Verified per day")).toBeTruthy();
  });
});
