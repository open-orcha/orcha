import { useState } from "react";
import { actionReason, objectiveActionReason, workflowPaths } from "./workflowApi";
import { WorkflowChange } from "./WorkflowChange";
import type { EvidenceBasis, WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { WorkflowEvidenceBasis } from "./WorkflowEvidence";
import { useWorkflowForm } from "./workflowFormState";
import { useWorkflowOperation } from "./workflowOperations";

export function WorkflowAcceptance({ detail, scope, verified, stale, objectiveId, onSaved }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; objectiveId?: string; onSaved: (detail: WorkflowDetail) => void;
}) {
  const objective = detail.objectives.find((o) => o.id === objectiveId);
  const action = objectiveId ? "accept_objective" : "accept_goal";
  const permission = (latest: WorkflowDetail) => objectiveId ? objectiveActionReason(latest, objectiveId, action, verified) : actionReason(latest, action, verified);
  const [narrative, setNarrative] = useWorkflowForm(scope, `acceptance:${detail.id}:${objectiveId ?? "goal"}`, "");
  // Saved-file choices must be reviewed again after navigating away. Only the
  // person's unsent text is retained; a previous confirmation is never reused.
  const [basis, setBasis] = useState<EvidenceBasis>({ narrative: "", task_revisions: {}, evidence_sets: [] });
  const op = useWorkflowOperation(scope, `workflow:${detail.id}`);
  const frozen = stale || op?.state === "sending" || op?.state === "uncertain";
  const invalid = !detail.evidence_capability?.available ? "Saved evidence must be available before acceptance."
    : permission(detail) || (!narrative.trim() || !basis.evidence_sets?.length ? "Explain the decision and select the current saved evidence before reviewing." : null);
  return <section aria-label={objective ? `Accept objective ${objective.title}` : "Accept current goal"}>
    <h4>{objective ? `Accept objective: ${objective.title}` : "Accept current goal"}</h4><p>{objective?.criteria ?? detail.goal}</p>
    <WorkflowEvidenceBasis detail={detail} value={{ ...basis, narrative }} disabled={frozen || !!permission(detail)}
      onChange={(next) => { setBasis(next); setNarrative(next.narrative); }} />
    <WorkflowChange detail={detail} scope={scope} verified={verified} stale={stale} operation={action}
      url={workflowPaths.detail(detail.id) + (objectiveId ? `/objectives/${encodeURIComponent(objectiveId)}/accept` : "/goal/accept")}
      label={objective ? "Objective acceptance" : "Goal acceptance"} body={{ evidence: { ...basis, narrative: narrative.trim() }, reason: "" }} invalid={invalid}
      check={(latest) => permission(latest) || (!latest.evidence_capability?.available ? "Saved evidence is unavailable." : null)
        || (Object.entries(basis.task_revisions ?? {}).some(([id, revision]) => latest.tasks.find((t) => t.id === id)?.work_revision !== revision)
          || basis.evidence_sets?.some((set) => !latest.tasks.some((t) => t.current_evidence_set_id === set.evidence_set_id && basis.task_revisions?.[t.id] === t.work_revision)) ? "The selected evidence changed. Read the current saved evidence and select it again." : null)
        || (latest.revision !== detail.revision ? "The workflow changed. Refresh this checklist and review the evidence again." : null)} onSaved={onSaved}>
      {() => <><p>This records acceptance against the selected task revisions and exact saved file versions. It does not finish the workflow.</p>
        <p>{basis.evidence_sets?.reduce((n, set) => n + set.items.length, 0)} exact file versions will be recorded with your decision.</p></>}
    </WorkflowChange>
  </section>;
}
