/**
 * V2 Tasks page behaviour: URL-persisted search/filter/sort/group/view, board
 * view, `?new=1`, Overview/Activity/Runs tabs (drafts survive tab switches),
 * inspector close / full view, not-found + truncation disclosure, failed
 * decisions keep input, cancel shows impact, keyboard list navigation.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    created_at: `2026-08-0${priority % 9 || 1}T00:00:00Z`,
    definition_of_done: "DoD for " + title,
    message_summary: { count: 0, last: null },
    ...extra,
  };
}

let SNAP: Record<string, unknown>;
let verifyStatus = 200;
let calls: { url: string; method: string; body: unknown }[] = [];
let loc = { pathname: "", search: "" };

function jsonRes(data: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => data } as Response;
}

beforeEach(() => {
  calls = [];
  verifyStatus = 200;
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "forge", kind: "ai", status: "working" },
      { id: "a2", alias: "mira", kind: "ai", status: "idle" },
    ],
    tasks: [
      task("t1aaaaaa", "Verify me", "needs_verification", 10, { result: "I did the thing", created_at: "2026-08-01T00:00:00Z" }),
      task("t2bbbbbb", "Second task", "in_progress", 50, { created_at: "2026-08-02T00:00:00Z" }),
      task("t3cccccc", "Mira's work", "ready", 30, { assignees: ["mira"], created_at: "2026-08-03T00:00:00Z" }),
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
      if (/\/messages$/.test(url) && method === "GET") return jsonRes({ messages: [] });
      if (/\/runs$/.test(url)) return jsonRes([{ run_id: "r1", status: "completed", exit_code: 0, started_at: "2026-08-01T00:00:00Z", ended_at: "2026-08-01T00:05:00Z", diff: null }]);
      if (/\/close-implications$/.test(url))
        return jsonRes({
          downstream_tasks: [{ task_id: "t3cccccc", title: "Mira's work", status: "pending", would_unblock: true }],
          in_flight_agents: [],
          spawned_from_request: null,
          open_requests_from_assignees: [],
          summary: { downstream_total: 1, would_unblock: 1, still_blocked: 0, in_flight_agents: 0, open_requests: 0, completes_container: false },
        });
      if (/\/verify$/.test(url)) return jsonRes(verifyStatus < 300 ? { ok: true } : { detail: "reviewer mismatch" }, verifyStatus);
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
  const l = useLocation();
  loc = { pathname: l.pathname, search: l.search };
  return null;
}

function renderPage(entry = "/tasks") {
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

const rowIds = () => Array.from(document.querySelectorAll(".trow")).map((r) => r.getAttribute("data-id"));
const groupHeads = () => Array.from(document.querySelectorAll(".tl-grp .v2-group-title")).map((h) => h.textContent);

describe("TasksPage V2 — list query in the URL", () => {
  it("search filters rows and persists as ?q= (replace)", async () => {
    renderPage();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("Filter tasks"), { target: { value: "mira" } });
    await waitFor(() => expect(new URLSearchParams(loc.search).get("q")).toBe("mira"));
    expect(rowIds()).toEqual(["t3cccccc"]);
    // #shortid search
    fireEvent.change(screen.getByLabelText("Filter tasks"), { target: { value: "#t2bb" } });
    await waitFor(() => expect(rowIds()).toEqual(["t2bbbbbb"]));
  });

  it("status + assignee filters come from the URL and can be cleared", async () => {
    renderPage("/tasks?status=in_progress,ready&assignee=forge");
    await waitFor(() => expect(rowIds()).toEqual(["t2bbbbbb"]));
    expect(groupHeads()).toEqual(["In progress"]);
    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    expect(new URLSearchParams(loc.search).get("status")).toBeNull();
    expect(new URLSearchParams(loc.search).get("assignee")).toBeNull();
  });

  it("an empty filter result says so and offers to clear", async () => {
    renderPage("/tasks?assignee=none");
    expect(await screen.findByText(/No tasks match these filters/)).toBeInTheDocument();
  });

  it("sort + group from the URL: priority, lowest first, ungrouped", async () => {
    renderPage("/tasks?sort=priority-desc&group=none");
    await waitFor(() => expect(rowIds()).toEqual(["t2bbbbbb", "t3cccccc", "t1aaaaaa"]));
    // ordering lives in the Display popover (radio rows, no native <select>)
    fireEvent.click(document.querySelector("[data-display-btn]")!);
    const pop = await screen.findByRole("dialog", { name: "Display options" });
    fireEvent.click(within(pop).getByLabelText("Priority · highest first"));
    await waitFor(() => expect(rowIds()).toEqual(["t1aaaaaa", "t3cccccc", "t2bbbbbb"]));
    expect(new URLSearchParams(loc.search).get("sort")).toBe("priority-asc");
    // the choice also becomes the local default (shared orcha:sort:tasks key)
    expect(JSON.parse(localStorage.getItem("orcha:sort:tasks") || "{}")).toEqual({ key: "priority", dir: "asc" });
  });

  it("group by assignee", async () => {
    renderPage("/tasks?group=assignee");
    await waitFor(() => expect(groupHeads()).toEqual(["forge", "mira"]));
  });

  it("board view is read-only status columns; a card opens the task", async () => {
    renderPage("/tasks?view=board");
    // the workflow note is screen-reader text (D12: boilerplate out of the layout)
    expect(await screen.findByText(/cards can't be dragged between columns/)).toBeInTheDocument();
    const col = screen.getByRole("region", { name: "In progress" });
    expect(col.querySelector(".v2-bcol-count")?.textContent).toBe("1");
    fireEvent.click(within(col).getByRole("button", { name: /Second task/ }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("task")).toBe("t2bbbbbb"));
    expect(new URLSearchParams(loc.search).get("view")).toBe("board");
  });

  it("?new=1 opens the New task composer", async () => {
    renderPage("/tasks?new=1");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("New task");
    expect(document.querySelector("#nt_title")).toBeTruthy();
  });

  it("?new=1&for=<alias> pre-fills the assignee only with a real AI agent", async () => {
    renderPage("/tasks?new=1&for=forge");
    await screen.findByRole("dialog");
    await waitFor(() => expect(document.querySelector("#nt_assignee")?.getAttribute("data-value")).toBe("forge"));
    cleanup();
    renderPage("/tasks?new=1&for=nobody");
    await screen.findByRole("dialog");
    expect(document.querySelector("#nt_assignee")?.getAttribute("data-value")).toBe("");
  });

  it("discloses a truncated snapshot instead of implying the list is complete", async () => {
    SNAP = { ...SNAP, task_total: 1500 };
    renderPage();
    expect(await screen.findByText(/tasks \(snapshot limit\)/)).toBeInTheDocument();
  });
});

describe("TasksPage V2 — detail", () => {
  it("the primary gate sits above the tabs; tabs mirror ?tab=", async () => {
    renderPage("/tasks?task=t1aaaaaa");
    await waitFor(() => expect(document.querySelector("#gate-t1aaaaaa")).toBeTruthy());
    const gate = document.querySelector("#gate-t1aaaaaa")!;
    const tablist = screen.getByRole("tablist", { name: "Task sections" });
    expect(gate.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // verification shows result, DoD and run evidence together
    expect(gate.textContent).toContain("I did the thing");
    expect(gate.textContent).toContain("DoD for Verify me");
    await waitFor(() => expect(gate.querySelector(".td-ev-line")?.textContent).toMatch(/^Completed·?exit 0/));
    expect(gate.textContent).toContain("not proof the task is done");
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("tab")).toBe("activity"));
  });

  it("a thread draft survives switching tabs", async () => {
    renderPage("/tasks?task=t2bbbbbb&tab=activity");
    await waitFor(() => expect(document.querySelector("#reply")).toBeTruthy());
    fireEvent.change(document.querySelector("#reply")!, { target: { value: "half-typed" } });
    fireEvent.click(screen.getByRole("tab", { name: /Runs/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    expect((document.querySelector("#reply") as HTMLTextAreaElement).value).toBe("half-typed");
  });

  it("a failed verification keeps the typed reason and shows the server's reason", async () => {
    verifyStatus = 409;
    renderPage("/tasks?task=t1aaaaaa");
    await waitFor(() => expect(document.querySelector("#gate-t1aaaaaa")).toBeTruthy());
    fireEvent.click(document.querySelector('#gate-t1aaaaaa [data-act="reject"]')!);
    fireEvent.change(document.querySelector("#rt-t1aaaaaa")!, { target: { value: "DoD not met" } });
    fireEvent.click(document.querySelector("#cr-t1aaaaaa")!);
    const err = await screen.findByText(/Decision not recorded/);
    expect(err.closest(".wk-err")?.textContent).toContain("reviewer mismatch");
    expect((document.querySelector("#rt-t1aaaaaa") as HTMLTextAreaElement).value).toBe("DoD not met");
    expect(document.querySelector("#gate-t1aaaaaa")).toBeTruthy(); // still awaiting a decision
  });

  it("a failed Accept keeps the confirm open with the error", async () => {
    verifyStatus = 403;
    renderPage("/tasks?task=t1aaaaaa");
    await waitFor(() => expect(document.querySelector("#gate-t1aaaaaa")).toBeTruthy());
    fireEvent.click(document.querySelector('#gate-t1aaaaaa [data-act="approve"]')!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText("Accept"));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("HTTP 403"));
  });

  it("deep link to an unknown task shows an honest not-found state", async () => {
    renderPage("/tasks?task=nope1234");
    expect(await screen.findByText("Task not found")).toBeInTheDocument();
  });

  it("closing the inspector removes ?task= and leaves the list", async () => {
    renderPage("/tasks?task=t2bbbbbb");
    await waitFor(() => expect(document.querySelector("#detailMain")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(document.querySelector("#detailMain")).toBeNull());
    expect(new URLSearchParams(loc.search).get("task")).toBeNull();
    expect(rowIds()).toHaveLength(3);
  });

  it("expands to a full view (?full=1) with a way back", async () => {
    renderPage("/tasks?task=t2bbbbbb");
    await waitFor(() => expect(document.querySelector("#detailMain")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Open full view" }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("full")).toBe("1"));
    expect(document.querySelector(".wk-full")).toBeTruthy();
    expect(document.querySelector(".trow")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("full")).toBeNull());
    expect(document.querySelector(".trow")).toBeTruthy();
  });

  it("Cancel task shows the read-only impact, then posts /cancel with the reason", async () => {
    renderPage("/tasks?task=t2bbbbbb");
    await waitFor(() => expect(document.querySelector('[data-act="cancel"]')).toBeTruthy());
    // the reason field lives in the confirm dialog (not an always-open textarea)
    expect(document.querySelector("#cancelReason")).toBeNull();
    fireEvent.click(document.querySelector('[data-act="cancel"]')!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "superseded" } });
    await waitFor(() => expect(dialog.textContent).toContain("1 task depends on this (1 would unblock)"));
    expect(dialog.textContent).not.toContain("(s)");
    fireEvent.click(within(dialog).getByText("Cancel task"));
    await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/tasks/t2bbbbbb/cancel");
      expect(c?.body).toEqual({ actor_agent_id: "h1", reason: "superseded" });
    });
  });

  it("Overview lists downstream relationships from close-implications", async () => {
    renderPage("/tasks?task=t2bbbbbb");
    const link = await screen.findByRole("link", { name: "Mira's work" });
    expect(link.getAttribute("href")).toBe("/tasks?task=t3cccccc");
  });
});

describe("TasksPage V2 — keyboard", () => {
  it("↓ / j move between rows and Enter selects", async () => {
    renderPage("/tasks?group=none&sort=priority-asc");
    await waitFor(() => expect(rowIds()).toEqual(["t1aaaaaa", "t3cccccc", "t2bbbbbb"]));
    const rows = document.querySelectorAll<HTMLElement>(".trow");
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: "j" });
    expect(document.activeElement).toBe(rows[2]);
    await act(async () => {
      fireEvent.keyDown(rows[2], { key: "Enter" });
    });
    await waitFor(() => expect(new URLSearchParams(loc.search).get("task")).toBe("t2bbbbbb"));
  });
});

describe("TasksPage V2 — Linear list (D8/D12)", () => {
  it("rows are one line: priority · short id · status glyph · title · avatar · time — no activity text line", async () => {
    SNAP = {
      ...SNAP,
      tasks: (SNAP.tasks as Record<string, unknown>[]).map((t) =>
        t.id === "t2bbbbbb" ? { ...t, message_summary: { count: 1, last: { body: "Pushed the first pass", author_alias: "forge", at: "2026-08-02T01:00:00Z" } } } : t,
      ),
    };
    renderPage("/tasks?group=none");
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const row = document.querySelector('.trow[data-id="t2bbbbbb"]') as HTMLElement;
    expect(row.querySelector("[data-priority]")).toBeTruthy();
    expect(row.querySelector(".tl-id")?.textContent).toBe("t2bbbbbb");
    expect(row.querySelector('[data-status="in_progress"]')?.textContent).toContain("In progress");
    expect(row.querySelector(".tl-title")?.textContent).toBe("Second task");
    // the latest-activity line moved to the tooltip (detail/activity hold it)
    expect(row.textContent).not.toContain("Pushed the first pass");
    expect(row.getAttribute("title")).toContain("Pushed the first pass");
    expect(row.querySelector(".wk-sub")).toBeNull();
  });

  it("'Working…' only when a run for THIS task is running — an agent merely 'working' is not enough", async () => {
    SNAP = {
      ...SNAP,
      tasks: (SNAP.tasks as Record<string, unknown>[]).map((t) =>
        t.id === "t2bbbbbb" ? { ...t, runs: { count: 1, latest: { status: "running", started_at: "2026-08-02T00:00:00Z" } } } : t,
      ),
    };
    renderPage("/tasks?group=none");
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    expect(document.querySelector('.trow[data-id="t2bbbbbb"] [data-live="working"]')).toBeTruthy();
    // t1 is assigned to forge (agent status "working", no active run on t1) → avatar, no pill
    expect(document.querySelector('.trow[data-id="t1aaaaaa"] [data-live]')).toBeNull();
  });

  it("scope pills write the exact statuses to ?status= and show counts", async () => {
    renderPage();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const scope = screen.getByRole("radiogroup", { name: "Task scope" });
    const active = within(scope).getByRole("radio", { name: /Active/ });
    expect(active.textContent).toContain("2"); // needs_verification + in_progress
    fireEvent.click(active);
    await waitFor(() => expect(new URLSearchParams(loc.search).get("status")).toBe("needs_verification,in_progress,blocked,failed"));
    await waitFor(() => expect(rowIds()).toEqual(expect.arrayContaining(["t1aaaaaa", "t2bbbbbb"])));
    expect(rowIds()).not.toContain("t3cccccc");
    expect(within(scope).getByRole("radio", { name: /Active/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(scope).getByRole("radio", { name: /All tasks/ }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("status")).toBeNull());
  });

  it("a custom status filter selects no scope pill (never pretends to be a preset)", async () => {
    renderPage("/tasks?status=ready");
    await waitFor(() => expect(rowIds()).toEqual(["t3cccccc"]));
    const scope = screen.getByRole("radiogroup", { name: "Task scope" });
    expect(within(scope).queryAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(0);
    expect(document.querySelector("[data-filter-btn]")?.className).toContain("is-on");
  });

  it("group bands collapse with the caret and remember it", async () => {
    renderPage();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const toggle = screen.getByRole("button", { name: /In progress/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rowIds()).not.toContain("t2bbbbbb");
    expect(JSON.parse(localStorage.getItem("orcha:v2:tasks:grp") || "{}")["status:in_progress"]).toBe(true);
  });

  it("the board-view toggle is a pressed circular button that writes ?view=board", async () => {
    renderPage();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const btn = screen.getByRole("button", { name: "Board view" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    await waitFor(() => expect(new URLSearchParams(loc.search).get("view")).toBe("board"));
    expect(screen.getByRole("button", { name: "Board view" }).getAttribute("aria-pressed")).toBe("true");
  });
});
