import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowTaskDecision } from "./WorkflowTaskDecision";
import { exampleTask, exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
import type { WorkflowTaskEvidence } from "./workflowContract.generated";
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });
const task = exampleTask({ status: "needs_verification", current_evidence_set_id: "evidence", evidence_state: "saved", available_actions: ["accept", "reject"].map((action) => ({ action, enabled: true })) });
const detail = exampleWorkflow({ tasks: [task], capability: writeCapability, evidence_capability: { available: true } });
function evidence(): WorkflowTaskEvidence {
  return { task_id: task.id, workflow_id: detail.id, current_evidence_set_id: "evidence", next_before_revision: null, sets: [{ evidence_set_id: "evidence", task_id: task.id, workflow_id: detail.id,
    workflow_execution_id: "execution", run_id: "run", work_revision: 3, result_revision: 2, source_sequence: 1, generation: 1, state: "saved", purpose: "acceptance",
    missing_reason: null, terminal_cause: null, created_at: "2026-10-25T10:00:00Z", frozen_at: "2026-10-25T10:01:00Z", source_revision: null,
    items: [{ item_id: "item", deliverable_id: "file", deliverable_version: 4, sha256: "a".repeat(64), kind: "result_summary", source: "worker", snapshot_phase: "terminal", complete: true, note: null, storage_state: "readable",
      captured_by: "worker", captured_by_alias: "Andrew", captured_by_kind: "ai" }] }] };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function selectEvidence() {
  const checkbox = await screen.findByRole("checkbox", { name: /Use current saved evidence/ });
  await waitFor(() => expect(checkbox).toBeEnabled()); fireEvent.click(checkbox);
}
it("accepts the checked work revision and exact saved versions, separate from plan approval and Finish", async () => {
  const writes: [string, Record<string, unknown>][] = []; const saved = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") writes.push([url, JSON.parse(String(init.body))]);
    return jsonResponse(url.endsWith("/evidence") ? evidence() : detail);
  }));
  render(<WorkflowTaskDecision detail={detail} task={task} scope={scope()} verified stale={false} onSaved={saved} />);
  expect(screen.getByRole("button", { name: "Review decision" })).toBeDisabled();
  await selectEvidence(); fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm accept result" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(1); expect(writes[0][0]).toBe("/api/tasks/build/accept");
  expect(writes[0][1]).toMatchObject({ expected_revision: 7, expected_work_revision: 3,
    evidence: { evidence_set_id: "evidence", items: [{ item_id: "item", deliverable_id: "file", deliverable_version: 4, sha256: "a".repeat(64) }] } });
});
it.each(["version", "hash", "storage", "work", "scope"])("refuses acceptance when the refreshed evidence changes its %s", async (change) => {
  let changed = false; const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") writes.push(url);
    if (!url.endsWith("/evidence")) return jsonResponse(detail);
    const current = evidence();
    if (changed) {
      if (change === "version") current.sets[0].items[0].deliverable_version++;
      if (change === "hash") current.sets[0].items[0].sha256 = "b".repeat(64);
      if (change === "storage") current.sets[0].items[0].storage_state = "missing_after_restore";
      if (change === "work") current.sets[0].work_revision++;
      if (change === "scope") current.task_id = "another-task";
    }
    return jsonResponse(current);
  }));
  render(<WorkflowTaskDecision detail={detail} task={task} scope={scope()} verified stale={false} onSaved={vi.fn()} />);
  await selectEvidence(); changed = true; fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/evidence changed or is unavailable/);
  expect(screen.queryByRole("button", { name: "Confirm accept result" })).toBeNull(); expect(writes).toEqual([]);
});
it("requires feedback for rejection and preserves it after refusal without restarting the task", async () => {
  const writes: [string, Record<string, unknown>][] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push([url, JSON.parse(String(init.body))]); return jsonResponse({ detail: { message: "Task changed; review again", code: "revision_conflict" } }, 409); }
    return jsonResponse(url.endsWith("/evidence") ? evidence() : detail);
  }));
  const ownScope = scope(); const props = { detail, task, scope: ownScope, verified: true, stale: false, onSaved: vi.fn() };
  const view = render(<WorkflowTaskDecision {...props} />);
  fireEvent.click(screen.getByRole("radio", { name: "Request changes" }));
  expect(screen.getByRole("button", { name: "Review decision" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("What needs to change"), { target: { value: "Add the failed pairing case." } });
  fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm request changes" }));
  await screen.findByText("Task changed; review again");
  expect(writes).toHaveLength(1); expect(writes[0]).toEqual(["/api/tasks/build/reject", expect.objectContaining({ expected_work_revision: 3, reason: "Add the failed pairing case." })]);
  expect(screen.queryByRole("button", { name: "Confirm request changes" })).toBeNull();
  view.unmount(); render(<WorkflowTaskDecision {...props} />);
  expect(screen.getByLabelText("Review note (optional)")).toHaveValue("Add the failed pairing case.");
});
it("retains the exact request across an uncertain response and checks its receipt before same-key replay", async () => {
  const bodies: string[] = []; const calls: string[] = []; const saved = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (init?.method === "POST") { bodies.push(String(init.body)); if (bodies.length === 1) throw new TypeError("lost response"); return jsonResponse(detail); }
    if (url.includes("workflow-operations")) return jsonResponse({ operation: "accept", idempotency_key: JSON.parse(bodies[0]).idempotency_key, status: "not_found" });
    return jsonResponse(url.endsWith("/evidence") ? evidence() : detail);
  }));
  render(<WorkflowTaskDecision detail={detail} task={task} scope={scope()} verified stale={false} onSaved={saved} />);
  await selectEvidence(); fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm accept result" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry same request" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce()); expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
  expect(calls.findIndex((url) => url.includes("workflow-operations"))).toBeLessThan(calls.lastIndexOf("/api/tasks/build/accept"));
});
it("consumes confirmation on edited feedback, refreshed scope, or changed permissions", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse(url.endsWith("/evidence") ? evidence() : detail)));
  const props = { detail, task, scope: scope(), verified: true, stale: false, onSaved: vi.fn() };
  const view = render(<WorkflowTaskDecision {...props} />); await selectEvidence();
  fireEvent.click(screen.getByRole("button", { name: "Review decision" })); await screen.findByRole("button", { name: "Confirm accept result" });
  fireEvent.change(screen.getByLabelText("Review note (optional)"), { target: { value: "One more check" } });
  expect(screen.queryByRole("button", { name: "Confirm accept result" })).toBeNull();
  view.rerender(<WorkflowTaskDecision {...props} verified={false} />);
  expect(screen.getByRole("button", { name: "Review decision" })).toBeDisabled();
});
it("allows a person to accept their own outside result and records the two roles explicitly", async () => {
  const writes: string[] = []; const saved = vi.fn(); const ownScope = scope();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") writes.push(url);
    if (!url.endsWith("/evidence")) return jsonResponse(detail);
    const current = evidence(); Object.assign(current.sets[0].items[0], { source: "outside", captured_by: ownScope.identity, captured_by_alias: "Kedar", captured_by_kind: "human" });
    return jsonResponse(current);
  }));
  render(<WorkflowTaskDecision detail={detail} task={task} scope={ownScope} verified stale={false} onSaved={saved} />);
  await selectEvidence();
  expect(screen.getByText(/You supplied this outside result; accepting your own result is allowed/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm accept result" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes).toEqual(["/api/tasks/build/accept"]);
});
it("refuses outside-result acceptance when immutable supplier attribution is missing", async () => {
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") writes.push(url);
    if (!url.endsWith("/evidence")) return jsonResponse(detail);
    const current = evidence(); Object.assign(current.sets[0].items[0], { source: "outside", captured_by: null, captured_by_alias: null, captured_by_kind: null }); return jsonResponse(current);
  }));
  render(<WorkflowTaskDecision detail={detail} task={task} scope={scope()} verified stale={false} onSaved={vi.fn()} />);
  await selectEvidence();
  expect(screen.getByText(/supplier attribution is unavailable/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Review decision" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Confirm accept result" })).toBeNull(); expect(writes).toEqual([]);
});
