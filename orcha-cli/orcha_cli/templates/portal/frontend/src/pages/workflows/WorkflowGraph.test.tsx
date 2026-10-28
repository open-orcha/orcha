import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import { WorkflowAddTasks } from "./WorkflowAddTasks";
import { graphPositions } from "./WorkflowGraph";
import { readDraft } from "./workflowDraft";
import { exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });

it("shares task keys and edited fields between cards and graph without a write", () => {
  const current = scope(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<WorkflowDraftEditor scope={current} saveUnavailableReason="Offline" />);
  fireEvent.click(screen.getByRole("button", { name: "Add task summary" }));
  fireEvent.change(screen.getByLabelText("Task summary"), { target: { value: "Build" } });
  const key = readDraft(current).tasks[0].key;
  fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
  fireEvent.click(screen.getByRole("button", { name: /Build.*Draft/ }));
  fireEvent.change(screen.getByLabelText("Task summary"), { target: { value: "Build both apps" } });
  fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
  expect(screen.getByLabelText("Task summary")).toHaveValue("Build both apps");
  expect(readDraft(current).tasks[0].key).toBe(key); expect(fetch).not.toHaveBeenCalled();
});

it("creates an after-node task atomically and recovers a lost save with the same dependency and key", async () => {
  const detail = exampleWorkflow({ capability: writeCapability, available_actions: [{ action: "add_tasks", enabled: true }] });
  const writes: string[] = []; const saved = vi.fn(); const close = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("workflow-operations")) return jsonResponse({ status: "not_found", operation: "add_tasks", idempotency_key: JSON.parse(writes[0]).idempotency_key, result: null });
    if (init?.method === "POST") { writes.push(String(init.body)); if (writes.length === 1) throw new TypeError("Response lost"); }
    return jsonResponse(detail);
  }));
  render(<WorkflowAddTasks detail={detail} scope={scope()} agents={[]} verified stale={false} onSaved={saved} control={{ open: true, onOpenChange: close }} seed={{ after: "build", seq: 1 }} />);
  fireEvent.change(await screen.findByLabelText("Task summary"), { target: { value: "Review build" } });
  expect(screen.getByRole("button", { name: "Remove prerequisite Build Android" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review task addition" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm task addition" }));
  await screen.findByRole("button", { name: "Check saved result" });
  expect(screen.getByLabelText("Task summary")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Keep draft and close" })).toBeDisabled();
  expect(JSON.parse(writes[0]).tasks[0]).toMatchObject({ title: "Review build", depends_on: ["build"] });
  fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(2); expect(writes[1]).toBe(writes[0]);
});

it("lays out only prerequisite relationships; independent tasks have no invented sequence", () => {
  const base = { title: "Task", status: "pending", label: "Draft", assignee: "", dependsOn: [] };
  const points = graphPositions([{ ...base, id: "a" }, { ...base, id: "b" }, { ...base, id: "c", dependsOn: ["a"] }]);
  expect(points[0].x).toBe(points[1].x); expect(points[2].x).toBeGreaterThan(points[0].x);
});

it("adds a dependent draft from a draft node and prevents a cycle", () => {
  const current = scope(); vi.stubGlobal("fetch", vi.fn());
  render(<WorkflowDraftEditor scope={current} saveUnavailableReason="Offline" />);
  fireEvent.click(screen.getByRole("button", { name: "Add task summary" }));
  fireEvent.change(screen.getByLabelText("Task summary"), { target: { value: "Build" } });
  const first = readDraft(current).tasks[0].key;
  fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
  fireEvent.click(screen.getByRole("button", { name: "Add task after this" }));
  fireEvent.change(screen.getByLabelText("Task summary"), { target: { value: "Review" } });
  expect(readDraft(current).tasks[1].dependsOn).toEqual([first]);
  fireEvent.click(screen.getByRole("button", { name: /Build.*Draft/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add prerequisite" }));
  expect(screen.getByRole("menuitem", { name: "Review" })).toHaveAttribute("aria-disabled", "true");
});
