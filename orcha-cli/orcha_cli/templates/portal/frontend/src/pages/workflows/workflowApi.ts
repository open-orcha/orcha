import { workflowSchemas, workflowRoutes, type WorkflowModels, type Capability, type WorkflowDetail, type AvailableAction } from "./workflowContract.generated";

type Schema = { $ref?: string; anyOf?: Schema[]; enum?: unknown[]; const?: unknown; type?: string; required?: string[];
  properties?: Record<string, Schema>; items?: Schema; additionalProperties?: boolean | Schema;
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; pattern?: string };
const schemas: Record<string, Schema> = workflowSchemas;

// The runtime boundary validates generated schemas as well as TypeScript types.
// A newer/incompatible server must not turn malformed data into empty success.
function matches(value: unknown, schema: Schema): boolean {
  if (schema.$ref) return matches(value, schemas[schema.$ref.split("/").at(-1)!]);
  if (schema.anyOf) return schema.anyOf.some((s) => matches(value, s));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "string") return typeof value === "string"
    && (schema.minLength === undefined || value.length >= schema.minLength)
    && (schema.maxLength === undefined || value.length <= schema.maxLength)
    && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === "number" || schema.type === "integer") return typeof value === "number" && Number.isFinite(value)
    && (schema.type !== "integer" || Number.isSafeInteger(value))
    && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === "array") return Array.isArray(value)
    && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems)
    && value.every((v) => matches(v, schema.items ?? {}));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (schema.required?.some((key) => !(key in record))) return false;
    return Object.entries(record).every(([key, v]) => schema.properties?.[key] ? matches(v, schema.properties[key])
      : schema.additionalProperties === false ? false
      : typeof schema.additionalProperties === "object" ? matches(v, schema.additionalProperties) : true);
  }
  return true;
}

export class WorkflowApiError extends Error {
  constructor(message: string, public status = 0, public code = "", public uncertain = false) { super(message); }
}

export function parseWorkflowModel<K extends keyof WorkflowModels>(name: K, value: unknown): WorkflowModels[K] {
  if (!matches(value, schemas[name])) throw new WorkflowApiError("This portal cannot read the Workflows response. Refresh or update Orcha before continuing.");
  return value as WorkflowModels[K];
}

export async function workflowRequest<K extends keyof WorkflowModels>(name: K, url: string,
  options: { method?: "GET" | "POST" | "PATCH" | "PUT"; body?: unknown; signal?: AbortSignal; actorId?: string | null } = {}): Promise<WorkflowModels[K]> {
  const method = options.method ?? "GET";
  if (method !== "GET") {
    const route = workflowRoutes.find((r) => r.method === method.toLowerCase() && new RegExp(`^${r.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(url.split("?")[0]));
    const body = route && "body" in route ? route.body : null;
    if (!body || !matches(options.body, schemas[body])) throw new WorkflowApiError("This change does not match the server’s supported fields. Your draft is kept; review it before trying again.", 422, "invalid_request");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 15_000);
  const mutation = method !== "GET" && !url.endsWith("/preview") && !url.endsWith("/import-preview");
  try {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.actorId) headers["X-Orcha-Local-Actor"] = options.actorId;
    const response = await fetch(url, { method, signal: controller.signal,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    if (!response.ok) {
      let message = "Orcha could not complete this request.";
      let code = "";
      try {
        const { detail } = await response.json();
        if (typeof detail === "string") message = detail;
        else if (detail && typeof detail.message === "string") { message = detail.message; code = typeof detail.code === "string" ? detail.code : ""; }
        else if (Array.isArray(detail)) message = "Check the highlighted fields and review again. Nothing was saved.";
      } catch { /* Status remains authoritative even without error detail. */ }
      throw new WorkflowApiError(message, response.status, code, mutation && (response.status >= 500 || response.status === 408));
    }
    try { return parseWorkflowModel(name, await response.json()); }
    catch { throw new WorkflowApiError("Orcha returned an unreadable response. Check the saved result before trying again.", 0, "invalid_response", mutation); }
  } catch (error) {
    if (error instanceof WorkflowApiError) throw error;
    throw new WorkflowApiError("Could not reach Orcha. Check your connection and try again.", 0, "connection", mutation);
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
}

export const workflowPaths = {
  collection: (cid: string) => `/api/containers/${encodeURIComponent(cid)}/workflows`,
  taskSearch: (cid: string) => `/api/containers/${encodeURIComponent(cid)}/workflow-task-search`,
  detail: (wid: string) => `/api/workflows/${encodeURIComponent(wid)}`,
  receipt: (cid: string, key: string, operation: string) => `/api/containers/${encodeURIComponent(cid)}/workflow-operations/${encodeURIComponent(key)}?${new URLSearchParams({ operation })}`,
};

export function workflowWriteReason(capability: Capability | null, hasHuman: boolean): string | null {
  if (!capability) return "Checking access to workflow changes…";
  if (capability.workflow_human_write !== true) {
    if (capability.reason === "integration_required") return "Workflow changes are not available on this server yet. You can continue reading.";
    if (capability.reason === "local_workflow_writes_unavailable") return "Workflow changes are unavailable on this older server. Update Orcha and try again.";
    if (capability.reason === "verified_sign_in_required") return "Sign in as a current human member of this project to change workflows on this hosted server.";
    if (capability.reason === "human_required") return "Choose a current human member of this project to change workflows.";
    if (capability.reason === "workflow_owner_required") return "Only this workflow’s owner can make these changes.";
    return "You do not have permission to change workflows on this connection.";
  }
  return hasHuman ? null : "Choose a current human member of this project to change workflows.";
}

const actionMessages: Record<string, string> = {
  integration_required: "This action is not available on this server yet.",
  approval_integration_required: "Task approval is not available on this server yet.",
  human_required: "Choose a current human member of this project for this action.",
  verified_sign_in_required: "Sign in as a current human member of this project for this hosted action.",
  verified_member_required: "A current non-viewer project membership is required.",
  workflow_owner_required: "Only this workflow’s owner can make this change.",
  human_reviewer_required: "A current human reviewer is required.",
  workflow_participation_required: "Only this workflow’s owner or a participating agent can do this.",
  completion_not_authorized: "You do not have permission to accept this task result.",
  workflow_not_active: "The workflow must be active before this action is available.",
  project_not_active: "The project is not active.",
  workflow_completed: "Completed workflows are read-only.",
  workflow_not_completed: "Run again is available after a workflow is completed.",
  workflow_terminal: "This workflow has ended. Only permitted recovery actions remain available.",
  workflow_not_started: "Start the workflow before adding work as a participant.",
  prepared_selection_required: "Prepare at least one task first: open a draft task and choose Prepare, then Start can release it.",
  already_started: "This workflow has already started.",
  workflow_not_paused: "The workflow is not paused.",
  reservation_live: "The current worker or review turn must end first.",
  task_not_prepared: "Prepare this task before releasing it.",
  no_hold: "This task has no hold you can release.",
  hold_owner_required: "Only the person who set this hold or the workflow owner may release it.",
  hold_exists: "This task is already held by another person.",
  task_already_started: "This task has already started.",
  task_terminal: "This task has ended.",
  task_not_waiting: "This task is not waiting. Stop its worker or wait for the current attempt.",
  task_withdrawn: "This task was withdrawn from scope.",
  task_has_dependents: "Resolve this task’s remaining dependents first.",
  last_required_task: "The last required task cannot be withdrawn.",
  task_history_present: "A task with work or review history cannot be moved.",
  no_running_worker: "There is no running worker to stop.",
  stop_already_requested: "A stop has already been requested. Use Send stop again if needed.",
  stop_not_pending: "There is no pending stop request.",
  already_released: "This worker has already been released.",
  release_not_yet_available: "Wait until the server confirms that lost-worker release is available.",
  owner_decision_required: "This task is waiting for its owner’s decision.",
  owner_evidence_pending: "Review or withdraw the pending outside result first.",
  evidence_not_pending: "There is no pending outside result to withdraw.",
  outside_result_not_allowed: "An outside result cannot be submitted in this task’s current state.",
  missing_evidence_required: "Only missing evidence can be replaced here.",
  worker_live: "Wait for the worker to finish before replacing evidence.",
  not_awaiting_review: "This task is not awaiting acceptance.",
  evidence_version_stale: "The saved evidence changed. Refresh and review it again.",
  evidence_not_saved: "Wait for evidence to finish saving before accepting.",
  evidence_missing: "Add or restore the missing evidence before accepting.",
  review_loop_unavailable: "There are no open review findings to resolve.",
  withdrawal_not_allowed: "This task cannot be withdrawn in its current state.",
  task_limit: "The workflow’s task limit has been reached.",
};

/** Per-action decisions are authoritative. The coarse write flag is owner-only;
 * a project owner can still receive permission for a safety hold or recovery. */
export function availableActionReason(capability: Capability, actions: AvailableAction[] | undefined, action: string, hasHuman: boolean): string | null {
  if (!hasHuman) return "Choose a current human member of this project to make this change.";
  if (capability.reason === "integration_required" || capability.reason === "local_workflow_writes_unavailable") return workflowWriteReason(capability, hasHuman);
  const available = actions?.find((a) => a.action === action);
  if (available?.enabled === true) return null;
  return actionMessages[available?.reason ?? ""] ?? "This action is not available in the current state. Refresh to check for changes.";
}

export function actionReason(detail: WorkflowDetail, action: string, hasHuman: boolean): string | null {
  if (detail.hidden && action !== "restore" && action !== "run_again") return "Restore this hidden workflow before making changes.";
  return availableActionReason(detail.capability, detail.available_actions, action, hasHuman);
}

export function objectiveActionReason(detail: WorkflowDetail, id: string, action: string, hasHuman: boolean): string | null {
  return availableActionReason(detail.capability, detail.objectives.find((o) => o.id === id)?.available_actions, action, hasHuman);
}

export function workflowLabel(workflow: WorkflowDetail): string {
  if (workflow.status === "active" && !workflow.launch_enabled) return "Preparing";
  if (workflow.status === "active" && workflow.completion.can_finish) return "Ready to finish";
  return { active: "Active", paused: "Paused", completed: "Completed", cancelled: "Cancelled" }[workflow.status];
}

/** Mirrors the server's prepare rule: in a Workflow that has already started, the FIRST prepare of a
 *  start-held task also releases that hold (Start only releases what was prepared when it ran). */
export function prepareReleasesHold(workflow: Pick<WorkflowDetail, "launch_enabled">, task: { start_hold: boolean; preparation_state: string | null }): boolean {
  return workflow.launch_enabled && task.start_hold && task.preparation_state !== "prepared";
}

export function hasWorkflowRoutes(spec: unknown): boolean {
  if (!spec || typeof spec !== "object" || !("paths" in spec) || !spec.paths || typeof spec.paths !== "object") throw new Error("OpenAPI paths unavailable");
  return Object.entries(spec.paths).some(([path, operations]) => /^\/api\/containers\/\{[^}]+\}\/workflows$/.test(path)
    && operations !== null && typeof operations === "object" && "get" in operations);
}
