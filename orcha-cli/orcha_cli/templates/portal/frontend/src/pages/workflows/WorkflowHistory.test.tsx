import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowActivity, WorkflowReviewHistory } from "./WorkflowHistory";
import { WorkflowResolveReview } from "./WorkflowReviewEditor";
import { WorkflowChange } from "./WorkflowChange";
import { exampleTask, exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
import type { ReviewHistory } from "./workflowContract.generated";
const scope = () => ({ origin: "https://orcha.example", project: "project", identity: crypto.randomUUID() });
const activity = { id: "notice", task_id: "build", actor_alias: "Kedar", actor_kind: "human", event: "workflow_lost_worker_released", revision: 7,
  detail: { warning: "Released without stop confirmation: the worker may still be running outside Orcha." }, created_at: "2026-10-25T10:00:00Z" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("retains labelled activity on a connection failure and removes cached and fallback rows on access refusal", async () => {
  let failure = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (failure === 1) throw new TypeError("offline");
    if (failure === 2) return jsonResponse({ detail: "Forbidden" }, 403);
    return jsonResponse({ activity: [activity], next_before_at: null, next_before_id: null });
  }));
  render(<MemoryRouter initialEntries={["/workflows/release?cid=project&tab=activity"]}><WorkflowActivity detail={exampleWorkflow({ activity: [activity] })} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh activity" })).toBeEnabled());
  expect(screen.getByText(activity.detail.warning)).toBeVisible();
  const taskUrl = new URL(screen.getByRole("link", { name: "Build Android" }).getAttribute("href")!, "https://orcha.example");
  expect(taskUrl.searchParams.get("workflowReturn")).toBe("/workflows/release?cid=project&tab=activity");
  failure = 1; fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
  expect(await screen.findByText(/Showing previously loaded activity/)).toBeVisible();
  expect(screen.getByText(activity.detail.warning)).toBeVisible();
  failure = 2; fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
  await waitFor(() => expect(screen.queryByText(activity.detail.warning)).toBeNull());
  expect(screen.getByRole("alert")).toHaveTextContent("Access to this workflow’s activity changed");
});

it("shows immutable supplier and same-person acceptance in Activity", async () => {
  const accepted = { ...activity, id: "accepted", event: "workflow_task_accepted", detail: {
    supplier_id: "kedar", supplier_alias: "Kedar", supplier_kind: "human", same_person_supplier: true,
  } };
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ activity: [accepted], next_before_at: null, next_before_id: null })));
  render(<MemoryRouter><WorkflowActivity detail={exampleWorkflow({ activity: [] })} /></MemoryRouter>);
  expect(await screen.findByText("Owner-supplied result, accepted by the same person.")).toBeVisible();
  expect(screen.getByText("Submitted by Kedar (verified).")).toBeVisible();
});

it("tells the loop's story in Activity: outcomes, the route taken, a stall and the owner's decision", async () => {
  const rows = [
    { ...activity, id: "r1", event: "workflow_outcome_reported", detail: { outcome: "Changes", findings: 2, route: "Sends the work back to Build iOS for round 2 of Draft and review." } },
    { ...activity, id: "r2", event: "workflow_route_applied", detail: { outcome: "Changes", result: "stalled", route: "Sends the work back to Build iOS for round 3 of Draft and review." } },
    { ...activity, id: "r3", event: "workflow_loop_decided", detail: { subject: "stalled", chosen: "accept_override", original_outcome: "Changes" } },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ activity: rows, next_before_at: null, next_before_id: null })));
  render(<MemoryRouter><WorkflowActivity detail={exampleWorkflow({ activity: [] })} /></MemoryRouter>);
  expect(await screen.findByText("“Changes”: Sends the work back to Build iOS for round 2 of Draft and review. 2 findings.")).toBeVisible();
  expect(screen.getByText(/Next step decided/)).toBeVisible();
  expect(screen.getByText("The loop stalled: the same findings came back on unchanged work. Waiting for the owner.")).toBeVisible();
  expect(screen.getByText("Accepted the work as it is and ended the loop. The reported outcome “Changes” is kept in the record.")).toBeVisible();
});
it("does not unlock owner resolution with a selected name or an unavailable integration", () => {
  const detail = exampleWorkflow({ capability: writeCapability, tasks: [exampleTask({ available_actions: [{ action: "resolve_loop", enabled: true }] })] });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const props = { detail, scope: scope(), verified: false, stale: false, reviewTaskId: "build", onSaved: vi.fn() };
  const view = render(<WorkflowResolveReview {...props} />);
  fireEvent.click(screen.getByText("Resolve findings by owner decision"));
  fireEvent.change(screen.getByLabelText("Reason for resolving"), { target: { value: "Reviewed the recorded findings" } });
  expect(screen.getByRole("button", { name: "Review owner resolution" })).toBeDisabled();
  view.rerender(<WorkflowResolveReview {...props} verified detail={{ ...detail, capability: { ...writeCapability, workflow_human_write: false, reason: "integration_required" } }} />);
  expect(screen.getByRole("button", { name: "Review owner resolution" })).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
});

it("guards a missing human even when an action supplies its own permission check", () => {
  vi.stubGlobal("fetch", vi.fn());
  render(<WorkflowChange detail={exampleWorkflow({ capability: writeCapability })} scope={scope()} verified={false} stale={false}
    operation="patch" url="/api/workflows/release" label="Settings change" body={{ title: "Updated" }} check={() => null} onSaved={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Review settings change" })).toBeDisabled();
});

it("rechecks permission before recording owner resolution and preserves the reason on refusal", async () => {
  const task = exampleTask({ available_actions: [{ action: "resolve_loop", enabled: true }] });
  const detail = exampleWorkflow({ capability: writeCapability, tasks: [task] });
  const fetch = vi.fn(async () => jsonResponse({ ...detail, tasks: [{ ...task, available_actions: [{ action: "resolve_loop", enabled: false, reason: "workflow_owner_required" }] }] }));
  vi.stubGlobal("fetch", fetch);
  render(<WorkflowResolveReview detail={detail} scope={scope()} verified stale={false} reviewTaskId="build" onSaved={vi.fn()} />);
  fireEvent.click(screen.getByText("Resolve findings by owner decision"));
  fireEvent.change(screen.getByLabelText("Reason for resolving"), { target: { value: "The documented exception covers this finding" } });
  fireEvent.click(screen.getByRole("button", { name: "Review owner resolution" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("owner");
  expect(screen.queryByRole("button", { name: "Confirm owner resolution" })).toBeNull();
  expect(screen.getByLabelText("Reason for resolving")).toHaveValue("The documented exception covers this finding");
  expect(fetch).toHaveBeenCalledOnce();
});

const round: ReviewHistory = { id: "round", loop_key: "loop", round_number: 1, review_task_id: "review", correction_task_id: null,
  reviewed_task_id: "build", reviewed_work_revision: 2, review_work_revision: 5, outcome: "changes_requested",
  reviewed_artifact: { evidence_set_id: "original-evidence", items: [{ item_id: "original-item", deliverable_id: "original-file", deliverable_version: 4, sha256: "b".repeat(64) }] } };

it("opens the recorded reviewed-task file version even after the task has newer work", () => {
  render(<MemoryRouter initialEntries={["/workflows/release?cid=project&tab=review"]}><WorkflowReviewHistory detail={exampleWorkflow({
    tasks: [exampleTask({ work_revision: 8, current_evidence_set_id: "new-evidence" }), exampleTask({ id: "review", title: "Review build" })], review_rounds: [round],
  })} /></MemoryRouter>);
  expect(screen.getByRole("link", { name: "Reviewed file 1 — version 4" })).toHaveAttribute("href", "/api/tasks/build/deliverables/original-file/versions/4/raw");
  expect(screen.getByText(/work revision 2/)).toBeVisible();
  expect(screen.getByText("Review report work revision 5.")).toBeVisible();
  const reviewed = new URL(screen.getByRole("link", { name: "Build Android" }).getAttribute("href")!, "https://orcha.example");
  expect(reviewed.searchParams.get("workflowReturn")).toBe("/workflows/release?cid=project&tab=review");
});

it.each([
  { ...round, outcome: null, reviewed_task_id: null, reviewed_work_revision: null },
  { ...round, reviewed_task_id: undefined, reviewed_work_revision: undefined },
])("never invents an evidence link for a pending round or an older response without the reviewed-task reference", (value) => {
  render(<MemoryRouter><WorkflowReviewHistory detail={exampleWorkflow({ review_rounds: [value] })} /></MemoryRouter>);
  expect(screen.queryByRole("link", { name: /Reviewed file/ })).toBeNull();
  expect(screen.getByText(value.outcome ? /exact reviewed-task reference is unavailable/ : /after this review outcome is recorded/)).toBeVisible();
});
