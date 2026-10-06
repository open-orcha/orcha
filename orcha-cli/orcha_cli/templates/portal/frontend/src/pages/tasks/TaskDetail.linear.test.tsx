/**
 * Task detail — the Linear issue layout (D5/D8/D10/D12): header row (glyph ·
 * short ID · title · ⋯ · "N / M ↑ ↓"), compact gate card (no boilerplate),
 * the property rail, and the Activity timeline built ONLY from real
 * timestamps + the thread as comment cards.
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
let MSGS: unknown[] = [];
let calls: { url: string; method: string; body: unknown }[] = [];
let loc = { pathname: "", search: "" };
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  calls = [];
  RUNS = [];
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
  const l = useLocation();
  loc = { pathname: l.pathname, search: l.search };
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

const pane = () => document.querySelector("#detailMain .td-pane") as HTMLElement;

describe("Task detail — Linear header row", () => {
  it("shows glyph · short ID · title (h1) and a 1 / N pager that walks the filtered list", async () => {
    renderPage("/tasks?task=t2bbbbbb&full=1");
    await waitFor(() => expect(document.querySelector("#detailMain h1")?.textContent).toBe("Second task"));
    const head = pane().querySelector(".td-head") as HTMLElement;
    expect(head.querySelector('[data-status="in_progress"]')).toBeTruthy(); // the shared D8 glyph with its label
    expect(head.textContent).toContain("t2bbbbbb");
    const pager = within(head).getByRole("group", { name: /task \d of 3/ });
    const idx = Number(/task (\d) of 3/.exec(pager.getAttribute("aria-label") || "")![1]);
    const next = within(pager).getByRole("button", { name: "Next task" }) as HTMLButtonElement;
    const prev = within(pager).getByRole("button", { name: "Previous task" }) as HTMLButtonElement;
    const btn = idx < 3 ? next : prev;
    fireEvent.click(btn);
    await waitFor(() => expect(new URLSearchParams(loc.search).get("task")).not.toBe("t2bbbbbb"));
    // the full view survives paging (replace, keeps ?full=1)
    expect(new URLSearchParams(loc.search).get("full")).toBe("1");
  });

  it("the ⋯ menu offers copy, runs and a Cancel task… that opens the same impact confirm", async () => {
    renderPage("/tasks?task=t2bbbbbb&full=1");
    await waitFor(() => expect(document.querySelector("#detailMain h1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    const menu = await screen.findByRole("menu", { name: "Task actions" });
    expect(within(menu).getByText("Copy link")).toBeTruthy();
    expect(within(menu).getByText("Copy task ID")).toBeTruthy();
    expect(within(menu).getByText("Open runs")).toBeTruthy();
    fireEvent.click(within(menu).getByText("Cancel task…"));
    const dialog = await screen.findByRole("dialog", { name: /Cancel this task/ });
    expect(within(dialog).getByLabelText(/Reason/)).toBeTruthy();
  });

  it("full view has one way back (no ✕ close) and the inspector offers expand + close", async () => {
    renderPage("/tasks?task=t2bbbbbb&full=1");
    await waitFor(() => expect(document.querySelector("#detailMain h1")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Back to tasks" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close details" })).toBeNull();
  });
});

describe("Task detail — gate card", () => {
  it("is a compact card: Result / Done when lines, Reject then Accept, no boilerplate sentences", async () => {
    renderPage("/tasks?task=t1aaaaaa");
    await waitFor(() => expect(document.querySelector("#gate-t1aaaaaa")).toBeTruthy());
    const gate = document.querySelector("#gate-t1aaaaaa") as HTMLElement;
    const keys = Array.from(gate.querySelectorAll(".td-g-k")).map((k) => k.textContent);
    expect(keys.slice(0, 2)).toEqual(["Result", "Done when"]);
    const reject = gate.querySelector('[data-act="reject"]')!;
    const accept = gate.querySelector('[data-act="approve"]')!;
    expect(reject.compareDocumentPosition(accept) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // D12: explanatory boilerplate lives in tooltips, not visible text
    expect(gate.textContent).not.toContain("Decisions are logged to the audit trail");
    expect(gate.textContent).not.toContain("Accepting marks the task completed");
    expect(accept.getAttribute("title")).toContain("Accepting marks the task completed");
    // no uppercase "RESULT CLAIMED BY" label block
    expect(gate.textContent).not.toMatch(/RESULT CLAIMED BY/);
  });
});

describe("Task detail — rail + activity", () => {
  it("properties sit in a labelled rail with exact status / priority labels", async () => {
    renderPage("/tasks?task=t2bbbbbb&full=1");
    const rail = await screen.findByRole("complementary", { name: "Task properties" });
    expect(within(rail).getByText("In progress")).toBeTruthy();
    expect(within(rail).getByText("Status")).toBeTruthy();
    expect(within(rail).getByText("Priority")).toBeTruthy();
    // D12: the bucket shows once; the exact numeric priority is kept in the tooltip
    expect(within(rail).queryByText("50")).toBeNull();
    expect(rail.querySelector(".td-prio")?.getAttribute("title")).toContain("50");
    expect(within(rail).getByText("forge")).toBeTruthy();
  });

  it("the timeline shows only timestamped events + the thread as comment cards", async () => {
    RUNS = [
      { run_id: "r1", status: "exited", exit_code: 1, agent: "forge", started_at: "2026-08-02T02:00:00Z", ended_at: "2026-08-02T02:05:00Z", diff: null },
    ];
    MSGS = [
      { message_id: "m1", is_human: true, author_id: "h1", author_alias: "kedar", body: "Looks close", created_at: "2026-08-02T03:00:00Z" },
    ];
    (SNAP.tasks as Record<string, unknown>[])[1].message_summary = { count: 1, last: null };
    renderPage("/tasks?task=t2bbbbbb&full=1");
    const tl = await screen.findByRole("list", { name: "Task activity" });
    await waitFor(() => expect(tl.textContent).toContain("Looks close"));
    expect(tl.textContent).toContain("created the task");
    expect(tl.textContent).toContain("Work started");
    await waitFor(() => expect(tl.textContent).toContain("started a run"));
    // an exited run with a non-zero exit is never drawn as success
    const runEv = Array.from(tl.querySelectorAll(".v2-tl-event")).find((e) => e.textContent?.includes("started a run"))!;
    expect(runEv.querySelector('svg[data-shape]')?.getAttribute("class")).toMatch(/v2-si-c-danger/);
    expect(runEv.textContent).toContain("exit 1");
    // chronological: created < started < run < comment
    const text = tl.textContent || "";
    expect(text.indexOf("created the task")).toBeLessThan(text.indexOf("Work started"));
    expect(text.indexOf("Work started")).toBeLessThan(text.indexOf("started a run"));
    expect(text.indexOf("started a run")).toBeLessThan(text.indexOf("Looks close"));
    // no invented events (no completion / plan decision on this task)
    expect(text).not.toContain("Completed");
    expect(text).not.toContain("approved the plan");
    expect(screen.getByPlaceholderText("Leave a comment…")).toBeTruthy();
  });
});

describe("Task detail — polish round 1 (D10/D12)", () => {
  it("inspector: title once (not in the header), one compact meta line, gate before the description", async () => {
    renderPage("/tasks?task=t1aaaaaa");
    await waitFor(() => expect(document.querySelector("#gate-t1aaaaaa")).toBeTruthy());
    const p = pane();
    expect(p.className).toContain("is-inspector");
    const head = p.querySelector(".td-head") as HTMLElement;
    expect(head.textContent).not.toContain("Verify me"); // D12: never the title twice
    expect(head.textContent).toContain("t1aaaaaa");
    const h1 = p.querySelector("h1.td-title") as HTMLElement;
    expect(h1.textContent).toBe("Verify me");
    expect(h1.getAttribute("title")).toBe("Verify me"); // clamped title keeps a tooltip
    const meta = p.querySelector(".td-meta") as HTMLElement;
    expect(meta.textContent).toContain("Needs verification");
    expect(meta.textContent).toContain("forge");
    // gate sits above the description in the inspector
    const gate = p.querySelector("#gate-t1aaaaaa")!;
    const desc = p.querySelector(".td-desc")!;
    expect(gate.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // status / priority / assignee are not repeated in the inspector rail
    const rail = screen.getByRole("complementary", { name: "Task properties" });
    expect(within(rail).queryByText("Status")).toBeNull();
    expect(within(rail).queryByText("Priority")).toBeNull();
  });

  it("a result's pr_url is a PR chip + a header 'Open pull request' button — never 'Pr url'", async () => {
    (SNAP.tasks as Record<string, unknown>[])[0].result = { summary: "Done, tests pass", pr_url: "https://github.com/acme/web/pull/102" };
    renderPage("/tasks?task=t1aaaaaa&full=1");
    await waitFor(() => expect(document.querySelector("#gate-t1aaaaaa")).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/Pr url/);
    const btn = screen.getByRole("link", { name: "Open pull request #102" });
    expect(btn.getAttribute("href")).toBe("https://github.com/acme/web/pull/102");
    expect(btn.getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy task ID/ })).toBeTruthy();
  });

  it("never guesses the creator: a null created_by_agent_id shows no 'Created by' row", async () => {
    (SNAP.tasks as Record<string, unknown>[])[1].created_by_agent_id = null;
    renderPage("/tasks?task=t2bbbbbb&full=1");
    const rail = await screen.findByRole("complementary", { name: "Task properties" });
    expect(within(rail).queryByText("Created by")).toBeNull();
    expect(rail.textContent).not.toContain("human");
    const tl = await screen.findByRole("list", { name: "Task activity" });
    expect(tl.textContent).toContain("Task created");
  });

  it("Runs tab: the count lives on the tab only (no repeated 'N runs' line)", async () => {
    RUNS = [{ run_id: "r1", status: "exited", exit_code: 0, agent: "forge", started_at: "2026-08-02T02:00:00Z", ended_at: "2026-08-02T02:05:00Z", diff: null }];
    renderPage("/tasks?task=t2bbbbbb&full=1&tab=runs");
    await waitFor(() => expect(document.querySelector(".wk-runs .run")).toBeTruthy());
    expect(document.querySelector(".td-runs-sum")).toBeNull();
    expect(document.querySelector(".wk-runs")!.textContent).not.toMatch(/\b1 run\b/);
  });

  it("plan gate: a leading 'Plan' heading isn't repeated, and the autonomy note lives in the help mark", async () => {
    SNAP.container = { id: "c1", name: "Orcha", status: "active", autonomy_level: "supervised" };
    (SNAP.tasks as Record<string, unknown>[])[1].plan_message = { body: "## Plan\n1. Add table\n2. Backfill", author_alias: "forge", at: "2026-08-02T01:30:00Z" };
    renderPage("/tasks?task=t2bbbbbb");
    await waitFor(() => expect(document.querySelector('#gate-t2bbbbbb[data-kind="plan"]')).toBeTruthy());
    const gate = document.querySelector("#gate-t2bbbbbb") as HTMLElement;
    expect(gate.querySelector("h1,h2,h3,h4")).toBeNull();
    expect(gate.textContent).toContain("Add table");
    expect(gate.querySelector(".td-g-chip")).toBeNull();
    const help = gate.querySelector(".td-g-help") as HTMLElement;
    expect(help.getAttribute("title")).toMatch(/Optional at the “supervised” autonomy level/);
  });
});

describe("New task composer", () => {
  const openComposer = async () => {
    renderPage("/tasks?new=1");
    return screen.findByRole("dialog", { name: /New task/ });
  };

  it("Escape in an empty dependency search closes only the picker — the draft survives", async () => {
    const dialog = await openComposer();
    fireEvent.change(document.querySelector("#nt_title")!, { target: { value: "Keep me" } });
    fireEvent.click(dialog.querySelector("[data-deps-btn]")!);
    // the picker is an anchored popover portaled above the dialog
    const q = await screen.findByLabelText("Search open tasks");
    fireEvent.change(q, { target: { value: "sec" } });
    fireEvent.keyDown(q, { key: "Escape" }); // 1st: clears the query
    expect((q as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText("Search open tasks")).toBeTruthy();
    fireEvent.keyDown(q, { key: "Escape" }); // 2nd: closes the picker only
    await waitFor(() => expect(screen.queryByLabelText("Search open tasks")).toBeNull());
    expect(screen.getByRole("dialog", { name: /New task/ })).toBeTruthy();
    expect((document.querySelector("#nt_title") as HTMLInputElement).value).toBe("Keep me");
  });

  it("closing a dirty draft asks before discarding it", async () => {
    const dialog = await openComposer();
    fireEvent.change(document.querySelector("#nt_title")!, { target: { value: "Half typed" } });
    fireEvent.keyDown(dialog, { key: "Escape" });
    const confirm = await screen.findByRole("dialog", { name: "Discard this task?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard this task?" })).toBeNull());
    expect((document.querySelector("#nt_title") as HTMLInputElement).value).toBe("Half typed");
  });

  it("a validation error is inline on its field, marks it invalid, and clears on change", async () => {
    const dialog = await openComposer();
    fireEvent.click(within(dialog).getByText("Create task"));
    const title = document.querySelector("#nt_title") as HTMLInputElement;
    await waitFor(() => expect(document.querySelector("#nt_err")?.textContent).toContain("Title is required."));
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(title.getAttribute("aria-describedby")).toBe("nt_err");
    fireEvent.change(title, { target: { value: "x" } });
    expect(document.querySelector("#nt_err")).toBeNull();
    expect(title.getAttribute("aria-invalid")).toBeNull();
  });

  it("priority + assignee are property chips opening menus (no native selects)", async () => {
    const dialog = await openComposer();
    expect(dialog.querySelector("select")).toBeNull();
    fireEvent.click(dialog.querySelector("#nt_pri")!);
    const pm = await screen.findByRole("menu", { name: "Priority" });
    fireEvent.click(within(pm).getByText("Urgent"));
    expect(dialog.querySelector("#nt_pri")!.getAttribute("data-value")).toBe("urgent");
    fireEvent.click(dialog.querySelector("#nt_assignee")!);
    const am = await screen.findByRole("menu", { name: "Assignee" });
    fireEvent.click(within(am).getByRole("menuitemradio", { name: /forge/ }));
    expect(dialog.querySelector("#nt_assignee")!.getAttribute("data-value")).toBe("forge");
  });
});

describe("Assign & wake — in-place agent picker", () => {
  it("picks an agent from the popover, confirms, then POSTs /assign", async () => {
    renderPage("/tasks?task=t3cccccc&full=1");
    const btn = await waitFor(() => {
      const b = document.querySelector('[data-act="assign"]') as HTMLButtonElement;
      expect(b && !b.disabled).toBeTruthy();
      return b;
    });
    fireEvent.click(btn);
    const menu = await screen.findByRole("menu", { name: "Agent to assign" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /forge/ }));
    const dialog = await screen.findByRole("dialog", { name: /Assign task/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign & wake" }));
    await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/tasks/t3cccccc/assign");
      expect(c?.body).toEqual({ actor_agent_id: "h1", agent_id: "a1", reassign: false });
    });
  });
});
