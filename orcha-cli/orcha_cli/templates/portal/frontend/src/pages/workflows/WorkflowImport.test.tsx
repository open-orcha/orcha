import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowImport } from "./WorkflowImport";
import { WorkflowAddTasks } from "./WorkflowAddTasks";
import { exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
import type { Preview } from "./workflowContract.generated";
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });
const detail = () => exampleWorkflow({ capability: writeCapability, tasks: [], available_actions: [{ action: "import", enabled: true }, { action: "add_tasks", enabled: true }] });
const choices = [{ id: "qa", title: "QA checklist", status: "ready", is_root: false }, { id: "data", title: "Prepare test data", status: "ready", is_root: false }];
const searchResponse = (url: string) => {
  const query = new URL(url, "https://orcha.example").searchParams;
  const selected = query.getAll("selected");
  const term = (query.get("query") ?? "").toLowerCase();
  return jsonResponse({
    results: choices.filter((task) => !selected.includes(task.id) && task.title.toLowerCase().includes(term)).slice(0, 5),
    selected: selected.map((id) => choices.find((task) => task.id === id)).filter(Boolean),
  });
};
async function openImport() {
  fireEvent.click(screen.getByRole("button", { name: "Add existing tasks" }));
  fireEvent.change(screen.getByLabelText("Find an existing task"), { target: { value: "a" } });
  await screen.findByRole("checkbox", { name: /QA checklist/ });
}
const impact = (ids: string[]): Preview => ({ graph_revision: 2, preview_digest: ids.join(","), selected_task_ids: ids, required_task_ids: ["qa", "data"], save_starts_work: false,
  blockers: ids.includes("data") ? [] : [{ code: "closure", message: "QA checklist also requires Prepare test data." }], task_impacts: choices.map((t) => ({ ...t, workflow_id: null, eligible: true, requires_acceptance: false, result_digest: null,
    definition_of_done: "Checks pass", preparation_state: "prepared", start_hold: true, human_hold_reason: null, assignee_ids: [], depends_on: t.id === "qa" ? ["data"] : [] })) });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("imports with start choices OFF by default and sends only explicitly releasable selections", async () => {
  const current = detail(); current.launch_enabled = true;
  const p = impact(["qa", "data"]); p.task_impacts![0].releasable = true; p.task_impacts![1].releasable = false;
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("workflow-task-search")) return searchResponse(url);
    if (url.endsWith("import-preview")) return jsonResponse(p);
    if (url.endsWith("/import")) writes.push(JSON.parse(String(init?.body)));
    return jsonResponse(current);
  }));
  render(<MemoryRouter><WorkflowImport detail={current} scope={scope()} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  await openImport();
  for (const title of [/QA checklist/, /Prepare test data/]) fireEvent.click(screen.getByRole("checkbox", { name: title }));
  fireEvent.click(screen.getByRole("button", { name: "Review selected tasks" }));
  const start = await screen.findByRole("checkbox", { name: "Start this task when it is ready: QA checklist" });
  expect(start).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Start this task when it is ready: Prepare test data/ })).toBeDisabled();
  expect(screen.getByText(/No work starts from this save/)).toBeVisible();
  fireEvent.click(start);
  expect(screen.getByText(/Selected tasks may start when ready/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Confirm addition" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].release_task_ids).toEqual(["qa"]);
});

it("keeps an unavailable import start choice after refusal and requires explicit removal", async () => {
  const current = detail(); current.launch_enabled = true;
  const p = impact(["qa", "data"]); p.task_impacts![0].releasable = true;
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("workflow-task-search")) return searchResponse(url);
    if (url.endsWith("import-preview")) return jsonResponse(p);
    if (url.endsWith("/import")) { writes++; return jsonResponse({ detail: { code: "release_not_allowed", message: "QA checklist can no longer start from import" } }, 409); }
    return jsonResponse(current);
  }));
  render(<MemoryRouter><WorkflowImport detail={current} scope={scope()} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  await openImport();
  for (const title of [/QA checklist/, /Prepare test data/]) fireEvent.click(screen.getByRole("checkbox", { name: title }));
  fireEvent.click(screen.getByRole("button", { name: "Review selected tasks" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Start this task when it is ready: QA checklist" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm addition" }));
  await screen.findByText("QA checklist can no longer start from import");
  p.task_impacts![0].releasable = false;
  fireEvent.click(screen.getByRole("button", { name: "Review selected tasks" }));
  expect(await screen.findByRole("checkbox", { name: /Start this task when it is ready: QA checklist/ })).toBeChecked();
  expect(screen.getByRole("button", { name: "Confirm addition" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Remove unavailable start choices" }));
  expect(screen.getByRole("button", { name: "Confirm addition" })).toBeEnabled();
  expect(writes).toBe(1);
});

it("requires explicit closure selection and a second preview before importing atomically", async () => {
  const saved = vi.fn(); const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("workflow-task-search")) return searchResponse(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("import-preview")) return jsonResponse(impact(body.task_ids));
    if (url.endsWith("/import")) writes.push(body);
    return jsonResponse(detail());
  }));
  render(<MemoryRouter><WorkflowImport detail={detail()} scope={scope()} verified stale={false} onSaved={saved} /></MemoryRouter>);
  await openImport();
  fireEvent.click(screen.getByRole("checkbox", { name: /QA checklist/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review selected tasks" }));
  await screen.findByText(/QA checklist also requires/);
  expect(screen.getByRole("button", { name: "Confirm addition" })).toBeDisabled(); expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Include the whole group and review again" }));
  expect(screen.getByRole("button", { name: "Confirm addition" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Review selected tasks" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm addition" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Confirm addition" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ task_ids: ["qa", "data"], preview_digest: "qa,data", expected_revision: 7 });
});
it("retains import choices on a conflict and across navigation, without a reusable confirmation", async () => {
  const identity = scope();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => url.includes("workflow-task-search") ? searchResponse(url)
    : url.endsWith("import-preview") ? jsonResponse(impact(JSON.parse(String(init?.body)).task_ids))
    : url.endsWith("/import") ? jsonResponse({ detail: { code: "changed", message: "Prepare test data started. Nothing was added." } }, 409) : jsonResponse(detail())));
  const view = render(<MemoryRouter><WorkflowImport detail={detail()} scope={identity} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  await openImport();
  for (const title of [/QA checklist/, /Prepare test data/]) fireEvent.click(screen.getByRole("checkbox", { name: title }));
  fireEvent.click(screen.getByRole("button", { name: "Review selected tasks" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm addition" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Confirm addition" }));
  await screen.findByText(/Prepare test data started/);
  expect(screen.getByRole("checkbox", { name: /QA checklist/ })).toBeChecked();
  expect(screen.getByRole("button", { name: "Confirm addition" })).toBeDisabled();
  view.unmount(); render(<MemoryRouter><WorkflowImport detail={detail()} scope={identity} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  await openImport();
  expect(screen.getByRole("checkbox", { name: /Prepare test data/ })).toBeChecked(); expect(screen.getByRole("button", { name: "Confirm addition" })).toBeDisabled();
});
it("does not fabricate acceptance from a completed task or an apparently clear preview", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("workflow-task-search")) return searchResponse(url);
    const p = impact(["qa"]); p.required_task_ids = ["qa"]; p.blockers = []; p.task_impacts![0].requires_acceptance = true;
    return jsonResponse(url.endsWith("import-preview") ? p : detail());
  }));
  render(<MemoryRouter><WorkflowImport detail={detail()} scope={scope()} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  await openImport(); fireEvent.click(screen.getByRole("checkbox", { name: /QA checklist/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review selected tasks" })); await screen.findByText(/needs explicit review of its exact saved result/);
  expect(screen.getByRole("button", { name: "Confirm addition" })).toBeDisabled();
});
it("invalidates reviewed task additions after an edit and sends stable dependency keys", async () => {
  const writes: Record<string, unknown>[] = []; const saved = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method === "POST") writes.push(JSON.parse(String(init.body))); return jsonResponse(detail()); }));
  render(<MemoryRouter><WorkflowAddTasks detail={detail()} scope={scope()} verified stale={false} agents={[]} onSaved={saved} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Add new tasks" }));
  for (const title of ["Build", "Review"]) { fireEvent.click(screen.getByRole("button", { name: "Add task summary" })); fireEvent.change(screen.getAllByLabelText("Task summary").at(-1)!, { target: { value: title } }); }
  fireEvent.click(screen.getAllByRole("button", { name: "Add prerequisite" })[1]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Build" }));
  fireEvent.click(screen.getByRole("button", { name: "Review task addition" })); await screen.findByRole("button", { name: "Confirm task addition" });
  fireEvent.change(screen.getAllByLabelText("Task summary")[0], { target: { value: "Build Android" } });
  expect(screen.queryByRole("button", { name: "Confirm task addition" })).toBeNull(); expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Review task addition" })); fireEvent.click(await screen.findByRole("button", { name: "Confirm task addition" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  const tasks = writes[0].tasks as { client_key: string; depends_on: string[] }[]; expect(tasks[1].depends_on).toEqual([tasks[0].client_key]);
});
it("tells the owner whether preparing a new task releases its hold, by whether the Workflow has started", () => {
  for (const started of [true, false]) {
    const view = render(<MemoryRouter><WorkflowAddTasks detail={{ ...detail(), launch_enabled: started }} scope={scope()} verified stale={false} agents={[]} onSaved={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Add new tasks" }));
    expect(!!screen.queryByText(/already started, so preparing a new task after saving also releases its start hold/)).toBe(started);
    expect(!!screen.queryByText(/Prepare and release them explicitly after saving/)).toBe(!started);
    view.unmount();
  }
});
it("accepts only the exact finished result shown in the preview with an explicit decision", async () => {
  const writes: Record<string, unknown>[] = []; const saved = vi.fn();
  const p = impact(["qa", "data"]); p.task_impacts![0] = { ...p.task_impacts![0], requires_acceptance: true, status: "completed", result_digest: "a".repeat(64), result_text: "Saved pairing checks passed.", definition_of_done: "Pairing passes on both platforms" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("workflow-task-search")) return searchResponse(url);
    if (url.endsWith("import-preview")) return jsonResponse(p);
    if (url.endsWith("/import")) writes.push(JSON.parse(String(init?.body)));
    return jsonResponse(detail());
  }));
  render(<MemoryRouter><WorkflowImport detail={detail()} scope={scope()} verified stale={false} onSaved={saved} /></MemoryRouter>);
  await openImport();
  for (const title of [/QA checklist/, /Prepare test data/]) fireEvent.click(screen.getByRole("checkbox", { name: title }));
  fireEvent.click(screen.getByRole("button", { name: "Review selected tasks" })); await screen.findByText("Saved pairing checks passed.");
  expect(screen.getByText(/Done when: Pairing passes/)).toBeVisible(); expect(screen.getByRole("button", { name: "Confirm addition" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Why this result satisfies QA checklist"), { target: { value: "These saved checks satisfy the pairing criteria." } });
  expect(screen.getByRole("button", { name: "Confirm addition" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "I accept this saved result for QA checklist." }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm addition" })); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes[0]).toMatchObject({ preview_digest: "qa,data", acceptances: { qa: { reviewed_result_digest: "a".repeat(64), evidence: { narrative: "These saved checks satisfy the pairing criteria." } } } });
});

it("keeps an existing-workflow selection while task search fails and recovers", async () => {
  const available = Array.from({ length: 6 }, (_, index) => ({ id: `task-${index}`, title: `Match ${index}`, status: "ready", is_root: false, workflow_id: null }));
  const urls: string[] = [];
  let failing = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!url.includes("workflow-task-search")) return jsonResponse(detail());
    urls.push(url);
    if (failing) return jsonResponse({ detail: { message: "Task search failed." } }, 503);
    const params = new URL(url, "https://orcha.example").searchParams;
    const selected = params.getAll("selected");
    return jsonResponse({
      results: available.filter((task) => !selected.includes(task.id)).slice(0, 5),
      selected: selected.map((id) => available.find((task) => task.id === id)).filter(Boolean),
    });
  }));
  render(<MemoryRouter><WorkflowImport detail={detail()} scope={scope()} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Add existing tasks" }));
  expect(screen.getByText("Enter a task name to search.")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Find an existing task"), { target: { value: "match" } });
  const results = await screen.findByRole("group", { name: "Task search results" });
  expect(results.querySelectorAll('input[type="checkbox"]')).toHaveLength(5);
  fireEvent.click(screen.getByRole("checkbox", { name: /Match 0/ }));
  failing = true;
  fireEvent.change(screen.getByLabelText("Find an existing task"), { target: { value: "broken" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Task search failed");
  expect(screen.getByRole("group", { name: "Selected existing tasks" }).querySelector('input[type="checkbox"]')).toBeChecked();
  expect(new URL(urls.at(-1)!, "https://orcha.example").searchParams.getAll("selected")).toEqual(["task-0"]);
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Try task search again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(urls.every((url) => new URL(url, "https://orcha.example").searchParams.get("limit") === "5")).toBe(true);
});
