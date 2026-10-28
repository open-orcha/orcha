/**
 * Workflow property rail (issue #350 §4.2 callout 7): Properties · Objectives · Finish blockers.
 * Read-only mirror of the loaded `WorkflowDetail`; every value is the server's.
 */
import { Avatar, Chip, Property, PropertyRail, PropertySection, StatusIcon } from "../../components/primitives";
import { workflowLabel } from "./workflowApi";
import type { WorkflowDetail } from "./workflowContract.generated";
import { MODE_LABEL, workflowStatusIcon } from "./WorkflowListView";
import { WorkflowTaskLink } from "./WorkflowTaskReturn";

export function WorkflowRail({ detail, ownerName, cid, className }: { detail: WorkflowDetail; ownerName: string; cid: string; className?: string }) {
  const goalAccepted = detail.goal_accepted_revision === detail.goal_revision;
  const objectivesAccepted = detail.objectives.filter((o) => o.accepted_revision === o.revision).length;
  return <PropertyRail label="Workflow properties" className={`wf-rail${className ? ` ${className}` : ""}`}>
    <PropertySection title="Properties">
      <Property label="Owner"><span className="wf-owner"><Avatar alias={ownerName} kind="human" size={16} decorative />{ownerName}</span></Property>
      <Property label="Status"><StatusIcon status={workflowStatusIcon(detail)} label={workflowLabel(detail)} showLabel /></Property>
      <Property label="How work runs" hint={MODE_LABEL[detail.execution_mode].long}>{MODE_LABEL[detail.execution_mode].short}</Property>
      <Property label="Tasks">{detail.progress.accepted} of {detail.progress.total} accepted</Property>
      <Property label="Objectives">{detail.progress.objectives_accepted} of {detail.progress.objectives_total} accepted</Property>
      <Property label="Goal" layout="stack"><Chip dot={goalAccepted ? "ok" : "warn"}>{goalAccepted ? "Accepted" : "Needs acceptance"}</Chip><span className="wf-muted wf-goal-full">{detail.goal}</span></Property>
      <Property label="Withdrawn" empty="None">{detail.progress.withdrawn > 0 ? `${detail.progress.withdrawn} ${detail.progress.withdrawn === 1 ? "task" : "tasks"}` : null}</Property>
      <Property label="Task limit">{detail.task_limit}</Property>
      <Property label="Review rounds">{detail.review_rounds === undefined ? "Unavailable on this server" : `${detail.review_rounds.length} of ${detail.round_limit}`}</Property>
      <Property label="Revision"><span className="v2-t-id">{detail.revision}</span></Property>
      {detail.hidden ? <Property label="Hidden">{detail.hidden_by_alias ? `By ${detail.hidden_by_alias}` : "Yes"}</Property> : null}
    </PropertySection>
    <PropertySection title="Objectives" actions={<span className="v2-count tnum">{objectivesAccepted}/{detail.objectives.length}</span>}>
      {detail.objectives.length === 0 ? <p className="wf-muted">No objectives.</p>
        : <ul className="wf-check">{detail.objectives.map((o) => <li key={o.id} title={o.criteria}>
          <StatusIcon status={o.accepted_revision === o.revision ? "completed" : "pending"} label={o.accepted_revision === o.revision ? "Accepted" : "Needs acceptance"} />
          <span className="t">{o.title}</span>
        </li>)}</ul>}
    </PropertySection>
    <PropertySection title="Finish blockers" actions={<span className={`v2-count tnum${detail.completion.blockers.length ? " v2-tone-warn" : ""}`}>{detail.completion.blockers.length}</span>}>
      {detail.completion.blockers.length === 0 ? <p className="wf-muted">{detail.completion.can_finish ? "Ready to finish." : "None reported."}</p>
        : <ul className="wf-blockers">{detail.completion.blockers.map((b, i) => <li key={i} className="is-warn">
          <span>{b.message}{b.task_id && <> <WorkflowTaskLink cid={cid} taskId={b.task_id}>Open task</WorkflowTaskLink></>}</span>
        </li>)}</ul>}
    </PropertySection>
  </PropertyRail>;
}
