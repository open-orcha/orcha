import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import { WorkflowActions } from "./WorkflowActions";
import { exampleWorkflow, exampleTask, exampleImpact, jsonResponse, writeCapability } from "./workflowTestFixtures";
import { type DraftScope } from "./workflowDraft";
const scope = (): DraftScope => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });
const preview = { graph_revision: 4, preview_digest: "graph-fingerprint", selected_task_ids: [], required_task_ids: [], blockers: [], save_starts_work: false };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function nameDraft() {
  fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Mobile release" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Goal" }), { target: { value: "Pairing works on both platforms" } });
}
async function review() {
  fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save workflow" })).toBeEnabled());
}
it("sends one atomic creation with draft dependencies and objectives, never staging or starting tasks", async () => {
  const onSaved = vi.fn();
  const fetch = vi.fn(async (url: string) => jsonResponse(url.endsWith("/preview") ? preview : url.endsWith("/capability") ? writeCapability : exampleWorkflow()));
  vi.stubGlobal("fetch", fetch);
  render(<WorkflowDraftEditor scope={scope()} saveUnavailableReason={null} onSaved={onSaved} agents={[{ id: "andrew", alias: "Andrew" }]} />);
  nameDraft();
  for (const title of ["Build Android", "Review build"]) {
    fireEvent.click(screen.getByRole("button", { name: "Add task summary" }));
    fireEvent.change(screen.getAllByLabelText("Task summary").at(-1)!, { target: { value: title } });
  }
  const second = within(screen.getByRole("group", { name: "Task 2" }));
  fireEvent.click(second.getByRole("button", { name: "Add prerequisite" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Build Android" }));
  fireEvent.click(screen.getByRole("button", { name: "Add objective" }));
  fireEvent.change(screen.getByLabelText("Objective title"), { target: { value: "Reliable pairing" } });
  fireEvent.change(screen.getByLabelText("Objective done when"), { target: { value: "Both builds pass" } });
  await review(); fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  const create = calls.filter(([url]) => url === "/api/containers/project/workflows"); expect(create).toHaveLength(1);
  const body = JSON.parse(create[0][1].body as string);
  expect(body.tasks[1].depends_on).toEqual([body.tasks[0].client_key]);
  expect(body.objectives).toEqual([{ title: "Reliable pairing", criteria: "Both builds pass" }]);
  expect(body.preview_digest).toBe("graph-fingerprint"); expect(body.idempotency_key).toBeTruthy();
  expect(calls.some(([url]) => /\/start|\/assign|\/readiness/.test(url))).toBe(false);
  expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled();
});
it("invalidates a preview after edits and keeps the draft on a revision conflict", async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith("/preview") ? jsonResponse(preview) : url.endsWith("/capability") ? jsonResponse(writeCapability)
    : jsonResponse({ detail: { code: "revision_conflict", message: "A task changed. Review the updated draft." } }, 409));
  vi.stubGlobal("fetch", fetch); render(<WorkflowDraftEditor scope={scope()} saveUnavailableReason={null} />); nameDraft(); await review();
  fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Updated release" } });
  expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled(); await review();
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" })); expect(await screen.findByText(/A task changed/)).toBeVisible();
  expect(screen.getByLabelText("Workflow name")).toHaveValue("Updated release"); expect(screen.getByRole("button", { name: "Save workflow" })).toBeDisabled();
});
it("keeps uncertain save immutable across navigation and retries with the exact original key and body", async () => {
  const currentScope = scope(); const writes: string[] = []; const onSaved = vi.fn();
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/preview")) return jsonResponse(preview);
    if (url.endsWith("/capability")) return jsonResponse(writeCapability);
    if (url.includes("/workflow-operations/")) { const key = JSON.parse(writes[0]).idempotency_key; return jsonResponse({ status: "not_found", operation: "create", idempotency_key: key, result: null }); }
    writes.push(options!.body as string); if (writes.length === 1) throw new TypeError("response lost"); return jsonResponse(exampleWorkflow());
  }); vi.stubGlobal("fetch", fetch);
  const view = render(<WorkflowDraftEditor scope={currentScope} saveUnavailableReason={null} onSaved={onSaved} />); nameDraft(); await review();
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" })); await screen.findByRole("button", { name: "Check saved result" });
  expect(screen.getByLabelText("Workflow name")).toBeDisabled(); view.unmount();
  render(<WorkflowDraftEditor scope={currentScope} saveUnavailableReason={null} onSaved={onSaved} />);
  expect(screen.getByLabelText("Workflow name")).toHaveValue("Mobile release");
  fireEvent.click(screen.getByRole("button", { name: "Check saved result" })); expect(await screen.findByText(/No saved receipt was found yet/)).toBeVisible(); expect(writes).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" })); await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(writes).toHaveLength(2); expect(writes[1]).toBe(writes[0]);
});
it("recovers a saved receipt without issuing a second write", async () => {
  let key = ""; const onSaved = vi.fn();
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/preview")) return jsonResponse(preview); if (url.endsWith("/capability")) return jsonResponse(writeCapability);
    if (url.includes("/workflow-operations/")) return jsonResponse({ status: "saved", operation: "create", idempotency_key: key, result: exampleWorkflow() });
    key = JSON.parse(options!.body as string).idempotency_key; return jsonResponse({ detail: "Gateway timeout" }, 504);
  }); vi.stubGlobal("fetch", fetch); render(<WorkflowDraftEditor scope={scope()} saveUnavailableReason={null} onSaved={onSaved} />); nameDraft(); await review();
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" })); fireEvent.click(await screen.findByRole("button", { name: "Check saved result" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1)); expect(fetch.mock.calls.filter(([url]) => url === "/api/containers/project/workflows")).toHaveLength(1);
});
it("start submits only selected prepared task revisions and leaves human holds alone", async () => {
  const detail = exampleWorkflow({ capability: writeCapability, available_actions: [{ action: "start", enabled: true }], tasks: [exampleTask(), exampleTask({ id: "guide", title: "Write guide", human_hold_by: "kedar" })] });
  const fetch = vi.fn(async (url: string) => jsonResponse(url.includes("start-check") ? exampleImpact(detail, url) : detail)); vi.stubGlobal("fetch", fetch); const onSaved = vi.fn();
  render(<MemoryRouter><WorkflowActions detail={detail} scope={scope()} verified stale={false} onSaved={onSaved} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Review start" })); const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("checkbox", { name: /Build Android/ }); expect(within(dialog).getByRole("button", { name: "Start selected tasks" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /Build Android/ }));
  expect(within(dialog).getByRole("button", { name: "Start selected tasks" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Check selected tasks" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Start selected tasks" })).toBeEnabled());
  expect(within(dialog).getAllByText("Another task is using the workflow turn")).toHaveLength(2);
  fireEvent.click(within(dialog).getByRole("button", { name: "Start selected tasks" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const calls = fetch.mock.calls as unknown as [string, RequestInit][]; const body = JSON.parse(calls.find(([url]) => url.endsWith("/start"))![1].body as string);
  expect(body.task_ids).toEqual(["build"]); expect(body.task_revisions).toEqual({ build: 3 }); expect(body.holds).toEqual(["start"]); expect(body.expected_revision).toBe(7);
});
it("finish reads fresh blockers and never combines goal acceptance with Finish", async () => {
  const detail = exampleWorkflow({ capability: writeCapability, available_actions: [{ action: "finish", enabled: true }], completion: { can_finish: true, blockers: [] } });
  const fetch = vi.fn(async (url: string) => jsonResponse(url.endsWith("/completion-check") ? { can_finish: false, blockers: [{ code: "live_worker", message: "Build Android is still stopping", task_id: "build" }] } : detail));
  vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter><WorkflowActions detail={detail} scope={scope()} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Finish checklist" })); expect(await screen.findByText("Build Android is still stopping")).toBeVisible();
  expect(screen.getByRole("button", { name: "Finish workflow" })).toBeDisabled();
  expect((fetch.mock.calls as unknown as [string, RequestInit][]).every(([, options]) => options.method === "GET")).toBe(true);
});
it("finish says how each loop ended and which steps were not needed", async () => {
  const detail = exampleWorkflow({ capability: writeCapability, available_actions: [{ action: "finish", enabled: true }], completion: { can_finish: true, blockers: [] }, semantics_version: 2,
    tasks: [exampleTask({ status: "completed" }), exampleTask({ id: "ios", title: "Build iOS", route_state: "not_selected" })],
    repeat_groups: [{ id: "g", name: "Draft and review", member_tasks: ["build", "ios"], review_task: "build", exit_outcome: "Approved", max_rounds: 3, current_round: 2, state: "exited", stall_rule: "findings_and_artifact" }] });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse(url.endsWith("/completion-check") ? { can_finish: true, blockers: [] } : detail)));
  render(<MemoryRouter><WorkflowActions detail={detail} scope={scope()} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Finish checklist" }));
  expect(await screen.findByText("Draft and review: the loop ended after round 2 of 3.")).toBeVisible();
  expect(screen.getByText("Not needed on the path this workflow took: Build iOS. They do not count toward Finish.")).toBeVisible();
});
