/**
 * Project Overview (V2) — parity H-01/H-02/H-03(summary)/H-05/H-06/H-07.
 * Real SnapshotProvider + mapSnapshot; fetch stubbed.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { HomePage, MEMBERS_HREF, OPEN_REQUESTS_HREF, OPEN_TASKS_HREF, activityEvents, dayLabel, groupByDay, pickFeed, statusBreakdown, type ActEvent } from "./HomePage";
import { selectAttention } from "../../state/attention";
import { mapSnapshot } from "../../api/client";
import { fireEvent } from "@testing-library/react";
import type { Task } from "../../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Call { url: string; method: string; body: any }
let calls: Call[] = [];
let snapshot: any;
let snapStatus = 200;
let keyResp: { status: number; body: any } = { status: 200, body: { configured: false, source: null } };
let verifyStatus = 200;

const busySnap = () => ({
  container: { id: "c1", name: "Website", description: "Ship the new marketing site", status: "active", autonomy_level: "plan", wakes_enabled: true },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "atlas", kind: "ai", status: "working", role: "builder", model: "claude", wake_enabled: true,
      active_run: { task_id: "t2", task_title: "Build hero" }, last_active: "2026-09-28T10:00:00Z" },
  ],
  tasks: [
    { id: "t1", title: "Ship the feature", status: "needs_verification", assignees: ["atlas"], definition_of_done: "It works", created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:00Z" },
    { id: "t2", title: "Build hero", status: "in_progress", assignees: ["atlas"], assignee: "atlas", started_at: "2026-09-27T00:00:00Z", created_at: "2026-09-26T00:00:00Z" },
    { id: "t3", title: "Old thing", status: "completed", assignees: [], completed_at: "2026-09-20T00:00:00Z", created_at: "2026-09-01T00:00:00Z" },
    { id: "t4", title: "Dropped idea", status: "cancelled", assignees: [], completed_at: "2026-09-21T00:00:00Z", created_at: "2026-09-02T00:00:00Z" },
    { id: "t5", title: "Broken", status: "blocked", assignees: [], created_at: "2026-09-03T00:00:00Z" },
  ],
  requests: [
    { id: "r1", type: "question", status: "escalated", requester_id: "a1", target_id: "a1", payload: { question: "Which domain?" }, created_at: "2026-09-27T00:00:00Z" },
  ],
  task_open_total: 3,
  request_open_total: 0,
  task_total: 5,
  request_total: 1,
});

function stubFetch() {
  calls = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.endsWith("/settings/llm-key")) return json(keyResp.body, keyResp.status);
    if (url.endsWith("/verify")) return json({ detail: "nope" }, verifyStatus);
    if (url.startsWith("/api/containers/c1")) return json(snapshot, snapStatus);
    return json({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  snapshot = busySnap();
  snapStatus = 200;
  verifyStatus = 200;
  keyResp = { status: 200, body: { configured: false, source: null } };
  stubFetch();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Overview summary", () => {
  it("leads with the objective and ONE facts line whose numbers open the exact filtered list", async () => {
    mount();
    expect(await screen.findByText("Ship the new marketing site")).toBeInTheDocument();
    const head = document.getElementById("ctxbar")!;
    const link = (label: string) => within(head).getByText(label).closest("a")!;
    // AI agents and people are counted apart (atlas = 1 agent, kedar = 1 person), singular copy
    expect(link("agent")).toHaveAttribute("href", "/agents");
    expect(within(link("agent")).getByText("1")).toBeInTheDocument();
    // people are members, not agents: the fact opens Settings › Members
    expect(link("person")).toHaveAttribute("href", MEMBERS_HREF);
    expect(link("open tasks")).toHaveAttribute("href", OPEN_TASKS_HREF);
    expect(OPEN_TASKS_HREF).toBe("/tasks?status=pending,ready,in_progress,blocked,needs_verification");
    expect(link("open requests")).toHaveAttribute("href", OPEN_REQUESTS_HREF);
    // the "+ New agent" circle sits right after the agents fact it adds to
    // (never dangling after "1 failed")
    const plus = within(head).getByRole("link", { name: "New agent" });
    expect(plus).toHaveAttribute("href", "/onboarding?new=1");
    expect(plus.closest(".ov-fi")).toBe(link("agent").closest(".ov-fi"));
    // an active project carries no "Project active" chip (every live project is active)
    expect(within(head).queryByText(/Project active/)).toBeNull();
    // authoritative server totals, not list lengths
    expect(within(link("open tasks")).getByText("3")).toBeInTheDocument();
    expect(within(link("open requests")).getByText("0")).toBeInTheDocument();
    // one plan-free verify + one escalated request = 2 decisions (escalated counts, GAP-04)
    // identity settles after the first paint (count unknown until then) — shown ONCE, on the band
    await waitFor(() => expect(document.querySelector("#needs .v2-group-count")).toHaveTextContent("2"));
    // D12: the header's Execution chip owns notifier/autonomy — not repeated here, no stat wall
    expect(within(head).queryByText("Plan-only")).toBeNull();
    expect(within(head).queryByText("Notifier")).toBeNull();
    expect(within(head).queryByText("Needs you")).toBeNull();
  });

  it("lists escalated requests in Needs you with a link to the request", async () => {
    mount();
    await waitFor(() => expect(document.querySelector("#needs .v2-group-count")).toHaveTextContent("2"));
    // one label on every width ("Escalated", like "Verify" / "Plan")
    const chip = document.querySelector("#needs .aq-type.v2-tone-danger")!;
    expect(chip.querySelector(".aq-l-long")).toHaveTextContent("Escalated");
    expect(chip.querySelector(".aq-l-short")).toHaveTextContent("Escalated");
    expect(screen.queryByText("Escalation")).toBeNull();
    // with the /needs page present the row opens THAT item there
    expect(within(document.getElementById("needs")!).getByRole("link", { name: /Which domain\?/ })).toHaveAttribute("href", "/needs?item=request:r1");
  });

  it("shows active work rows and finished tasks in the updates feed with exact statuses", async () => {
    mount();
    await screen.findByText("Ship the new marketing site");
    const active = document.getElementById("activeWork")!;
    expect(within(active).getAllByRole("link", { name: /Build hero/ })[0]).toHaveAttribute("href", "/tasks?task=t2");
    // atlas's LIVE run is on t2 → a truthful "Working…" pill with the actor (not a status guess)
    expect(within(active).getByText("Working…")).toBeInTheDocument();
    // status is a glyph with its exact label (sr/tooltip), never colour alone
    expect(within(active).getByTitle("In progress")).toBeInTheDocument();
    // Linear My-issues row: priority bars, then the muted short ID, BEFORE the status glyph — one line
    const row = within(active).getAllByRole("link", { name: /Build hero/ })[0];
    const prio = row.querySelector(".ov-prio");
    const id = row.querySelector(".ov-id");
    expect(prio).not.toBeNull();
    expect(id).toHaveTextContent("t2");
    expect(prio!.compareDocumentPosition(id!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.querySelector(".ov-row-t")!.compareDocumentPosition(id!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const feed = document.getElementById("actList")!;
    // completed and cancelled keep their own labels (never merged)
    expect(within(feed).getByText("Completed")).toBeInTheDocument();
    expect(within(feed).getByText("Cancelled")).toBeInTheDocument();
    expect(within(feed).getByRole("link", { name: "Dropped idea" })).toHaveAttribute("href", "/tasks?task=t4");
    // every section links to its full view
    expect(screen.getByRole("link", { name: "Open activity" })).toHaveAttribute("href", "/activity");
    expect(within(active).getByRole("link", { name: "View all" })).toHaveAttribute("href", "/tasks?status=in_progress");
  });

  it("an in-progress task whose agent is NOT working (idle, no live run) shows the assignee avatar, not a Working pill", async () => {
    snapshot = busySnap();
    snapshot.agents[1].active_run = null;
    snapshot.agents[1].status = "idle";
    mount();
    await screen.findByText("Ship the new marketing site");
    const active = document.getElementById("activeWork")!;
    expect(within(active).queryByText("Working…")).toBeNull();
    expect(within(active).getByLabelText(/Assignee: atlas/)).toBeInTheDocument();
  });

  it("wave4: the pill follows the sidebar's 'working' rule — a working agent on its current task gets it even between runs", async () => {
    snapshot = busySnap();
    snapshot.agents[1].active_run = null; // status stays "working"; current_task = its in-progress task
    mount();
    await screen.findByText("Ship the new marketing site");
    const active = document.getElementById("activeWork")!;
    expect(within(active).getByText("Working…")).toBeInTheDocument();
  });

  it("the updates filter pills narrow the feed", async () => {
    mount();
    await screen.findByText("Ship the new marketing site");
    const feed = () => document.getElementById("actList")!;
    expect(within(feed()).getByText("Completed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Requests" }));
    expect(within(feed()).queryByText("Completed")).toBeNull();
    expect(within(feed()).getByText("asked")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Finished" }));
    expect(within(feed()).getByText("Completed")).toBeInTheDocument();
    expect(within(feed()).queryByText("asked")).toBeNull();
    expect(within(feed()).getByRole("link", { name: "All finished tasks" })).toHaveAttribute("href", "/tasks?status=completed,cancelled");
  });

  it("D10: no per-status stat wall — only non-zero blocked/failed counts join the facts line", async () => {
    mount();
    await screen.findByText("Ship the new marketing site");
    expect(document.getElementById("kanban")).toBeNull();
    expect(document.querySelector(".ov-status")).toBeNull();
    const head = document.getElementById("ctxbar")!;
    expect(within(head).getByText("blocked").closest("a")).toHaveAttribute("href", "/tasks?status=blocked");
    // zero failed tasks → no "failed" fact; completed/cancelled are not repeated here
    expect(within(head).queryByText("failed")).toBeNull();
    expect(within(head).queryByText(/completed|cancelled/i)).toBeNull();
  });

  it("singular copy: 1 open task / 1 open request", async () => {
    snapshot = busySnap();
    snapshot.task_open_total = 1;
    snapshot.request_open_total = 1;
    mount();
    await screen.findByText("Ship the new marketing site");
    const head = document.getElementById("ctxbar")!;
    expect(within(head).getByText("open task")).toBeInTheDocument();
    expect(within(head).getByText("open request")).toBeInTheDocument();
    expect(within(head).queryByText("open tasks")).toBeNull();
  });

  it("groups the feed under Today / Yesterday / date dividers", () => {
    const now = new Date(2026, 8, 28, 12, 0, 0);
    expect(dayLabel(new Date(2026, 8, 28, 0, 5).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 8, 27, 23, 59).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 8, 20, 9).toISOString(), now)).not.toMatch(/Today|Yesterday/);
    const ev = (at: Date) => ({ who: "a", human: false, kind: "post" as const, ctx: "x", text: "", at: at.toISOString(), link: "/" });
    const g = groupByDay([ev(new Date(2026, 8, 28, 11)), ev(new Date(2026, 8, 28, 9)), ev(new Date(2026, 8, 27, 9))], now);
    expect(g.map((x) => [x.day, x.events.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
  });

  it("outcome events need a real completion stamp (no invented dates)", () => {
    const t = (id: string, status: string, completed_at: string | null) => ({ id, status, title: id, completed_at, assignees: [] }) as unknown as Task;
    const evs = activityEvents([t("1", "completed", "2026-09-20T00:00:00Z"), t("2", "cancelled", null)], []);
    expect(evs.map((e) => [e.kind, e.status])).toEqual([["outcome", "completed"]]);
  });

  it("statusBreakdown never merges failed/blocked or cancelled/completed", () => {
    const t = (id: string, status: string) => ({ id, status, title: id }) as unknown as Task;
    const g = statusBreakdown([t("1", "failed"), t("2", "blocked"), t("3", "completed"), t("4", "cancelled")]);
    expect(g.map((x) => x.status)).toEqual(["blocked", "failed", "completed", "cancelled"]);
  });

  it("statusBreakdown excludes the root task, like Active work (one number per fact)", () => {
    const g = statusBreakdown([
      { id: "r", status: "in_progress", title: "root", is_root: true },
      { id: "1", status: "in_progress", title: "x" },
    ] as unknown as Task[]);
    expect(g).toEqual([{ status: "in_progress", tasks: [expect.objectContaining({ id: "1" })] }]);
  });

  it("an experienced project gets no setup checklist (and no provider-key probe)", async () => {
    mount();
    await screen.findByText("Ship the new marketing site");
    expect(screen.queryByText("Get this project working")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/settings/llm-key"))).toBe(false);
  });
});

describe("Overview empty project", () => {
  beforeEach(() => {
    snapshot = {
      container: { id: "c1", name: "Fresh", status: "active", autonomy_level: "plan", wakes_enabled: false },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
      tasks: [], requests: [], task_open_total: 0, request_open_total: 0, task_total: 0, request_total: 0,
    };
  });

  it("explains the next useful actions in order, with real state", async () => {
    mount();
    expect(await screen.findByText("Get this project working")).toBeInTheDocument();
    expect(await screen.findByText(/No Anthropic API key yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Provider keys" })).toHaveAttribute("href", "/settings#tab=provider-keys");
    const setup = screen.getAllByRole("link", { name: "Set up agents" });
    expect(setup.every((a) => a.getAttribute("href") === "/onboarding")).toBe(true);
    // opens the Shell composer over Overview (no route change)
    expect(screen.getByRole("button", { name: "Create a task" })).toBeInTheDocument();
    expect(screen.getByText(/Wakes are paused/)).toBeInTheDocument();
    // AI agents only: the lone human owner is a person, not "1 agent"
    const head = document.getElementById("ctxbar")!;
    expect(within(within(head).getByText("agents").closest("a")!).getByText("0")).toBeInTheDocument();
    expect(within(head).getByText("person")).toBeInTheDocument();
    // one line per step: the explanation lives in an ⓘ tooltip, not running copy
    expect(screen.queryByText(/Describe the project and review/)).toBeNull();
    expect(screen.getByLabelText(/Describe the project and review a proposed roster/)).toBeInTheDocument();
    // only the header + checklist: no wall of empty sections under it
    expect(document.getElementById("needs")).toBeNull();
    expect(document.getElementById("activeWork")).toBeNull();
    expect(document.getElementById("outcomes")).toBeNull();
    expect(document.getElementById("kanban")).toBeNull();
    // one "Set up agents" CTA (the checklist); the header keeps its shape —
    // "New task" is still there, but quiet (the checklist owns the primary)
    expect(setup).toHaveLength(1);
    const nt = screen.getByRole("button", { name: "New task" });
    expect(nt).not.toHaveClass("v2-btn-primary");
  });

  it("marks the provider step done when a key is configured, and says so when it can't check", async () => {
    keyResp = { status: 200, body: { configured: true, source: "env" } };
    mount();
    expect(await screen.findByText(/configured \(from the environment\)/)).toBeInTheDocument();
    cleanup();
    keyResp = { status: 403, body: { detail: "no" } };
    stubFetch();
    mount();
    expect(await screen.findByText(/Couldn't check the provider key \(HTTP 403\)/)).toBeInTheDocument();
  });
});

describe("Overview Needs-you preview (the /needs page exists)", () => {
  it("shows compact rows that open the exact item on /needs — no inline Accept/Approve", async () => {
    mount();
    await screen.findByText("Verify task");
    const needs = document.getElementById("needs")!;
    expect(within(needs).getByRole("link", { name: /Ship the feature/ })).toHaveAttribute("href", "/needs?item=verify:t1");
    expect(within(needs).queryByRole("button", { name: /Accept|Approve/ })).toBeNull();
    // the header link never contradicts the count ("8" beside "View all 9")
    expect(within(needs).getByRole("link", { name: /Open queue/ })).toHaveAttribute("href", "/needs");
    expect(within(needs).queryByText(/View all/)).toBeNull();
  });

  it("the band count equals preview rows + 'N more'; another reviewer's item is named apart, rows oldest first", async () => {
    snapshot = busySnap();
    snapshot.agents[0].member_role = "member";
    snapshot.agents.push({ id: "h2", alias: "sam", kind: "human", status: "idle", member_role: "member" });
    const v = (id: string, mins: number, reviewer?: boolean) => ({
      id, title: "Verify " + id, status: "needs_verification", assignees: ["atlas"], definition_of_done: "ok",
      created_at: "2026-09-01T00:00:00Z", started_at: new Date(Date.now() - mins * 60000).toISOString(),
      completed_at: new Date(Date.now() - mins * 60000).toISOString(),
      ...(reviewer ? { reviewer_agent_id: "h2", reviewer: { agent_id: "h2", alias: "sam", github_login: null } } : {}),
    });
    snapshot.tasks = [v("v1", 5), v("v2", 50), v("v3", 20), v("v4", 40), v("v5", 10), v("v6", 30), v("vx", 60, true)];
    snapshot.requests = [];
    mount();
    await waitFor(() => expect(document.querySelector("#needs .v2-group-count")).toHaveTextContent("6"));
    const needs = document.getElementById("needs")!;
    const rows = Array.from(needs.querySelectorAll(".nq .ov-row-t")).map((e) => e.textContent);
    // 5 of mine, oldest first; the other reviewer's item is not a preview row
    expect(rows).toEqual(["Verify v2", "Verify v4", "Verify v6", "Verify v3", "Verify v5"]);
    expect(within(needs).getByRole("link", { name: "1 more in the queue" })).toHaveAttribute("href", "/needs");
    expect(within(needs).getByRole("link", { name: "1 assigned to someone else" })).toHaveAttribute("href", "/needs");
  });

  it("keeps a one-word kind label for narrow screens (never an icon alone)", async () => {
    mount();
    await screen.findByText("Verify task");
    const chip = screen.getByText("Verify task").closest(".aq-type")!;
    expect(chip.querySelector(".aq-l-short")).toHaveTextContent("Verify");
  });
});

describe("Overview activity + active work", () => {
  it("never lists the root task as active work, and names null-author messages 'System' with task context", async () => {
    snapshot = busySnap();
    snapshot.container.root_task_id = "t0";
    snapshot.tasks.push({ id: "t0", title: "Root objective", status: "in_progress", is_root: true, assignees: [], started_at: "2026-09-28T00:00:00Z", created_at: "2026-09-01T00:00:00Z" });
    snapshot.tasks[1].message_summary = { count: 1, last: { body: "## Heads up\nanon **note**", at: "2026-09-28T09:00:00Z", is_human: false } };
    mount();
    await screen.findByText("Ship the new marketing site");
    const active = document.getElementById("activeWork")!;
    expect(within(active).queryByText("Root objective")).toBeNull();
    const feed = document.getElementById("actList")!;
    expect(within(feed).getByText("System")).toBeInTheDocument();
    expect(within(feed).getAllByText("Build hero").length).toBeGreaterThan(0); // task context on the row
    expect(within(feed).getByText("Heads up anon note")).toBeInTheDocument(); // markdown flattened
    expect(within(feed).queryByText("message")).toBeNull();
    // request payload is a readable title, never JSON
    expect(feed.textContent).not.toMatch(/[{}]/);
  });
});

describe("Overview load states", () => {
  it("shows an error state (not zeros) when the project cannot load", async () => {
    snapStatus = 500;
    mount();
    expect(await screen.findByText("Couldn't load this project")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs you right now.")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });
});

describe("Overview round-2 polish", () => {
  const planTask = () => ({
    id: "tp", title: "Plan: migrate", status: "in_progress", assignees: ["atlas"], assignee: "atlas",
    started_at: "2026-09-27T01:00:00Z", created_at: "2026-09-26T00:00:00Z",
    plan_message: { body: "1. do it", author_alias: "atlas", at: "2026-09-27T02:00:00Z" }, plan_decision: null,
  });

  it("a plan waiting on a human is listed in Needs you, not again in Active work (count follows)", async () => {
    snapshot = busySnap();
    snapshot.tasks.push(planTask());
    mount();
    await waitFor(() => expect(document.querySelector("#needs .v2-group-count")).toHaveTextContent("3"));
    const needs = document.getElementById("needs")!;
    expect(within(needs).getByRole("link", { name: /Plan: migrate/ })).toHaveAttribute("href", "/needs?item=plan:tp");
    const active = document.getElementById("activeWork")!;
    expect(within(active).queryByText("Plan: migrate")).toBeNull();
    expect(within(active).getByText("Build hero")).toBeInTheDocument();
    expect(active.querySelector(".v2-group-count")).toHaveTextContent("1");
  });

  it("the band count is the shared attention count (plans in, another reviewer's review out)", async () => {
    snapshot = busySnap();
    snapshot.agents.push({ id: "h2", alias: "sam", kind: "human", status: "idle", member_role: "member" });
    snapshot.agents[0].member_role = "member";
    snapshot.tasks.push(planTask());
    snapshot.tasks.push({ id: "tv", title: "Sam's review", status: "needs_verification", assignees: ["atlas"], created_at: "2026-09-01T00:00:00Z",
      reviewer_agent_id: "h2", reviewer: { agent_id: "h2", alias: "sam", github_login: null } });
    const shared = selectAttention(mapSnapshot(snapshot), "h1");
    mount();
    await waitFor(() => expect(document.querySelector("#needs .v2-group-count")).toHaveTextContent(String(shared.count)));
    expect(shared.count).toBe(3); // verify t1 + escalated r1 + plan tp — not sam's review
  });

  it("shows the project status chip only when the project is not active", async () => {
    snapshot = busySnap();
    snapshot.container.status = "completed";
    mount();
    await screen.findByText("Ship the new marketing site");
    const head = document.getElementById("ctxbar")!;
    expect(within(head).getByText("Project completed")).toBeInTheDocument();
  });

  it("wave4: the Overview status chip uses the shared project-status map (paused → warn tone, same word as All projects)", async () => {
    snapshot = busySnap();
    snapshot.container.status = "paused";
    mount();
    await screen.findByText("Ship the new marketing site");
    const chip = document.querySelector("#ctxbar .ov-pstatus")!;
    expect(chip).toHaveTextContent("Project paused");
    expect(chip.querySelector(".v2-chip-dot")!.className).toMatch(/v2-tone-warn/);
  });

  it("'All' keeps other kinds visible instead of a wall of posts; a filter shows only its kind", () => {
    const ev = (i: number, kind: ActEvent["kind"]): ActEvent => ({
      who: "a", human: false, kind, ctx: kind + i, text: "", link: "/",
      at: new Date(Date.UTC(2026, 8, 28, 12, 0) - i * 60000).toISOString(),
      ...(kind === "outcome" ? { status: "completed" } : {}),
    });
    // 20 newest are posts; then a request, an answer, two outcomes
    const evs = [...Array.from({ length: 20 }, (_, i) => ev(i, "post")), ev(30, "request"), ev(31, "answer"), ev(32, "outcome"), ev(33, "outcome")];
    const all = pickFeed(evs, "all", 12);
    expect(all).toHaveLength(12);
    expect(all.filter((e) => e.kind === "post")).toHaveLength(8);
    expect(all.map((e) => e.kind)).toEqual(expect.arrayContaining(["request", "answer", "outcome"]));
    // still newest first
    expect(all.map((e) => e.at)).toEqual([...all.map((e) => e.at)].sort().reverse());
    // only posts → posts fill every slot; few posts → other kinds fill the rest
    expect(pickFeed(evs.slice(0, 20), "all", 12)).toHaveLength(12);
    expect(pickFeed([ev(0, "post"), ...evs.slice(20)], "all", 12)).toHaveLength(5);
    expect(pickFeed(evs, "requests", 12).map((e) => e.kind)).toEqual(["request", "answer"]);
  });
});
