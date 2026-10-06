/**
 * Goal ancestry breadcrumb: truthful crumbs (objective text or "No objective
 * set", real parents only, "This task" — never the title twice), links to the
 * parent, the read-only lock, and the parent picker's PUT round-trip.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui";
import { SnapshotProvider } from "../../../state/SnapshotProvider";
import type { Task } from "../../../types";
import { GoalChain, GoalChainView } from "./GoalChain";
import { chainText, clip, directParent, parentCandidates, type GoalChain as Chain } from "./goalApi";
import { goalChainCss } from "./goalCss";

let SNAP: Record<string, unknown>;
const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" };

const OBJ = { kind: "objective", id: "root", title: "Orcha", text: "Ship a calm portal", source: "project_description" } as const;
const chainOf = (...mid: Chain["goal_chain"]): Chain => ({
  task_id: "t3",
  goal_chain: [OBJ, ...mid, { kind: "task", id: "t3", title: "Leaf task", status: "ready" }],
  truncated: false,
  cycle: false,
});
const EPIC = { kind: "parent", id: "t1", title: "Epic: onboarding", status: "in_progress", via: "parent_link" } as const;
const STORY = { kind: "parent", id: "t2", title: "Story: invites", status: "ready", via: "task_request", request_id: "r9" } as const;

const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) }) as unknown as Response;
let calls: { url: string; method: string; body: unknown }[];
let GET_RESP: Chain;
let PUT_RESP: { status: number; body: unknown };

function mount(node: React.ReactNode) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  calls = [];
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [HUMAN, { id: "a1", alias: "forge", kind: "ai", status: "idle" }],
    tasks: [
      { id: "root", title: "Orcha", status: "ready", is_root: true },
      { id: "t1", title: "Epic: onboarding", status: "in_progress", is_root: false },
      { id: "t2", title: "Story: invites", status: "ready", is_root: false },
      { id: "t3", title: "Leaf task", status: "ready", is_root: false },
      { id: "t4", title: "Another epic", status: "completed", is_root: false },
    ],
    requests: [],
  };
  GET_RESP = chainOf(EPIC);
  PUT_RESP = { status: 200, body: { ...chainOf(), parent_task_id: null } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
      if (url.endsWith("/goal-chain")) return jsonRes(GET_RESP);
      if (url.endsWith("/parent") && method === "PUT") return jsonRes(PUT_RESP.body, PUT_RESP.status);
      return jsonRes({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("goalChain helpers", () => {
  it("directParent is the nearest ancestor; chainText reads top-down", () => {
    const c = chainOf(EPIC, STORY);
    expect(directParent(c)?.id).toBe("t2");
    expect(directParent(chainOf())).toBeNull();
    expect(chainText(c)).toBe("Objective: Ship a calm portal → Parent: Epic: onboarding → Parent: Story: invites → This task: Leaf task");
    const none: Chain = { ...chainOf(), goal_chain: [{ ...OBJ, text: null }, chainOf().goal_chain[1]] };
    expect(chainText(none)).toBe("Orcha — no objective set → This task: Leaf task");
  });

  it("parentCandidates excludes root + self, filters, and puts open work first", () => {
    const tasks = SNAP.tasks as Task[];
    expect(parentCandidates(tasks, "t3", "").map((t) => t.id)).toEqual(["t1", "t2", "t4"]);
    expect(parentCandidates(tasks, "t3", "epic").map((t) => t.id)).toEqual(["t1", "t4"]);
    expect(parentCandidates(undefined, "t3", "")).toEqual([]);
  });

  it("clip collapses whitespace and ellipsises", () => {
    expect(clip("a  b\nc", 10)).toBe("a b c");
    expect(clip("abcdefghijk", 5)).toBe("abcd…");
  });

  it("css uses tokens only — no hex colours, no stripes", () => {
    expect(goalChainCss).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(goalChainCss).not.toMatch(/border-left:\s*[2-9]px/);
  });
});

describe("GoalChainView", () => {
  it("renders objective › parents › This task, links parents, never repeats the title", () => {
    mount(<GoalChainView chain={chainOf(EPIC, STORY)} canEdit onEditParent={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Goal chain" });
    const items = within(nav).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Ship a calm portal", "Epic: onboarding", "Story: invites", "This task"]);
    const epic = within(nav).getByRole("link", { name: /Epic: onboarding/ });
    expect(epic.getAttribute("href")).toBe("/tasks?task=t1");
    const story = within(nav).getByRole("link", { name: /Story: invites/ });
    expect(story.getAttribute("title")).toMatch(/spawned from a task request/);
    expect(story.getAttribute("data-via")).toBe("task_request");
    expect(nav.textContent).not.toContain("Leaf task");
    expect(within(nav).getByText("This task").getAttribute("aria-current")).toBe("page");
    expect(nav.getAttribute("title")).toContain("Objective: Ship a calm portal");
  });

  it("says 'No objective set' truthfully when the project has none", () => {
    const c: Chain = { ...chainOf(), goal_chain: [{ ...OBJ, text: null, source: null }, chainOf().goal_chain[1]] };
    mount(<GoalChainView chain={c} canEdit={false} />);
    expect(screen.getByText("No objective set")).toBeTruthy();
    expect(screen.queryByText("Ship a calm portal")).toBeNull();
  });

  it("marks truncated / looped chains instead of hiding it", () => {
    mount(<GoalChainView chain={{ ...chainOf(EPIC), truncated: true }} canEdit={false} />);
    expect(screen.getByText("(more above)")).toBeTruthy();
  });

  it("the edit control is disabled with the reason when read-only", () => {
    mount(<GoalChainView chain={chainOf(EPIC)} canEdit={false} readOnlyReason="Viewing as vera · view-only" onEditParent={() => {}} />);
    const b = screen.getByRole("button", { name: /Change parent task — Viewing as vera/ });
    expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("folds far ancestors into one '…' crumb (tooltip names them + the truncation) so 'This task' is never clipped", () => {
    const P = (i: number) => ({ kind: "parent", id: "p" + i, title: "Parent " + i, status: "ready", via: "parent_link" }) as const;
    mount(<GoalChainView chain={{ ...chainOf(P(1), P(2), P(3), P(4)), truncated: true }} canEdit onEditParent={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Goal chain" });
    const items = within(nav).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Ship a calm portal", "…", "Parent 3", "Parent 4", "This task"]);
    const fold = within(nav).getAllByRole("listitem")[1];
    expect(fold.getAttribute("title")).toBe("2 more parent tasks: Parent 1 › Parent 2 — More ancestors exist above these");
    expect(within(nav).queryByRole("link", { name: /Parent 1/ })).toBeNull();
    expect(nav.getAttribute("title")).toContain("Parent: Parent 1");
  });

  it("the root task (objective-only chain) offers no set-parent control", () => {
    const root: Chain = { task_id: "root", goal_chain: [OBJ], truncated: false, cycle: false };
    mount(<GoalChainView chain={root} canEdit onEditParent={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Ship a calm portal"]);
  });

  it("no edit control at all when no handler is given", () => {
    mount(<GoalChainView chain={chainOf()} canEdit />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("GoalChain (connected)", () => {
  it("fetches the chain for the task and renders nothing until it arrives", async () => {
    mount(<GoalChain taskId="t3" />);
    expect(screen.queryByTestId("goal-chain")).toBeNull();
    await screen.findByRole("link", { name: /Epic: onboarding/ });
    expect(calls[0]).toEqual({ url: "/api/tasks/t3/goal-chain", method: "GET", body: undefined });
  });

  it("renders nothing when the read fails (no invented crumbs)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ detail: "boom" }, 500)));
    mount(<GoalChain taskId="t3" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId("goal-chain")).toBeNull();
  });

  it("picking a parent PUTs {parent_task_id, actor_agent_id} and shows the new chain", async () => {
    GET_RESP = chainOf();
    PUT_RESP = { status: 200, body: { ...chainOf({ ...EPIC, id: "t4", title: "Another epic", status: "completed" }), parent_task_id: "t4" } };
    mount(<GoalChain taskId="t3" />);
    fireEvent.click(await screen.findByRole("button", { name: "Set parent task" }));
    const menu = await screen.findByRole("menu", { name: "Parent task" });
    // root and self are never offered; open work before completed
    await waitFor(() =>
      expect(within(menu).getAllByRole("menuitemradio").map((o) => o.getAttribute("data-value"))).toEqual(["t1", "t2", "t4"]),
    );
    // no explicit parent -> no "Remove parent"
    expect(within(menu).queryByText("Remove parent")).toBeNull();
    fireEvent.change(within(menu).getByRole("searchbox", { name: "Search tasks" }), { target: { value: "another" } });
    fireEvent.click(within(menu).getByRole("menuitemradio"));
    await screen.findByRole("link", { name: /Another epic/ });
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toEqual({ url: "/api/tasks/t3/parent", method: "PUT", body: { parent_task_id: "t4", actor_agent_id: "h1" } });
  });

  it("an explicit parent can be removed; a server refusal is surfaced, chain unchanged", async () => {
    GET_RESP = chainOf(EPIC);
    PUT_RESP = { status: 409, body: { detail: "that parent would create a cycle (it descends from this task)" } };
    mount(<GoalChain taskId="t3" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change parent task" }));
    const menu = await screen.findByRole("menu", { name: "Parent task" });
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { checked: true }).getAttribute("data-value")).toBe("t1"));
    fireEvent.click(within(menu).getByText("Remove parent"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ parent_task_id: null, actor_agent_id: "h1" });
    await screen.findByText(/Couldn't change the parent/);
    expect(screen.getByRole("link", { name: /Epic: onboarding/ })).toBeTruthy();
  });

  it("a derived (task-request) parent offers no 'Remove parent' — it is a stored fact", async () => {
    GET_RESP = chainOf(STORY);
    mount(<GoalChain taskId="t3" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change parent task" }));
    const menu = await screen.findByRole("menu", { name: "Parent task" });
    expect(within(menu).queryByText("Remove parent")).toBeNull();
  });

  it("with nobody able to act, the chain shows but the picker is locked with the reason", async () => {
    SNAP.agents = [{ id: "a1", alias: "forge", kind: "ai", status: "idle" }];
    mount(<GoalChain taskId="t3" />);
    const b = await screen.findByRole("button", { name: /^Change parent task — / });
    await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(b);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("switching tasks refetches and never shows the previous task's chain", async () => {
    const { rerender } = mount(<GoalChain taskId="t3" />);
    await screen.findByRole("link", { name: /Epic: onboarding/ });
    GET_RESP = { ...chainOf(), task_id: "t2" };
    rerender(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter>
            <GoalChain taskId="t2" />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/tasks/t2/goal-chain").length).toBe(1));
    await waitFor(() => expect(screen.queryByRole("link", { name: /Epic: onboarding/ })).toBeNull());
  });
});
