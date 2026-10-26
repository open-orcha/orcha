import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exampleWorkflow, exampleTask, jsonResponse, readCapability, workflowSpec, writeCapability } from "./workflowTestFixtures";
const context = vi.hoisted(() => ({ cid: "project", identity: null as null | { agent_id: string }, identityTrusted: false, identityPending: false,
  snap: { agents: [{ id: "kedar", alias: "Kedar" }, { id: "andrew", alias: "Andrew" }] } }));
vi.mock("../../shell/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("../../state/SnapshotProvider", () => ({ useSnapshot: () => context }));
import { WorkflowsPage } from "./WorkflowsPage";
beforeEach(() => { context.cid = "project"; context.identity = null; context.identityTrusted = false; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function renderPage(path = "/workflows?cid=project") { return render(<MemoryRouter initialEntries={[path]}><WorkflowsPage /></MemoryRouter>); }
function reads(handler: (url: string) => unknown) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/openapi.json") return jsonResponse(workflowSpec);
    if (url.endsWith("/capability")) return jsonResponse(readCapability);
    return jsonResponse(handler(url));
  }); vi.stubGlobal("fetch", fetch); return fetch;
}
it("does not call missing workflow routes or treat actor selection as sign-in", async () => {
  const fetch = vi.fn(async () => jsonResponse({ paths: {} })); vi.stubGlobal("fetch", fetch);
  renderPage("/workflows/new?cid=project");
  expect(await screen.findByText(/doesn’t support Workflows yet/)).toBeVisible();
  expect(screen.getByText(/Verified sign-in is required/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save workflow" })).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects malformed discovery and only retries on request", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({})).mockResolvedValue(jsonResponse({ paths: {} })); vi.stubGlobal("fetch", fetch);
  renderPage(); expect(await screen.findByRole("alert")).toHaveTextContent("OpenAPI paths unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Refresh workflows" }));
  expect(await screen.findByText(/doesn’t support Workflows yet/)).toBeVisible(); expect(fetch).toHaveBeenCalledTimes(2);
});
it("reads exact server progress, discloses loaded search and paginates without duplicate workflows", async () => {
  reads((url) => ({ workflows: url.includes("cursor=") ? [exampleWorkflow(), exampleWorkflow({ id: "guide", title: "Publish setup guide" })] : [exampleWorkflow()], capability: readCapability, next_cursor: url.includes("cursor=") ? null : "next-page" }));
  renderPage(); expect(await screen.findByText("4 of 8 tasks accepted · 50%")).toBeVisible();
  expect(screen.getByText(/search and owner filters apply to loaded pages/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Load more workflows" }));
  expect(await screen.findByRole("link", { name: "Publish setup guide" })).toBeVisible(); expect(screen.getAllByRole("link", { name: "Mobile release" })).toHaveLength(1);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "guide" } });
  expect(screen.queryByRole("link", { name: "Mobile release" })).toBeNull(); expect(screen.getByText(/1 matching workflows shown from 2 loaded/)).toBeVisible();
});
it("keeps stale rows on an interrupted refresh but hides them after access is denied", async () => {
  let failure = 0;
  const fetch = vi.fn(async (url: string) => {
    if (url === "/openapi.json") return jsonResponse(workflowSpec);
    if (url.endsWith("/capability")) return jsonResponse(readCapability);
    if (failure === 1) throw new TypeError("network");
    if (failure === 2) return jsonResponse({ detail: "Forbidden" }, 403);
    return jsonResponse({ workflows: [exampleWorkflow()], capability: readCapability, next_cursor: null });
  }); vi.stubGlobal("fetch", fetch); renderPage(); await screen.findByRole("link", { name: "Mobile release" });
  failure = 1; fireEvent.click(screen.getByRole("button", { name: "Refresh workflows" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Orcha"); expect(screen.getByRole("link", { name: "Mobile release" })).toBeVisible();
  expect(screen.getByText(/Showing the last loaded/)).toBeVisible();
  failure = 2; fireEvent.click(screen.getByRole("button", { name: "Refresh workflows" }));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Mobile release" })).toBeNull());
});
it("renders server stop outcomes and deadline without unlocking release from the browser clock", async () => {
  reads(() => exampleWorkflow({ tasks: [exampleTask({ display_state: { label: "Stopping - accepted", release_available: false, release_available_at: "2020-01-01T00:00:00Z", warning: null } })] }));
  renderPage("/workflows/release?cid=project");
  expect(await screen.findByText(/Stopping - accepted/)).toBeVisible(); expect(screen.getByText(/Refresh to check availability/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Review start" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Dependencies" })); expect(screen.getByText(/Arrows point from a prerequisite/)).toBeVisible();
});
it("refuses a detail belonging to another project without displaying its name", async () => {
  reads(() => exampleWorkflow({ container_id: "private-project", title: "Secret workflow" }));
  renderPage("/workflows/release?cid=project");
  expect(await screen.findByRole("alert")).toHaveTextContent("different project"); expect(screen.queryByText("Secret workflow")).toBeNull();
});
it("does not trust capability alone as verified human sign-in", async () => {
  reads(() => exampleWorkflow({ capability: writeCapability, available_actions: [{ action: "start", enabled: true }] }));
  renderPage("/workflows/release?cid=project"); await screen.findByRole("heading", { name: "Mobile release" });
  expect(screen.getByRole("button", { name: "Review start" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Create workflow" })).toBeDisabled();
});
it("rejects malformed detail rather than treating missing tasks or blockers as success", async () => {
  reads(() => ({ id: "release", title: "Wrong shape" })); renderPage("/workflows/release?cid=project");
  expect(await screen.findByRole("alert")).toHaveTextContent("unreadable response"); expect(screen.queryByText("No tasks yet")).toBeNull();
});
it("restores list filters and keyboard focus after a workflow detail round trip", async () => {
  reads((url) => url.startsWith("/api/workflows/") ? exampleWorkflow() : { workflows: [exampleWorkflow()], capability: readCapability, next_cursor: null });
  renderPage("/workflows?cid=project&status=preparing&search=mobile&owner=kedar");
  fireEvent.click(await screen.findByRole("link", { name: "Mobile release" }));
  expect(await screen.findByRole("heading", { name: "Mobile release" })).toHaveFocus();
  expect(screen.getByRole("link", { name: "All workflows" })).toHaveAttribute("href", "/workflows?cid=project&status=preparing&search=mobile&owner=kedar");
  fireEvent.click(screen.getByRole("link", { name: "All workflows" }));
  const row = await screen.findByRole("link", { name: "Mobile release" });
  expect(screen.getByLabelText("Status")).toHaveValue("preparing");
  expect(screen.getByRole("searchbox")).toHaveValue("mobile");
  expect(screen.getByLabelText("Owner")).toHaveValue("kedar");
  expect(row).toHaveFocus();
});
