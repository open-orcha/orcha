/**
 * Overview parity r1 (home-projects fixer): agent deep links (AA-118), the
 * setup checklist ignores the root task, honest "assigned to someone else" /
 * "Nothing else in progress" copy, and a load failure that says what it
 * means without leaking the endpoint (SH-123 / e2e-scope-live-8 / Not found).
 * Real SnapshotProvider + mapSnapshot; fetch stubbed.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { _resetProjectsForTests } from "../../state/projects";
import { HomePage, liveWorkByTask } from "./HomePage";
import type { Agent } from "../../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
let snapshot: any;
let snapStatus = 200;
let snapDetail: unknown = null;

const snap = () => ({
  container: { id: "c1", name: "Website", description: "Ship the new marketing site", status: "active", autonomy_level: "plan", wakes_enabled: true, root_task_id: "root" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" },
    { id: "a1", alias: "atlas", kind: "ai", status: "working", role: "builder", model: "claude",
      active_run: { task_id: "t2", task_title: "Build hero" }, last_active: "2026-09-28T10:00:00Z" },
  ],
  tasks: [
    { id: "root", title: "Ship the site", status: "in_progress", is_root: true, assignees: [], created_at: "2026-09-01T00:00:00Z" },
    { id: "t1", title: "Ship the feature", status: "needs_verification", assignees: ["atlas"], definition_of_done: "It works", created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:00Z" },
    { id: "t2", title: "Build hero", status: "in_progress", assignees: ["atlas"], assignee: "atlas", started_at: "2026-09-27T00:00:00Z", created_at: "2026-09-26T00:00:00Z",
      message_summary: { count: 1, last: { author_alias: "atlas", is_human: false, body: "Pushed the hero", at: new Date(Date.now() - 60_000).toISOString() } } },
  ],
  requests: [],
});

function stubFetch() {
  const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers" || url.startsWith("/api/containers?")) return json({ containers: [{ id: "c1", name: "Website", status: "active" }] });
    if (url.endsWith("/settings/llm-key")) return json({ configured: true, source: "db" });
    if (url.startsWith("/api/containers/c1")) return json(snapStatus < 400 ? snapshot : { detail: snapDetail }, snapStatus);
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
  window.history.replaceState(null, "", "/");
  _resetProjectsForTests();
  snapshot = snap();
  snapStatus = 200;
  snapDetail = null;
  stubFetch();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Overview agent deep links (AA-118)", () => {
  it("a feed actor that is a real agent links to /agents?agent=<alias>", async () => {
    mount();
    const feed = await screen.findByLabelText("Project updates");
    expect(within(feed).getByRole("link", { name: "atlas" })).toHaveAttribute("href", "/agents?agent=atlas");
  });

  it("a Needs-you row's actor avatar is its own agent link (a sibling of the row link, never nested)", async () => {
    mount();
    await screen.findAllByText("Ship the feature");
    const needs = document.getElementById("needs")!;
    const av = within(needs).getByRole("link", { name: "Open agent atlas" });
    expect(av).toHaveAttribute("href", "/agents?agent=atlas");
    expect(av.closest(".ov-row")).toBeNull();
    expect(needs.querySelectorAll("a a").length).toBe(0);
  });
});

describe("Overview setup checklist", () => {
  it("the root task never counts as 'First task' — a new project offers Create a task", async () => {
    snapshot = snap();
    snapshot.agents = [snapshot.agents[0]]; // owner only → empty project checklist
    snapshot.tasks = [snapshot.tasks[0]]; // root only
    mount();
    await screen.findByText("Get this project working");
    const step = document.querySelector('[data-step="first-task"]')!;
    expect(step).not.toHaveClass("done");
    expect(within(step as HTMLElement).queryByText(/1 task created/)).toBeNull();
    expect(within(step as HTMLElement).getByRole("button", { name: /Create a task/ })).toBeInTheDocument();
  });
});

describe("Overview honest copy", () => {
  it("Active work does not claim 'No task is in progress' when the in-progress task waits on a plan", async () => {
    snapshot = snap();
    snapshot.agents[1].active_run = null;
    snapshot.agents[1].status = "idle";
    snapshot.tasks[2].plan_message = { body: "1. do it", author_alias: "atlas", at: "2026-09-27T02:00:00Z" };
    snapshot.tasks[2].plan_decision = null;
    mount();
    await screen.findByText("Ship the new marketing site");
    const active = document.getElementById("activeWork")!;
    expect(within(active).queryByText("No task is in progress.")).toBeNull();
    expect(within(active).getByText(/1 task waiting on a plan decision/)).toBeInTheDocument();
  });

  it("liveWorkByTask: the sidebar's working rule (live run wins; idle agents never count)", () => {
    const ag = (x: Partial<Agent>) => ({ kind: "ai", status: "idle", active_run: null, current_task: null, ...x }) as Agent;
    const m = liveWorkByTask([
      ag({ alias: "a", status: "working", current_task: { task_id: "t1", title: "x" } }),
      ag({ alias: "b", status: "idle", current_task: { task_id: "t2", title: "y" } }),
      ag({ alias: "c", status: "idle", active_run: { task_id: "t1" } as Agent["active_run"] }),
      ag({ alias: "h", kind: "human", status: "working", current_task: { task_id: "t3", title: "z" } }),
    ]);
    expect(m.get("t1")?.alias).toBe("c");
    expect(m.has("t2")).toBe(false);
    expect(m.has("t3")).toBe(false);
  });
});

describe("Overview load failure says what it means (SH-123 / e2e-scope-live-8)", () => {
  it("403 → no access (All projects), no Retry, no raw endpoint", async () => {
    snapStatus = 403; snapDetail = "not a member of this project";
    mount();
    expect(await screen.findByText("You don't have access to this project")).toBeInTheDocument();
    // ONE action (the shell banner's) — never repeated by the page (D12)
    const bar = document.querySelector(".v2-stalebar") as HTMLElement;
    expect(within(bar).getByRole("link", { name: "All projects" })).toHaveAttribute("href", "/projects");
    const main = document.getElementById("main") ?? document.body;
    expect(within(main).queryByRole("link", { name: "All projects" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\/api\/containers/);
  });

  it("404 → Project not found", async () => {
    snapStatus = 404; snapDetail = "container c1 not found";
    mount();
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("503 on a listed project → '<name> is unreachable', one Retry, no raw endpoint", async () => {
    snapStatus = 503; snapDetail = "project database unreachable";
    mount();
    expect(await screen.findByText("Website is unreachable")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(document.querySelector(".v2-empty, main")?.textContent ?? "").not.toMatch(/\/api\/containers\//);
    expect(screen.queryByText(/The project data did not load \(/)).toBeNull();
  });
});

describe("overview.css (390 feed)", () => {
  it("at ≤480px the event line wraps to two lines and the body line drops (D12 max 2)", () => {
    const css = readFileSync(resolve(__dirname, "overview.css"), "utf8");
    const m = /@media \(max-width: 480px\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/-webkit-line-clamp:\s*2/);
    expect(m![1]).toMatch(/\.ov-ev-body\s*\{\s*display:\s*none/);
  });
});
