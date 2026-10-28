import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mapSnapshot } from "../../api/client";
import { ToastProvider } from "../../components/ui";
import { WorkflowInput } from "./WorkflowInput";
import { WorkflowDiscussion } from "./WorkflowDiscussion";
import { exampleTask, exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
import type { Snapshot } from "../../types";

const state = vi.hoisted(() => ({ snap: null as Snapshot | null, identity: "kedar", refresh: vi.fn() }));
vi.mock("../../state/SnapshotProvider", async (original) => ({ ...await original<typeof import("../../state/SnapshotProvider")>(),
  useSnapshot: () => ({ snap: state.snap, cid: "project", refresh: state.refresh }),
  useActingAuthority: () => ({ human: state.snap?.agents.find((a) => a.id === state.identity), readOnly: false, pending: false }),
}));
const agents = [{ id: "kedar", alias: "Kedar", kind: "human", member_role: "owner" }, { id: "maya", alias: "Maya", kind: "human", member_role: "member" }, { id: "builder", alias: "Builder", kind: "ai" }];
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: state.identity });
const spec = { paths: { "/api/containers/{cid}/requests": { get: { parameters: [{ name: "workflow" }] } } } };
beforeEach(() => { state.identity = "kedar"; state.snap = mapSnapshot({ container: { id: "project" }, agents, tasks: [{ id: "build", title: "Build", status: "ready", assignees: ["Builder"] }] }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function view() { return render(<MemoryRouter><ToastProvider><WorkflowInput detail={exampleWorkflow({ capability: writeCapability })} scope={scope()} stale={false} open onOpen={vi.fn()} onClose={vi.fn()} onChecklist={vi.fn()} onSaved={vi.fn()} /></ToastProvider></MemoryRouter>); }

it("does not claim zero questions or call a workflow filter on an unsupported server", async () => {
  const fetch = vi.fn(async () => jsonResponse({ paths: {} })); vi.stubGlobal("fetch", fetch); view();
  expect(screen.getByText("Checking decisions…")).toBeVisible();
  expect(await screen.findByText("Workflow questions are not available on this server.")).toBeVisible();
  expect(screen.getByText("At least 0 decisions")).toBeVisible(); expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects incorrectly scoped requests instead of assigning them to this workflow", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse(url === "/openapi.json" ? spec : { requests: [{ id: "other", originating_task_id: "unrelated", origin_task: { workflow_id: "elsewhere" }, payload: "Private question" }], total: 1, has_more: false })));
  view(); expect(await screen.findByRole("alert")).toHaveTextContent("Some questions could not be checked"); expect(screen.queryByText("Private question")).toBeNull();
});

it("preserves partial counts and shows another person's question without granting answer permission", async () => {
  const request = { id: "q1", type: "info", status: "open", requester_id: "builder", target_id: "maya", payload: "Which release is ready?", agent_payload: "HIDDEN INTERNAL INSTRUCTIONS", originating_task_id: "build", origin_task: { workflow_id: "release", task_id: "build" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse(url === "/openapi.json" ? spec : { requests: [request], total: 40, has_more: true })));
  view(); await screen.findByRole("button", { name: "Load more questions" });
  expect(screen.getByText("At least 0 decisions")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Assigned to someone else" }));
  fireEvent.click(screen.getByRole("option", { name: /Which release is ready/ }));
  expect(screen.queryByText("HIDDEN INTERNAL INSTRUCTIONS")).toBeNull();
  expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
});

it("rechecks the full plan and refuses an approval when the plan changes", async () => {
  const task = { id: "build", title: "Build", status: "in_progress", autonomy: "off", autonomy_revision: 1, work_revision: 3, assignees: ["Builder"], definition_of_done: "Tests pass", plan_message: { body: "Plan: build and test", author_alias: "Builder", at: "2026-10-27T10:00:00Z" } };
  state.snap = mapSnapshot({ container: { id: "project" }, agents, tasks: [task] });
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") writes.push(url);
    if (url === "/openapi.json") return jsonResponse(spec);
    if (url.includes("/requests?")) return jsonResponse({ requests: [], total: 0, has_more: false });
    return jsonResponse({ container: { id: "project" }, agents, tasks: [{ ...task, plan_message: { ...task.plan_message, body: "Plan: changed requirements" } }] });
  }));
  view(); fireEvent.click(await screen.findByRole("option", { name: /Build Plan approval/ }));
  expect(screen.getByText("Plan: build and test")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("plan or task changed"); expect(writes).toEqual([]);
});

it("counts finished work even when autonomy is ON", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ paths: {} })));
  render(<MemoryRouter><ToastProvider><WorkflowInput detail={exampleWorkflow({ capability: writeCapability, tasks: [exampleTask({ autonomy: "on", status: "needs_verification", available_actions: [{ action: "accept", enabled: true }] })] })} scope={scope()} stale={false} open onOpen={vi.fn()} onClose={vi.fn()} onChecklist={vi.fn()} onSaved={vi.fn()} /></ToastProvider></MemoryRouter>);
  await screen.findByText("At least 1 decision"); expect(screen.getByRole("option", { name: /Build Android Finished work/ })).toBeVisible();
});

it("does not resend an uncertain discussion post and checks saved delivery", async () => {
  state.identity = "maya"; const writes: unknown[] = []; let delivered = false;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); delivered = true; throw new TypeError("Lost response"); }
    return jsonResponse({ task_id: "build", messages: delivered ? [{ message_id: "m1", author_id: "maya", author_alias: "Maya", body: "Please check the build", created_at: new Date().toISOString(), is_human: true }] : [], has_more: false });
  }));
  render(<WorkflowDiscussion taskId="build" scope={scope()} />);
  await screen.findByText("No messages yet.");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Please check the build" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("alert"); expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Check delivery" }));
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
  expect(writes).toEqual([{ author_agent_id: "maya", body: "Please check the build" }]);
});
