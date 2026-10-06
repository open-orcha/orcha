/**
 * D9 Agents board: /agents defaults to a Linear "Agent tasks" board (one column
 * per agent; humans with assigned/review work), filter pills All/Active/Backlog,
 * truthful live pills, and a toggle to the roster list view.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";
import { cardLiveState, taskInFilter } from "./agentModel";
import type { Snapshot, Task } from "../../types";

const now = new Date().toISOString();
const task = (id: string, title: string, status: string, assignees: string[], extra: Partial<Task> = {}): Task =>
  ({ id, title, status, assignees, assignee: assignees[0] ?? null, priority: 50, is_root: false, created_at: now, started_at: null, completed_at: null, thread: [], runs: [], plan_message: null, plan_decision: null, ...extra }) as unknown as Task;

const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    { id: "h2", alias: "nobody", kind: "human", role: "Viewer", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "working", active_run: { run_id: "r1", task_id: "t1aaaaaa-1" } },
    { id: "a2", alias: "scout", kind: "ai", role: "Researcher", status: "idle" },
  ],
  tasks: [
    task("t1aaaaaa-1", "Wire the board", "in_progress", ["forge"]),
    task("t2bbbbbb-2", "Idle in-progress task", "in_progress", ["forge"]),
    task("t3cccccc-3", "Ready task", "ready", ["scout"]),
    task("t4dddddd-4", "Done task", "completed", ["scout"], { completed_at: now }),
    task("t5eeeeee-5", "Check the export", "needs_verification", ["scout"], { reviewer_agent_id: "h1" }),
  ],
  requests: [],
};

function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}
function stubFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
let lastLoc = "";
function Loc() {
  const l = useLocation();
  lastLoc = l.pathname + l.search;
  return null;
}
function mount(path = "/agents") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Loc />
          <Routes>
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const col = (c: HTMLElement, alias: string) => c.querySelector(`[data-column="${alias}"]`) as HTMLElement | null;

describe("D9 Agents board", () => {
  beforeEach(() => {
    stubFetch();
    localStorage.clear();
    sessionStorage.clear();
    try {
      window.scrollTo = () => {};
    } catch { /* jsdom */ }
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("defaults to the board: one column per AI agent, plus humans that have work", async () => {
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    expect(col(container, "forge")).toBeTruthy();
    expect(col(container, "scout")).toBeTruthy();
    expect(col(container, "kedar")).toBeTruthy(); // reviewer of t5
    expect(col(container, "nobody")).toBeNull(); // a human with no work adds no empty column
    expect(container.querySelector(".roster-card")).toBeNull();
    // column header: name opens the workspace, count is the real number of cards
    const forge = col(container, "forge")!;
    expect(within(forge).getByRole("link", { name: "forge" }).getAttribute("href")).toBe("/agents?agent=forge");
    expect(forge.querySelector(".v2-bcol-count")?.textContent).toBe("2");
  });

  it("cards link to the task; the live pill only says Working… for the task the agent is on", async () => {
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    const forge = col(container, "forge")!;
    const live = within(forge).getByRole("link", { name: /Wire the board/ });
    expect(live.getAttribute("href")).toBe("/tasks?task=t1aaaaaa-1&full=1");
    expect(live.querySelector("[data-live]")?.getAttribute("data-live")).toBe("working");
    const idle = within(forge).getByRole("link", { name: /Idle in-progress task/ });
    expect(idle.querySelector("[data-live]")).toBeNull(); // in progress but nobody on it: no invented pill
    const scout = col(container, "scout")!;
    expect(within(scout).getByRole("link", { name: /Check the export/ }).querySelector("[data-live]")?.getAttribute("data-live")).toBe("needs_review");
    // human reviewer column shows the review work, marked as review
    const kedar = col(container, "kedar")!;
    expect(within(kedar).getByRole("link", { name: /Check the export.*You review/ })).toBeInTheDocument();
  });

  it("filter pills: Active hides backlog and finished work; Backlog shows only not-started", async () => {
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    const scout = () => col(container, "scout")!;
    expect(within(scout()).queryByText("Done task")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Active/ }));
    await waitFor(() => expect(within(scout()).queryByText("Done task")).toBeNull());
    expect(within(scout()).queryByText("Ready task")).toBeNull();
    expect(lastLoc).toContain("show=active");
    fireEvent.click(screen.getByRole("radio", { name: /Backlog/ }));
    await waitFor(() => expect(within(scout()).getByText("Ready task")).toBeInTheDocument());
    // B1: a filtered board drops columns with no matching cards (forge has no backlog)
    expect(col(container, "forge")).toBeNull();
  });

  it("B1: a filter that matches nothing says so once, with a way back to All", async () => {
    const saved = SNAP.tasks.slice();
    SNAP.tasks.length = 0;
    SNAP.tasks.push(task("t9zzzzzz-9", "Only closed", "completed", ["forge"]));
    try {
      const { container } = mount("/agents?view=board&show=backlog");
      await waitFor(() => expect(container.querySelector(".ab-none")?.textContent).toMatch(/^Nothing in backlog/));
      expect(container.querySelector(".v2-board")).toBeNull();
      expect(screen.getByRole("link", { name: "Show all tasks" })).toBeInTheDocument();
    } finally {
      SNAP.tasks.splice(0, SNAP.tasks.length, ...saved);
    }
  });

  it("the view toggle switches to the roster list and remembers it", async () => {
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    expect(screen.getByRole("button", { name: "Board view" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    await screen.findByText("Roster · 4");
    expect(container.querySelector(".v2-board")).toBeNull();
    expect(lastLoc).toContain("view=list");
    expect(localStorage.getItem("orcha:v2:agentsView")).toBe("list");
  });

  it("a deep link to an agent opens the list + workspace, not the board", async () => {
    const { container } = mount("/agents?agent=scout");
    await screen.findByText("Roster · 4");
    expect(container.querySelector(".v2-board")).toBeNull();
    expect(container.querySelector(".rrow.sel")?.textContent).toContain("scout");
  });

  it("+ opens the New task composer (a human is acting)", async () => {
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    fireEvent.click(within(col(container, "scout")!).getByRole("button", { name: "New task for scout" }));
    // the Shell composer opens over the board, pre-filled for scout; no navigation
    expect(await screen.findByRole("dialog", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(lastLoc).toBe("/agents");
  });
});

describe("D9 board: presence, order, reasons, unassigned, idle fold, palette", () => {
  const base = JSON.parse(JSON.stringify(SNAP));
  beforeEach(() => {
    stubFetch();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.assign(SNAP, JSON.parse(JSON.stringify(base)));
  });
  const headerOrder = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-column]")).map((e) => e.getAttribute("data-column"));

  it("B3: column headers show agent presence as an avatar dot + one word, never a task-status glyph", async () => {
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    const forge = col(container, "forge")!;
    expect(forge.querySelector(".v2-bcol-h .v2-si, .v2-bcol-h .v2-si-wrap")).toBeNull();
    expect(forge.querySelector(".ab-col-word")?.textContent).toBe("Working");
    expect(forge.querySelector(".v2-bcol-h .v2-av-badge")).toBeTruthy();
    // idle: no word at all (the dot says it)
    expect(col(container, "scout")!.querySelector(".ab-col-word")).toBeNull();
  });

  it("orders AI columns by live state (working first), humans after, Unassigned last", async () => {
    (SNAP.agents as { status: string }[])[3].status = "failed"; // scout
    SNAP.tasks.push(task("t6ffffff-6", "Nobody's job", "ready", []));
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    expect(headerOrder(container)).toEqual(["forge", "scout", "kedar", "__unassigned"]);
  });

  it("B6: unassigned work gets its own column and counts in All", async () => {
    SNAP.tasks.push(task("t6ffffff-6", "Nobody's job", "ready", []));
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    const un = col(container, "__unassigned")!;
    expect(within(un).getByRole("link", { name: /Nobody's job/ })).toBeInTheDocument();
    expect(within(un).getByRole("link", { name: "Unassigned" }).getAttribute("href")).toBe("/tasks?assignee=none");
    expect(screen.getByRole("radio", { name: /All tasks/ }).textContent).toContain("6");
  });

  it("B4: an agent needing attention with no cards says why and links there", async () => {
    SNAP.agents.push({ id: "a3", alias: "docs", kind: "ai", role: "Docs", status: "awaiting_human" } as never);
    SNAP.agents.push({ id: "a4", alias: "infra", kind: "ai", role: "Infra", status: "failed" } as never);
    (SNAP as { requests: unknown[] }).requests = [
      { id: "r1", type: "question", status: "open", from: "docs", to: "kedar", requester_id: "a3", target_id: "h1" },
    ];
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    const docs = col(container, "docs")!;
    expect(docs.textContent).toContain("Waiting on kedar");
    expect(within(docs).getByRole("link", { name: /1 request/ }).getAttribute("href")).toBe("/agents?agent=docs&tab=requests");
    expect(docs.querySelector(".v2-bcol-count")).toBeNull(); // no "0" next to a reason
    const infra = col(container, "infra")!;
    expect(within(infra).getByRole("link", { name: /View runs/ }).getAttribute("href")).toBe("/agents?agent=infra&tab=runs");
  });

  it("idle agents with no work fold into one '+N idle agents' slot that expands", async () => {
    SNAP.agents.push({ id: "a5", alias: "sleepy", kind: "ai", role: "Spare", status: "idle" } as never);
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    expect(col(container, "sleepy")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /\+1 idle agent/ }));
    await waitFor(() => expect(col(container, "sleepy")).toBeTruthy());
  });

  it("D13: avatars on the board use collision-free page-wide palette slots", async () => {
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    const fills = Array.from(container.querySelectorAll(".v2-bcol-h .v2-av")).map((e) => (e as HTMLElement).style.background || (e as HTMLElement).style.backgroundColor);
    expect(fills.length).toBeGreaterThan(2);
    expect(new Set(fills).size).toBe(fills.length);
  });
});

describe("D9 board r2: priority slot, SPA column menu, presence + palette parity", () => {
  const base = JSON.parse(JSON.stringify(SNAP));
  beforeEach(() => {
    stubFetch();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.assign(SNAP, JSON.parse(JSON.stringify(base)));
  });

  it("the priority bars always lead the chip row, never the id line", async () => {
    SNAP.tasks.push(task("t7gggggg-7", "Root work", "in_progress", ["forge"], { is_root: true }));
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    const cards = Array.from(container.querySelectorAll(".v2-bcard"));
    expect(cards.length).toBeGreaterThan(3);
    for (const c of cards) {
      const chips = c.querySelector(".v2-bcard-chips");
      expect(chips, c.textContent || "").toBeTruthy();
      expect(chips!.firstElementChild?.classList.contains("ab-prio")).toBe(true);
      expect(c.querySelector(".v2-bcard-id .v2-prio, .ab-bid")).toBeNull();
    }
  });

  it("column ⋯ items navigate in the SPA (no <a href> full reload)", async () => {
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    fireEvent.click(within(col(container, "forge")!).getByRole("button", { name: "More for forge" }));
    const menu = await screen.findByRole("menu", { name: "forge actions" });
    expect(menu.querySelector("a[href]")).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Runs" }));
    await waitFor(() => expect(lastLoc).toBe("/agents?agent=forge&tab=runs"));
  });

  it("an awaiting_human agent with a live run reads 'Needs you' (never plain Working) — same as agentPresence", async () => {
    (SNAP.agents as { status: string }[])[2].status = "awaiting_human"; // forge, active_run set
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    expect(col(container, "forge")!.querySelector(".ab-col-word")?.textContent).toBe("Needs you");
  });

  it("D13: board avatars take the project roster's one slot map (rosterPaletteSlots over snap.agents)", async () => {
    const { rosterPaletteSlots, paletteColor } = await import("../../components/primitives");
    const { container } = mount();
    await screen.findByRole("region", { name: "Agent tasks" });
    const slots = rosterPaletteSlots(SNAP.agents)!;
    const norm = (v: string) => { const d = document.createElement("div"); d.style.background = v; return d.style.background; };
    const av = col(container, "forge")!.querySelector(".v2-bcol-h .v2-av") as HTMLElement;
    expect(av.style.background).toBe(norm(paletteColor(slots.get("forge")!).background));
  });
});

describe("Roster list view (R1/R2/R3)", () => {
  beforeEach(() => {
    stubFetch();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it("tells an agent's status once: one word, lease only in its tooltip; idle rows show no word", async () => {
    (SNAP.agents[2] as { embodiment?: string }).embodiment = "resident";
    try {
      const { container } = mount("/agents?view=list");
      await screen.findByText("Roster · 4");
      const forge = container.querySelector('.rrow-in[data-alias="forge"]')!;
      expect(forge.querySelector(".rword")?.textContent).toBe("Working");
      expect(forge.querySelector(".rword")?.getAttribute("title")).toMatch(/in progress.*live conversation/i);
      expect(forge.textContent).not.toContain("in convo");
      // the agent's STATUS is a word, never a task glyph; a glyph only prefixes the task sub-line (r3)
      expect(forge.querySelector(".rword .v2-si, .rword .v2-si-wrap")).toBeNull();
      forge.querySelectorAll(".v2-si-wrap, .v2-si").forEach((g) => expect(g.closest(".rl-task")).not.toBeNull());
      expect(container.querySelector('.rrow-in[data-alias="scout"] .rword')).toBeNull();
      // R3: no "N agents · M working" summary row
      expect(container.querySelector(".ab-summary")).toBeNull();
      const fills = Array.from(container.querySelectorAll(".rrow-in > .v2-av")).map((e) => (e as HTMLElement).style.background || (e as HTMLElement).style.backgroundColor);
      expect(new Set(fills).size).toBe(fills.length);
    } finally {
      delete (SNAP.agents[2] as { embodiment?: string }).embodiment;
    }
  });
});

describe("agentModel", () => {
  const snap = SNAP as unknown as Snapshot;
  it("taskInFilter buckets", () => {
    expect(taskInFilter(task("x", "", "ready", []), "backlog")).toBe(true);
    expect(taskInFilter(task("x", "", "pending", []), "active")).toBe(false);
    expect(taskInFilter(task("x", "", "blocked", []), "active")).toBe(true);
    expect(taskInFilter(task("x", "", "completed", []), "active")).toBe(false);
    expect(taskInFilter(task("x", "", "completed", []), "all")).toBe(true);
  });
  it("cardLiveState never invents work", () => {
    expect(cardLiveState(snap, SNAP.tasks[0])).toBe("working");
    expect(cardLiveState(snap, SNAP.tasks[1])).toBeNull();
    expect(cardLiveState(snap, SNAP.tasks[2])).toBeNull();
    expect(cardLiveState(snap, SNAP.tasks[3])).toBe("finished");
    expect(cardLiveState(snap, task("p", "Plan", "in_progress", ["scout"], { plan_message: { body: "1. do" } } as Partial<Task>))).toBe("waiting");
    expect(cardLiveState(snap, task("f", "F", "failed", ["scout"]))).toBe("error");
  });
});
