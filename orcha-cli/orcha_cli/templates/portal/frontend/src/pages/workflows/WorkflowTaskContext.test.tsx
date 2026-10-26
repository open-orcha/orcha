import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkflowTaskInspector, WorkflowTaskProvider, useTaskWorkflow } from "./WorkflowTaskContext";
import { exampleWorkflow, jsonResponse, workflowSpec, writeCapability } from "./workflowTestFixtures";

let identity = "kedar";
vi.mock("../../state/SnapshotProvider", () => ({ useSnapshot: () => ({ cid: "project", identity: { agent_id: identity }, identityTrusted: true, identityPending: false }) }));
beforeEach(() => { identity = "kedar"; });
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
