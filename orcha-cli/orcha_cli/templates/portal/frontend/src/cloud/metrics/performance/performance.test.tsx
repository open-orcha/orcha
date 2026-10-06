/**
 * Agent performance (evals-lite): model formatters + Metrics → Agent performance table.
 * Tripwires: below-threshold figures read "Not enough data" (never a number), nothing
 * metered reads "Not metered" (never $0), counts render real zeros, project row first,
 * range pills refetch with ?range=, error → Retry, older server (404) → nothing rendered.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PerformanceSection } from "./PerformanceSection";
import { PerfSparkline } from "./PerfSparkline";
import {
  costFigure, firstPassFigure, firstPassTone, fmtCost, fmtSpan, medianFigure, NOT_ENOUGH, NOT_METERED,
  parseRange, planFigure, reworkTip, sparkValues, UNEXPECTED_RESPONSE, type PerfMetrics, type PerformancePayload,
} from "./performanceModel";

function metrics(o: Partial<PerfMetrics> = {}): PerfMetrics {
  return {
    tasks_verified: 0,
    first_pass_rate: { value: null, numerator: 0, denominator: 0, enough: false },
    rework: { total: 0, human_rejections: 0, manager_send_backs: 0 },
    median_time_to_verified_seconds: { value: null, n: 0, enough: false },
    cost_per_verified_task_usd: { value: null, metered_tasks: 0, unmetered_tasks: 0, total_metered_usd: null, enough: false },
    plan_approval_rate: { value: null, numerator: 0, denominator: 0, enough: false, approved: 0, rejected: 0 },
    escalations: 0,
    ...o,
  };
}
const FULL = metrics({
  tasks_verified: 4,
  first_pass_rate: { value: 0.75, numerator: 3, denominator: 4, enough: true },
  rework: { total: 2, human_rejections: 1, manager_send_backs: 1 },
  median_time_to_verified_seconds: { value: 5400, n: 4, enough: true },
  cost_per_verified_task_usd: { value: 0.4333, metered_tasks: 3, unmetered_tasks: 1, total_metered_usd: 1.3, enough: true },
  plan_approval_rate: { value: 0.75, numerator: 3, denominator: 4, enough: true, approved: 3, rejected: 1 },
  escalations: 1,
});
const series = (vals: number[]) => vals.map((v, i) => ({
  start: `2026-09-${String(20 + i).padStart(2, "0")}T00:00:00+00:00`,
  end: `2026-09-${String(21 + i).padStart(2, "0")}T00:00:00+00:00`, verified: v, rework: 0,
}));
const PAYLOAD: PerformancePayload = {
  range: "30d", since: "2026-08-31T00:00:00+00:00", bucket_days: 1, min_sample: 3, generated_at: "2026-09-29T00:00:00Z",
  project: { container_id: "c1", name: "orcha-web", metrics: FULL, series: series([0, 2, 3]) },
  agents: [
    { agent_id: "a2", alias: "Pixel", model: null, role: "frontend", retired: false,
      metrics: metrics({ tasks_verified: 1, first_pass_rate: { value: null, numerator: 1, denominator: 1, enough: false },
        cost_per_verified_task_usd: { value: null, metered_tasks: 0, unmetered_tasks: 1, total_metered_usd: null, enough: false } }),
      series: series([0, 1, 0]) },
    { agent_id: "a1", alias: "Forge", model: "claude-sonnet", role: "backend", retired: false, metrics: FULL, series: series([0, 1, 3]) },
  ],
};

function stub(body: unknown, status = 200) {
  const f = vi.fn(async (_u: string) => ({ ok: status < 400, status, json: async () => body }) as Response);
  global.fetch = f as unknown as typeof fetch;
  return f;
}
const mount = () => render(<MemoryRouter><PerformanceSection cid="c1" /></MemoryRouter>);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("performanceModel", () => {
  it("formats spans, costs and ranges", () => {
    expect(fmtSpan(42)).toBe("42s");
    expect(fmtSpan(600)).toBe("10m");
    expect(fmtSpan(5400)).toBe("1.5h");
    expect(fmtSpan(7200)).toBe("2h");
    expect(fmtSpan(86400 * 2.25)).toBe("2.3d");
    expect(fmtSpan(-1)).toBe("—");
    expect(fmtCost(0.4333)).toBe("$0.43");
    expect(fmtCost(0.004)).toBe("$0.004");
    expect(fmtCost(12.5)).toBe("$12.50");
    expect(fmtCost(250.4)).toBe("$250");
    expect(parseRange("90d")).toBe("90d");
    expect(parseRange("1y")).toBeNull();
    expect(sparkValues(series([1, 0, 2]))).toEqual([1, 0, 2]);
  });

  it("withholds rates below the threshold and never shows $0", () => {
    const thin = metrics({ tasks_verified: 2, first_pass_rate: { value: null, numerator: 2, denominator: 2, enough: false } });
    const fp = firstPassFigure(thin, 3);
    expect(fp.text).toBe(NOT_ENOUGH);
    expect(fp.known).toBe(false);
    expect(fp.tip).toContain("at least 3");
    expect(firstPassTone(thin)).toBeNull();
    expect(medianFigure(thin, 3).text).toBe(NOT_ENOUGH);
    expect(planFigure(thin, 3).text).toBe(NOT_ENOUGH);
    // nothing metered → "Not metered", not $0 and not "Not enough data"
    const c = costFigure(metrics({ tasks_verified: 2, cost_per_verified_task_usd: { value: null, metered_tasks: 0, unmetered_tasks: 2, total_metered_usd: null, enough: false } }), 3);
    expect(c.text).toBe(NOT_METERED);
    expect(c.text).not.toContain("$");
    expect(c.sub).toContain("2 not metered");
    // nothing verified at all → a sample problem ("Not enough data"), not "Not metered"
    expect(costFigure(metrics(), 3).text).toBe(NOT_ENOUGH);
    // metered but thin → not enough data
    expect(costFigure(metrics({ cost_per_verified_task_usd: { value: null, metered_tasks: 1, unmetered_tasks: 0, total_metered_usd: 0.2, enough: false } }), 3).text).toBe(NOT_ENOUGH);
  });

  it("formats enough-data figures", () => {
    expect(firstPassFigure(FULL, 3).text).toBe("75%");
    expect(firstPassFigure(FULL, 3).sub).toBe("3 of 4 verified tasks");
    expect(firstPassTone(FULL)).toBe("warn");
    expect(firstPassTone(metrics({ first_pass_rate: { value: 0.9, numerator: 9, denominator: 10, enough: true } }))).toBe("good");
    expect(firstPassTone(metrics({ first_pass_rate: { value: 0.2, numerator: 1, denominator: 5, enough: true } }))).toBe("bad");
    expect(medianFigure(FULL, 3).text).toBe("1.5h");
    expect(costFigure(FULL, 3).text).toBe("$0.43");
    expect(costFigure(FULL, 3).sub).toBe("3 metered tasks · 1 not metered");
    expect(planFigure(FULL, 3).text).toBe("75%");
    expect(reworkTip(FULL)).toBe("1 rejection by a human reviewer · 1 send-back by an AI manager's pre-review");
  });
});

describe("PerfSparkline", () => {
  it("draws one bar per non-zero bucket and a tick for honest zeros", () => {
    render(<PerfSparkline series={series([0, 2, 4])} bucketDays={1} label="Forge: verified" />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("aria-label")).toBe("Forge: verified: 6 verified across 3 days, peak 4 per day");
    expect(img.querySelectorAll(".pf-bar")).toHaveLength(2);
    expect(img.querySelectorAll(".pf-tick")).toHaveLength(1);
    expect((img.querySelectorAll(".pf-col")[2] as HTMLElement).title).toContain("4 verified");
  });
  it("says no activity for an empty series", () => {
    render(<PerfSparkline series={[]} bucketDays={7} label="x" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("x: no activity yet");
  });
});

describe("PerformanceSection", () => {
  it("renders the project total first, then agents by verified count, with honest cells", async () => {
    const f = stub(PAYLOAD);
    mount();
    const table = await screen.findByRole("table");
    expect(f.mock.calls[0][0]).toBe("/api/containers/c1/metrics/performance?range=7d");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("All agents");
    expect(rows[0].textContent).toContain("orcha-web");
    expect(rows[1].textContent).toContain("Forge");
    expect(rows[2].textContent).toContain("Pixel");
    const forge = rows[1].textContent || "";
    expect(forge).toContain("75%");
    expect(forge).toContain("1.5h");
    expect(forge).toContain("$0.43");
    const pixel = rows[2].textContent || "";
    expect(pixel).toContain(NOT_ENOUGH);
    expect(pixel).toContain(NOT_METERED);
    expect(pixel).not.toContain("$0");
    expect(screen.getByText("Agent performance")).toBeTruthy();
  });

  it("refetches with the chosen range", async () => {
    const f = stub(PAYLOAD);
    mount();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("radio", { name: /90 days/ }));
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).endsWith("range=90d"))).toBe(true));
  });

  it("shows an empty state when nothing happened in the range", async () => {
    stub({ ...PAYLOAD, range: "7d", project: { ...PAYLOAD.project, metrics: metrics() },
      agents: PAYLOAD.agents.map((a) => ({ ...a, metrics: metrics() })) });
    mount();
    expect(await screen.findByText("No verified work in the last 7 days")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("surfaces a load error with Retry", async () => {
    const f = stub({ detail: "boom" }, 500);
    mount();
    expect(await screen.findByText("Performance is temporarily unavailable")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    stub(PAYLOAD);
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(f).toHaveBeenCalled();
  });

  it("AP-29: a 200 HTML (proxy / login) page reads as a friendly error, never the JSON parser's text", async () => {
    const html = vi.fn(async (_u: string) => ({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError("Unexpected token '<', \"<html>prox\"... is not valid JSON"); },
    }) as unknown as Response);
    global.fetch = html as unknown as typeof fetch;
    const { container } = mount();
    expect(await screen.findByText("Performance is temporarily unavailable")).toBeTruthy();
    expect(screen.getByText(UNEXPECTED_RESPONSE)).toBeTruthy();
    expect(container.textContent).not.toContain("Unexpected token");
    expect(container.textContent).not.toContain("is not valid JSON");
  });

  it("AP-30: a 403 (not a member) hides the section — no repeated message, no useless Retry", async () => {
    const f = stub({ detail: "You are not a member of this project" }, 403);
    const { container } = mount();
    await waitFor(() => expect(f).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("#mxPerf")).toBeNull());
    expect(container.textContent).not.toContain("not a member");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("AP-30: a 401 also hides the section", async () => {
    const f = stub({ detail: "Not authenticated" }, 401);
    const { container } = mount();
    await waitFor(() => expect(f).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("#mxPerf")).toBeNull());
  });

  it("AP-31: follows the Metrics page window (7d → 30d) without a reload, and defaults to 7d like the table", async () => {
    const f = stub(PAYLOAD);
    const { rerender } = render(<MemoryRouter><PerformanceSection cid="c1" defaultRange="7d" /></MemoryRouter>);
    await screen.findByRole("table");
    expect(String(f.mock.calls[0][0])).toMatch(/range=7d$/);
    expect(screen.getByRole("radio", { name: /7 days/ }).getAttribute("aria-checked")).toBe("true");
    rerender(<MemoryRouter><PerformanceSection cid="c1" defaultRange="30d" /></MemoryRouter>);
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).endsWith("range=30d"))).toBe(true));
    expect(screen.getByRole("radio", { name: /30 days/ }).getAttribute("aria-checked")).toBe("true");
    // the section's own pill still picks a wider range in between…
    fireEvent.click(screen.getByRole("radio", { name: /90 days/ }));
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).endsWith("range=90d"))).toBe(true));
    // …and the next page-window change takes over again
    rerender(<MemoryRouter><PerformanceSection cid="c1" defaultRange="7d" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("radio", { name: /7 days/ }).getAttribute("aria-checked")).toBe("true"));
    expect(String(f.mock.calls[f.mock.calls.length - 1][0])).toMatch(/range=7d$/);
  });

  it("renders nothing against an older server without the route", async () => {
    const f = stub({ detail: "Not Found" }, 404);
    const { container } = mount();
    await waitFor(() => expect(f).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("#mxPerf")).toBeNull());
  });
});
