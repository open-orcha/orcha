/**
 * "Make recurring…" from a task:
 *  - the task list row ⋯ and the task detail ⋯ both offer it;
 *  - it opens the Routines create form pre-filled as a COPY of the task (title,
 *    description, definition of done, AI assignee, priority) and POSTs a routine with
 *    origin_task_id — the task itself is never written to;
 *  - schedule presets (daily / weekdays / weekly on a day / monthly / custom cron) + timezone;
 *  - without routine authority the item is disabled with the reason;
 *  - the task shows a small "Recurring" link to the routine; the routine shows
 *    "Created from task #…" and /routines?routine=<id> preselects it.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Snapshot, Task } from "../../types";
import { TasksPage } from "../tasks/TasksPage";
import { routinePrefillFromTask } from "./MakeRecurring";
import { RoutinesPage } from "./RoutinesPage";
import { PRESETS, toCron, DEFAULT_FORM } from "./schedule";

interface Call { url: string; method: string; body: any }
let calls: Call[] = [];
let SNAP: Record<string, any>;
let FROM_TASK: unknown[] = [];

const TASK = {
  id: "t1aaaaaa-0000-4000-8000-000000000001", title: "Triage new issues", status: "ready", priority: 50,
  description: "Look at the inbox.", definition_of_done: "Every new issue has a label.",
  assignees: ["forge"], assignee: "forge", created_by_agent_id: "h1", created_at: "2026-08-01T00:00:00Z",
  message_summary: { count: 0, last: null },
};

const ROUTINE = {
  id: "r7", container_id: "c1", title: "Triage new issues", description: "Look at the inbox.", definition_of_done: "Every new issue has a label.",
  assignee_agent_id: "a1", assignee_alias: "forge", assignee_retired: false, priority: 50,
  cron: "0 9 * * 3", timezone: "UTC", schedule_text: "Every Wednesday at 09:00 UTC",
  enabled: true, skip_if_open: true, next_run_at: new Date(Date.now() + 3600_000).toISOString(), last_run_at: null,
  created_by_alias: "kedar", updated_by_alias: "kedar", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  last_run: null, origin_task_id: TASK.id, origin_task_title: TASK.title,
};

const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  calls = [];
  FROM_TASK = [];
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "forge", kind: "ai", status: "idle" },
    ],
    tasks: [TASK],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1/routines?origin_task_id=")) return jsonRes({ routines: FROM_TASK, scheduler: { last_tick_at: null } });
    if (url === "/api/containers/c1/routines/preview") return jsonRes({ valid: true, error: null, schedule_text: null, next_runs: [] });
    if (url === "/api/containers/c1/routines" && method === "POST") return jsonRes({ ...ROUTINE, ...body, id: "r8" }, 201);
    if (url === "/api/containers/c1/routines") return jsonRes({ routines: [ROUTINE], scheduler: { last_tick_at: new Date().toISOString() } });
    if (url.startsWith("/api/routines/r7/runs")) return jsonRes({ runs: [] });
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (/\/messages$/.test(url)) return jsonRes({ messages: [] });
    if (/\/runs$/.test(url)) return jsonRes([]);
    return jsonRes({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* jsdom */ }
});

function renderAt(entry: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/routines" element={<RoutinesPage />} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

async function findRow(): Promise<HTMLElement> {
  return waitFor(() => {
    const r = document.querySelector<HTMLElement>('.trow[data-id="' + TASK.id + '"]');
    if (!r) throw new Error("row not rendered yet");
    return r;
  });
}

const dialog = () => screen.getByRole("dialog", { name: "Make recurring" });

describe("routinePrefillFromTask", () => {
  it("copies the task fields; only an AI assignee carries over; priority is a number", () => {
    const snap = SNAP as unknown as Snapshot;
    expect(routinePrefillFromTask(TASK as unknown as Task, snap)).toEqual({
      title: "Triage new issues", description: "Look at the inbox.", definition_of_done: "Every new issue has a label.",
      assignee_agent_id: "a1", priority: 50,
    });
    const human = { ...TASK, assignees: ["kedar"], assignee: "kedar", priority: "7", description: "" } as unknown as Task;
    expect(routinePrefillFromTask(human, snap)).toMatchObject({ assignee_agent_id: null, priority: 7, description: null });
    expect(routinePrefillFromTask({ ...TASK, priority: null } as unknown as Task, snap).priority).toBe(100);
  });
});

describe("schedule presets", () => {
  it("offer daily, weekdays, weekly on a day, monthly and custom cron", () => {
    const labels = PRESETS.map((p) => p.label);
    expect(labels).toEqual(expect.arrayContaining(["Daily", "Weekdays", "Weekly", "Monthly", "Custom"]));
    const f = { ...DEFAULT_FORM, time: "08:30" };
    expect(toCron({ ...f, preset: "daily" })).toBe("30 8 * * *");
    expect(toCron({ ...f, preset: "weekdays" })).toBe("30 8 * * 1-5");
    expect(toCron({ ...f, preset: "weekly", weekday: 3 })).toBe("30 8 * * 3");
    expect(toCron({ ...f, preset: "monthly", monthDay: 15 })).toBe("30 8 15 * *");
    expect(toCron({ ...f, preset: "advanced", cron: " 0  6 * * 1 " })).toBe("0 6 * * 1");
  });
});

describe("Make recurring… from the task list row", () => {
  it("opens the routine form pre-filled as a copy and creates a routine with the origin — the task is untouched", async () => {
    renderAt("/tasks");
    const row = await waitFor(() => {
      const r = document.querySelector<HTMLElement>('.trow[data-id="' + TASK.id + '"]');
      expect(r).not.toBeNull();
      return r!;
    });
    fireEvent.click(within(row).getByRole("button", { name: "Actions for Triage new issues" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Make recurring…/ }));

    const dlg = dialog();
    expect(within(dlg).getByText(/A copy of task/)).toBeInTheDocument();
    expect(within(dlg).getByLabelText(/Task title/)).toHaveValue("Triage new issues");
    expect(within(dlg).getByLabelText("Description")).toHaveValue("Look at the inbox.");
    expect(within(dlg).getByLabelText("Definition of done")).toHaveValue("Every new issue has a label.");
    expect(within(dlg).getByLabelText("Assignee")).toHaveValue("a1");
    expect(within(dlg).getByLabelText("Priority")).toHaveValue("50");

    // weekly on Wednesday at 09:00, in a chosen timezone
    fireEvent.click(within(dlg).getByRole("radio", { name: "Weekly" }));
    fireEvent.change(within(dlg).getByLabelText(/^on$/), { target: { value: "3" } });
    fireEvent.change(within(dlg).getByLabelText(/timezone/), { target: { value: "UTC" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create routine" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/containers/c1/routines")).toBe(true));
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/containers/c1/routines")!;
    expect(post.body).toMatchObject({
      title: "Triage new issues", description: "Look at the inbox.", definition_of_done: "Every new issue has a label.",
      assignee_agent_id: "a1", priority: 50, cron: "0 9 * * 3", timezone: "UTC", origin_task_id: TASK.id, actor_agent_id: "h1",
    });
    // a copy, not a conversion: nothing was written to the task
    expect(calls.filter((c) => c.method !== "GET" && c.url.includes("/api/tasks/"))).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Make recurring" })).toBeNull());
  });

  it("custom cron is accepted as typed", async () => {
    renderAt("/tasks");
    const row = await findRow();
    fireEvent.click(within(row).getByRole("button", { name: "Actions for Triage new issues" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Make recurring…/ }));
    const dlg = dialog();
    fireEvent.click(within(dlg).getByRole("radio", { name: "Custom" }));
    fireEvent.change(within(dlg).getByLabelText(/^cron$/), { target: { value: "15 7 1,15 * *" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url === "/api/containers/c1/routines")?.body.cron).toBe("15 7 1,15 * *"));
  });

  it("is disabled with the reason when nobody may manage routines", async () => {
    SNAP.agents = [{ id: "a1", alias: "forge", kind: "ai", status: "idle" }];
    renderAt("/tasks");
    const row = await findRow();
    fireEvent.click(within(row).getByRole("button", { name: "Actions for Triage new issues" }));
    const item = await screen.findByRole("menuitem", { name: /Make recurring…/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(screen.queryByRole("dialog", { name: "Make recurring" })).toBeNull();
  });
});

describe("Make recurring… from the task detail", () => {
  it("is in the header ⋯ menu and the task shows a Recurring link to its routine", async () => {
    FROM_TASK = [ROUTINE];
    renderAt("/tasks?task=" + TASK.id);
    const link = await screen.findByRole("link", { name: /Recurring/ });
    expect(link).toHaveAttribute("href", "/routines?routine=r7");
    const pane = document.querySelector<HTMLElement>(".td-pane")!;
    fireEvent.click(within(pane).getAllByRole("button", { name: "Task actions" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Make recurring…/ }));
    expect(within(dialog()).getByLabelText(/Task title/)).toHaveValue("Triage new issues");
    expect(calls.some((c) => c.url === "/api/containers/c1/routines?origin_task_id=" + encodeURIComponent(TASK.id))).toBe(true);
  });

  it("shows no Recurring link when no routine was made from the task", async () => {
    renderAt("/tasks?task=" + TASK.id);
    await screen.findAllByRole("button", { name: "Task actions" });
    await waitFor(() => expect(calls.some((c) => c.url.includes("origin_task_id="))).toBe(true));
    expect(screen.queryByRole("link", { name: /Recurring/ })).toBeNull();
  });
});

describe("the routine side", () => {
  it("/routines?routine=<id> preselects it and says which task it was created from", async () => {
    renderAt("/routines?routine=r7");
    const insp = await screen.findByRole("complementary", { name: "Routine details" }).catch(() => screen.findByLabelText("Routine details"));
    expect(within(insp).getByText("Created from task")).toBeInTheDocument();
    const taskLink = within(insp).getByRole("link", { name: /#t1aaaaaa/ });
    expect(taskLink).toHaveAttribute("href", "/tasks?task=" + TASK.id);
  });
});
