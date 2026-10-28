import { useState, type ReactNode } from "react";
import { Button } from "../../components/primitives/Button";
import { workflowPaths, workflowRequest, workflowWriteReason } from "./workflowApi";
import type { WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";

/** Shared current-revision review and receipt boundary for owner forms. Form
 * inputs stay separate from confirmations: any edit consumes the preview. */
export function WorkflowChange({ detail, scope, verified, stale, operation, url, method = "POST", body, invalid, label, check, children, onSaved }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean;
  operation: string; url: string; method?: "POST" | "PATCH" | "PUT";
  body: Record<string, unknown>; invalid?: string | null; label: string;
  check?: (latest: WorkflowDetail) => string | null;
  children?: (latest: WorkflowDetail) => ReactNode;
  onSaved: (detail: WorkflowDetail) => void;
}) {
  const [preview, setPreview] = useState<{ basis: string; detail: WorkflowDetail } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slot = `workflow:${detail.id}`;
  const op = useWorkflowOperation(scope, slot);
  const unresolved = op?.state === "sending" || op?.state === "uncertain";
  const basis = JSON.stringify([detail.revision, url, method, body]);
  const current = preview?.basis === basis ? preview.detail : null;
  const guard = (latest: WorkflowDetail) => latest.id !== detail.id || latest.container_id !== scope.project
    ? "This workflow changed. Open it again from its project."
    : !verified ? "Choose a current human member of this project to make this change."
    : latest.capability.reason === "integration_required" || latest.capability.reason === "local_workflow_writes_unavailable"
      ? workflowWriteReason(latest.capability, verified)
    : check ? check(latest) : workflowWriteReason(latest.capability, verified);
  async function review() {
    if (stale || unresolved || invalid || busy) return;
    setPreview(null); setError(""); setBusy(true);
    try {
      const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
      const reason = guard(latest);
      if (reason) throw new Error(reason);
      setPreview({ basis, detail: latest });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not review this change. Your draft is kept."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!current || invalid || stale || unresolved || busy || guard(current)) return;
    const result = await sendWorkflowOperation(scope, slot, { operation, url, method, expectedWorkflowId: detail.id,
      body: { ...body, expected_revision: current.revision } });
    setPreview(null);
    if (result.state === "saved" && result.result) onSaved(result.result);
  }
  return <section aria-label={`Review ${label}`}>
    {invalid && <p>{invalid}</p>}
    {guard(detail) && <p>{guard(detail)}</p>}
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Checking the latest workflow…</p>}
    <Button disabled={busy || unresolved || stale || !!invalid || !!guard(detail)} onClick={() => void review()}>Review {label.toLowerCase()}</Button>
    {current && <><p>Review this change against the current saved workflow. Nothing has been saved yet.</p>{children?.(current)}
      <Button variant="primary" disabled={!!invalid || stale || unresolved || busy || !!guard(current)} onClick={() => void confirm()}>Confirm {label.toLowerCase()}</Button></>}
    <WorkflowOperationNotice scope={scope} slot={slot} onSaved={onSaved} canRetry={async () => op?.operation === operation && op.url === url && !guard(await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity }))} />
  </section>;
}
