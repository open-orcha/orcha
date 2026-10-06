/**
 * Task detail — polish round 2 (tasks-detail): PR inline in the gate result,
 * the one-line "·" evidence, the in-place assignee editor, the one-line
 * "Spawned from", the pluralized cancel impact, and the New-task composer's
 * property menus (priority + assignee reach the POST body; Escape in a menu
 * never closes the draft; the dependency picker keeps its label and never
 * offers the project root).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { TasksPage } from "./TasksPage";

function task(id: string, title: string, status: string, priority: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    status,
    priority,
    assignees: ["forge"],
    created_by_agent_id: "h1",
    created_at: "2026-08-01T00:00:00Z",
    definition_of_done: "DoD for " + title,
    message_summary: { count: 0, last: null },
    ...extra,
  };
}

let SNAP: Record<string, unknown>;
let RUNS: unknown[] = [];
let IMPL: Record<string, unknown> | null = null;
let MSGS: unknown[] = [];
let calls: { url: string; method: string; body: unknown }[] = [];
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  calls = [];
  RUNS = [];
  IMPL = null;
  MSGS = [];
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "forge", kind: "ai", status: "working" },
    ],
    tasks: [
      task("t1aaaaaa", "Verify me", "needs_verification", 10, { result: "I did the thing", created_at: "2026-08-01T00:00:00Z" }),
      task("t2bbbbbb", "Second task", "in_progress", 50, { created_at: "2026-08-02T00:00:00Z", started_at: "2026-08-02T01:00:00Z" }),
      task("t3cccccc", "Third task", "ready", 30, { created_at: "2026-08-03T00:00:00Z" }),
    ],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || "GET";
      let body: unknown;
      if (init && typeof init.body === "string") body = JSON.parse(init.body);
      calls.push({ url, method, body });
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      if (/\/messages$/.test(url) && method === "GET") return jsonRes({ messages: MSGS });
      if (/\/runs$/.test(url)) return jsonRes(RUNS);
      if (/\/close-implications$/.test(url) && IMPL) return jsonRes(IMPL);
      if (/\/close-implications$/.test(url))
        return jsonRes({
          downstream_tasks: [],
          in_flight_agents: [],
          spawned_from_request: null,
          open_requests_from_assignees: [],
          summary: { downstream_total: 0, would_unblock: 0, still_blocked: 0, in_flight_agents: 0, open_requests: 0, completes_container: false },
        });
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
    sessionStorage.clear();
  } catch {
    /* jsdom */
  }
});

function Probe() {
  useLocation();
  return null;
}

function renderPage(entry: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <TasksPage />
          <Probe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}


const RUN_OK = { run_id: "r1", status: "completed", exit_code: 0, started_at: "2026-08-01T00:00:00Z", ended_at: "2026-08-01T00:05:00Z" };
const DIFF = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("Gate result — PR renders inline, never a nested 'Pull request' row", () => {
  it("pulls pr_url out of the result into a #102 chip after the summary", async () => {
    (SNAP.tasks as Record<string, unknown>[])[0].result = { summary: "Implemented and tested; PR opened.", pr_url: "https://github.com/acme/web/pull/102", pr_number: 102 };
    renderPage("/tasks?task=t1aaaaaa&full=1");
    const gate = await waitFor(() => {
      const g = document.querySelector("#gate-t1aaaaaa") as HTMLElement;
      expect(g).toBeTruthy();
      return g;
    });
    expect(gate.textContent).toContain("Implemented and tested; PR opened.");
    expect(within(gate).getByRole("link", { name: /#102/ })).toBeTruthy();
    // no key/value "Pull request" label (nor a repeated "Pr number" row)
    const labels = Array.from(gate.querySelectorAll("dt, .v2-payload-label")).map((e) => e.textContent);
    expect(labels).not.toContain("Pull request");
    expect(labels.join(" ")).not.toMatch(/Pr number/i);
  });
});

describe("Verification evidence — one '·'-joined line", () => {
  it("inspector: status · exit · age · runs · Open runs, and no code-changes disclosure", async () => {
    RUNS = [{ ...RUN_OK, diff: DIFF }, { run_id: "r0", status: "failed", exit_code: 2, started_at: "2026-07-31T00:00:00Z", ended_at: "2026-07-31T00:01:00Z" }];
    renderPage("/tasks?task=t1aaaaaa");
    const line = await waitFor(() => {
      const l = document.querySelector("#gate-t1aaaaaa .td-ev-line") as HTMLElement;
      expect(l).toBeTruthy();
      return l;
    });
    const parts = Array.from(line.querySelectorAll(":scope > .td-ev-part")).map((p) => p.textContent);
    expect(parts[0]).toBe("Completed");
    expect(parts[1]).toBe("exit 0");
    expect(parts).toContain("2 runs");
    expect(parts[parts.length - 1]).toBe("Open runs");
    expect(line.textContent).not.toContain("Latest run");
    expect(document.querySelector("#gate-t1aaaaaa .td-ev-diff")).toBeNull();
  });

  it("full view keeps the code-changes disclosure under the line", async () => {
    RUNS = [{ ...RUN_OK, diff: DIFF }];
    renderPage("/tasks?task=t1aaaaaa&full=1");
    await waitFor(() => expect(document.querySelector("#gate-t1aaaaaa .td-ev-diff")).toBeTruthy());
    expect(document.querySelector("#gate-t1aaaaaa .td-ev-diff summary")?.textContent).toBe("Code changes");
  });

  it("accepting toasts plain 'Accepted'", async () => {
    RUNS = [RUN_OK];
    renderPage("/tasks?task=t1aaaaaa");
    const accept = await waitFor(() => {
      const b = document.querySelector('#gate-t1aaaaaa [data-act="approve"]') as HTMLButtonElement;
      expect(b && !b.disabled).toBeTruthy();
      return b;
    });
    fireEvent.click(accept);
    const dialog = await screen.findByRole("dialog", { name: "Accept this task?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/tasks/t1aaaaaa/verify")).toBe(true));
    await waitFor(() => expect(document.body.textContent).toMatch(/Accepted/));
    expect(document.body.textContent).not.toContain("Accepted · completed");
  });
});

describe("Assignee — edited in place", () => {
  it("full view: the Assignee value opens the picker (no separate bottom action)", async () => {
    renderPage("/tasks?task=t3cccccc&full=1");
    const btn = await waitFor(() => {
      const b = document.querySelector('.td-rail [data-act="assign"]') as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    expect(btn.textContent).toContain("forge");
    expect(document.querySelector(".td-railact")).toBeNull();
    expect(screen.queryByText(/Reassign & wake…|Assign & wake…/)).toBeNull();
    fireEvent.click(btn);
    const menu = await screen.findByRole("menu", { name: "Agent to assign" });
    expect(within(menu).getByRole("menuitemradio", { name: /forge/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("inspector: the meta-line assignee is the editor", async () => {
    renderPage("/tasks?task=t3cccccc");
    await waitFor(() => expect(document.querySelector('.td-meta [data-act="assign"]')).toBeTruthy());
  });

  it("a finished task shows plain assignee links (not assignable)", async () => {
    renderPage("/tasks?task=t1aaaaaa&full=1");
    await waitFor(() => expect(document.querySelector(".td-rail")).toBeTruthy());
    expect(document.querySelector('[data-act="assign"]')).toBeNull();
    expect(document.querySelector('.td-rail a[href="/agents?agent=forge"]')).toBeTruthy();
  });
});

describe("Relations + cancel impact copy", () => {
  it("'Spawned from' is one line: 'Request from lead' (the implied 'converted' is only in the tooltip)", async () => {
    IMPL = {
      downstream_tasks: [],
      in_flight_agents: [],
      spawned_from_request: { request_id: "rq1", requester_alias: "lead", status: "converted_to_task" },
      open_requests_from_assignees: [],
      summary: { downstream_total: 0, would_unblock: 0, still_blocked: 0, in_flight_agents: 0, open_requests: 0, completes_container: false },
    };
    renderPage("/tasks?task=t2bbbbbb&full=1");
    const sp = await waitFor(() => {
      const e = document.querySelector(".td-spawned") as HTMLElement;
      expect(e).toBeTruthy();
      return e;
    });
    expect(sp.textContent).toBe("Request from lead");
    expect(sp.getAttribute("title")).toMatch(/Request from lead · Converted/i);
  });

  it("cancel impact pluralizes and shows at most two facts (the rest behind ⓘ)", async () => {
    IMPL = {
      downstream_tasks: [],
      in_flight_agents: [],
      spawned_from_request: null,
      open_requests_from_assignees: [],
      summary: { downstream_total: 2, would_unblock: 1, still_blocked: 1, in_flight_agents: 1, open_requests: 3, completes_container: false },
    };
    renderPage("/tasks?task=t2bbbbbb");
    await waitFor(() => expect(document.querySelector('[data-act="cancel"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-act="cancel"]')!);
    const dialog = await screen.findByRole("dialog", { name: "Cancel this task?" });
    const impact = await waitFor(() => {
      const e = dialog.querySelector(".td-impact") as HTMLElement;
      expect(e.textContent).toContain("2 tasks depend on this (1 would unblock) · 1 agent holds it.");
      return e;
    });
    expect(impact.textContent).not.toContain("(s)");
    expect(impact.textContent).not.toContain("open requests");
    expect(within(impact).getByRole("button", { name: /3 open requests from its assignees stay open/ })).toBeTruthy();
  });
});

describe("New task composer — menus above the dialog", () => {
  const openComposer = async () => {
    renderPage("/tasks?new=1");
    return screen.findByRole("dialog", { name: /New task/ });
  };

  it("picking High + an assignee reaches the create POST body", async () => {
    const dialog = await openComposer();
    fireEvent.change(document.querySelector("#nt_title")!, { target: { value: "Ship it" } });
    fireEvent.change(document.querySelector("#nt_dod")!, { target: { value: "It ships" } });
    fireEvent.click(dialog.querySelector("#nt_pri")!);
    const pm = await screen.findByRole("menu", { name: "Priority" });
    fireEvent.click(within(pm).getByText("High"));
    fireEvent.click(dialog.querySelector("#nt_assignee")!);
    const am = await screen.findByRole("menu", { name: "Assignee" });
    // keyboard: the menu takes focus and Enter picks
    const item = within(am).getByRole("menuitemradio", { name: /forge/ });
    item.focus();
    fireEvent.keyDown(item, { key: "Enter" });
    expect(dialog.querySelector("#nt_assignee")!.getAttribute("data-value")).toBe("forge");
    fireEvent.click(within(dialog).getByText("Create task"));
    await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/containers/c1/tasks" && x.method === "POST");
      expect(c?.body).toMatchObject({ title: "Ship it", definition_of_done: "It ships", priority: 10, assignee_alias: "forge", created_by_agent_id: "h1" });
    });
  });

  it("Escape in the assignee menu closes only the menu — the draft stays open", async () => {
    const dialog = await openComposer();
    fireEvent.change(document.querySelector("#nt_title")!, { target: { value: "Keep me" } });
    fireEvent.click(dialog.querySelector("#nt_assignee")!);
    const am = await screen.findByRole("menu", { name: "Assignee" });
    fireEvent.keyDown(within(am).getAllByRole("menuitemradio")[0], { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Assignee" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Discard this task?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: /New task/ })).toBeTruthy();
  });

  it("the dependency chip keeps its label while open and never offers the project root", async () => {
    (SNAP.tasks as Record<string, unknown>[]).push(task("t9rootaa", "Project root", "in_progress", 100, { is_root: true }));
    const dialog = await openComposer();
    const chip = dialog.querySelector("[data-deps-btn]") as HTMLButtonElement;
    fireEvent.click(chip);
    const pop = await screen.findByRole("dialog", { name: "Depends on" });
    expect(chip.textContent).toBe("Depends on");
    expect(within(pop).queryByText("Project root")).toBeNull();
    fireEvent.click(within(pop).getByText("Second task"));
    expect(chip.textContent).toBe("Depends on · 1");
  });
});
