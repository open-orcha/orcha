import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { SavedEvidence, WorkerDetailsNotice, WorkflowDependencies, WorkflowProgress, type WorkflowTaskView } from "./WorkflowReadViews";

afterEach(cleanup);
it("uses exact totals, never a partial page or a rounded-up percentage", () => {
  const view = render(<WorkflowProgress accepted={3} total={8} />);
  expect(screen.getByText("3 of 8 tasks accepted · 37%")).toBeVisible();
  view.rerender(<WorkflowProgress accepted={0} total={0} />);
  expect(screen.getByText("No tasks yet")).toBeVisible();
  expect(screen.queryByRole("progressbar")).toBeNull();
  view.rerender(<WorkflowProgress accepted={null} total={8} />);
  expect(screen.getByText("Task progress unavailable")).toBeVisible();
});

it("keeps immutable saved evidence distinct from absent worker diagnostics", () => {
  render(<><SavedEvidence evidence={{ state: "saved", workRevisionLabel: "Work revision 2", sourceLabel: "Owner result", items: [
    { name: "Result summary", version: 2, readable: true, href: "/api/tasks/task/deliverables/file/versions/2/raw" },
    { name: "File changes", version: 1, readable: false, href: "/api/tasks/task/deliverables/missing/versions/1/raw" },
    { name: "Wrong version", version: 9, readable: true, href: "/api/tasks/task/deliverables/file/versions/2/raw" },
    { name: "Log excerpt", version: 1, readable: true, href: "javascript:alert(1)" },
  ] }} /><WorkerDetailsNotice state="unavailable" /></>);
  expect(screen.getByRole("link", { name: "Result summary — version 2" })).toHaveAttribute("href", "/api/tasks/task/deliverables/file/versions/2/raw");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByText("File changes — version 1: unavailable")).toBeVisible();
  expect(screen.getByText("Worker details are unavailable.")).toBeVisible();
  expect(screen.queryByText(/No files changed|Older worker details/)).toBeNull();
});

it("keeps a pending evidence set unavailable for acceptance", () => {
  render(<SavedEvidence evidence={{ state: "pending", workRevisionLabel: "Work revision 3", sourceLabel: "Worker result", items: [] }} />);
  expect(screen.getByRole("heading", { name: "Saving evidence…" })).toBeVisible();
  expect(screen.getByText("Evidence is still being saved. Acceptance is unavailable.")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
});

it("preserves authoritative stop labels, external relationships and warnings in graph and list", () => {
  const task: WorkflowTaskView = {
    id: "build", title: "Build Android", assignee: "Andrew", displayLabel: "Stopping — accepted", reasons: ["Waiting for worker stop confirmation"],
    prerequisites: [{ id: "design", title: "Design release" }], dependents: [{ id: "review", title: "Review release" }],
    unconfirmedStopWarning: true, releaseAvailableAt: "2026-10-25T12:00:00Z", autonomy: true,
  };
  render(<MemoryRouter><WorkflowDependencies cid="mobile" tasks={[task]} total={8} /></MemoryRouter>);
  expect(screen.getByText("1 of 8 tasks shown")).toBeVisible();
  expect(screen.getByRole("link", { name: "Design release" })).toHaveAttribute("href", "/tasks?task=design&cid=mobile");
  fireEvent.click(screen.getByRole("button", { name: "Graph and list" }));
  expect(screen.getByText(/1 task in the graph of 8/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Review release" })).toBeVisible();
  expect(screen.getByText(/Released without stop confirmation:/)).toBeVisible();
  expect(screen.getByRole("button", { name: /Select Build Android:.*Released without stop confirmation/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Release lost worker" })).toBeNull(); // elapsed local time cannot enable recovery
  expect(screen.getByText("Stopping — accepted · Andrew")).toBeVisible();
});

it("lets keyboard users inspect graph nodes and preserves complete relationships in its list", () => {
  const tasks: WorkflowTaskView[] = [
    { id: "design", title: "Design", assignee: "Dana", displayLabel: "Accepted", reasons: [], prerequisites: [], dependents: [{ id: "build", title: "Build" }], unconfirmedStopWarning: false, releaseAvailableAt: null, autonomy: false },
    { id: "build", title: "Build", assignee: "Andrew", displayLabel: "Waiting for its turn", reasons: ["Another task has the turn"], prerequisites: [{ id: "design", title: "Design" }], dependents: [], unconfirmedStopWarning: false, releaseAvailableAt: null, autonomy: false },
  ];
  render(<MemoryRouter><WorkflowDependencies cid="project" tasks={tasks} total={2} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Graph and list" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Select Build: Waiting for its turn" }), { key: "Enter" });
  expect(screen.getByRole("link", { name: "Open selected task" })).toHaveAttribute("href", "/tasks?task=build&cid=project");
  expect(screen.getByText(/Showing the selected task and its direct prerequisites/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Fit graph" })); fireEvent.click(screen.getByRole("button", { name: "Reset selection" }));
  expect(screen.queryByRole("link", { name: "Open selected task" })).toBeNull();
  expect(screen.getByText("2 of 2 tasks shown")).toBeVisible();
});
