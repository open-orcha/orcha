import { useEffect, useState } from "react";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { actionReason, availableActionReason, workflowPaths } from "./workflowApi";
import { WorkflowChange } from "./WorkflowChange";
import type { EvidenceReference, WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { useWorkflowOperation } from "./workflowOperations";
import { WorkflowEvidencePanel } from "./WorkflowEvidence";
import { useDialogOpen, type DialogControl } from "./workflowDialogs";

export function WorkflowReviewEditor({ detail, scope, verified, stale, agents, onSaved, control }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; agents: { id: string; alias: string }[]; onSaved: (detail: WorkflowDetail) => void; control?: DialogControl;
}) {
  const [open, setOpen] = useDialogOpen(control);
  useEffect(() => { if (control?.open) setReference(null); }, [control?.open]);
  const [draft, setDraft] = useWorkflowForm(scope, `round:${detail.id}`, { loop: "", newLoop: crypto.randomUUID(), review: "", reviewed: "",
    outcome: "changes_requested", pair: false, correction: { key: crypto.randomUUID(), title: "", criteria: "", assignee: "" }, next: { key: crypto.randomUUID(), title: "", criteria: "", assignee: "" } });
  const [reference, setReference] = useState<EvidenceReference | null>(null);
  const op = useWorkflowOperation(scope, `workflow:${detail.id}`);
  const frozen = stale || op?.state === "sending" || op?.state === "uncertain";
  const rounds = [...new Map((detail.review_rounds ?? []).slice().sort((a, b) => a.round_number - b.round_number).map((round) => [round.loop_key, round])).values()];
  const invalid = actionReason(detail, "review_round", verified) || (!draft.review || !draft.reviewed || !reference ? "Choose the review task, the task it reviewed and its current saved evidence."
    : draft.pair && draft.outcome === "changes_requested" && [draft.correction, draft.next].some((t) => !t.title.trim() || !t.criteria.trim() || !t.assignee) ? "Give both new tasks a title, completion criteria and assignee." : null);
  const taskBody = (task: typeof draft.correction) => ({ client_key: task.key, title: task.title.trim(), definition_of_done: task.criteria.trim(), description: "", assignee_id: task.assignee, priority: 100, depends_on: [] });
  return <>{!control && <Button disabled={stale || !!actionReason(detail, "review_round", verified)} onClick={() => { setReference(null); setOpen(true); }}>Record review outcome</Button>}
    {open && <Dialog title="Record review and next steps" className="wf-page" size="lg" onClose={() => { if (!frozen) setOpen(false); }} footer={<Button disabled={frozen} onClick={() => setOpen(false)}>Keep draft and close</Button>}>
      <p>The review outcome records findings. Acceptance of the delivered report is a separate action. Corrections and follow-up reviews use fresh tasks.</p>
      <fieldset disabled={frozen} className="wf-form-body">
        <label>Review sequence<select value={draft.loop} onChange={(e) => { const round = rounds.find((r) => r.loop_key === e.target.value); setDraft({ ...draft, loop: e.target.value, review: round?.review_task_id ?? "" }); setReference(null); }}>
          <option value="">New review sequence</option>{rounds.map((r) => <option key={r.loop_key} value={r.loop_key}>{detail.tasks.find((t) => t.id === r.review_task_id)?.title ?? "Review sequence"} — round {r.round_number}</option>)}</select></label>
        <label>Review task<select value={draft.review} disabled={!!draft.loop} onChange={(e) => setDraft({ ...draft, review: e.target.value })}><option value="">Choose a review task</option>{detail.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
        <label>Task that was reviewed<select value={draft.reviewed} onChange={(e) => { setDraft({ ...draft, reviewed: e.target.value }); setReference(null); }}><option value="">Choose the reviewed task</option>{detail.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
        {draft.reviewed && <WorkflowEvidencePanel key={draft.reviewed} detail={detail} taskId={draft.reviewed} selected={reference?.evidence_set_id} onSelect={(ref) => setReference(ref)} />}
        <label>Review outcome<select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}><option value="changes_requested">Changes requested</option><option value="accepted">Accepted</option><option value="inconclusive">Inconclusive</option></select></label>
        {draft.outcome === "changes_requested" && <label className="wf-choice"><input type="checkbox" checked={draft.pair} onChange={(e) => setDraft({ ...draft, pair: e.target.checked })} />Add a fresh correction and follow-up review together</label>}
        {draft.outcome === "changes_requested" && draft.pair && (["correction", "next"] as const).map((kind) => <fieldset key={kind}><legend>{kind === "correction" ? "Correction task" : "Follow-up review task"}</legend>
          <label>Task title<input maxLength={200} value={draft[kind].title} onChange={(e) => setDraft({ ...draft, [kind]: { ...draft[kind], title: e.target.value } })} /></label>
          <label>Done when<textarea maxLength={4000} value={draft[kind].criteria} onChange={(e) => setDraft({ ...draft, [kind]: { ...draft[kind], criteria: e.target.value } })} /></label>
          <label>Assignee<select value={draft[kind].assignee} onChange={(e) => setDraft({ ...draft, [kind]: { ...draft[kind], assignee: e.target.value } })}><option value="">Choose an assignee</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.alias}</option>)}</select></label>
          <p>{kind === "correction" ? "Depends on acceptance of the current review report." : "Depends on acceptance of the correction."} Task autonomy OFF.</p>
        </fieldset>)}
      </fieldset>
      <WorkflowChange detail={detail} scope={scope} verified={verified} stale={stale} operation="review_round" url={workflowPaths.detail(detail.id) + "/review-rounds"}
        label="Review outcome" invalid={invalid} body={{ loop_key: draft.loop || draft.newLoop, review_task_id: draft.review, reviewed_task_id: draft.reviewed, reviewed_artifact: reference, outcome: draft.outcome,
          correction: draft.pair && draft.outcome === "changes_requested" ? taskBody(draft.correction) : null, next_review: draft.pair && draft.outcome === "changes_requested" ? taskBody(draft.next) : null, reason: "" }}
        check={(latest) => actionReason(latest, "review_round", verified) || (latest.revision !== detail.revision ? "The workflow changed. Refresh before confirming the review outcome." : null)}
        onSaved={(result) => { setOpen(false); setReference(null); onSaved(result); }}>
        {() => <p>{draft.pair && draft.outcome === "changes_requested" ? "Two fresh tasks will be requested as one change, subject to workflow limits. Existing reviews are not reopened." : "Record the outcome without adding tasks."} Goal acceptance will need review again. This does not finish the workflow.</p>}
      </WorkflowChange>
    </Dialog>}
  </>;
}

export function WorkflowResolveReview({ detail, scope, verified, stale, reviewTaskId, onSaved }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; reviewTaskId: string; onSaved: (detail: WorkflowDetail) => void;
}) {
  const [reason, setReason] = useWorkflowForm(scope, `resolve:${detail.id}:${reviewTaskId}`, "");
  const check = (latest: WorkflowDetail) => availableActionReason(latest.capability,
    latest.tasks.find((t) => t.id === reviewTaskId)?.available_actions, "resolve_loop", verified);
  return <details><summary>Resolve findings by owner decision</summary><p>This keeps the original report and records your reason. It does not accept the report, add correction tasks or finish the workflow.</p>
    <label>Reason for resolving<textarea maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    <WorkflowChange detail={detail} scope={scope} verified={verified} stale={stale} operation="resolve_loop" url={workflowPaths.detail(detail.id) + `/review-loops/${encodeURIComponent(reviewTaskId)}/resolve`}
      label="Owner resolution" body={{ reason: reason.trim() }} invalid={!reason.trim() ? "Explain why these findings are resolved." : check(detail)} check={check} onSaved={onSaved} />
  </details>;
}
