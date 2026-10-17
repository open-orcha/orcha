/**
 * Routines page: Linear list (schedule text, last result, next run, enabled switch),
 * create dialog with presets + server preview, run-now confirm, history inspector,
 * truthful scheduler notice, and read-only affordances without an acting human.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { RoutinesPage } from "./RoutinesPage";

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];

const HUMAN = { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" };
const FORGE = { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "idle" };

function snap(withHuman = true) {
  return {
    container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
    agents: withHuman ? [HUMAN, FORGE] : [FORGE],
    tasks: [],
    requests: [],
  };
}

const future = new Date(Date.now() + 3 * 3600_000).toISOString();

const ROUTINES = [
  {
    id: "r1", container_id: "c1", title: "Dependency audit", description: "Check packages.", definition_of_done: "Report posted.",
    assignee_agent_id: "a1", assignee_alias: "forge", assignee_retired: false, priority: 100,
    cron: "0 9 * * 1-5", timezone: "Africa/Nairobi", schedule_text: "Every weekday at 09:00 Nairobi time",
    enabled: true, skip_if_open: true, next_run_at: future, last_run_at: null,
    created_by_alias: "kedar", updated_by_alias: "kedar", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    last_run: { run_id: "x1", outcome: "created", trigger: "schedule", detail: null, created_at: "2026-09-28T06:00:00Z",
      task_id: "t9", task_status: "in_progress", task_title: "Dependency audit", missed_count: 0 },
  },
  {
    id: "r2", container_id: "c1", title: "Weekly triage", description: null, definition_of_done: "Inbox zero.",
    assignee_agent_id: null, assignee_alias: null, assignee_retired: false, priority: 10,
    cron: "0 16 * * 5", timezone: "UTC", schedule_text: "Every Friday at 16:00 UTC",
    enabled: false, skip_if_open: true, next_run_at: null, last_run_at: null,
    created_by_alias: "kedar", updated_by_alias: "kedar", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    last_run: null,
  },
];

const RUNS = [
  { run_id: "x2", routine_id: "r1", trigger: "catch_up", scheduled_for: "2026-09-29T06:00:00Z", missed_count: 3, outcome: "skipped",
    task_id: null, task_title: null, task_status: null, detail: "Skipped: the previous task “Dependency audit” is still in progress.",
    actor_alias: "kedar", created_at: "2026-09-29T07:00:00Z", finished_at: "2026-09-29T07:00:00Z" },
  { run_id: "x1", routine_id: "r1", trigger: "schedule", scheduled_for: "2026-09-28T06:00:00Z", missed_count: 0, outcome: "created",
    task_id: "t9", task_title: "Dependency audit", task_status: "in_progress", detail: null,
    actor_alias: "kedar", created_at: "2026-09-28T06:00:00Z", finished_at: "2026-09-28T06:00:00Z" },
];

function jsonRes(data: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => data } as Response;
}

function stubFetch(opts: { withHuman?: boolean; lastTick?: string | null; routines?: unknown[] } = {}) {
  calls = [];
  const lastTick = opts.lastTick === undefined ? new Date().toISOString() : opts.lastTick;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1/routines" && method === "GET")
      return jsonRes({ routines: opts.routines ?? ROUTINES, scheduler: { last_tick_at: lastTick } });
    if (url === "/api/containers/c1/routines/preview")
      return jsonRes({ valid: true, error: null, schedule_text: "Every weekday at 09:00 Nairobi time", next_runs: ["2026-09-30T06:00:00Z"] });
    if (url === "/api/containers/c1/routines" && method === "POST")
      return jsonRes({ ...ROUTINES[1], id: "r3", title: body.title, enabled: true }, 201);
    if (url.startsWith("/api/routines/r1/runs")) return jsonRes({ runs: RUNS });
    if (url.startsWith("/api/routines/") && method === "PATCH") {
      const id = url.split("/")[3];
      const base = ROUTINES.find((r) => r.id === id)!;
      return jsonRes({ ...base, ...body });
    }
    if (url === "/api/routines/r1/run") return jsonRes({ run_id: "x3", outcome: "created", task_id: "t10", detail: null });
    if (url.startsWith("/api/containers/c1")) return jsonRes(snap(opts.withHuman ?? true));
    return jsonRes({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/routines"]}>
          <Routes>
            <Route path="/routines" element={<RoutinesPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

beforeEach(() => stubFetch());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("RoutinesPage", () => {
  it("lists routines with schedule, last result, next run and enabled state", async () => {
    mount();
    const list = await screen.findByRole("list", { name: "Routines" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Dependency audit");
    expect(rows[0]).toHaveTextContent("Every weekday at 09:00 Nairobi time");
    expect(rows[0]).toHaveTextContent("In progress");
    expect(rows[0]).toHaveTextContent("in 3h");
    expect(rows[1]).toHaveTextContent("Paused");
    expect(rows[1]).toHaveTextContent("Never run");
    const sw = within(rows[0]).getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(within(rows[1]).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    // the healthy scheduler says nothing
    expect(screen.queryByText(/scheduler/i)).toBeNull();
  });

  it("toggling the switch PATCHes enabled as the acting human", async () => {
    mount();
    const list = await screen.findByRole("list", { name: "Routines" });
    const sw = within(within(list).getAllByRole("listitem")[0]).getByRole("switch");
    await waitFor(() => expect(sw).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/routines/r1");
    expect(patch.body).toEqual({ enabled: false, actor_agent_id: "h1" });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
  });

  it("creates a routine from presets with a plain-English preview", async () => {
    mount();
    await screen.findByRole("list", { name: "Routines" });
    const btn = screen.getAllByRole("button", { name: /New routine/ })[0];
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog", { name: "New routine" });
    fireEvent.change(within(dlg).getByLabelText(/Task title/), { target: { value: "Morning triage" } });
    fireEvent.change(within(dlg).getByLabelText("Definition of done"), { target: { value: "Inbox triaged." } });
    fireEvent.change(within(dlg).getByLabelText("timezone"), { target: { value: "Africa/Nairobi" } });
    await within(dlg).findByText("Every weekday at 09:00 Nairobi time");
    await waitFor(() => expect(within(dlg).getByText(/^Next:/)).toBeInTheDocument());
    fireEvent.click(within(dlg).getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/containers/c1/routines")).toBe(true));
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/containers/c1/routines")!;
    expect(post.body).toMatchObject({
      title: "Morning triage", definition_of_done: "Inbox triaged.", cron: "0 9 * * 1-5", timezone: "Africa/Nairobi",
      enabled: true, skip_if_open: true, assignee_agent_id: null, actor_agent_id: "h1",
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New routine" })).toBeNull());
  });

  it("weekly preset builds the weekday cron", async () => {
    mount();
    await screen.findByRole("list", { name: "Routines" });
    const btn = screen.getAllByRole("button", { name: /New routine/ })[0];
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog", { name: "New routine" });
    fireEvent.click(within(dlg).getByRole("radio", { name: "Weekly" }));
    fireEvent.change(within(dlg).getByLabelText("on"), { target: { value: "5" } });
    fireEvent.change(within(dlg).getByLabelText("at"), { target: { value: "16:30" } });
    await waitFor(() => {
      const pv = calls.filter((c) => c.url.endsWith("/routines/preview")).pop();
      expect(pv?.body).toMatchObject({ cron: "30 16 * * 5" });
    });
  });

  it("opens the inspector with run history and runs now after confirmation", async () => {
    mount();
    const list = await screen.findByRole("list", { name: "Routines" });
    fireEvent.click(within(within(list).getAllByRole("listitem")[0]).getByRole("button", { name: /Dependency audit/ }));
    const insp = await screen.findByRole("region", { name: "Routine details" });
    await within(insp).findByText(/Catch-up \(3 missed\)/);
    expect(insp).toHaveTextContent("Skipped");
    expect(insp).toHaveTextContent("Report posted.");
    expect(insp).toHaveTextContent("Skip the run");
    const run = within(insp).getByRole("button", { name: "Run now" });
    await waitFor(() => expect(run).not.toBeDisabled());
    fireEvent.click(run);
    const confirm = await screen.findByRole("dialog", { name: /Run “Dependency audit” now\?/ });
    expect(confirm).toHaveTextContent("assigned to forge");
    fireEvent.click(within(confirm).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/routines/r1/run" && c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.url === "/api/routines/r1/run")!.body).toEqual({ actor_agent_id: "h1" });
  });

  it("says so when the scheduler has never checked in", async () => {
    stubFetch({ lastTick: null });
    mount();
    await screen.findByRole("list", { name: "Routines" });
    expect(await screen.findByText(/scheduler hasn't checked in yet/)).toBeInTheDocument();
  });

  it("is read-only without an acting human", async () => {
    stubFetch({ withHuman: false });
    mount();
    const list = await screen.findByRole("list", { name: "Routines" });
    await waitFor(() => expect(within(within(list).getAllByRole("listitem")[0]).getByRole("switch")).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(within(within(list).getAllByRole("listitem")[0]).getByRole("switch"));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    for (const b of screen.getAllByRole("button", { name: /New routine/ })) expect(b).toBeDisabled();
  });

  it("shows an empty state that explains routines", async () => {
    stubFetch({ routines: [] });
    mount();
    expect(await screen.findByText("No routines yet")).toBeInTheDocument();
    expect(screen.getByText(/plan approval and verification/)).toBeInTheDocument();
  });
});
