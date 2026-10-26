import { objectiveActionReason, workflowPaths } from "./workflowApi";
import { WorkflowChange } from "./WorkflowChange";
import type { WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { useWorkflowOperation } from "./workflowOperations";

export function WorkflowObjectiveEditor({ detail, objectiveId, scope, verified, stale, onSaved }: {
  detail: WorkflowDetail; objectiveId: string; scope: DraftScope; verified: boolean; stale: boolean; onSaved: (detail: WorkflowDetail) => void;
}) {
  const objective = detail.objectives.find((o) => o.id === objectiveId)!;
  const [draft, setDraft] = useWorkflowForm(scope, `objective:${detail.id}:${objectiveId}`, { title: objective.title, criteria: objective.criteria, reason: "" });
  const op = useWorkflowOperation(scope, `workflow:${detail.id}`);
  const check = (latest: WorkflowDetail) => objectiveActionReason(latest, objectiveId, "edit_objective", verified);
  const frozen = stale || op?.state === "sending" || op?.state === "uncertain" || !!check(detail);
  return <details><summary>Edit objective: {objective.title}</summary>
    <p>Changing this objective requires its acceptance and the goal acceptance to be reviewed again. Existing evidence stays in the history.</p>
    <fieldset className="wf-form-body" disabled={frozen}>
      <label>Objective title<input maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
      <label>Objective done when<textarea maxLength={4000} value={draft.criteria} onChange={(e) => setDraft({ ...draft, criteria: e.target.value })} /></label>
      <label>Reason for changing objective<textarea maxLength={4000} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} /></label>
    </fieldset>
    <WorkflowChange detail={detail} scope={scope} verified={verified} stale={stale} operation="edit_objective" method="PATCH"
      url={workflowPaths.detail(detail.id) + `/objectives/${encodeURIComponent(objectiveId)}`} label="Objective change"
      body={{ title: draft.title.trim(), criteria: draft.criteria.trim(), reason: draft.reason.trim() }} check={check}
      invalid={!draft.title.trim() || !draft.criteria.trim() || !draft.reason.trim() ? "Give the objective a title, completion criteria and reason for changing it." : null} onSaved={onSaved}>
      {(latest) => <><p>Current: {latest.objectives.find((o) => o.id === objectiveId)?.criteria}</p><p>Proposed: {draft.criteria}</p></>}
    </WorkflowChange>
  </details>;
}
