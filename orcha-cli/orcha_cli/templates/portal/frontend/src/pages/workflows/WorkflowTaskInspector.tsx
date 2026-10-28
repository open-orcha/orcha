import { WorkflowDiscussion } from "./WorkflowDiscussion";
import { useWorkflowOperation } from "./workflowOperations";
/**
 * Task inspector (issue #350 §4.3): replaces the "Manage {task}" dialog. Header · State · Actions ·
 * Dependencies · Acceptance and saved evidence · Task authority. Escape closes (the page returns
 * focus to the row); the expand icon opens the task page. All action logic stays in
 * `WorkflowTaskActions` (inline mode); the result review (§4.5) opens `WorkflowTaskDecision`.
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { Avatar, Chip, Inspector, Section, StatusIcon, Tabs } from "../../components/primitives";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import type { WorkflowDetail, WorkflowTask } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { WorkflowEvidencePanel } from "./WorkflowEvidence";
import { WorkflowTaskAcceptanceRecord } from "./WorkflowTaskAcceptanceRecord";
import { taskReason, WorkflowTaskActions, type TaskActionRequest } from "./WorkflowTaskActions";
import { WorkflowTaskDecision } from "./WorkflowTaskDecision";
import { WorkflowTaskLink } from "./WorkflowTaskReturn";
import { WorkflowLoopDecision } from "./WorkflowLoopDecision";
import { WorkflowRoundContext } from "./WorkflowRoundContext";
import { formatServerTime } from "./WorkflowTaskRows";

export function WorkflowTaskInspector({ detail, task, cid, scope, verified, stale, agents, actorName, onSaved, onClose, onExpand, request, onRequest, reviewRequest }: {
  detail: WorkflowDetail; task: WorkflowTask; cid: string; scope: DraftScope; verified: boolean; stale: boolean;
  agents: { id: string; alias: string }[]; actorName: (id: string) => string;
  onSaved: (result: WorkflowDetail) => void; onClose: () => void; onExpand: () => void;
  request: TaskActionRequest | null; onRequest: (action: TaskActionRequest["action"]) => void;
  /** A row-menu "Review result…" request (§4.5); a new number opens the review dialog. */
  reviewRequest: number | null;
}) {
  const operation = useWorkflowOperation(scope, `workflow:${detail.id}`);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  const [view, setView] = useState("details");
  const [decisionOpen, setDecisionOpen] = useState(false);
  useEffect(() => { if (reviewRequest !== null && task.status === "needs_verification") setDecisionOpen(true); }, [reviewRequest, task.status]);
  const assignees = task.assignee_ids.map((id) => ({ id, alias: actorName(id) }));
  const prerequisites = task.depends_on.map((id) => ({ id, title: detail.tasks.find((p) => p.id === id)?.title ?? "Prerequisite unavailable" }));
  const dependents = detail.tasks.filter((other) => other.depends_on.includes(task.id)).map((other) => ({ id: other.id, title: other.title }));
  const warning = task.display_state.warning;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => { if (e.key === "Escape" && !decisionOpen && !unresolved) { e.preventDefault(); e.stopPropagation(); onClose(); } };
  return <div className="wf-insp" onKeyDown={onKeyDown}>
    <Inspector label={`Task: ${task.title}`} onClose={() => { if (!unresolved) onClose(); }} onExpand={onExpand}
      title={<><StatusIcon status={task.status} label={task.display_state.label} /> {task.title}</>}
      meta={<span className="wf-insp-meta">
        {assignees.length === 0 ? <span className="wf-muted">Unassigned</span> : assignees.map((a) => <span key={a.id} className="wf-owner"><Avatar alias={a.alias} kind="ai" size={16} decorative />{a.alias}</span>)}
        <Chip title={task.autonomy === "on" ? "The agent approves its own plan and finished work" : "Plan and finished work need approval"}>{task.autonomy === "on" ? "Autonomy ON" : "Autonomy OFF"}</Chip>
        <span className="v2-t-id" title={`Task ${task.id}`}>{task.id.slice(0, 8)}</span>
      </span>}>
      <Tabs label="Task inspector view" value={view} onChange={setView} tabs={[{ key: "details", label: "Details" }, { key: "discussion", label: "Discussion" }]} />
      {view === "discussion" ? <WorkflowDiscussion taskId={task.id} scope={scope} locked={detail.hidden || stale} /> : <>
      <Section title="State" actions={<span className="wf-state-label">{task.display_state.label}{stale ? " (last loaded)" : ""}</span>}>
        {task.withdrawn_at && <p className="wf-p">Withdrawn by {task.withdrawn_by ? actorName(task.withdrawn_by) : "Name unavailable"}: {task.withdrawn_reason ?? "Reason unavailable"}</p>}
        {task.blockers.length === 0 && !warning && !task.display_state.release_available_at && !task.withdrawn_at && <p className="wf-muted">Nothing is blocking this task.</p>}
        <ul className="wf-blockers">
          {task.blockers.map((b, i) => <li key={i}>{b.message}</li>)}
          {warning && <li className="is-warn">{warning}</li>}
          {task.display_state.release_available_at && <li>If the worker stays silent, Release lost worker becomes available at <time dateTime={task.display_state.release_available_at}>{formatServerTime(task.display_state.release_available_at)}</time>. Refresh to check availability.</li>}
        </ul>
      </Section>
      {detail.semantics_version === 2 && ((task.outcomes ?? []).length > 0 || task.repeat_group_id) && <Section title={task.round ? `Round ${task.round}` : "Outcomes"}>
        <WorkflowRoundContext detail={detail} task={task} />
      </Section>}
      {task.awaiting_loop_decision && <Section title="Decision needed">
        <WorkflowLoopDecision detail={detail} task={task} scope={scope} stale={stale} agents={agents} onSaved={onSaved} />
      </Section>}
      <Section title="Actions">
        <WorkflowTaskActions inline detail={detail} task={task} scope={scope} verified={verified} stale={stale} agents={agents} onSaved={onSaved} request={request}
          leading={task.status === "needs_verification" ? <Button size="sm" variant="secondary" disabled={stale || unresolved} title={stale ? "Refresh before making changes." : undefined} onClick={() => setDecisionOpen(true)}>Review result…</Button> : undefined} />
      </Section>
      <Section title="Dependencies" actions={<Button size="sm" variant="ghost" disabled={stale || unresolved || !!taskReason(detail, task, "dependencies", verified)} title={taskReason(detail, task, "dependencies", verified) ?? undefined} onClick={() => onRequest("dependencies")}>Edit</Button>}>
        <dl className="wf-kv">
          <dt>Depends on</dt><dd>{prerequisites.length === 0 ? <span className="wf-muted">None</span> : <span className="wf-chipline">{prerequisites.map((t) => <Chip key={t.id}><WorkflowTaskLink cid={cid} taskId={t.id}>{t.title}</WorkflowTaskLink></Chip>)}</span>}</dd>
          <dt>Needed by</dt><dd>{dependents.length === 0 ? <span className="wf-muted">None</span> : <span className="wf-chipline">{dependents.map((t) => <Chip key={t.id}><WorkflowTaskLink cid={cid} taskId={t.id}>{t.title}</WorkflowTaskLink></Chip>)}</span>}</dd>
        </dl>
      </Section>
      {task.acceptance && <Section title="Acceptance"><WorkflowTaskAcceptanceRecord task={task} /></Section>}
      <Section title="Saved evidence"><WorkflowEvidencePanel key={task.id} detail={detail} taskId={task.id} /></Section>
      <Section title="Task authority">
        <p className="wf-p">Task autonomy {task.autonomy === "on" ? "ON: the agent approves its own plan, start and completion" : "OFF: plan and finished work need approval"}. Dependencies, holds and workflow controls still apply. Only the human project owner changes it, from the <WorkflowTaskLink cid={cid} taskId={task.id}>task page</WorkflowTaskLink>.</p>
      </Section>
      </>}
    </Inspector>
    {decisionOpen && <Dialog title={`Review result: ${task.title}`} size="lg" className="wf-page wf-review-dialog" onClose={() => { if (!unresolved) setDecisionOpen(false); }}
      footer={<Button disabled={unresolved} onClick={() => setDecisionOpen(false)}>Close</Button>}>
      <WorkflowTaskDecision detail={detail} task={task} scope={scope} verified={verified} stale={stale} onSaved={(result) => { onSaved(result); setDecisionOpen(false); }} />
    </Dialog>}
  </div>;
}
