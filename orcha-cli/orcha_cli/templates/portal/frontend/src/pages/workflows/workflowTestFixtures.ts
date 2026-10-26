import type { Impact, WorkflowDetail, WorkflowImpact, WorkflowTask } from "./workflowContract.generated";
export const readCapability = { workflow_read: true, workflow_human_write: false, reason: "integration_required" };
export const writeCapability = { workflow_read: true, workflow_human_write: true, reason: null };
export const workflowSpec = { paths: { "/api/containers/{cid}/workflows": { get: {} } } };
export function exampleTask(patch: Partial<WorkflowTask> = {}): WorkflowTask {
  return { id: "build", title: "Build Android", definition_of_done: "Pairing checks pass", description: "Build the client", status: "not_ready", work_revision: 3,
    preparation_state: "prepared", start_hold: true, human_hold_by: null, human_hold_reason: null, awaiting_owner_decision: null, withdrawn_at: null,
    priority: 100, assignee_ids: ["andrew"], depends_on: [], can_start: false, blockers: [{ code: "start_hold", message: "Waiting for Start" }],
    display_state: { label: "Prepared · waiting for Start", release_available: false, release_available_at: null, warning: null }, available_actions: [], ...patch };
}
export function exampleWorkflow(patch: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return { id: "release", container_id: "project", title: "Mobile release", goal: "Pairing works on both platforms", owner_human_id: "kedar", status: "active", execution_mode: "parallel",
    launch_enabled: false, revision: 7, graph_revision: 4, scope_revision: 2, goal_revision: 1, goal_accepted_revision: null, task_limit: 200, round_limit: 10, limit_reached: false,
    capability: readCapability, available_actions: ["start","pause","resume","cancel","finish","add_tasks","import"].map((action) => ({ action, enabled: false, reason: "integration_required" })),
    progress: { accepted: 4, total: 8, percent: 50, withdrawn: 0, objectives_accepted: 0, objectives_total: 1 },
    completion: { can_finish: false, blockers: [{ code: "tasks_unaccepted", message: "Some task results still need acceptance" }] }, tasks: [exampleTask()],
    objectives: [{ id: "pairing", title: "Reliable pairing", criteria: "The pairing checks pass", revision: 1, accepted_revision: null }], ...patch };
}
export const jsonResponse = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

export function exampleImpact(detail: WorkflowDetail, url: string, patch: Partial<Impact> = {}): WorkflowImpact {
  const query = new URL(url, "https://orcha.example");
  const kind = query.pathname.endsWith("/cancellation-check") ? "cancellation" : query.pathname.endsWith("/release-check") ? "release" : "start";
  const selected = query.searchParams.has("task_ids") ? query.searchParams.getAll("task_ids") : kind === "start" ? detail.tasks.map((t) => t.id) : [];
  return { ...detail, impact: { kind, revision: detail.revision, graph_revision: detail.graph_revision, scope_revision: detail.scope_revision,
    task_revisions: Object.fromEntries(detail.tasks.map((t) => [t.id, t.work_revision])),
    holds: kind === "cancellation" ? [] : query.searchParams.has("holds") ? query.searchParams.getAll("holds") as ("start" | "human")[] : ["start"],
    tasks: detail.tasks.map((t) => ({ task_id: t.id, title: t.title, work_revision: t.work_revision, selected: selected.includes(t.id),
      current_status: t.status, resulting_status: "ready", can_start: false, blockers: [{ code: "workflow_turn", message: "Another task is using the workflow turn" }] })),
    counts_by_state: { not_ready: detail.tasks.length }, accepted_retained: [], workers_to_stop: [], ...patch } };
}
