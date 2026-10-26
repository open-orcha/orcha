import { useSyncExternalStore } from "react";
import { workflowPaths, workflowRequest, WorkflowApiError } from "./workflowApi";
import type { WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";

export interface WorkflowOperation {
  operation: string;
  key: string;
  url: string;
  method: "POST" | "PATCH" | "PUT";
  expectedWorkflowId?: string;
  body: Record<string, unknown>;
  state: "sending" | "uncertain" | "saved" | "refused";
  result?: WorkflowDetail;
  message?: string;
}
const operations = new Map<string, WorkflowOperation>();
const listeners = new Set<() => void>();
function publish(key: string, op: WorkflowOperation) { operations.set(key, op); listeners.forEach((fn) => fn()); }
const scopeKey = (scope: DraftScope, slot: string) => JSON.stringify([scope.origin, scope.project, scope.identity, slot]);
export const pendingOperation = (scope: DraftScope, slot: string) => operations.get(scopeKey(scope, slot));
export function useWorkflowOperation(scope: DraftScope, slot: string) {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => pendingOperation(scope, slot));
}

/** Keep the exact request/key across navigation and lost responses. No offline
 * queue, automatic replay, or new key while the original outcome is uncertain. */
export async function sendWorkflowOperation(scope: DraftScope, slot: string,
  request: { operation: string; url: string; method?: "POST" | "PATCH" | "PUT"; expectedWorkflowId?: string; body: Record<string, unknown> },
  replay = false): Promise<WorkflowOperation> {
  const storage = scopeKey(scope, slot);
  const previous = operations.get(storage);
  if (previous?.state === "sending") return previous;
  if (previous?.state === "uncertain" && !replay) return previous;
  if (replay && previous?.state !== "uncertain") throw new Error("No uncertain request to retry");
  const op: WorkflowOperation = replay ? { ...previous!, state: "sending" }
    : { ...request, method: request.method ?? "POST", body: structuredClone(request.body), key: crypto.randomUUID(), state: "sending" };
  publish(storage, op);
  try {
    const result = await workflowRequest("WorkflowDetail", op.url, { method: op.method, body: { ...op.body, idempotency_key: op.key }, actorId: scope.identity });
    if (result.container_id !== scope.project || (op.expectedWorkflowId && result.id !== op.expectedWorkflowId)) throw new WorkflowApiError("The response could not be matched to this workflow. Check the save receipt.", 0, "scope_mismatch", true);
    op.state = "saved"; op.result = result;
  } catch (error) {
    op.state = error instanceof WorkflowApiError && !error.uncertain ? "refused" : "uncertain";
    op.message = op.state === "uncertain" ? "The outcome is not confirmed. Your draft and the original request are kept. Check the saved result before trying again."
      : error instanceof Error ? error.message : "Orcha refused this change. Review the latest state before confirming again.";
  }
  publish(storage, { ...op });
  return { ...op };
}

export async function checkWorkflowOperation(scope: DraftScope, slot: string): Promise<WorkflowOperation | undefined> {
  const op = pendingOperation(scope, slot);
  if (!op || op.state !== "uncertain") return op;
  const receipt = await workflowRequest("Receipt", workflowPaths.receipt(scope.project, op.key, op.operation), { actorId: scope.identity });
  if (receipt.idempotency_key !== op.key || receipt.operation !== op.operation ||
    (receipt.status === "saved" && (!receipt.result || receipt.result.container_id !== scope.project || (op.expectedWorkflowId && receipt.result.id !== op.expectedWorkflowId)))) {
    throw new WorkflowApiError("The saved result could not be matched to this request. Keep this draft and check again.");
  }
  const next: WorkflowOperation = receipt.status === "saved" ? { ...op, state: "saved", result: receipt.result!, message: undefined }
    : { ...op, message: "No saved receipt was found yet. The original request may still be running. Check again, or retry the exact same request." };
  publish(scopeKey(scope, slot), next);
  return next;
}
