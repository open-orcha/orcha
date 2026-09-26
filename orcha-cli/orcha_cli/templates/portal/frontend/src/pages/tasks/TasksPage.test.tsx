/**
 * TasksPage tests — list render, ?task= deep-link selection, verify gate POST
 * body, and the reject-requires-reason flow. `global.fetch` is stubbed; the
 * page renders inside ToastProvider + SnapshotProvider + MemoryRouter (jsdom
 * has no EventSource — the provider and useRunStream tolerate that).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";

const RAW_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
  ],
  tasks: [
    {
      id: "t1",
      title: "Verify me",
      status: "needs_verification",
      priority: 10,
      assignees: ["forge"],
      created_by_agent_id: "a1",
      created_at: "2026-08-01T00:00:00Z",
      definition_of_done: "It works end to end",
      result: "I did the thing",
      message_summary: { count: 0, last: null },
    },
    {
      id: "t2",
      title: "Second task",
      status: "in_progress",
      priority: 50,
      assignees: ["forge"],
      created_by_agent_id: "h1",
      created_at: "2026-08-02T00:00:00Z",
      definition_of_done: "Also works",
      message_summary: { count: 0, last: null },
    },
  ],
  requests: [],
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];

function jsonRes(data: unknown, status = 200) {
  return {
    ok: status < 300,
    status,
    json: async () => data,
  } as Response;
}

beforeEach(() => {
  calls = [];
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      let body: unknown = undefined;
      if (init && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method, body });
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(RAW_SNAPSHOT);
      if (/\/api\/tasks\/[^/]+\/messages$/.test(url) && method === "GET") return jsonRes({ messages: [] });
      if (/\/api\/tasks\/[^/]+\/runs$/.test(url)) return jsonRes([]);
      return jsonRes({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});

function renderPage(initialEntry = "/tasks") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("TasksPage", () => {
  it("renders the grouped task list from the snapshot", async () => {
    renderPage();
    // both tasks appear in the list once the snapshot lands
    expect((await screen.findAllByText("Verify me")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Second task")).length).toBeGreaterThan(0);
    // grouped by status with the vanilla group headers
    expect(screen.getByText("Needs verification")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("selects the task from the ?task= deep link", async () => {
    renderPage("/tasks?task=t2");
    await waitFor(() => {
      const h1 = document.querySelector("#detailMain h1");
      expect(h1?.textContent).toContain("Second task");
    });
    // and the matching list row is highlighted
    const row = document.querySelector('.trow[data-id="t2"]');
    expect(row?.className).toContain("sel");
  });

  it("verify gate posts the exact vanilla body on Accept", async () => {
    renderPage("/tasks?task=t1");
    await waitFor(() => expect(document.querySelector("#gate-t1")).toBeTruthy());
    // gate approve -> confirm modal -> primary
    fireEvent.click(document.querySelector('#gate-t1 [data-act="approve"]')!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Accept this task?");
    fireEvent.click(within(dialog).getByText("Accept"));
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/tasks/t1/verify");
      expect(call).toBeTruthy();
      expect(call!.method).toBe("POST");
      expect(call!.body).toEqual({ approve: true, actor_agent_id: "h1" });
    });
  });

  it("reject demands a typed reason before it can submit", async () => {
    renderPage("/tasks?task=t1");
    await waitFor(() => expect(document.querySelector("#gate-t1")).toBeTruthy());
    // opening the reject flow reveals the reason box, submit still disabled
    fireEvent.click(document.querySelector('#gate-t1 [data-act="reject"]')!);
    const reasonBox = document.querySelector("#reason-t1")!;
    expect(reasonBox.className).toContain("show");
    const submitBtn = document.querySelector<HTMLButtonElement>("#cr-t1")!;
    expect(submitBtn.disabled).toBe(true);
    // no POST without a reason
    fireEvent.click(submitBtn);
    expect(calls.some((c) => c.url === "/api/tasks/t1/verify")).toBe(false);
    // typing a reason enables submit; the POST carries it as feedback
    fireEvent.change(document.querySelector("#rt-t1")!, { target: { value: "DoD not met" } });
    expect(submitBtn.disabled).toBe(false);
    fireEvent.click(submitBtn);
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/tasks/t1/verify");
      expect(call).toBeTruthy();
      expect(call!.body).toEqual({ approve: false, actor_agent_id: "h1", feedback: "DoD not met" });
    });
  });
});
