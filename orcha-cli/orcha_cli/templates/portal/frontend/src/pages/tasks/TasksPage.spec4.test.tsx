/**
 * SPEC-4 behavioral tests (Create-Task UI + per-task Protocol panel), ported
 * from the pytest node harness that used to eval static/tasks.html
 * (tests/test_spec4_createtask_protocol.py). Drives the REAL TasksPage:
 *   - protoEmpty truth table, behaviorally: no/blank protocol renders the
 *     "No protocol set" empty state; ANY key carrying text renders the panel;
 *   - Edit -> Save PATCHes /api/tasks/{tid}/protocol with the acting human +
 *     all four free-text keys ("" clears — the Ledger partial-merge contract);
 *   - the New-Task form validates required title + DoD, then POSTs the
 *     EXISTING container-tasks route with created_by_agent_id.
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
      id: "p1",
      title: "No proto task",
      status: "in_progress",
      priority: 50,
      assignees: ["forge"],
      created_at: "2026-08-01T00:00:00Z",
      definition_of_done: "Works",
      protocol: null, // protoEmpty(null) -> empty state
      message_summary: { count: 0, last: null },
    },
    {
      id: "p2",
      title: "Partial proto task",
      status: "in_progress",
      priority: 50,
      assignees: ["forge"],
      created_at: "2026-08-02T00:00:00Z",
      definition_of_done: "Works",
      // a PARTIAL protocol still renders the panel, not the empty note
      protocol: { review_chain: "dev -> Helm", notes: "check the runbook" },
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
  return { ok: status < 300, status, json: async () => data } as Response;
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
      if (url.startsWith("/api/containers/c1") && method === "GET") return jsonRes(RAW_SNAPSHOT);
      if (/\/api\/tasks\/[^/]+\/messages$/.test(url) && method === "GET") return jsonRes({ messages: [] });
      if (/\/api\/tasks\/[^/]+\/runs$/.test(url)) return jsonRes([]);
      if (/\/api\/tasks\/p2\/protocol$/.test(url) && method === "PATCH")
        return jsonRes({ task_id: "p2", protocol: body });
      if (/\/api\/containers\/c1\/tasks$/.test(url) && method === "POST")
        return jsonRes({ task_id: "t9", status: "ready" });
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

describe("SPEC-4 protocol panel (protoEmpty truth table, behaviorally)", () => {
  it("no protocol renders the empty state with a human-gated Set affordance", async () => {
    renderPage("/tasks?task=p1");
    await waitFor(() => expect(document.querySelector("#proto-p1")).toBeTruthy());
    const panel = document.querySelector("#proto-p1")!;
    expect(panel.textContent).toContain("No protocol set — using container defaults.");
    expect(panel.querySelector('[data-pact="set"]')).toBeTruthy(); // acting human present
  });

  it("a PARTIAL protocol (any key carrying text) renders the panel rows, not the empty note", async () => {
    renderPage("/tasks?task=p2");
    await waitFor(() => expect(document.querySelector("#proto-p2")).toBeTruthy());
    const panel = document.querySelector("#proto-p2")!;
    expect(panel.textContent).not.toContain("No protocol set");
    expect(panel.textContent).toContain("Review chain");
    expect(panel.textContent).toContain("dev -> Helm");
    expect(panel.textContent).toContain("check the runbook"); // notes row
  });

  it("Edit -> Save PATCHes /api/tasks/{tid}/protocol with the acting human + all four keys ('' clears)", async () => {
    renderPage("/tasks?task=p2");
    await waitFor(() => expect(document.querySelector("#proto-p2")).toBeTruthy());
    fireEvent.click(document.querySelector('#proto-p2 [data-pact="edit"]')!);
    // autonomy is FREE TEXT (SPEC-1 enum deferred)
    fireEvent.change(document.querySelector('[data-pfield="autonomy"]')!, { target: { value: "ship without asking" } });
    fireEvent.click(document.querySelector('#proto-p2 [data-pact="save"]')!);
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/tasks/p2/protocol");
      expect(call).toBeTruthy();
      expect(call!.method).toBe("PATCH");
      expect(call!.body).toEqual({
        actor_agent_id: "h1", // human authority, on the audit trail
        review_chain: "dev -> Helm",
        handoff_to: "", // untouched-blank keys still ride ('' clears)
        autonomy: "ship without asking",
        notes: "check the runbook",
      });
    });
  });
});

describe("SPEC-4 create-task form (human-gated, real route)", () => {
  it("validates required title + DoD, then POSTs the container-tasks route with the acting human", async () => {
    renderPage("/tasks");
    await waitFor(() => expect(document.querySelector("[data-newtask]")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-newtask]")!);
    const dialog = await screen.findByRole("dialog");

    // required-field validation: title first, then DoD — no POST either time
    fireEvent.click(within(dialog).getByText("Create task"));
    await waitFor(() => expect(document.querySelector("#nt_err")?.textContent).toContain("Title is required."));
    fireEvent.change(document.querySelector("#nt_title")!, { target: { value: "Ship it" } });
    fireEvent.click(within(dialog).getByText("Create task"));
    await waitFor(() => expect(document.querySelector("#nt_err")?.textContent).toContain("Definition of done is required."));
    expect(calls.some((c) => c.url === "/api/containers/c1/tasks" && c.method === "POST")).toBe(false);

    // full form -> POST to the EXISTING route, creator = the acting human
    fireEvent.change(document.querySelector("#nt_dod")!, { target: { value: "It ships" } });
    fireEvent.click(within(dialog).getByText("Create task"));
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/containers/c1/tasks" && c.method === "POST");
      expect(call).toBeTruthy();
      expect(call!.body).toEqual({
        title: "Ship it",
        description: null,
        definition_of_done: "It ships",
        priority: 100,
        created_by_agent_id: "h1",
        depends_on: [],
      });
      // #57: no protocol field touched -> the key is omitted entirely, not sent as {}
      expect(call!.body).not.toHaveProperty("protocol");
    });
  });

  it("#57 create-time protocol: only the set fields ride under `protocol`, collapsed by default", async () => {
    renderPage("/tasks");
    await waitFor(() => expect(document.querySelector("[data-newtask]")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-newtask]")!);
    const dialog = await screen.findByRole("dialog");

    // collapsed-by-default: the native <details> starts closed (fields are present in the DOM
    // per HTML semantics, but not visible/expanded until the summary is toggled open).
    const details = dialog.querySelector("details");
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);

    fireEvent.click(dialog.querySelector("summary")!);
    expect(details!.open).toBe(true);

    fireEvent.change(document.querySelector("#nt_title")!, { target: { value: "Ship it" } });
    fireEvent.change(document.querySelector("#nt_dod")!, { target: { value: "It ships" } });
    // only review_chain and notes are filled in — handoff_to/autonomy stay untouched
    fireEvent.change(document.querySelector("#nt_p_chain")!, { target: { value: "Builder → Reviewer → human" } });
    fireEvent.change(document.querySelector("#nt_p_notes")!, { target: { value: "keep it small" } });

    fireEvent.click(within(dialog).getByText("Create task"));
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/containers/c1/tasks" && c.method === "POST");
      expect(call).toBeTruthy();
      const body = call!.body as Record<string, unknown>;
      expect(body.protocol).toEqual({
        review_chain: "Builder → Reviewer → human",
        notes: "keep it small",
      });
      // untouched keys never ride, even as empty strings
      expect(body.protocol).not.toHaveProperty("handoff_to");
      expect(body.protocol).not.toHaveProperty("autonomy");
    });
  });
});
