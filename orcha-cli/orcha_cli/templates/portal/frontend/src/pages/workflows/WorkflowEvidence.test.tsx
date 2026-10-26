import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowEvidencePanel } from "./WorkflowEvidence";
import { WorkflowAcceptance } from "./WorkflowAcceptance";
import { WorkflowActions } from "./WorkflowActions";
import { MemoryRouter } from "react-router-dom";
import { exampleTask, exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
import type { SavedEvidenceSet, WorkflowTaskEvidence } from "./workflowContract.generated";
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });
const task = exampleTask({ current_evidence_set_id: "evidence", evidence_state: "saved" });
const workflow = () => exampleWorkflow({ capability: writeCapability, tasks: [task], evidence_capability: { available: true, reason: null }, available_actions: ["accept_goal", "accept_objective", "finish"].map((action) => ({ action, enabled: true })) });
function evidence(patch: Partial<SavedEvidenceSet> = {}): WorkflowTaskEvidence {
  return { task_id: "build", workflow_id: "release", current_evidence_set_id: "evidence", next_before_revision: null, sets: [{ evidence_set_id: "evidence", task_id: "build", workflow_id: "release", workflow_execution_id: "execution", run_id: "run", work_revision: 3, result_revision: 2,
    source_sequence: 1, generation: 1, state: "saved", purpose: "acceptance", missing_reason: null, terminal_cause: null, created_at: "2026-10-25T10:00:00Z", frozen_at: "2026-10-25T10:01:00Z", source_revision: null,
    items: [{ item_id: "item", deliverable_id: "file", deliverable_version: 4, sha256: "a".repeat(64), kind: "file_changes", source: "worker", snapshot_phase: "terminal", complete: false, note: "Bounded diff; full commit named in file", storage_state: "readable" }], ...patch }] };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows immutable saved versions and incomplete evidence without treating it as empty changes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(evidence())));
  render(<WorkflowEvidencePanel detail={workflow()} taskId="build" />);
  expect(await screen.findByRole("link", { name: "Saved file changes — version 4" })).toHaveAttribute("href", "/api/tasks/build/deliverables/file/versions/4/raw");
  expect(screen.getByText(/Incomplete saved evidence/)).toBeVisible(); expect(screen.queryByText(/No file changes/)).toBeNull();
});
it("labels a pre-workflow result as reviewed on import, not owner supplied", async () => {
  const imported = evidence({ items: [{ item_id: "item", deliverable_id: "file", deliverable_version: 4, sha256: "a".repeat(64), kind: "import_result", source: "import", snapshot_phase: "submission", complete: true, note: null, storage_state: "readable",
    captured_by: "kedar", captured_by_alias: "Kedar", captured_by_kind: "human" }] });
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(imported)));
  render(<WorkflowEvidencePanel detail={workflow()} taskId="build" />);
  expect(await screen.findByRole("link", { name: "Imported result review — version 4" })).toBeVisible();
  expect(screen.getByText(/Completed before it joined this workflow/)).toBeVisible();
  expect(screen.getByText("Reviewed and accepted on import by Kedar.")).toBeVisible();
  expect(screen.queryByText(/Owner-supplied result/)).toBeNull();
});
it.each(["pending", "missing", "superseded"] as const)("does not offer %s evidence as an acceptance basis", async (state) => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(evidence({ state }))));
  render(<WorkflowEvidencePanel detail={workflow()} taskId="build" onSelect={vi.fn()} />);
  await screen.findByRole("link", { name: "Saved file changes — version 4" });
  expect(screen.getByRole("checkbox", { name: /Use current saved evidence/ })).toBeDisabled();
});
it("keeps database-only restore history visible without a link or acceptable selection", async () => {
  const restored = evidence(); restored.sets[0].items[0].storage_state = "missing_after_restore";
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(restored)));
  render(<WorkflowEvidencePanel detail={workflow()} taskId="build" onSelect={vi.fn()} />);
  await screen.findByText(/file missing after restore/);
  expect(screen.queryByRole("link", { name: /Saved file changes/ })).toBeNull(); expect(screen.getByRole("checkbox", { name: /Use current/ })).toBeDisabled();
});
it("records goal acceptance with exact item_id, version and hash, in a separate request from Finish", async () => {
  const writes: [string, Record<string, unknown>][] = []; const saved = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/evidence")) return jsonResponse(evidence());
    if (init?.method === "POST") writes.push([url, JSON.parse(String(init.body))]);
    return jsonResponse(workflow());
  }));
  render(<WorkflowAcceptance detail={workflow()} scope={scope()} verified stale={false} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText("Why this satisfies the criteria"), { target: { value: "The saved checks cover both builds." } });
  fireEvent.change(screen.getByLabelText("Review evidence from a task"), { target: { value: "build" } });
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Use current saved evidence/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("checkbox", { name: /Use current saved evidence/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review goal acceptance" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm goal acceptance" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce()); expect(writes).toHaveLength(1); expect(writes[0][0]).toBe("/api/workflows/release/goal/accept");
  expect(writes[0][1].evidence).toEqual({ narrative: "The saved checks cover both builds.", task_revisions: { build: 3 }, evidence_sets: [{ evidence_set_id: "evidence", items: [{ item_id: "item", deliverable_id: "file", deliverable_version: 4, sha256: "a".repeat(64) }] }] });
});
it("refuses a goal confirmation after a concurrent workflow change without discarding the explanation", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse(url.endsWith("/evidence") ? evidence() : { ...workflow(), revision: 8 })));
  render(<WorkflowAcceptance detail={workflow()} scope={scope()} verified stale={false} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Why this satisfies the criteria"), { target: { value: "Reviewed the build." } });
  fireEvent.change(screen.getByLabelText("Review evidence from a task"), { target: { value: "build" } });
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Use current saved evidence/ })).toBeEnabled()); fireEvent.click(screen.getByRole("checkbox", { name: /Use current saved evidence/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review goal acceptance" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("workflow changed"); expect(screen.getByLabelText("Why this satisfies the criteria")).toHaveValue("Reviewed the build.");
  expect(screen.queryByRole("button", { name: "Confirm goal acceptance" })).toBeNull();
});
it("finishes only after a fresh server check, with no implicit objective or goal acceptance", async () => {
  const complete = { ...workflow(), completion: { can_finish: true, blockers: [] }, goal_accepted_revision: 1, objectives: [], progress: { ...workflow().progress, total: 1, accepted: 1, objectives_total: 0, objectives_accepted: 0 } };
  const posts: string[] = []; const saved = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === "POST") posts.push(url); return jsonResponse(url.endsWith("/completion-check") ? complete.completion : complete); }));
  render(<MemoryRouter><WorkflowActions detail={complete} scope={scope()} verified stale={false} onSaved={saved} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Finish checklist" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Finish workflow" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Finish workflow" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce()); expect(posts).toEqual(["/api/workflows/release/finish"]);
});
