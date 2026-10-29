import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exampleWorkflow, exampleTask, jsonResponse, readCapability, workflowSpec, writeCapability } from "./workflowTestFixtures";
const context = vi.hoisted(() => ({ cid: "project", identity: null as null | { agent_id: string }, identityTrusted: false, identityPending: false,
  snap: { agents: [{ id: "kedar", alias: "Kedar" }, { id: "andrew", alias: "Andrew" }] } }));
const authority = vi.hoisted(() => ({ human: null as null | { id: string; kind: string; member_role: string }, reason: null, readOnly: false, pending: false }));
vi.mock("../../shell/Shell", () => ({ Shell: ({ children, primaryAction, toolbar }: { children: React.ReactNode; primaryAction?: React.ReactNode; toolbar?: React.ReactNode }) => <main>{toolbar}{primaryAction}{children}</main> }));
vi.mock("../../state/SnapshotProvider", async (original) => ({ ...await original<typeof import("../../state/SnapshotProvider")>(), useSnapshot: () => context, useActingAuthority: () => authority }));
import { WorkflowsPage } from "./WorkflowsPage";
beforeEach(() => { context.cid = "project"; context.identity = null; context.identityTrusted = false; context.identityPending = false; authority.human = null; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function renderPage(path = "/workflows?cid=project") { return render(<MemoryRouter initialEntries={[path]}><WorkflowsPage /></MemoryRouter>); }
function reads(handler: (url: string) => unknown) {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === "/openapi.json") return jsonResponse(workflowSpec);
    if (url.endsWith("/capability")) return jsonResponse(readCapability);
    return jsonResponse(handler(url));
  }); vi.stubGlobal("fetch", fetch); return fetch;
}
it("does not call missing workflow routes without a current human", async () => {
  const fetch = vi.fn(async () => jsonResponse({ paths: {} })); vi.stubGlobal("fetch", fetch);
  renderPage("/workflows/new?cid=project");
  expect(await screen.findByText(/doesn’t support Workflows yet/)).toBeVisible();
  expect(screen.getByText(/Choose a current human member/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save workflow" })).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("lets the selected local human prepare a workflow and identifies them to the local API", async () => {
  authority.human = { id: "kedar", kind: "human", member_role: "owner" };
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === "/openapi.json") return jsonResponse(workflowSpec);
    return jsonResponse(writeCapability);
  });
  vi.stubGlobal("fetch", fetch);
  renderPage("/workflows/new?cid=project");
  expect(await screen.findByLabelText("Workflow name")).toBeVisible();
  const capabilityCall = fetch.mock.calls.find(([url]) => String(url).endsWith("/capability"));
  expect(capabilityCall?.[1]).toMatchObject({ headers: { "X-Orcha-Local-Actor": "kedar" } });
  expect(screen.queryByText(/verified sign-in is required/i)).toBeNull();
});
it("rejects malformed discovery and only retries on request", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({})).mockResolvedValue(jsonResponse({ paths: {} })); vi.stubGlobal("fetch", fetch);
  renderPage(); expect(await screen.findByRole("alert")).toHaveTextContent("OpenAPI paths unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Refresh workflows" }));
  expect(await screen.findByText(/doesn’t support Workflows yet/)).toBeVisible(); expect(fetch).toHaveBeenCalledTimes(2);
});
it("reads exact server progress, discloses loaded search and paginates without duplicate workflows", async () => {
  reads((url) => ({ workflows: url.includes("cursor=") ? [exampleWorkflow(), exampleWorkflow({ id: "guide", title: "Publish setup guide" })] : [exampleWorkflow()], capability: readCapability, next_cursor: url.includes("cursor=") ? null : "next-page" }));
  renderPage(); expect(await screen.findByRole("img", { name: "4 of 8 tasks accepted · 50%" })).toBeInTheDocument();
  expect(screen.getByLabelText(/search and owner filters apply to loaded pages/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Load more workflows" }));
  expect(await screen.findByRole("option", { name: /Publish setup guide/ })).toBeVisible(); expect(screen.getAllByRole("option", { name: /Mobile release/ })).toHaveLength(1);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "guide" } });
  expect(screen.queryByRole("option", { name: /Mobile release/ })).toBeNull(); expect(screen.getByLabelText(/1 of 2 loaded workflows shown/)).toBeVisible();
});
it("keeps stale rows on an interrupted refresh but hides them after access is denied", async () => {
  let failure = 0;
  const fetch = vi.fn(async (url: string) => {
    if (url === "/openapi.json") return jsonResponse(workflowSpec);
    if (url.endsWith("/capability")) return jsonResponse(readCapability);
    if (failure === 1) throw new TypeError("network");
    if (failure === 2) return jsonResponse({ detail: "Forbidden" }, 403);
    return jsonResponse({ workflows: [exampleWorkflow()], capability: readCapability, next_cursor: null });
  }); vi.stubGlobal("fetch", fetch); renderPage(); await screen.findByRole("option", { name: /Mobile release/ });
  failure = 1; fireEvent.click(screen.getByRole("button", { name: "Refresh workflows" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Orcha"); expect(screen.getByRole("option", { name: /Mobile release/ })).toBeVisible();
  expect(screen.getByText(/Showing the last loaded/)).toBeVisible();
  failure = 2; fireEvent.click(screen.getByRole("button", { name: "Refresh workflows" }));
  await waitFor(() => expect(screen.queryByRole("option", { name: /Mobile release/ })).toBeNull());
});
it("renders server stop outcomes and deadline without unlocking release from the browser clock", async () => {
  reads(() => exampleWorkflow({ tasks: [exampleTask({ display_state: { label: "Stopping - accepted", release_available: false, release_available_at: "2020-01-01T00:00:00Z", warning: null } })] }));
  renderPage("/workflows/release?cid=project");
  const row = await screen.findByRole("option", { name: /Build Android/ });
  expect(row).toHaveTextContent(/Release lost worker becomes available at/);
  fireEvent.click(row);
  expect(await screen.findByText(/Refresh to check availability/)).toBeVisible();
  expect(screen.getAllByText(/Stopping - accepted/).length).toBeGreaterThan(0);
  // Start is not offered: the primary falls back to the checklist and the menu item carries the server reason.
  expect(screen.getByRole("button", { name: "Finish checklist" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
  expect(screen.getByRole("menuitem", { name: "Review start" })).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.click(screen.getByRole("tab", { name: /Dependencies/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Graph and list" }));
  expect(screen.getByText(/Arrows point from a prerequisite/)).toBeVisible();
});
it("refuses a detail belonging to another project without displaying its name", async () => {
  reads(() => exampleWorkflow({ container_id: "private-project", title: "Secret workflow" }));
  renderPage("/workflows/release?cid=project");
  expect(await screen.findByRole("alert")).toHaveTextContent("different project"); expect(screen.queryByText("Secret workflow")).toBeNull();
});
it("does not trust capability alone as verified human sign-in", async () => {
  reads(() => exampleWorkflow({ capability: writeCapability, available_actions: [{ action: "start", enabled: true }] }));
  renderPage("/workflows/release?cid=project"); await screen.findByRole("heading", { name: "Mobile release" });
  // The server says start is enabled, but no verified human is acting: the primary is the checklist and Review start stays disabled.
  expect(screen.queryByRole("button", { name: "Review start" })).toBeNull();
  expect(screen.getByRole("button", { name: "Finish checklist" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
  expect(screen.getByRole("menuitem", { name: "Review start" })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("menuitem", { name: "Add new tasks…" })).toHaveAttribute("aria-disabled", "true");
});
it("rejects malformed detail rather than treating missing tasks or blockers as success", async () => {
  reads(() => ({ id: "release", title: "Wrong shape" })); renderPage("/workflows/release?cid=project");
  expect(await screen.findByRole("alert")).toHaveTextContent("unreadable response"); expect(screen.queryByText("No tasks yet")).toBeNull();
});
it("restores list filters and keyboard focus after a workflow detail round trip", async () => {
  reads((url) => url.startsWith("/api/workflows/") ? exampleWorkflow() : { workflows: [exampleWorkflow()], capability: readCapability, next_cursor: null });
  renderPage("/workflows?cid=project&status=preparing&search=mobile&owner=kedar");
  fireEvent.click(await screen.findByRole("option", { name: /Mobile release/ }));
  expect(await screen.findByRole("heading", { name: "Mobile release" })).toHaveFocus();
  expect(screen.getByRole("link", { name: "All workflows" })).toHaveAttribute("href", "/workflows?cid=project&status=preparing&search=mobile&owner=kedar");
  fireEvent.click(screen.getByRole("link", { name: "All workflows" }));
  const row = await screen.findByRole("option", { name: /Mobile release/ });
  expect(screen.getByRole("radio", { name: /Preparing/ })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("searchbox")).toHaveValue("mobile");
  expect(row).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Owner filter" }));
  expect(screen.getByRole("radio", { name: "Kedar" })).toBeChecked();
});
it("focuses the requested task after the workflow read finishes", async () => {
  reads(() => exampleWorkflow());
  renderPage("/workflows/release?cid=project#workflow-task-build");
  await screen.findByRole("option", { name: /Build Android/ });
  expect(document.getElementById("workflow-task-build")).toHaveFocus();
  // The named task also opens in the inspector.
  expect(await screen.findByRole("region", { name: "Task: Build Android" })).toBeVisible();
});

it("does not carry a row action to a different selected task", async () => {
  authority.human = { id: "kedar", kind: "human", member_role: "owner" };
  const task = exampleTask({ available_actions: [{ action: "prepare", enabled: true }] });
  reads(() => exampleWorkflow({ capability: writeCapability, tasks: [task, { ...task, id: "other", title: "Write release notes" }] }));
  renderPage("/workflows/release?cid=project");
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Build Android" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Prepare task" }));
  await screen.findByLabelText("Done when");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("option", { name: /Write release notes/ }));
  expect(screen.getByRole("region", { name: "Task: Write release notes" })).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("lists a loop's steps together in one bracket even when the server lists another step between them", async () => {
  const group = { id: "g1", name: "Draft and review", member_tasks: ["write", "review"], review_task: "review", exit_outcome: "Passed", max_rounds: 5, escalation_owner_id: "kedar", stall_rule: "findings_and_artifact", current_round: 2, state: "open" };
  const write = exampleTask({ id: "write", title: "Write the launch post", repeat_group_id: "g1", round: 2 });
  const publish = exampleTask({ id: "publish", title: "Publish approval", depends_on: ["review"] });
  const review = exampleTask({ id: "review", title: "Review the post", repeat_group_id: "g1", round: 2, depends_on: ["write"] });
  reads(() => exampleWorkflow({ semantics_version: 2, repeat_groups: [group], tasks: [write, publish, review] }));
  renderPage("/workflows/release?cid=project");
  const loop = await screen.findByRole("group", { name: "Draft and review, round 2 of 5" });
  expect(screen.getAllByRole("group", { name: /Draft and review/ })).toHaveLength(1);
  expect(within(loop).getAllByRole("option").map((o) => o.getAttribute("title"))).toEqual(["Write the launch post", "Review the post"]);
  expect(screen.getAllByRole("option").map((o) => o.getAttribute("title"))).toEqual(["Write the launch post", "Review the post", "Publish approval"]);
});

it("Run again creates a distinct draft, navigates to it, and leaves Start explicit", async () => {
  authority.human = { id: "kedar", kind: "human", member_role: "owner" };
  const source = exampleWorkflow({ status: "completed", hidden: true, launch_enabled: true, capability: writeCapability,
    available_actions: [{ action: "run_again", enabled: true, permission: "workflow_or_project_owner" }] });
  const draft = exampleWorkflow({ id: "new-draft", title: "Mobile release (run again)", launch_enabled: false,
    capability: writeCapability, copy_notes: ["Choose an available assignee for Build Android."],
    available_actions: [{ action: "start", enabled: true }, { action: "patch", enabled: true }] });
  const writes: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/openapi.json") return jsonResponse(workflowSpec);
    if (url.endsWith("/capability")) return jsonResponse(writeCapability);
    if (init?.method === "POST") { writes.push(url); return jsonResponse(draft); }
    return jsonResponse(url.includes("new-draft") ? draft : source);
  });
  vi.stubGlobal("fetch", fetch);
  renderPage("/workflows/release?cid=project");
  await screen.findByRole("heading", { name: "Mobile release", level: 1 });
  fireEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Run again…" }));
  expect(writes).toEqual([]);
  expect(screen.getByText(/can change its setup before choosing Start/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Create editable draft" }));
  await screen.findByRole("heading", { name: "Mobile release (run again)", level: 1 });
  expect(fetch.mock.calls.some(([url]) => String(url) === "/api/workflows/new-draft")).toBe(true);
  expect(writes).toEqual(["/api/workflows/release/run_again"]);
  expect(screen.getByRole("button", { name: "Review start" })).toBeEnabled();
  expect(screen.getByText(/Nothing runs until you choose Start/)).toBeVisible();
  expect(screen.getByRole("list", { name: "Copied draft notes" })).toHaveTextContent("Choose an available assignee");
  fireEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
  expect(screen.getByRole("menuitem", { name: "Workflow settings…" })).not.toHaveAttribute("aria-disabled", "true");
});

it.each(["cancelled", "paused"] as const)("does not show draft Start guidance or copy notes for a %s workflow that never started", async (status) => {
  reads(() => exampleWorkflow({ status, launch_enabled: false,
    copy_notes: ["Choose an available assignee for Build Android."] }));
  renderPage("/workflows/release?cid=project");
  await screen.findByRole("heading", { name: "Mobile release", level: 1 });
  expect(screen.queryByText(/Nothing runs until you choose Start/)).toBeNull();
  expect(screen.queryByRole("list", { name: "Copied draft notes" })).toBeNull();
});

it("Run again follows the server action even for a completed workflow", async () => {
  authority.human = { id: "kedar", kind: "human", member_role: "owner" };
  reads(() => exampleWorkflow({ status: "completed", available_actions: [{ action: "run_again", enabled: false, reason: "workflow_owner_required" }] }));
  renderPage("/workflows/release?cid=project");
  await screen.findByRole("heading", { name: "Mobile release", level: 1 });
  fireEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
  expect(screen.getByRole("menuitem", { name: "Run again…" })).toHaveAttribute("aria-disabled", "true");
});
