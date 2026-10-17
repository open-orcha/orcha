/**
 * Integration mounts for the overnight features — each feature's component is exercised
 * INSIDE the real page it is wired into (not just in isolation):
 *   - Task detail: the Proof row (evidence pack) leads the verification gate; the goal
 *     chain sits above the title.
 *   - Needs you: a verify row's second line is the evidence one-liner.
 *   - Settings: General carries Work type (mode + templates) and Template (portability);
 *     Integrations carries Verdikt — also when the distribution has no GitHub.
 *   - General mode: the project tabs drop Code / GitHub and "Build to PR" reads "Execute".
 *   - Metrics: the Agent performance table; Agents › Configuration: the Performance card.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { resetProjectModeCache } from "../lib/projectMode";
import { TasksPage } from "./tasks/TasksPage";
import { NeedsPage } from "./needs/NeedsPage";
import { SettingsPage } from "./settings/SettingsPage";
import { HomePage } from "./home/HomePage";
import { AgentsPage } from "./agents/AgentsPage";
import { MetricsPage } from "../cloud/metrics/MetricsPage";
import { extensions } from "../extensions";

const TID = "t1aaaaaa";
const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" };
const FORGE = { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "backend" };

let SNAP: Record<string, unknown>;
let MODE: "code" | "general";
let calls: string[];

const SUMMARY = {
  dod: { total: 3, proven: 1, not_proven: 1, needs_human: 1 },
  tests: { status: "passed", passed: 42, failed: 0, skipped: 0, errors: 0, suites: 2 },
  risk_flags: 1,
  verdikt: { status: "completed", verdict: "fail" },
  line: "1/3 DoD items evidenced · 42 tests passed · 1 risk flag · Verdikt fail",
};
const PACK = {
  version: 1, task_id: TID, task_status: "needs_verification", basis: "b", built_at: "2026-09-29T00:00:00Z", round_started_at: null,
  runs: [{ run_id: "r1", agent_alias: "forge", status: "exited", exit_code: 0, lane: "work", started_at: null, ended_at: null }],
  tests: { status: "passed", passed: 42, failed: 0, skipped: 0, errors: 0, suites: 2, invocations: 1, earlier: 0, latest: [] },
  changes: { files: 1, additions: 2, deletions: 0, categories: { code: 1 }, summary: "Changed 1 file (+2 −0).", ui_touching: false, flags: [], list: [], truncated_list: false, unavailable_runs: [] },
  flags: [], branch: null, pr_urls: [], preview_urls: [], links: [], claim: null, dod_text: "",
  dod: {
    items: [
      { index: 0, text: "All tests pass", status: "proven", basis: "tests", evidence: "42 passed" },
      { index: 1, text: "Greets the user by name", status: "not_proven", basis: "verdikt", evidence: "Verdikt: fail" },
      { index: 2, text: "Copy reads well", status: "needs_human", basis: "none", evidence: "" },
    ],
    total: 3, proven: 1, not_proven: 1, needs_human: 1,
  },
  verdikt: null,
  summary: SUMMARY,
};
const CHAIN = {
  task_id: TID,
  goal_chain: [
    { kind: "objective", id: "root", title: "Orcha", text: "Ship a calm portal", source: "project_description" },
    { kind: "parent", id: "t0", title: "Epic: sign-in", status: "in_progress", via: "parent_link" },
    { kind: "task", id: TID, title: "Sign-in page", status: "needs_verification" },
  ],
  truncated: false,
  cycle: false,
};
function perfMetrics() {
  return {
    tasks_verified: 4,
    first_pass_rate: { value: 0.75, numerator: 3, denominator: 4, enough: true },
    rework: { total: 1, human_rejections: 1, manager_send_backs: 0 },
    median_time_to_verified_seconds: { value: 5400, n: 4, enough: true },
    cost_per_verified_task_usd: { value: null, metered_tasks: 0, unmetered_tasks: 4, total_metered_usd: null, enough: false },
    plan_approval_rate: { value: 1, numerator: 3, denominator: 3, enough: true, approved: 3, rejected: 0 },
    escalations: 0,
  };
}
const series = [{ start: "2026-09-27T00:00:00+00:00", end: "2026-09-28T00:00:00+00:00", verified: 2, rework: 0 }];
const PERF = {
  range: "30d", since: "2026-08-31T00:00:00+00:00", bucket_days: 1, min_sample: 3, generated_at: "2026-09-29T00:00:00Z",
  project: { container_id: "c1", name: "Orcha", metrics: perfMetrics(), series },
  agents: [{ agent_id: "a1", alias: "forge", model: null, role: "backend", retired: false, metrics: perfMetrics(), series }],
};
const VERDIKT = {
  configured: true, enabled: true, base_url: "http://127.0.0.1:31950", verdikt_project: "shop-web", target_kind: "web",
  target_locator: "http://127.0.0.1:5810", trigger_mode: "always", timeout_minutes: 30, updated_at: null, updated_by: null,
};

const json = (data: unknown, status = 200) =>
  ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data), clone() { return this; } }) as unknown as Response;

function route(url: string, method: string): Response {
  if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
  if (url.endsWith("/project-profile")) return json({ container_id: "c1", mode: MODE, dod_presets: [], template_key: null, template_name: null, last_applied_at: null });
  if (url.endsWith("/evidence-summaries")) return json({ summaries: { [TID]: SUMMARY } });
  if (url.endsWith("/evidence") && method === "GET") return json(PACK);
  if (url.endsWith("/goal-chain")) return json(CHAIN);
  if (url.endsWith("/deliverables")) return json({ task_id: TID, deliverables: [], limits: { max_bytes: 1, max_deliverables_per_task: 1, max_versions_per_deliverable: 1, allowed_extensions: [], outputs_folder: ".orcha/outputs" } });
  if (url.endsWith("/verdikt")) return json(VERDIKT);
  if (url.includes("/metrics/performance/agents/")) return json({ ...PERF, agent: PERF.agents[0] });
  if (url.includes("/metrics/performance")) return json(PERF);
  if (url.endsWith("/dod-presets") || url.endsWith("/skills")) return json({ items: [] });
  if (url.includes("/metrics?")) return json({ days: 7, totals: { runs: 0, runs_with_cost: 0, est_cost_usd: 0, sandbox_seconds: 0, tokens_in: 0, tokens_out: 0, tasks_completed: 0, tasks_verified: 0 }, daily: [], per_agent: [] });
  if (url === "/api/containers/c1" || url.startsWith("/api/containers/c1?")) return json(SNAP);
  if (url.startsWith("/api/containers/c1/snapshot")) return json(SNAP);
  return json({ detail: "Not Found" }, 404);
}

beforeEach(() => {
  localStorage.clear();
  resetProjectModeCache();
  MODE = "code";
  calls = [];
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "pr", wakes_enabled: true },
    agents: [HUMAN, FORGE],
    tasks: [
      {
        id: TID, title: "Sign-in page", status: "needs_verification", priority: 10, assignees: ["forge"],
        created_by_agent_id: "h1", created_at: "2026-09-01T00:00:00Z", definition_of_done: "All tests pass",
        result: "Built the sign-in page", message_summary: { count: 0, last: null },
      },
    ],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      return route(url, init?.method || "GET");
    }),
  );
});
const ORIGINAL_ROUTES = extensions.routes;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  extensions.routes = ORIGINAL_ROUTES;
});

function wrap(node: React.ReactNode, entry = "/") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("Task detail", () => {
  it("leads the verification gate with the Proof row and shows the goal chain above the title", async () => {
    wrap(<TasksPage />, "/tasks?task=" + TID + "&full=1");
    const gate = await screen.findByRole("region", { name: "Verification" });
    const proof = await waitFor(() => within(gate).getByTestId("evidence-pack"));
    await waitFor(() => expect(proof.textContent).toContain("1/3 DoD"));
    expect(proof.textContent).toContain("Verdikt fail");
    // Proof is the FIRST row of the gate
    expect(gate.querySelector(".td-g-rows")?.firstElementChild?.getAttribute("data-testid")).toBe("evidence-pack");
    const chain = await screen.findByTestId("goal-chain");
    expect(chain.textContent).toContain("Epic: sign-in");
    // the chain precedes the title
    const title = document.querySelector("#detailMain h1")!;
    expect(chain.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an older backend without the evidence route shows no Proof row (never a broken one)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/evidence")) return json({ detail: "Not Found" }, 404);
      return route(url, init?.method || "GET");
    }));
    wrap(<TasksPage />, "/tasks?task=" + TID + "&full=1");
    const gate = await screen.findByRole("region", { name: "Verification" });
    await waitFor(() => expect(within(gate).queryByText(/Gathering evidence/)).toBeNull());
    expect(within(gate).queryByTestId("evidence-pack")).toBeNull();
  });
});

describe("Needs you", () => {
  it("a verify row's second line is the proof-of-work one-liner", async () => {
    wrap(<NeedsPage />, "/needs");
    await waitFor(() => expect(calls.some((u) => u.endsWith("/evidence-summaries"))).toBe(true));
    await waitFor(() => {
      const row = document.querySelector(".nd-row");
      expect(row?.textContent || "").toContain("1/3 DoD");
    });
  });
});

describe("Settings", () => {
  it("General carries Work type and the Template (portability) section", async () => {
    window.history.replaceState(null, "", window.location.pathname + "#tab=general");
    wrap(<SettingsPage />);
    await waitFor(() => expect(document.getElementById("setWorkType")).toBeTruthy());
    expect(document.getElementById("setTemplate")).toBeTruthy();
    expect(screen.getByText("Share this setup")).toBeTruthy();
  });

  it("Integrations carries Verdikt even without GitHub routes", async () => {
    extensions.routes = (ORIGINAL_ROUTES || []).filter((r) => r.path !== "/github");
    window.history.replaceState(null, "", window.location.pathname + "#tab=github-access");
    wrap(<SettingsPage />);
    const url = await screen.findByLabelText("Verdikt URL");
    expect((url as HTMLInputElement).value).toBe("http://127.0.0.1:31950");
  });
});

describe("General (non-code) mode", () => {
  function home() {
    return render(
      <ToastProvider>
        <SnapshotProvider>
          <HashRouter>
            <HomePage />
          </HashRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
  }

  it("Code mode keeps the Code and GitHub tabs and 'Build to PR'", async () => {
    home();
    const nav = await screen.findByRole("navigation", { name: "Orcha sections" });
    await waitFor(() => expect(within(nav).queryByText("Code")).toBeTruthy());
    expect(within(nav).queryByText("GitHub")).toBeTruthy();
    fireEvent.click(await waitFor(() => document.getElementById("execBtn")!));
    await waitFor(() => expect(document.getElementById("autTop")?.textContent).toContain("Build to PR"));
  });

  it("General mode drops Code and GitHub and reads 'Execute'", async () => {
    MODE = "general";
    home();
    const nav = await screen.findByRole("navigation", { name: "Orcha sections" });
    await waitFor(() => expect(within(nav).queryByText("Code")).toBeNull());
    expect(within(nav).queryByText("GitHub")).toBeNull();
    expect(within(nav).queryByText("Metrics")).toBeTruthy();
    fireEvent.click(await waitFor(() => document.getElementById("execBtn")!));
    await waitFor(() => expect(document.getElementById("autTop")?.textContent).toContain("Execute"));
    expect(document.getElementById("autTop")?.textContent).not.toContain("Build to PR");
  });
});

describe("Agent performance", () => {
  it("Metrics shows the Agent performance table", async () => {
    wrap(<MetricsPage />, "/metrics");
    await screen.findByRole("heading", { name: "Agent performance" });
    await waitFor(() => expect(calls.some((u) => u.includes("/metrics/performance?range="))).toBe(true));
  });

  it("an AI agent's Configuration tab carries the Performance card", async () => {
    wrap(<AgentsPage />, "/agents?agent=forge&tab=config");
    await screen.findByRole("heading", { name: "Performance" });
    await waitFor(() => expect(calls.some((u) => u.includes("/metrics/performance/agents/a1"))).toBe(true));
  });
});
