/**
 * QA regressions for /tasks:
 *  - #10 the optimistic `acted` suppression of a task's gate is pruned once the
 *    task leaves the gate, so a re-raised verification renders its gate again.
 *  - #14 / #32 a failed FIRST load renders an error state with Retry, never an
 *    endless "Loading tasks" status next to the offline banner.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";

const t1 = (status: string) => ({
  id: "t1aaaaaa", title: "Verify me", status, priority: 10, assignees: ["forge"], created_by_agent_id: "h1",
  created_at: "2026-08-01T00:00:00Z", definition_of_done: "DoD", message_summary: { count: 0, last: null }, result: "I did the thing",
});
let SNAP: Record<string, unknown>;
let snapStatus = 200;
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  snapStatus = 200;
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "forge", kind: "ai", status: "working" },
    ],
    tasks: [t1("needs_verification")],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return snapStatus === 200 ? jsonRes(SNAP) : jsonRes({ detail: "down" }, snapStatus);
    if (/\/messages$/.test(url) && method === "GET") return jsonRes({ messages: [] });
    if (/\/runs$/.test(url)) return jsonRes([]);
    return jsonRes({ ok: true });
  }));
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* jsdom */ }
});

const renderPage = (entry = "/tasks") =>
  render(
    <ToastProvider>
      <SnapshotProvider pollMs={40}>
        <MemoryRouter initialEntries={[entry]}>
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
const gate = () => document.querySelector("#gate-t1aaaaaa");

describe("TasksPage QA", () => {
  it("#10 a re-raised verification shows its gate again after the first decision is confirmed", async () => {
    renderPage("/tasks?task=t1aaaaaa");
    await waitFor(() => expect(gate()).toBeTruthy());
    fireEvent.click(document.querySelector('#gate-t1aaaaaa [data-act="reject"]')!);
    fireEvent.change(document.querySelector("#rt-t1aaaaaa")!, { target: { value: "DoD not met" } });
    fireEvent.click(document.querySelector("#cr-t1aaaaaa")!);
    await waitFor(() => expect(gate()).toBeNull());
    SNAP = { ...SNAP, tasks: [t1("in_progress")] };
    await new Promise((r) => setTimeout(r, 200));
    expect(gate()).toBeNull();
    SNAP = { ...SNAP, tasks: [t1("needs_verification")] };
    await waitFor(() => expect(gate()).toBeTruthy(), { timeout: 2000 });
  });

  it("#14/#32 a failed first load shows 'Couldn't load tasks' with Retry, not a loading status", async () => {
    snapStatus = 503;
    renderPage();
    expect(await screen.findByText("Couldn't load tasks", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading tasks" })).toBeNull();
    // the page's own Retry (the shell's offline banner may carry another one)
    const retry = within(document.querySelector("#tlist") as HTMLElement).getByRole("button", { name: "Retry" });
    // Retry recovers once the backend answers
    snapStatus = 200;
    fireEvent.click(retry);
    await waitFor(() => expect(document.querySelector('[data-id="t1aaaaaa"]')).toBeTruthy());
  });
});
