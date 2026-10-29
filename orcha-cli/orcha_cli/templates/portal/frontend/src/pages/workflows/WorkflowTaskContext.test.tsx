import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkflowTaskInspector, WorkflowTaskProvider, WorkflowTaskStatus, useTaskWorkflow } from "./WorkflowTaskContext";
import { exampleTask, exampleWorkflow, jsonResponse, workflowSpec, writeCapability } from "./workflowTestFixtures";

let identity = "kedar";
let snapshotStatus = "not_ready";
vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ cid: "project", snap: { agents: [], tasks: [{ id: "build", status: snapshotStatus }] }, identity: { agent_id: identity }, identityTrusted: true, identityPending: false }),
  useActingAuthority: () => ({ human: { id: identity, kind: "human", member_role: "owner" }, reason: null, readOnly: false, pending: false }),
}));
beforeEach(() => { identity = "kedar"; snapshotStatus = "not_ready"; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Probe() {
  const { blockLegacy, index } = useTaskWorkflow("build");
  return <><button disabled={blockLegacy}>Legacy action</button><button onClick={index?.refresh}>Check again</button><WorkflowTaskInspector taskId="build" /><input aria-label="Comment draft" /></>;
}
function App() { return <MemoryRouter><WorkflowTaskProvider><Probe /></WorkflowTaskProvider></MemoryRouter>; }
function mockReads(read: (url: string) => Response | Promise<Response>) {
  const fetch = vi.fn(async (url: string) => url === "/openapi.json" ? jsonResponse(workflowSpec)
    : url.endsWith("/capability") ? jsonResponse(writeCapability) : read(url));
  vi.stubGlobal("fetch", fetch); return fetch;
}
it("hides workflow presentation while retaining hidden membership guards", async () => {
  const fetch = mockReads(() => jsonResponse({ capability: writeCapability, workflows: [exampleWorkflow({ hidden: true, status: "completed" })] }));
  render(<MemoryRouter><WorkflowTaskProvider><WorkflowTaskStatus taskId="build" fallback="completed" showLabel /><Probe /></WorkflowTaskProvider></MemoryRouter>);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes("visibility=all"))).toBe(true));
  await waitFor(() => expect(screen.queryByText(/Checking workflow membership/)).toBeNull());
  expect(screen.getByRole("button", { name: "Legacy action" })).toBeDisabled();
  expect(screen.queryByRole("region", { name: "Task workflow" })).toBeNull();
  expect(screen.queryByText("Mobile release")).toBeNull();
  expect(screen.queryByText(/Prepared · waiting for Start/)).toBeNull();
});
it("clears the server's list warning while preserving permanent inspector history and recorded withdrawal", async () => {
  const warning = "Released without stop confirmation: the worker may still be running outside Orcha.";
  const task = exampleTask({ display_state: { label: "Worker released · owner decides", warning, list_warning: true } });
  mockReads(() => jsonResponse({ capability: writeCapability, workflows: [exampleWorkflow({ tasks: [task] })] }));
  render(<MemoryRouter><WorkflowTaskProvider><WorkflowTaskStatus taskId="build" fallback="not_ready" showLabel /><Probe /></WorkflowTaskProvider></MemoryRouter>);
  expect(await screen.findByLabelText(warning)).toHaveTextContent("Warning");
  task.display_state.list_warning = false;
  task.withdrawn_at = "2026-10-26T02:00:00Z"; task.withdrawn_by = "former-owner"; task.withdrawn_reason = "The alternative solution is accepted";
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.queryByLabelText(warning)).toBeNull());
  expect(screen.getByText(warning)).toBeVisible();
  expect(screen.getByText("Withdrawn by Name unavailable: The alternative solution is accepted")).toBeVisible();
  expect(screen.queryByText("former-owner")).toBeNull();
});
it("shows the exact recorded acceptance actor, authority and evidence version", async () => {
  const task = exampleTask({ acceptance: {
    id: "acceptance", work_revision: 3, actor_id: "andrew", actor_kind: "ai", actor_alias: "Build Agent",
    autonomy_at_acceptance: "on", autonomy_revision: 2, acceptance_source: "task_autonomy", evidence_set_id: "evidence",
    accepted_at: "2026-10-26T03:00:00Z", evidence_items: [{ item_id: "item", deliverable_id: "result", deliverable_version: 4, sha256: "a".repeat(64) }],
  } });
  mockReads((url) => url.includes("/evidence") ? jsonResponse({ task_id: "build", workflow_id: "release", current_evidence_set_id: null, sets: [] })
    : jsonResponse({ capability: writeCapability, workflows: [exampleWorkflow({ tasks: [task] })] }));
  render(<App />);
  expect(await screen.findByText(/Accepted by Build Agent \(agent\) for work revision 3/)).toBeVisible();
  expect(screen.getByText("Task autonomy ON at acceptance · setting revision 2.")).toBeVisible();
  expect(screen.getByText(/Agent acceptance authorized by task autonomy/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Accepted evidence — version 4" })).toHaveAttribute("href", "/api/tasks/build/deliverables/result/versions/4/raw");
  fireEvent.click(screen.getByText("Recorded file fingerprint"));
  expect(screen.getByText(/SHA-256/)).toHaveTextContent("a".repeat(64));
  expect(screen.queryByText(/Accepted by andrew/)).toBeNull();
});
it("checks later workflow pages before releasing legacy actions and preserves drafts", async () => {
  let resolve!: (response: Response) => void;
  const fetch = mockReads((url) => url.includes("cursor=") ? new Promise<Response>((done) => { resolve = done; })
    : jsonResponse({ capability: writeCapability, workflows: [], next_cursor: "next" }));
  render(<App />);
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  expect(screen.getByRole("button", { name: "Legacy action" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Comment draft"), { target: { value: "Keep my comment" } });
  await act(async () => resolve(jsonResponse({ capability: writeCapability, workflows: [exampleWorkflow()], next_cursor: null })));
  expect(await screen.findByRole("link", { name: "Open workflow task controls" })).toHaveAttribute("href", "/workflows/release?cid=project#workflow-task-build");
  expect(screen.getByRole("button", { name: "Legacy action" })).toBeDisabled();
  expect(screen.getByLabelText("Comment draft")).toHaveValue("Keep my comment");
  expect(fetch.mock.calls.filter(([url]) => url.includes("?limit"))).toHaveLength(2);
});
it("allows standalone actions only after the complete membership read", async () => {
  mockReads(() => jsonResponse({ capability: writeCapability, workflows: [], next_cursor: null }));
  render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Legacy action" })).toBeEnabled());
  expect(screen.queryByRole("link", { name: "Open workflow task controls" })).toBeNull();
});
it("distinguishes an older server from a failed membership check", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ paths: {} })));
  render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Legacy action" })).toBeEnabled());
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be checked");
  expect(screen.getByRole("button", { name: "Legacy action" })).toBeDisabled();
});
it.each(["cursor", "duplicate", "wrong_project", "malformed"])("refuses %s membership instead of treating it as standalone", async (failure) => {
  const workflow = exampleWorkflow(failure === "wrong_project" ? { container_id: "another-project" } : {});
  mockReads(() => jsonResponse(failure === "malformed" ? {} : { capability: writeCapability,
    workflows: failure === "duplicate" ? [workflow, workflow] : [workflow], next_cursor: failure === "cursor" ? "again" : null }));
  render(<App />);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Legacy action" })).toBeDisabled();
  expect(screen.queryByRole("link", { name: "Mobile release" })).toBeNull();
});
it("labels stale membership on failure, then clears all prior reads on access refusal", async () => {
  let status = 200;
  mockReads(() => jsonResponse(status === 200 ? { capability: writeCapability, workflows: [exampleWorkflow()] } : {}, status));
  render(<App />); await screen.findByRole("link", { name: "Mobile release" });
  status = 503; fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await screen.findByRole("alert"); expect(screen.getByText(/Showing last loaded workflow/)).toBeVisible();
  status = 403; fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Mobile release" })).toBeNull());
  expect(screen.getByRole("button", { name: "Legacy action" })).toBeDisabled();
});
it("removes the previous identity's workflow immediately while keeping the task page mounted", async () => {
  let delayed = false;
  mockReads(() => delayed ? new Promise<Response>(() => {}) : jsonResponse({ capability: writeCapability, workflows: [exampleWorkflow()] }));
  const view = render(<App />); await screen.findByRole("link", { name: "Mobile release" });
  fireEvent.change(screen.getByLabelText("Comment draft"), { target: { value: "Unsent comment" } });
  identity = "other-reader"; delayed = true; view.rerender(<App />);
  expect(screen.queryByRole("link", { name: "Mobile release" })).toBeNull();
  expect(screen.getByRole("button", { name: "Legacy action" })).toBeDisabled();
  expect(screen.getByLabelText("Comment draft")).toHaveValue("Unsent comment");
});
it("also clears previous reads when OpenAPI discovery itself refuses access", async () => {
  mockReads(() => jsonResponse({ capability: writeCapability, workflows: [exampleWorkflow()] }));
  render(<App />); await screen.findByRole("link", { name: "Mobile release" });
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 403)));
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("access is unavailable");
  expect(screen.queryByRole("link", { name: "Mobile release" })).toBeNull();
});

it.each(["Draft · not prepared", "On hold", "Prepared · waiting for Start", "Stopped by owner · owner decides", "Stopping", "Recovery needed"])("keeps the workflow's %s label on a not-ready task", async (label) => {
  mockReads(() => jsonResponse({ capability: writeCapability, workflows: [exampleWorkflow({ tasks: [exampleTask({ status: "not_ready", display_state: { label } })] })] }));
  render(<MemoryRouter><WorkflowTaskProvider><WorkflowTaskStatus taskId="build" fallback="not_ready" showLabel /></WorkflowTaskProvider></MemoryRouter>);
  expect(screen.getByText("Not ready · checking workflow")).toBeVisible();
  expect(await screen.findByText(label)).toBeVisible();
  if (label !== "On hold") expect(screen.queryByText("On hold")).toBeNull();
});
it.each(["hidden", "forbidden", "unavailable", "ordinary"])("uses an honest fallback for %s membership", async (mode) => {
  mockReads(() => jsonResponse(mode === "hidden" ? { capability: writeCapability, workflows: [exampleWorkflow({ hidden: true })] }
    : { capability: writeCapability, workflows: [] }, mode === "forbidden" ? 403 : mode === "unavailable" ? 503 : 200));
  render(<MemoryRouter><WorkflowTaskProvider><WorkflowTaskStatus taskId="build" fallback="not_ready" showLabel /></WorkflowTaskProvider></MemoryRouter>);
  expect(await screen.findByText(mode === "ordinary" ? "On hold" : "Not ready")).toBeVisible();
});

it("shows a version-two unselected branch as Not selected instead of a hold", async () => {
  const task = exampleTask({ status: "not_ready", start_hold: false, route_state: "not_selected",
    display_state: { label: "Not selected" },
    blockers: [{ code: "not_selected", message: "An earlier step's outcome did not select this step." }] });
  mockReads(() => jsonResponse({ capability: writeCapability,
    workflows: [exampleWorkflow({ semantics_version: 2, tasks: [task] })] }));
  render(<MemoryRouter><WorkflowTaskProvider><WorkflowTaskStatus taskId="build" fallback="not_ready" showLabel /></WorkflowTaskProvider></MemoryRouter>);
  expect(screen.getByText("Not ready · checking workflow")).toBeVisible();
  expect(await screen.findByText("Not selected")).toBeVisible();
  expect(screen.queryByText("On hold")).toBeNull();
});

it("refreshes the shared membership index after a live task status changes", async () => {
  let label = "Prepared · waiting for Start";
  const fetch = mockReads(() => jsonResponse({ capability: writeCapability, workflows: [exampleWorkflow({ tasks: [exampleTask({ display_state: { label } })] })] }));
  function Status() { return <MemoryRouter><WorkflowTaskProvider><WorkflowTaskStatus taskId="build" fallback={snapshotStatus} showLabel /></WorkflowTaskProvider></MemoryRouter>; }
  const view = render(<Status />);
  await screen.findByText(label);
  label = "Working"; snapshotStatus = "in_progress"; view.rerender(<Status />);
  await screen.findByText("Working");
  expect(fetch.mock.calls.filter(([url]) => url.includes("visibility=all"))).toHaveLength(2);
  view.rerender(<Status />);
  expect(fetch.mock.calls.filter(([url]) => url.includes("visibility=all"))).toHaveLength(2);
});
