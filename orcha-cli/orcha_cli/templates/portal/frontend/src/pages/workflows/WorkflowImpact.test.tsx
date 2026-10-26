import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowActions } from "./WorkflowActions";
import { WorkflowTaskActions } from "./WorkflowTaskActions";
import { exampleImpact, exampleTask, exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("does not let an older detail-only response authorize Start or cancellation", async () => {
  const detail = exampleWorkflow({ capability: writeCapability, available_actions: [{ action: "start", enabled: true }, { action: "cancel", enabled: true }] });
  const fetch = vi.fn(async () => jsonResponse(detail)); vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter><WorkflowActions detail={detail} scope={scope()} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Review start" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Start selected tasks" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Keep preparing" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel workflow" }));
  await screen.findByRole("alert");
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel workflow" })).toBeDisabled();
  expect(fetch.mock.calls).toHaveLength(2);
});

it.each(["refused", "revision", "wrong_workflow", "missing_task"])("refuses a %s preview without dropping the selected task", async (failure) => {
  const detail = exampleWorkflow({ capability: writeCapability, available_actions: [{ action: "start", enabled: true }] });
  const fetch = vi.fn(async (url: string) => {
    const result = exampleImpact(detail, url);
    if (failure === "refused") result.impact.tasks![0] = { ...result.impact.tasks![0], resulting_status: "refused", refusal: { code: "reservation_live", message: "Build Android has a turn still stopping" } };
    if (failure === "revision") result.impact.task_revisions.build = 2;
    if (failure === "wrong_workflow") result.id = "elsewhere";
    if (failure === "missing_task") result.impact.tasks = [];
    return jsonResponse(result);
  }); vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter><WorkflowActions detail={detail} scope={scope()} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Review start" }));
  if (failure === "refused") {
    fireEvent.click(await screen.findByRole("checkbox", { name: /Build Android/ }));
    expect(screen.getByText("Build Android has a turn still stopping")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Build Android/ })).toBeChecked();
  } else await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Start selected tasks" })).toBeDisabled();
  expect(fetch.mock.calls).toHaveLength(1);
});

it("renders cancellation counts, retained results and named workers before one guarded save", async () => {
  const detail = exampleWorkflow({ capability: writeCapability, available_actions: [{ action: "cancel", enabled: true }],
    tasks: [exampleTask(), exampleTask({ id: "review", title: "Review both builds", status: "completed" })] });
  const writes: Record<string, unknown>[] = []; const saved = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return jsonResponse(detail); }
    return jsonResponse(exampleImpact(detail, url, { tasks: [], counts_by_state: { in_progress: 1, completed: 1 }, accepted_retained: ["review"], workers_to_stop: [{ task_id: "build", agent_id: "andrew", name: "Andrew" }] }));
  }));
  render(<MemoryRouter><WorkflowActions detail={detail} scope={scope()} verified stale={false} onSaved={saved} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Cancel workflow" }));
  expect(await screen.findByText("Andrew — Build Android")).toBeVisible();
  expect(screen.getByText("in progress: 1")).toBeVisible();
  expect(screen.getByText("completed: 1")).toBeVisible();
  expect(screen.getByText("Review both builds")).toBeVisible();
  expect(screen.getByText(/cancellation does not confirm shutdown/)).toBeVisible();
  const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel workflow" });
  expect(confirm).toBeDisabled(); expect(writes).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Reason for cancelling"), { target: { value: "The release is no longer needed" } });
  fireEvent.click(confirm); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ expected_revision: 7, reason: "The release is no longer needed" });
});

it("checks each hold selection, preserves the reason after a conflict and does not replay", async () => {
  const task = exampleTask({ human_hold_by: "kedar", available_actions: [{ action: "release", enabled: true, holds: ["start", "human"] }] });
  const detail = exampleWorkflow({ capability: writeCapability, launch_enabled: true, tasks: [task] });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST"
    ? jsonResponse({ detail: { code: "revision_conflict", message: "A hold changed. Check again." } }, 409)
    : jsonResponse(exampleImpact(detail, url)));
  vi.stubGlobal("fetch", fetch);
  render(<WorkflowTaskActions detail={detail} task={task} scope={scope()} verified stale={false} agents={[]} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Build Android" })); fireEvent.click(screen.getByRole("button", { name: "Release holds" }));
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Ready for review" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Release start hold" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Release human hold/ }));
  const confirm = () => screen.getAllByRole("button", { name: "Release holds" }).at(-1)!;
  expect(confirm()).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Check selected holds" }));
  await waitFor(() => expect(confirm()).toBeEnabled());
  const query = new URL(fetch.mock.calls.at(-1)![0], "https://orcha.example");
  expect(query.searchParams.getAll("task_ids")).toEqual(["build"]);
  expect(query.searchParams.getAll("holds")).toEqual(["start", "human"]);
  fireEvent.click(confirm()); await screen.findByText(/A hold changed/);
  expect(confirm()).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh task review" }));
  expect(await screen.findByLabelText("Reason")).toHaveValue("Ready for review");
  expect(screen.getByRole("checkbox", { name: "Release start hold" })).toBeChecked();
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
