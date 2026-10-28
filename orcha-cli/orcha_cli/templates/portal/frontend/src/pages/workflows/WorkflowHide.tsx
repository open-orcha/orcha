/**
 * Hide or restore a workflow (issue #350 §4.14). The header menu opens it; every opening runs
 * the server's visibility check, which alone decides eligibility — the loaded detail never does.
 * Hiding keeps tasks, messages and evidence; restoring never starts work.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { actionReason, workflowPaths, workflowRequest } from "./workflowApi";
import type { VisibilityCheck, WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";
import { useDialogOpen, type DialogControl } from "./workflowDialogs";

export type WorkflowVisibilityMode = "hide" | "restore";
const copy: Record<WorkflowVisibilityMode, { title: string; keep: string; effects: string; unavailable: string }> = {
  hide: { title: "Hide workflow", keep: "Keep visible", unavailable: "This workflow cannot be hidden right now. Check again later.",
    effects: "Removes this workflow from the usual list. Its tasks and messages stay. Workflow details disappear from ordinary task views. You can restore it from Hidden workflows." },
  restore: { title: "Restore workflow", keep: "Keep hidden", unavailable: "This workflow cannot be restored right now. Check again later.",
    effects: "Puts this workflow back in the usual list with its previous status. No worker starts and nothing changes in its tasks." },
};

export function WorkflowHide({ detail, scope, verified, stale, mode, control, onSaved }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; mode: WorkflowVisibilityMode; control: DialogControl; onSaved: (result: WorkflowDetail) => void;
}) {
  const [open, setOpen] = useDialogOpen(control);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [check, setCheck] = useState<VisibilityCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slot = `workflow:${detail.id}`;
  const url = workflowPaths.detail(detail.id) + `/${mode}`;
  const operation = useWorkflowOperation(scope, slot);
  const sending = operation?.state === "sending";
  const unresolved = sending || operation?.state === "uncertain";
  async function review() {
    setCheck(null); setError(""); setBusy(true);
    try {
      const result = await workflowRequest("VisibilityCheck", workflowPaths.detail(detail.id) + "/visibility-check", { actorId: scope.identity });
      if (active.current) setCheck(result);
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : "Could not check this workflow."); }
    finally { if (active.current) setBusy(false); }
  }
  // Each opening runs a fresh server check; the loaded detail never decides eligibility.
  useEffect(() => { if (open) void review(); }, [open, mode, detail.id]);
  // A refreshed detail with another revision invalidates the check; the person checks again.
  const changed = !!check && check.revision !== detail.revision;
  const eligible = !!check && (mode === "hide" ? check.can_hide : check.can_restore);
  const reason = actionReason(detail, mode, verified);
  const blockers = check?.blockers ?? [];
  const needsCancellation = mode === "hide" && !!check && !check.can_hide && (check.status === "active" || check.status === "paused");
  const confirmBlocked = busy || unresolved || stale || !check || changed || !eligible || !!reason;
  const close = () => { if (!unresolved) setOpen(false); };
  const saved = (result: WorkflowDetail) => { onSaved(result); setOpen(false); };
  async function confirm() {
    if (confirmBlocked || !check) return;
    const result = await sendWorkflowOperation(scope, slot, { operation: mode, url, expectedWorkflowId: detail.id, body: { expected_revision: check.revision } });
    if (!active.current) return;
    if (result.state === "saved" && result.result) saved(result.result);
    // Refusal consumes the check: the person must check again before confirming.
    else if (result.state === "refused") setCheck(null);
  }
  if (!open) return null;
  return <Dialog title={copy[mode].title} className="wf-page" onClose={close}
    footer={<><Button disabled={unresolved} onClick={close}>{copy[mode].keep}</Button>
      <Button variant="primary" disabled={confirmBlocked} onClick={() => void confirm()}>{copy[mode].title}</Button></>}>
    {busy && <p role="status">Checking the current workflow…</p>}
    {error && <p role="alert">{error}</p>}
    {check && <>
      <p><strong>{check.title}</strong> · {check.task_count === 1 ? "1 task" : `${check.task_count} tasks`}</p>
      <p>{copy[mode].effects}</p>
      {reason && <p className="wf-notice">{reason}</p>}
      {blockers.length > 0 && <ul aria-label="Blockers">{blockers.map((b, i) => <li key={`${b.code}-${i}`}>{b.message}</li>)}</ul>}
      {needsCancellation && <p>Review cancellation from the workflow menu first.</p>}
      {!eligible && !blockers.length && !reason && <p className="wf-notice">{copy[mode].unavailable}</p>}
      {changed && <p className="wf-notice">The workflow changed. Check again.</p>}
    </>}
    {!busy && (!check || changed) && <Button onClick={() => void review()}>Check again</Button>}
    <WorkflowOperationNotice scope={scope} slot={slot} onSaved={saved} canRetry={async () => {
      if (operation?.operation !== mode || operation.url !== url) return false;
      const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
      return latest.id === detail.id && latest.container_id === scope.project && !actionReason(latest, mode, verified);
    }} />
  </Dialog>;
}
