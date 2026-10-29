import { useEffect, useRef } from "react";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { actionReason, workflowPaths, workflowRequest } from "./workflowApi";
import type { WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";
import { useDialogOpen, type DialogControl } from "./workflowDialogs";

export function WorkflowRunAgain({ detail, scope, verified, stale, control, onSaved }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean;
  control: DialogControl; onSaved: (result: WorkflowDetail) => void;
}) {
  const [open, setOpen] = useDialogOpen(control);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const slot = `workflow:${detail.id}`;
  const operation = useWorkflowOperation(scope, slot);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  const reason = actionReason(detail, "run_again", verified);
  const url = workflowPaths.detail(detail.id) + "/run_again";
  const saved = (result: WorkflowDetail) => { setOpen(false); onSaved(result); };
  const close = () => { if (!unresolved) setOpen(false); };
  async function createDraft() {
    if (stale || unresolved || reason) return;
    // The response is a NEW workflow. Scope-check its project, not the source id.
    const result = await sendWorkflowOperation(scope, slot, {
      operation: "run_again", url, body: { expected_revision: detail.revision },
    });
    if (active.current && result.state === "saved" && result.result) saved(result.result);
  }
  if (!open) return null;
  return <Dialog title="Run again" className="wf-page" onClose={close}
    footer={<><Button disabled={unresolved} onClick={close}>Cancel</Button>
      <Button variant="primary" disabled={stale || unresolved || !!reason} onClick={() => void createDraft()}>Create editable draft</Button></>}>
    <p>Create a new draft from “{detail.title}” in this project. You will own the draft and can change its setup before choosing Start.</p>
    <p>The completed workflow and its history stay as they are. Earlier results and approvals are not copied.</p>
    <p>Unavailable assignees will need replacements. Only the project owner can carry over automatic approval settings.</p>
    {reason && <p className="wf-notice">{reason}</p>}
    <WorkflowOperationNotice scope={scope} slot={slot} onSaved={saved} canRetry={async () => {
      if (operation?.operation !== "run_again" || operation.url !== url) return false;
      const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
      return latest.id === detail.id && latest.container_id === scope.project && !actionReason(latest, "run_again", verified);
    }} />
  </Dialog>;
}
