/**
 * KG-6b: a budget-paused assignee is explained where the owner looks — the task's
 * meta line carries the "Budget paused" chip, the assign menu marks the paused agent,
 * and the Assign confirm never promises a wake the server will refuse.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";

const scope = (paused: boolean) => ({
  limits: { usd: 10, tokens: null },
  usage: { spend_usd: paused ? 12 : 1, metered_runs: 1, unmetered_runs: 0, unmetered_tokens: 0, tokens: 10, runs: 1, in_flight_runs: 0 },
  state: paused ? "exceeded" : "ok",
  usd_ratio: paused ? 1.2 : 0.1,
  token_ratio: null,
  limits_reached: paused ? ["usd"] : [],
  paused,
  override: { active: false, granted_by: null, granted_at: null, note: null },
  updated_at: null,
});
const BUDGETS = {
  period: "2026-09",
  starts_at: "2026-09-01T00:00:00Z",
  resets_at: "2026-10-01T00:00:00Z",
  project: scope(false),
  agents: [
    { ...scope(true), agent_id: "a2", alias: "quill", blocked_by: "agent", reason: "Quill's monthly budget is reached" },
    { ...scope(false), agent_id: "a1", alias: "forge", blocked_by: null, reason: null },
  ],
};

const task = (id: string, title: string, status: string, assignees: string[]) => ({
  id, title, status, priority: 50, assignees, created_by_agent_id: "h1",
  created_at: "2026-09-01T00:00:00Z", definition_of_done: "DoD", message_summary: { count: 0, last: null },
});

const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  const SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "forge", kind: "ai", status: "idle" },
      { id: "a2", alias: "quill", kind: "ai", status: "idle" },
    ],
    tasks: [task("t1aaaaaa", "Quill docs task", "in_progress", ["quill"]), task("t2bbbbbb", "Unassigned task", "ready", [])],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1/budgets") return jsonRes(BUDGETS);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (/\/messages$/.test(url)) return jsonRes({ messages: [] });
    if (/\/runs$/.test(url)) return jsonRes([]);
    return jsonRes({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderPage = (entry: string) =>
  render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}><TasksPage /></MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );

describe("KG-6b: budget-paused assignee", () => {
  it("the task meta line shows the Budget paused chip next to the assignee", async () => {
    renderPage("/tasks?task=t1aaaaaa");
    const meta = await waitFor(() => {
      const m = document.querySelector(".td-meta") as HTMLElement;
      expect(m?.textContent).toContain("Budget paused");
      return m;
    });
    expect(meta.textContent).toContain("quill");
  });

  it("the assign menu marks the paused agent and the confirm is honest", async () => {
    renderPage("/tasks?task=t2bbbbbb");
    const btn = await waitFor(() => {
      const b = document.querySelector('.td-meta [data-act="assign"]') as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    expect(document.querySelector(".td-meta")?.textContent).not.toContain("Budget paused");
    fireEvent.click(btn);
    const menu = await screen.findByRole("menu", { name: "Agent to assign" });
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { name: /quill/ }).textContent).toContain("Budget paused"));
    expect(within(menu).getByRole("menuitemradio", { name: /forge/ }).textContent).not.toContain("Budget paused");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /quill/ }));
    const dialog = await screen.findByRole("dialog", { name: "Assign task?" });
    expect(dialog.textContent).toContain("quill is budget-paused — the task is queued and starts when the budget resets or an override is granted.");
    expect(dialog.textContent).not.toContain("This wakes them");
    expect(within(dialog).getByRole("button", { name: "Assign" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Assign & wake" })).toBeNull();
  });
});
