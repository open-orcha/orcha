import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { exampleTask, exampleWorkflow, jsonResponse, workflowSpec, writeCapability } from "../workflows/workflowTestFixtures";
import type { WorkflowDetail, WorkflowTaskEvidence } from "../workflows/workflowContract.generated";
import { TasksPage } from "./TasksPage";
import { NeedsPage, _resetNeedsHistory } from "../needs/NeedsPage";
import { extensions, type Identity } from "../../extensions";

let workflow: WorkflowDetail;
let taskStatus: string;
let legacyAutonomy: string;
let planBody: string | null;
let taskAutonomy: "on" | "off";
let humanRole: string;
let readsFail = false;
let writes: string[];
const evidence: WorkflowTaskEvidence = {
  task_id: "build", workflow_id: "release", current_evidence_set_id: "saved", next_before_revision: null,
  sets: [{ evidence_set_id: "saved", task_id: "build", workflow_id: "release", workflow_execution_id: "execution", run_id: "run", work_revision: 3, result_revision: 2,
    source_sequence: 1, generation: 1, state: "saved", purpose: "acceptance", missing_reason: null, terminal_cause: null, created_at: "2026-10-25T10:00:00Z", frozen_at: "2026-10-25T10:01:00Z", source_revision: null,
    items: [{ item_id: "item", deliverable_id: "result", deliverable_version: 2, sha256: "a".repeat(64), kind: "result_summary", source: "worker", snapshot_phase: "terminal", complete: true, note: null, storage_state: "readable" }] }],
};
beforeEach(() => {
  _resetNeedsHistory();
  taskStatus = "not_ready"; legacyAutonomy = "full"; readsFail = false; writes = []; planBody = null; taskAutonomy = "off"; humanRole = "member";
  workflow = exampleWorkflow({ evidence_capability: { available: true, reason: null }, tasks: [exampleTask({ current_evidence_set_id: "saved", evidence_state: "saved" })] });
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") { writes.push(url); return jsonResponse({}); }
    if (url === "/openapi.json") return jsonResponse(workflowSpec);
    if (url.endsWith("/workflows/capability")) return jsonResponse(writeCapability);
    if (url.startsWith("/api/containers/project/workflows")) return jsonResponse(readsFail ? {} : { capability: writeCapability, workflows: [workflow] }, readsFail ? 503 : 200);
    if (url === "/api/workflows/release/tasks/build/evidence") return jsonResponse(evidence);
    if (url === "/api/containers") return jsonResponse([{ id: "project", name: "Orcha", status: "active" }]);
    if (url.startsWith("/api/containers/project")) return jsonResponse({
      container: { id: "project", name: "Orcha", status: "active", autonomy_level: legacyAutonomy },
      agents: [{ id: "kedar", alias: "Kedar", kind: "human", status: "idle", member_role: humanRole }, { id: "andrew", alias: "Andrew", kind: "ai", status: "working", autonomy_override: "full" }],
      tasks: [{ id: "build", title: "Build Android", status: taskStatus, autonomy: taskAutonomy, autonomy_revision: 1, priority: 100, assignees: ["Andrew"], created_by_agent_id: "kedar", created_at: "2026-10-25T10:00:00Z", definition_of_done: "Pairing checks pass", result: "Build checks passed", message_summary: { count: 0, last: null }, plan_message: planBody ? { body: planBody, author_alias: "Andrew", at: "2026-10-25T10:00:00Z" } : null }], requests: [],
    });
    if (url.endsWith("/messages")) return jsonResponse({ messages: [] });
    if (url.endsWith("/runs")) return jsonResponse([{ run_id: "run", status: "running", agent: "Andrew", started_at: "2026-10-25T10:00:00Z" }]);
    return jsonResponse({});
  }));
});
afterEach(() => { cleanup(); delete extensions.identity; delete extensions.identityTrusted; vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });
function page(entry = "/tasks?cid=project&task=build&full=1") {
  return render(<ToastProvider><SnapshotProvider><MemoryRouter initialEntries={[entry]}>{entry.startsWith("/needs") ? <NeedsPage /> : <TasksPage />}</MemoryRouter></SnapshotProvider></ToastProvider>);
}
it("lets a verified human member approve an OFF task plan without workflow-owner powers or legacy result verification", async () => {
  extensions.identity = async () => ({ agent_id: "kedar", member_role: "member", alias: "Kedar" }) as Identity;
  extensions.identityTrusted = () => true;
  taskStatus = "in_progress"; planBody = "Andrew will check pairing before starting the build.";
  workflow.capability = { workflow_read: true, workflow_human_write: false, reason: "workflow_owner_required" };
  workflow.tasks[0] = { ...workflow.tasks[0], autonomy: "off", autonomy_revision: 1, status: "in_progress" };
  page(); const plan = await screen.findByRole("region", { name: "Plan approval" });
  expect(within(plan).getByText(planBody)).toBeVisible();
  fireEvent.click(within(plan).getByRole("button", { name: "Approve plan" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Approve this plan?" })).getByRole("button", { name: "Approve plan" }));
  await waitFor(() => expect(writes).toEqual(["/api/decisions"]));
  const call = vi.mocked(fetch).mock.calls.find(([url, init]) => url === "/api/decisions" && init?.method === "POST")!;
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ subject_type: "plan_approval", subject_id: "build", actor_agent_id: "kedar", target_agent_id: "andrew" });
  expect(screen.queryByRole("region", { name: "Verification" })).toBeNull();
  expect(screen.getByRole("switch", { name: "Task autonomy", checked: false })).toBeDisabled();
});
it.each(["on", "unsupported"])("does not offer a workflow plan decision for %s authority", async (kind) => {
  extensions.identity = async () => ({ agent_id: "kedar", member_role: "member" }) as Identity;
  extensions.identityTrusted = () => true;
  taskStatus = "in_progress"; planBody = "Andrew plans the build."; taskAutonomy = kind === "on" ? "on" : "off";
  workflow.tasks[0] = { ...workflow.tasks[0], autonomy: taskAutonomy, autonomy_revision: 1, status: "in_progress" };
  workflow.capability = kind === "unsupported" ? { workflow_read: true, workflow_human_write: false, reason: "integration_required" } : writeCapability;
  page(); await screen.findByRole("link", { name: "Mobile release" });
  expect(screen.queryByRole("region", { name: "Plan approval" })).toBeNull(); expect(writes).toEqual([]);
});
it("offers an OFF workflow plan decision to the selected local human", async () => {
  extensions.identityTrusted = () => false;
  taskStatus = "in_progress"; planBody = "Andrew plans the build."; taskAutonomy = "off";
  workflow.tasks[0] = { ...workflow.tasks[0], autonomy: "off", autonomy_revision: 1, status: "in_progress" };
  workflow.capability = writeCapability;
  page(); await screen.findByRole("link", { name: "Mobile release" });
  expect(screen.getByRole("region", { name: "Plan approval" })).toBeVisible();
  const workflowRead = vi.mocked(fetch).mock.calls.find(([url, init]) =>
    String(url).endsWith("/workflows/capability") && (init?.headers as Record<string, string> | undefined)?.["X-Orcha-Local-Actor"] === "kedar");
  expect(workflowRead).toBeDefined();
  expect(writes).toEqual([]);
});
it("keeps a locally selected viewer read-only for an OFF workflow plan", async () => {
  extensions.identityTrusted = () => false;
  humanRole = "viewer"; taskStatus = "in_progress"; planBody = "Andrew plans the build.";
  workflow.tasks[0] = { ...workflow.tasks[0], autonomy: "off", autonomy_revision: 1, status: "in_progress" };
  workflow.capability = { workflow_read: true, workflow_human_write: false, reason: "verified_member_required" };
  page(); await screen.findByRole("link", { name: "Mobile release" });
  expect(screen.queryByRole("region", { name: "Plan approval" })).toBeNull();
  expect(writes).toEqual([]);
});
it("shows server status and task OFF while replacing standalone hold, assign and cancellation controls", async () => {
  page(); const context = await screen.findByRole("region", { name: "Task workflow" });
  await within(context).findByRole("link", { name: "Mobile release" });
  expect(within(context).getByText(/Task autonomy OFF/)).toBeVisible();
  expect(within(context).getByRole("list", { name: "Workflow blockers" })).toHaveTextContent("Waiting for Start");
  expect(within(context).getByText(/Prepared · waiting for Start/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /Reassign & wake/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Cancel task/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
  const menu = await screen.findByRole("menu", { name: "Task actions" });
  expect(within(menu).queryByText("Release hold")).toBeNull();
  expect(within(menu).queryByText("Unassign…")).toBeNull();
  expect(within(menu).queryByText("Cancel task…")).toBeNull();
  expect(within(menu).getByText("Open workflow task controls")).toBeVisible();
  expect(writes).toEqual([]);
});
it("opens saved evidence before diagnostics and keeps legacy result acceptance unavailable", async () => {
  extensions.identity = async () => ({ agent_id: "kedar", member_role: "member" }) as Identity;
  extensions.identityTrusted = () => true;
  workflow.tasks[0].autonomy_revision = 1;
  taskStatus = "needs_verification";
  page(); const link = await screen.findByRole("link", { name: "Result summary — version 2" });
  expect(link).toHaveAttribute("href", "/api/tasks/build/deliverables/result/versions/2/raw");
  expect(link.compareDocumentPosition(screen.getByRole("tablist", { name: "Task sections" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Verification" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Accept/ })).toBeNull();
  expect(screen.getByText(/Review finished results in the workflow task controls/)).toBeVisible();
  expect(screen.getByText("Definition of done")).toBeVisible();
  expect(writes).toEqual([]);
});
it("uses the same evidence-first workflow guard on Needs you without exposing legacy acceptance", async () => {
  taskStatus = "needs_verification"; legacyAutonomy = "plan";
  page("/needs?cid=project&item=verify:build");
  const context = await screen.findByRole("region", { name: "Task workflow" });
  expect(await within(context).findByRole("link", { name: "Result summary — version 2" })).toHaveAttribute("href", "/api/tasks/build/deliverables/result/versions/2/raw");
  expect(within(context).getByRole("link", { name: "Open workflow task controls" })).toHaveAttribute("href", "/workflows/release?cid=project#workflow-task-build");
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reject…" })).toBeNull();
  expect(writes).toEqual([]);
});
it("does not offer the ordinary run-stop route for a cancelled workflow or lose its stop warning", async () => {
  taskStatus = "in_progress";
  workflow = { ...workflow, status: "cancelled", tasks: [exampleTask({ status: "cancelled", display_state: { label: "Stopping · cancelled", warning: "Released without stop confirmation: the worker may still be running outside Orcha.", release_available: false, release_available_at: "2026-10-25T12:30:00Z" } })] };
  page(); await screen.findByRole("link", { name: "Open workflow task controls" });
  expect(screen.getByText("Released without stop confirmation: the worker may still be running outside Orcha.")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: /Runs/ }));
  await screen.findByRole("region", { name: "Runs and diffs" });
  expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
  expect(writes).toEqual([]);
});
it("carries the workflow label and OFF presentation into the global task list", async () => {
  page("/tasks?cid=project");
  expect(await screen.findByText("Workflow")).toBeVisible();
  expect(screen.getByText("Prepared · waiting for Start")).toBeVisible();
});
it("retains a typed comment while membership refresh fails and keeps old information labelled", async () => {
  page(); await screen.findByRole("link", { name: "Open workflow task controls" });
  const composer = screen.getByRole("textbox", { name: /comment|message/i });
  fireEvent.change(composer, { target: { value: "Please check the saved result" } });
  readsFail = true; fireEvent.click(screen.getByRole("button", { name: "Refresh task workflow" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("membership could not be checked"));
  expect(composer).toHaveValue("Please check the saved result");
  expect(screen.getByText(/Showing last loaded workflow information/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /Cancel task/ })).toBeNull();
  expect(writes).toEqual([]);
});
it("preserves a standalone rejection draft through membership refresh without submitting it", async () => {
  workflow = { ...workflow, tasks: [] }; taskStatus = "needs_verification";
  page();
  await screen.findByRole("region", { name: "Verification" });
  fireEvent.click(document.querySelector('#gate-build [data-act="reject"]')!);
  fireEvent.change(document.querySelector("#rt-build")!, { target: { value: "Need the pairing checks" } });
  readsFail = true; fireEvent.focus(window);
  await screen.findByRole("alert");
  expect(screen.queryByRole("region", { name: "Verification" })).toBeNull();
  readsFail = false; fireEvent.click(screen.getByRole("button", { name: "Refresh task workflow" }));
  await screen.findByRole("region", { name: "Verification" });
  expect(document.querySelector("#rt-build")).toHaveValue("Need the pairing checks");
  expect(writes).toEqual([]);
});
