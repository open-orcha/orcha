import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowObjectiveEditor } from "./WorkflowObjectiveEditor";
import { WorkflowMove } from "./WorkflowMove";
import { WorkflowSettings } from "./WorkflowSettings";
import { exampleTask, exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("uses the objective's own permission and invalidates confirmation when the criteria change", async () => {
  const detail = exampleWorkflow({ capability: writeCapability, available_actions: [], objectives: [{ id: "quality", title: "Quality", criteria: "Old checks", revision: 1, accepted_revision: 1,
    available_actions: [{ action: "edit_objective", enabled: true }] }] });
  const writes: [string, RequestInit][] = []; const saved = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { if (init.method === "PATCH") writes.push([url, init]); return jsonResponse(detail); }));
  render(<WorkflowObjectiveEditor detail={detail} objectiveId="quality" scope={scope()} verified stale={false} onSaved={saved} />);
  fireEvent.click(screen.getByText("Edit objective: Quality"));
  fireEvent.change(screen.getByLabelText("Reason for changing objective"), { target: { value: "Include recovery" } });
  fireEvent.click(screen.getByRole("button", { name: "Review objective change" })); await screen.findByRole("button", { name: "Confirm objective change" });
  fireEvent.change(screen.getByLabelText("Objective done when"), { target: { value: "Pairing and recovery pass" } });
  expect(screen.queryByRole("button", { name: "Confirm objective change" })).toBeNull(); expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Review objective change" })); fireEvent.click(await screen.findByRole("button", { name: "Confirm objective change" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes[0][0]).toBe("/api/workflows/release/objectives/quality");
  expect(JSON.parse(String(writes[0][1].body))).toMatchObject({ expected_revision: 7, criteria: "Pairing and recovery pass", reason: "Include recovery" });
});

it("requires the complete dependency group and both current workflow revisions before a move", async () => {
  const tasks = [exampleTask({ available_actions: [{ action: "move", enabled: true }] }), exampleTask({ id: "review", title: "Review build", depends_on: ["build"], available_actions: [{ action: "move", enabled: true }] })];
  const detail = exampleWorkflow({ tasks, capability: writeCapability, available_actions: [{ action: "move", enabled: true }] });
  const destination = exampleWorkflow({ id: "next-release", title: "Next release", revision: 12, tasks: [], capability: writeCapability, available_actions: [{ action: "import", enabled: true }] });
  const writes: Record<string, unknown>[] = []; const saved = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("/containers/")) return jsonResponse({ workflows: [detail, destination], next_cursor: null, capability: writeCapability });
    if (url.endsWith("/next-release")) return jsonResponse(destination);
    if (init.method === "POST") writes.push(JSON.parse(String(init.body)));
    return jsonResponse(detail);
  }));
  render(<WorkflowMove detail={detail} scope={scope()} verified stale={false} onSaved={saved} />);
  fireEvent.click(screen.getByRole("button", { name: "Move or remove tasks" })); await screen.findByRole("option", { name: "Next release" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Build Android" }));
  fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "next-release" } });
  fireEvent.change(screen.getByLabelText("Reason for moving tasks"), { target: { value: "Move this untouched group to the next release" } });
  fireEvent.click(screen.getByRole("button", { name: "Review task move" })); await screen.findByRole("region", { name: "Move impact" });
  expect(screen.getByText(/Prepare and release them there/)).toBeVisible(); // destination has not started
  expect(screen.getByRole("button", { name: "Confirm task move" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Include the whole group" })); expect(screen.getByRole("button", { name: "Confirm task move" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Review task move" })); await waitFor(() => expect(screen.getByRole("button", { name: "Confirm task move" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Confirm task move" })); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ task_ids: ["build", "review"], expected_revision: 7, destination_workflow_id: "next-release", destination_revision: 12 });
});
it("says a moved task is released by preparing it only when the destination Workflow has already started", async () => {
  const task = exampleTask({ available_actions: [{ action: "move", enabled: true }] });
  const detail = exampleWorkflow({ tasks: [task], capability: writeCapability, available_actions: [{ action: "move", enabled: true }] });
  const destination = exampleWorkflow({ id: "next-release", title: "Next release", revision: 12, launch_enabled: true, tasks: [], capability: writeCapability, available_actions: [{ action: "import", enabled: true }] });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/containers/")) return jsonResponse({ workflows: [detail, destination], next_cursor: null, capability: writeCapability });
    if (url.endsWith("/next-release")) return jsonResponse(destination);
    return jsonResponse(detail);
  }));
  render(<WorkflowMove detail={detail} scope={scope()} verified stale={false} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Move or remove tasks" })); await screen.findByRole("option", { name: "Next release" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Build Android" }));
  fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "next-release" } });
  fireEvent.change(screen.getByLabelText("Reason for moving tasks"), { target: { value: "Move this task to the running release" } });
  fireEvent.click(screen.getByRole("button", { name: "Review task move" })); await screen.findByRole("region", { name: "Move impact" });
  expect(screen.getByText(/That Workflow has already started, so a task that still needs preparing is released when you prepare it/)).toBeVisible();
  expect(screen.queryByText(/Prepare and release them there/)).toBeNull();
});

it("lets the owner change a loop workflow's agent-turn allowance in Workflow settings (#362 x02)", async () => {
  const detail = exampleWorkflow({ capability: writeCapability, semantics_version: 2, turn_allowance: 40, turns_used: 12,
    available_actions: [{ action: "patch", enabled: true }] });
  const writes: [string, RequestInit][] = []; const saved = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { if (init.method === "PATCH") writes.push([url, init]); return jsonResponse(detail); }));
  render(<WorkflowSettings detail={detail} scope={scope()} verified stale={false} humans={[]} onSaved={saved} />);
  fireEvent.click(screen.getByRole("button", { name: "Workflow settings" }));
  expect(screen.getByText(/12 used/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Long loop" } });
  fireEvent.change(screen.getByLabelText(/Agent-turn allowance for this run/), { target: { value: "1001" } });
  expect(screen.getByText("The agent-turn allowance can be at most 1000.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Agent-turn allowance for this run/), { target: { value: "60" } });
  fireEvent.click(screen.getByRole("button", { name: "Review settings change" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm settings change" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(JSON.parse(String(writes[0][1].body))).toMatchObject({ turn_allowance: 60, reason: "Long loop" });
});
