import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowTaskEntry } from "./WorkflowTaskEntry";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import { exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
import { emptyDraft, keepDraft, newDraftTask } from "./workflowDraft";
vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ cid: "project", identity: { agent_id: "kedar" }, identityTrusted: true, identityPending: false }),
  useActingAuthority: () => ({ human: { id: "kedar", kind: "human", member_role: "owner" }, reason: null, readOnly: false, pending: false }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("finds existing workflow membership on later pages and never offers a second import", async () => {
  const fetch = vi.fn(async (url: string) => jsonResponse({ capability: writeCapability, workflows: url.includes("cursor=") ? [exampleWorkflow()] : [], next_cursor: url.includes("cursor=") ? null : "next" }));
  vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter><WorkflowTaskEntry taskId="build" /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Workflow membership" }));
  fireEvent.click(await screen.findByRole("button", { name: "Check more workflows" }));
  expect(await screen.findByRole("link", { name: "Mobile release" })).toHaveAttribute("href", "/workflows/release?cid=project");
  expect(screen.queryByRole("link", { name: "Create workflow with this task" })).toBeNull();
  expect(fetch.mock.calls).toHaveLength(2);
});
it("offers only draft navigation after checking membership, with no mutation", async () => {
  const fetch = vi.fn(async () => jsonResponse({ capability: writeCapability, workflows: [exampleWorkflow({ tasks: [], capability: writeCapability, available_actions: [{ action: "import", enabled: true }] })], next_cursor: null }));
  vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter><WorkflowTaskEntry taskId="build" /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Workflow membership" }));
  expect(await screen.findByRole("link", { name: "Add to Mobile release" })).toHaveAttribute("href", "/workflows/release?cid=project&addTask=build");
  expect(screen.getByRole("link", { name: "Create workflow with this task" })).toHaveAttribute("href", "/workflows/new?cid=project&addTask=build");
  expect((fetch.mock.calls as unknown as [string, RequestInit][]).every(([, init]) => init.method === "GET")).toBe(true);
});
it("seeds an existing task without overwriting a retained creation draft or saving it", async () => {
  const scope = { origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() };
  keepDraft(scope, { ...emptyDraft(), name: "Retained plan", goal: "Retained goal", tasks: [{ ...newDraftTask(), title: "Already planned" }] });
  const fetch = vi.fn(async (_url: string) => jsonResponse({ results: [], selected: [{ id: "build", title: "Build Android", status: "ready", is_root: false, workflow_id: null }] })); vi.stubGlobal("fetch", fetch);
  render(<WorkflowDraftEditor scope={scope} saveUnavailableReason={null} initialTaskId="build" />);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Build Android.*Will stay held/ })).toBeChecked());
  expect(screen.getByLabelText("Workflow name")).toHaveValue("Retained plan"); expect(screen.getByLabelText("Task summary")).toHaveValue("Already planned");
  expect(String(fetch.mock.calls[0][0])).toContain("workflow-task-search");
});
