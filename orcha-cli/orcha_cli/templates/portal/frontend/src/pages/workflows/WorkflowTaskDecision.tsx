import { useState } from "react";
import { Button } from "../../components/primitives/Button";
import { availableActionReason, workflowPaths, workflowRequest } from "./workflowApi";
import { evidenceReference, evidenceSupplier, evidenceUsable, WorkflowEvidencePanel, type EvidenceSupplier } from "./WorkflowEvidence";
import type { EvidenceReference, WorkflowDetail, WorkflowTask } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";

/** Plan approval and result acceptance are different decisions. This form only
 * accepts/rejects the exact submitted result, using the workflow receipt route. */
export function WorkflowTaskDecision({ detail, task, scope, verified, stale, onSaved }: {
  detail: WorkflowDetail; task: WorkflowTask; scope: DraftScope; verified: boolean; stale: boolean;
  onSaved: (detail: WorkflowDetail) => void;
}) {
  const [action, setAction] = useState<"accept" | "reject">("accept");
  const [reason, setReason] = useWorkflowForm(scope, `task:${task.id}:decision`, "");
  const [evidence, setEvidence] = useState<EvidenceReference | null>(null);
  const [supplier, setSupplier] = useState<EvidenceSupplier | null>(null);
  const [supplierRequired, setSupplierRequired] = useState(false);
  const [preview, setPreview] = useState<{ detail: WorkflowDetail; basis: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slot = `workflow:${detail.id}`;
  const operation = useWorkflowOperation(scope, slot);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  const permission = (current: WorkflowDetail, verb = action) => {
    if (current.hidden) return "Restore this hidden workflow before reviewing work.";
    const target = current.tasks.find((t) => t.id === task.id);
    return current.id !== detail.id || current.container_id !== scope.project || !target
      ? "This task is no longer in this workflow. Refresh before continuing."
      : availableActionReason(current.capability, target.available_actions, verb, verified);
  };
  const basis = JSON.stringify([detail.revision, task.work_revision, action, reason, evidence]);
  const current = preview?.basis === basis ? preview.detail : null;
  const invalid = permission(detail) || (action === "accept"
    ? !detail.evidence_capability?.available || !evidence || evidence.evidence_set_id !== task.current_evidence_set_id
      ? "Read and select the current saved evidence before accepting."
      : supplierRequired && !supplier ? "Result supplier attribution is unavailable. This outside result cannot be accepted safely." : null
    : !reason.trim() ? "Explain what needs to change before requesting changes." : null);

  async function review() {
    if (busy || stale || unresolved || invalid) return;
    setBusy(true); setPreview(null); setError("");
    try {
      const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
      const blocked = permission(latest);
      if (blocked) throw new Error(blocked);
      const target = latest.tasks.find((t) => t.id === task.id)!;
      if (latest.revision !== detail.revision || target.work_revision !== task.work_revision) {
        throw new Error("The task changed. Refresh it and review the current result; your feedback is kept.");
      }
      if (action === "accept") {
        const saved = await workflowRequest("WorkflowTaskEvidence", workflowPaths.detail(detail.id) + `/tasks/${encodeURIComponent(task.id)}/evidence`, { actorId: scope.identity });
        const selected = saved.sets.find((set) => set.evidence_set_id === evidence?.evidence_set_id);
        const refreshedSupplier = selected ? evidenceSupplier(selected) : { required: false, supplier: null };
        if (!latest.evidence_capability?.available || saved.task_id !== task.id || saved.workflow_id !== detail.id || !selected
          || selected.task_id !== task.id || selected.workflow_id !== detail.id
          || saved.current_evidence_set_id !== target.current_evidence_set_id || selected.evidence_set_id !== target.current_evidence_set_id
          || !evidenceUsable(selected, target.work_revision) || JSON.stringify(evidenceReference(selected)) !== JSON.stringify(evidence)
          || refreshedSupplier.required !== supplierRequired || JSON.stringify(refreshedSupplier.supplier) !== JSON.stringify(supplier)) {
          setEvidence(null); setSupplier(null); setSupplierRequired(false);
          throw new Error("The saved evidence changed or is unavailable. Read the current files and select them again.");
        }
        if (refreshedSupplier.required && !refreshedSupplier.supplier) {
          throw new Error("Result supplier attribution is unavailable. This outside result cannot be accepted safely.");
        }
      }
      setPreview({ detail: latest, basis });
    } catch (e) { setError(e instanceof Error ? e.message : "The result could not be checked. Your feedback is kept."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!current || invalid || stale || unresolved || busy || permission(current)) return;
    const result = await sendWorkflowOperation(scope, slot, { operation: action, expectedWorkflowId: detail.id,
      url: `/api/tasks/${encodeURIComponent(task.id)}/${action}`, body: {
        expected_revision: current.revision, expected_work_revision: task.work_revision, reason: reason.trim(),
        ...(action === "accept" ? { evidence } : {}),
      } });
    setPreview(null);
    if (result.state === "saved" && result.result) onSaved(result.result);
  }
  return <section aria-label={`Review result for ${task.title}`} className="wf-form-body">
    <h3>Review finished work</h3>
    <p>Done when: {task.definition_of_done}</p>
    <p>This decision is about the finished result, separate from its plan approval. Accepting a result never finishes the workflow.</p>
    <div className="wf-review">
    <div className="wf-review-evidence">
    <fieldset disabled={busy || unresolved || stale || !!permission(detail)}><legend>Saved result to review</legend>
      <WorkflowEvidencePanel key={`${detail.id}:${task.id}:${task.work_revision}:${task.current_evidence_set_id}`} detail={detail} taskId={task.id}
        selected={evidence?.evidence_set_id} onSelect={action === "accept" ? (next, _revision, selected) => {
          const attribution = selected ? evidenceSupplier(selected) : { required: false, supplier: null };
          setEvidence(next); setSupplier(attribution.supplier); setSupplierRequired(attribution.required); setPreview(null);
        } : undefined} />
    </fieldset>
    </div>
    <div className="wf-review-decision">
    <fieldset disabled={busy || unresolved || stale}><legend>Decision</legend>
      <label className="wf-choice"><input type="radio" name={`decision-${task.id}`} checked={action === "accept"} onChange={() => setAction("accept")} />Accept result</label>
      <label className="wf-choice"><input type="radio" name={`decision-${task.id}`} checked={action === "reject"} onChange={() => setAction("reject")} />Request changes</label>
      <label>{action === "reject" ? "What needs to change" : "Review note (optional)"}<textarea maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    </fieldset>
    {action === "accept" && supplierRequired && supplier && <p>Result supplied by {supplier.alias} ({supplier.kind === "human" ? "person" : "agent"}). {supplier.id === scope.identity
      ? "You supplied this outside result; accepting your own result is allowed and will be recorded."
      : "The supplier and acceptor will be recorded separately."}</p>}
    {invalid && <p>{invalid}</p>}{error && <p role="alert">{error}</p>}
    <Button disabled={busy || stale || unresolved || !!invalid} onClick={() => void review()}>{busy ? "Checking result…" : "Review decision"}</Button>
    {current && <>
      <p>{action === "accept" ? `Accept work revision ${task.work_revision} with ${evidence?.items.length} exact saved file versions. Holds and worker shutdown rules remain in effect.`
        : "Your feedback is recorded against this result. The owner decides what happens next; this does not restart the agent. A running worker must still stop."}</p>
      <Button variant={action === "reject" ? "danger" : "primary"} disabled={busy || stale || unresolved || !!invalid || !!permission(current)} onClick={() => void confirm()}>
        {action === "accept" ? "Confirm accept result" : "Confirm request changes"}
      </Button>
    </>}
    </div></div>
    <WorkflowOperationNotice scope={scope} slot={slot} onSaved={onSaved} canRetry={async () => {
      const verb = operation?.operation;
      if (!operation || (verb !== "accept" && verb !== "reject") || operation.url !== `/api/tasks/${encodeURIComponent(task.id)}/${verb}` || stale) return false;
      return !permission(await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity }), verb);
    }} />
  </section>;
}
