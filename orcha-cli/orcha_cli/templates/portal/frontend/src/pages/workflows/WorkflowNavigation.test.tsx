import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowTaskLink, WorkflowTaskReturn, workflowReturnTarget } from "./WorkflowTaskReturn";
import { exampleWorkflow, jsonResponse } from "./workflowTestFixtures";
import { workflowListReturnTarget } from "./workflowNavigation";
vi.mock("../../state/SnapshotProvider", () => ({ useSnapshot: () => ({ cid: "project", identity: { agent_id: "kedar" } }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps the canonical task URL and carries the workflow tab as return context", () => {
  render(<MemoryRouter initialEntries={["/workflows/release?cid=project&tab=dependencies"]}><WorkflowTaskLink cid="project" taskId="build">Build Android</WorkflowTaskLink></MemoryRouter>);
  const href = new URL(screen.getByRole("link").getAttribute("href")!, "https://orcha.example");
  expect(href.pathname).toBe("/tasks"); expect(href.searchParams.get("task")).toBe("build");
  expect(href.searchParams.get("workflowReturn")).toBe("/workflows/release?cid=project&tab=dependencies");
});
it.each(["https://outside.example/workflows/release?cid=project", "//outside.example/workflows/release?cid=project", "/workflows/release?cid=another-project", "/workflows/new?cid=project", "/workflows/release/../../settings?cid=project"])("refuses unsafe or cross-project return context: %s", (hint) => {
  expect(workflowReturnTarget(hint, "project")).toBeNull();
});
it("verifies task membership before showing the workflow return link", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(exampleWorkflow())));
  const query = new URLSearchParams({ cid: "project", task: "build", workflowReturn: "/workflows/release?cid=project&tab=dependencies" });
  render(<MemoryRouter initialEntries={[`/tasks?${query}`]}><WorkflowTaskReturn taskId="build" /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "Back to Mobile release" })).toHaveAttribute("href", "/workflows/release?cid=project&tab=dependencies");
});
it("does not claim membership from a return hint when the task is absent", async () => {
  const fetch = vi.fn(async () => jsonResponse(exampleWorkflow({ tasks: [] }))); vi.stubGlobal("fetch", fetch);
  const query = new URLSearchParams({ workflowReturn: "/workflows/release?cid=project" });
  render(<MemoryRouter initialEntries={[`/tasks?${query}`]}><WorkflowTaskReturn taskId="build" /></MemoryRouter>);
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); expect(screen.queryByRole("link")).toBeNull();
});
it.each(["https://outside.example/workflows?cid=project", "//outside.example/workflows?cid=project", "/workflows?cid=another", "/workflows/release?cid=project", "/workflows?cid=project\\outside"])("rejects unsafe workflow list return hints: %s", (hint) => {
  expect(workflowListReturnTarget(hint, "project")).toBeNull();
});
