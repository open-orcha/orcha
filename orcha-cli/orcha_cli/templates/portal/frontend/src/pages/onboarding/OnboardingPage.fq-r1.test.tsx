/**
 * Full-QA round 1 (portal-settings-etc fixer):
 *  - P-10: "Pick a task" assigns the EXISTING ready task (no duplicate via
 *    initial_task) and the pick list never offers the project's root task;
 *  - P-26d: renaming a proposed agent carries its tasks (kickoff) along;
 *  - P-27b: finishing the roster walk's standalone tasks lands on Overview;
 *  - P-29b: a viewer can't start the "Add tasks" path; a 403 never says "retry".
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, _setActingAuth, _setActingIdentity } from "../../state/SnapshotProvider";
import {
  FORK_VIEWER_REASON, KEY, TASK_VIEWER_REASON, normalizeRoster, renameRosterAgent, rosterToWalk,
  taskBatchFailCopy, taskCreateDenial, type Roster,
} from "./logic";
import { OnboardingPage } from "./OnboardingPage";

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let taskPostStatus: number;
let rawSnapshot: unknown;
let agentPostStatus: number;

function jsonRes(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

const snapshot = {
  container: { id: "c1", name: "orcha-web" },
  agents: [
    { id: "h1", alias: "hussein", kind: "human", status: "idle", member_role: "owner" },
    { id: "h2", alias: "vera", kind: "human", status: "idle", member_role: "viewer" },
    { id: "a0", alias: "lead", kind: "ai", status: "idle" },
  ],
  tasks: [
    { id: "root", title: "Container objective met", status: "ready", is_root: true },
    { id: "t1", title: "Set up CI", status: "ready", definition_of_done: "CI green" },
  ],
  requests: [],
};

beforeEach(() => {
  localStorage.clear();
  calls = [];
  taskPostStatus = 200;
  rawSnapshot = snapshot;
  agentPostStatus = 200;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (method !== "GET") calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/models") return jsonRes({ models: [{ id: "m1", name: "Model One" }], default: "m1" });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1/agents" && method === "POST") {
      return agentPostStatus === 200
        ? jsonRes({ agent_id: "a-new", alias: "atlas", container_id: "c1", initial_task: { task_id: "t1", title: "Set up CI", status: "in_progress" } })
        : jsonRes({ detail: "task 'Set up CI' is already assigned" }, false, agentPostStatus);
    }
    if (url === "/api/tasks/t1/assign" && method === "POST") return jsonRes({ alias: "atlas", woke: true, status: "ready" });
    if (url === "/api/containers/c1/tasks" && method === "POST") {
      return taskPostStatus === 200 ? jsonRes({ task_id: "tn" }) : jsonRes({ detail: "your role on this project is viewer" }, false, taskPostStatus);
    }
    if (url.startsWith("/api/containers/")) return jsonRes(rawSnapshot);
    return jsonRes({ detail: "not found" }, false, 404);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete extensions.identity;
  delete extensions.identityTrusted;
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
});

function signIn(id: Identity) {
  extensions.identity = async () => id;
  extensions.identityTrusted = () => true;
}

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/" element={<div>OVERVIEW PAGE</div>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("P-10 / P-10c: pick an existing ready task as the first task", () => {
  const seed = () => localStorage.setItem(KEY, JSON.stringify({
    step: "create-agent", tasks: [], lastAgentAlias: null,
    _agentDraft: { alias: "atlas", role: "Builder", prompt: "Build", model: "m1", _firstMode: "pick", _pickId: null, _desc: "" },
  }));

  it("sends initial_task_id on register (no duplicate, no follow-up /assign) and never offers the root task", async () => {
    seed();
    renderAt("/onboarding");
    const pick = await screen.findByRole("radiogroup", { name: "Existing ready task" });
    expect(pick).toHaveTextContent("Set up CI");
    expect(pick).not.toHaveTextContent("Container objective met");
    fireEvent.click(screen.getByRole("radio", { name: /Set up CI/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/containers/c1/agents")).toBe(true));
    const create = calls.find((c) => c.url === "/api/containers/c1/agents")!;
    expect(create.body).toMatchObject({ initial_task_id: "t1" });
    expect((create.body as Record<string, unknown>).initial_task).toBeUndefined();
    // the server starts the task in the same transaction: no separate /assign
    expect(calls.some((c) => c.url === "/api/tasks/t1/assign")).toBe(false);
    // no new task row was created
    expect(calls.some((c) => c.url === "/api/containers/c1/tasks")).toBe(false);
  });

  it("a 409 from the task lock surfaces the server's reason in the toast", async () => {
    agentPostStatus = 409;
    seed();
    renderAt("/onboarding");
    await screen.findByRole("radiogroup", { name: "Existing ready task" });
    fireEvent.click(screen.getByRole("radio", { name: /Set up CI/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    expect(await screen.findByText(/Create failed \(409\) — task 'Set up CI' is already assigned/)).toBeInTheDocument();
  });
});

describe("P-26d: renaming a proposed agent keeps its kickoff", () => {
  const roster = (): Roster => ({
    rationale: "",
    agents: [{ name: "atlas-lead", role: "Lead", charter: "lead", model: "m1" }, { name: "bolt", role: "B", charter: "b", model: "m1" }],
    tasks: [
      { title: "Map the flow", definition_of_done: "a map", assignee: "atlas-lead", depends_on: [], protocol: null, is_kickoff: true },
      { title: "Build", definition_of_done: "built", assignee: "bolt", depends_on: [], protocol: null, is_kickoff: true },
    ],
  });

  it("renameRosterAgent re-points the agent's tasks; the walk keeps the kickoff", () => {
    const r = roster();
    for (const n of ["atlas-lea", "atlas-l", "l", "le", "lead"]) renameRosterAgent(r, 0, n);
    expect(r.tasks[0].assignee).toBe("lead");
    expect(r.tasks[1].assignee).toBe("bolt");
    const walk = rosterToWalk(normalizeRoster({ agents: r.agents.map((a) => ({ ...a, model_hint: a.model })), tasks: r.tasks }, "m1"));
    expect(walk.agents[0]).toMatchObject({ name: "lead", kickoff: { title: "Map the flow", dod: "a map" } });
    expect(walk.standalone).toEqual([]);
  });

  it("in the roster UI, the chip follows the rename and the commit seeds the kickoff", async () => {
    localStorage.setItem(KEY, JSON.stringify({ step: "propose-roster", tasks: [], lastAgentAlias: null, _agentDraft: null, _roster: roster() }));
    renderAt("/onboarding");
    const names = await screen.findAllByRole("textbox", { name: "Agent name" });
    fireEvent.change(names[0], { target: { value: "lead" } });
    expect(await screen.findByTitle("Assignee: lead")).toBeInTheDocument();
    expect(screen.queryByTitle("Assignee: atlas-lead")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Looks good/ }));
    await waitFor(() => {
      const st = JSON.parse(localStorage.getItem(KEY) || "{}");
      expect(st.step).toBe("create-agent");
      expect(st._agentDraft).toMatchObject({ alias: "lead", _firstMode: "describe", _taskTitle: "Map the flow", _desc: "a map" });
    });
  });
});

describe("P-27b: finishing the roster lands on the Overview", () => {
  it("Continue after the walk's standalone tasks goes to Overview, not create-agent", async () => {
    localStorage.setItem(KEY, JSON.stringify({
      step: "create-tasks", tasks: [{ title: "Write docs", dod: "docs exist" }], lastAgentAlias: "lead",
      _agentDraft: null, _walk: null, _walkDone: true,
    }));
    renderAt("/onboarding");
    const cont = await screen.findByRole("button", { name: /Continue — go to Overview/ });
    fireEvent.click(cont);
    expect(await screen.findByText("OVERVIEW PAGE")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/containers/c1/tasks")).toHaveLength(1);
    const st = JSON.parse(localStorage.getItem(KEY) || "{}");
    expect(st._walkDone).toBe(false);
    expect(st.step).not.toBe("create-agent");
  });

  it("without the flag, Continue still leads to create-agent", async () => {
    localStorage.setItem(KEY, JSON.stringify({ step: "create-tasks", tasks: [], lastAgentAlias: null, _agentDraft: null }));
    renderAt("/onboarding");
    fireEvent.click(await screen.findByRole("button", { name: /Continue — create an agent/ }));
    expect(await screen.findByRole("heading", { name: /agent/i })).toBeInTheDocument();
    expect(screen.queryByText("OVERVIEW PAGE")).toBeNull();
  });
});

describe("P-29b: viewer Add tasks path", () => {
  it("taskCreateDenial / taskBatchFailCopy", () => {
    expect(taskCreateDenial(null)).toBeNull();
    expect(taskCreateDenial({ member_role: "member" })).toBeNull();
    expect(taskCreateDenial({ member_role: "viewer" })).toBe(TASK_VIEWER_REASON);
    expect(taskBatchFailCopy(0, 1, [403], TASK_VIEWER_REASON)).toBe(TASK_VIEWER_REASON + ".");
    expect(taskBatchFailCopy(0, 1, [403], null)).not.toMatch(/retry/);
    expect(taskBatchFailCopy(1, 1, [500])).toBe("1 created, 1 failed — retry the rest");
  });

  it("the fork disables Add tasks for a viewer with one combined reason", async () => {
    signIn({ agent_id: "h2", alias: "vera", member_role: "viewer", grants: [] });
    localStorage.setItem(KEY, JSON.stringify({ step: "fork" }));
    renderAt("/onboarding");
    const add = await screen.findByRole("button", { name: /Add tasks/ });
    await waitFor(() => expect(add).toBeDisabled());
    expect(add).toHaveAttribute("title", TASK_VIEWER_REASON);
    expect(screen.getByRole("note")).toHaveTextContent(FORK_VIEWER_REASON);
  });

  it("a 403 on create shows the permission reason, never 'retry the rest'", async () => {
    taskPostStatus = 403;
    localStorage.setItem(KEY, JSON.stringify({ step: "create-tasks", tasks: [{ title: "T", dod: "D" }], lastAgentAlias: null, _agentDraft: null }));
    renderAt("/onboarding");
    fireEvent.click(await screen.findByRole("button", { name: /Continue — create an agent/ }));
    expect(await screen.findByText(/permission to add tasks/)).toBeInTheDocument();
    expect(screen.queryByText(/retry the rest/)).toBeNull();
  });
});
