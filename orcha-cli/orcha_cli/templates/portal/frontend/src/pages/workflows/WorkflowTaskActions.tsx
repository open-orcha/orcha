import { useEffect, useRef, useState, type ReactNode } from "react";
import { MenuButton } from "../../components/primitives";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { availableActionReason, prepareReleasesHold, workflowPaths, workflowRequest } from "./workflowApi";
import { workflowRoutes, type Impact, type WorkflowDetail, type WorkflowTask } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";
import { useWorkflowForm } from "./workflowFormState";
import { dependencyReason, type DraftTask } from "./workflowDraft";
import { WorkflowEvidencePanel } from "./WorkflowEvidence";
import { impactMatches, readWorkflowImpact, WorkflowImpactView } from "./WorkflowImpact";
import { WorkflowTaskDecision } from "./WorkflowTaskDecision";
import { WorkflowTaskAcceptanceRecord } from "./WorkflowTaskAcceptanceRecord";
import { WorkflowGraph } from "./WorkflowGraph";

const taskActions = {
  prepare: { label: "Prepare task", path: "prepare", operation: "prepare" },
  hold: { label: "Put on hold", path: "hold", operation: "hold" },
  stop: { label: "Stop this task", path: "stop", operation: "stop" },
  reissue_stop: { label: "Send stop again", path: "reissue-stop", operation: "reissue_stop" },
  retry: { label: "Retry task", path: "retry", operation: "retry" },
  release_lost_worker: { label: "Release lost worker", path: "release-lost-worker", operation: "release_lost_worker" },
  withdraw: { label: "Withdraw from scope", path: "withdraw-from-scope", operation: "withdraw" },
  release: { label: "Release holds", path: "release", operation: "release" },
  dependencies: { label: "Edit dependencies", path: "dependencies", operation: "dependencies" },
  submit_outside_result: { label: "Submit outside result", path: "external-result", operation: "external_result" },
  withdraw_evidence: { label: "Withdraw outside result", path: "external-result/{eid}/withdraw", operation: "withdraw_evidence" },
  add_evidence: { label: "Replace missing evidence", path: "tasks/{tid}/evidence", operation: "add_evidence" },
} as const;
export type TaskActionKey = keyof typeof taskActions;
type Action = TaskActionKey;
export const TASK_ACTION_KEYS = Object.keys(taskActions) as TaskActionKey[];
/** Inspector grouping (§4.3 callout 4): secondary buttons, danger buttons, the rest behind More. */
const PRIMARY_ACTIONS: TaskActionKey[] = ["prepare", "retry", "release"];
const DANGER_ACTIONS: TaskActionKey[] = ["stop", "withdraw", "withdraw_evidence", "release_lost_worker"];
/** A row-menu or inspector request; `seq` lets the same action be requested twice in a row. */
export interface TaskActionRequest { action: TaskActionKey; seq: number }
function routePattern(action: Action) {
  return action === "release" ? "/api/workflows/{wid}/release" : action === "add_evidence" ? "/api/workflows/{wid}/tasks/{tid}/evidence" : `/api/tasks/{tid}/${taskActions[action].path}`;
}
function actionUrl(action: Action, wid: string, task: WorkflowTask) {
  return routePattern(action).replace("{wid}", encodeURIComponent(wid)).replace("{tid}", encodeURIComponent(task.id)).replace("{eid}", encodeURIComponent(task.outside_result_id ?? ""));
}
function supported(action: Action) { return workflowRoutes.some((route) => route.path === routePattern(action) && route.method === (action === "dependencies" ? "put" : "post")); }
export function taskActionLabel(task: Pick<WorkflowTask, "awaiting_owner_decision">, key: TaskActionKey): string {
  return key === "retry" && task.awaiting_owner_decision === "evidence_withdrawn" ? "Let worker start" : taskActions[key].label;
}
export function taskReason(detail: WorkflowDetail, task: WorkflowTask, action: Action, verified: boolean) {
  if (detail.hidden) return "Restore this hidden workflow before making changes.";
  return !supported(action) ? "This action is not supported by this portal version yet."
    : availableActionReason(detail.capability, task.available_actions, action, verified);
}

export function WorkflowTaskActions({ detail, task, scope, verified, stale, agents, onSaved, inline = false, request, leading }: {
  detail: WorkflowDetail; task: WorkflowTask; scope: DraftScope; verified: boolean; stale: boolean;
  agents: { id: string; alias: string }[]; onSaved: (result: WorkflowDetail) => void;
  /** Inspector mode (§4.3): no "Manage" button or outer dialog; each action opens its own dialog. */
  inline?: boolean;
  /** A row-menu / inspector request to open one action's dialog. */
  request?: TaskActionRequest | null;
  /** Extra leading button(s) in the inline actions grid (the inspector's "Review result…"). */
  leading?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [preview, setPreview] = useState<WorkflowDetail | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useWorkflowForm(scope, `task:${task.id}:reason`, "");
  const [criteria, setCriteria] = useWorkflowForm(scope, `task:${task.id}:criteria`, task.definition_of_done);
  const [assignee, setAssignee] = useWorkflowForm(scope, `task:${task.id}:assignee`, task.assignee_ids[0] ?? "");
  const [holds, setHolds] = useWorkflowForm<Array<"start" | "human">>(scope, `task:${task.id}:holds`, []);
  const [dependencies, setDependencies] = useWorkflowForm(scope, `task:${task.id}:dependencies`, task.depends_on);
  const [resultText, setResultText] = useWorkflowForm(scope, `task:${task.id}:result`, "");
  const [evidenceText, setEvidenceText] = useWorkflowForm(scope, `task:${task.id}:evidence`, "");
  const [producedBy, setProducedBy] = useWorkflowForm(scope, `task:${task.id}:produced`, "");
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [checkedDependencies, setCheckedDependencies] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const slot = `workflow:${detail.id}`;
  const operation = useWorkflowOperation(scope, slot);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  const currentTask = preview?.tasks.find((t) => t.id === task.id);
  const allowedHolds = currentTask?.available_actions.find((a) => a.action === "release" && a.enabled)?.holds ?? [];
  const label = (key: Action) => taskActionLabel(task, key);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new seq is a new request; review() reads current props
  useEffect(() => { if (request) void review(request.action); }, [request?.seq]);
  async function review(next: Action) {
    setAction(next); setPreview(null); setImpact(null); setBusy(true); setError(""); setRiskAccepted(false);
    try {
      const current = next === "release" ? await readWorkflowImpact(detail, "release", [task.id], holds.length ? holds : ["start"], scope.identity)
        : await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
      if (current.id !== detail.id || current.container_id !== scope.project) throw new Error("The workflow changed. Open the task again from its project.");
      const currentTask = current.tasks.find((t) => t.id === task.id);
      if (!currentTask) throw new Error("This task is no longer in this workflow.");
      setPreview(current);
      if (next === "dependencies") setCheckedDependencies(JSON.stringify(dependencies));
      if ("impact" in current) setImpact(current.impact as Impact);
    } catch (e) { setError(e instanceof Error ? e.message : "The task could not be checked."); }
    finally { setBusy(false); }
  }
  const blocked = !action || !preview || !currentTask ? "Review the current task before confirming."
    : taskReason(preview, currentTask, action, verified);
  const checkedHolds = impactMatches(impact, [task.id], holds);
  const disabled = busy || unresolved || stale || !!blocked || !action
    || (action === "prepare" ? !criteria.trim() || !assignee : !reason.trim())
    || (action === "release_lost_worker" && (!riskAccepted || currentTask?.display_state.release_available !== true))
    || (action === "release" && (!holds.length || holds.some((hold) => !allowedHolds.includes(hold))))
    || (action === "release" && (!checkedHolds || impact?.tasks?.some((t) => t.selected && (t.resulting_status === "refused" || t.refusal))))
    || (action === "withdraw_evidence" && !currentTask?.outside_result_id)
    || (action === "dependencies" && checkedDependencies !== JSON.stringify(dependencies))
    || (action === "submit_outside_result" && (!resultText.trim() || !evidenceText.trim() || resultText.trim().length + evidenceText.trim().length > 3950))
    || (action === "add_evidence" && (!evidenceText.trim() || currentTask?.evidence_state !== "missing"));
  async function confirm() {
    if (disabled || !action || !preview || !currentTask) return;
    const result = await sendWorkflowOperation(scope, slot, { operation: taskActions[action].operation,
      expectedWorkflowId: detail.id,
      url: actionUrl(action, detail.id, currentTask), method: action === "dependencies" ? "PUT" : "POST",
      body: { expected_revision: preview.revision, ...(action !== "release" ? { expected_work_revision: currentTask.work_revision } : {}), reason: reason.trim(),
        ...(action === "prepare" ? { definition_of_done: criteria.trim(), assignee_id: assignee } : {}),
        ...(action === "retry" ? { assignee_id: assignee || null } : {}),
        ...(action === "release" ? { task_ids: [task.id], task_revisions: { [task.id]: impact!.task_revisions[task.id] }, holds } : {}),
        ...(action === "dependencies" ? { depends_on: dependencies } : {}),
        ...(action === "submit_outside_result" ? { produced_by: producedBy.trim() || null, evidence: { narrative: `Result:\n${resultText.trim()}\n\nEvidence:\n${evidenceText.trim()}`, task_revisions: { [task.id]: currentTask.work_revision }, evidence_sets: [] } } : {}),
        ...(action === "add_evidence" ? { evidence: { narrative: evidenceText.trim(), task_revisions: { [task.id]: currentTask.work_revision }, evidence_sets: [] } } : {}),
      } });
    if (active.current && result.state === "saved" && result.result) { onSaved(result.result); setOpen(false); setAction(null); }
    if (result.state === "refused") setPreview(null);
  }
  const done = () => { if (inline) setAction(null); else setOpen(false); };
  const dismiss = () => { if (!busy && !unresolved) done(); };
  const form = <fieldset className="wf-form-body" disabled={busy || unresolved || stale}>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Checking the current task…</p>}
    {action && !preview && !busy && <Button onClick={() => void review(action)}>Refresh task review</Button>}
    {currentTask && action && <>
      {!inline && <h3>{label(action)}</h3>}{blocked && <p className="wf-notice">{blocked}</p>}
      {action === "prepare" ? <>
        {prepareReleasesHold(detail, currentTask)
          ? <p>This Workflow has already started, so preparing this task also releases its start hold and it can begin as soon as its prerequisites, turn and any other holds allow. A hold a person placed stays until they release it.</p>
          : <p>Preparing does not start this task or release any hold.</p>}
        <label>Done when<textarea maxLength={4000} value={criteria} onChange={(e) => setCriteria(e.target.value)} /></label>
        <label>Assignee<select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Choose an assignee</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.alias}</option>)}</select></label>
      </> : <label>Reason<textarea maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      {action === "hold" && <p>The task will not start while this hold remains. Existing prerequisites and start holds stay in place.</p>}
      {action === "release" && <><p>Only the selected holds are removed. All other holds, owner decisions and prerequisites remain; releasing a hold does not promise the task will run.</p>
        {(["start", "human"] as const).map((hold) => <label className="wf-choice" key={hold}><input type="checkbox" checked={holds.includes(hold)}
          disabled={!allowedHolds.includes(hold) && !holds.includes(hold)}
          onChange={(e) => setHolds(e.target.checked ? [...holds, hold] : holds.filter((h) => h !== hold))} />{hold === "start" ? "Release start hold" : `Release human hold: ${currentTask.human_hold_reason ?? "No human hold"}`}{!allowedHolds.includes(hold) && <small>This hold is not available for you to release.</small>}</label>)}
        {!checkedHolds && <p>Your hold choices need a fresh check before release.</p>}
        <Button disabled={busy || unresolved || stale || !holds.length || holds.some((hold) => !allowedHolds.includes(hold))} onClick={() => void review("release")}>Check selected holds</Button>
        {checkedHolds && impact && <WorkflowImpactView impact={impact} detail={preview!} />}</>}
      {action === "dependencies" && <><p>Saving may make this task eligible. It does not accept or withdraw an old prerequisite. Goal acceptance will need review again.</p>
        <WorkflowGraph tasks={preview!.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, label: t.display_state.label,
          assignee: agents.find((a) => t.assignee_ids.includes(a.id))?.alias ?? "Unassigned",
          dependsOn: t.id === task.id ? dependencies : t.depends_on,
          changedDependencies: t.id === task.id ? dependencies.filter((id) => !t.depends_on.includes(id)) : [],
        }))} selected={task.id} onSelect={() => {}} />
        <fieldset><legend>Prerequisites — {dependencies.length} of 3</legend>{preview!.tasks.filter((t) => t.id !== task.id).map((candidate) => {
          const graph: DraftTask[] = preview!.tasks.map((t) => ({ key: t.id, title: t.title, dependsOn: t.depends_on, doneWhen: t.definition_of_done, description: "", assignee: "", autonomy: false }));
          const target = { ...graph.find((t) => t.key === task.id)!, dependsOn: dependencies };
          const why = candidate.withdrawn_at ? "Withdrawn from scope" : dependencyReason(graph, target, graph.find((t) => t.key === candidate.id)!);
          return <label className="wf-choice" key={candidate.id}><input type="checkbox" checked={dependencies.includes(candidate.id)} disabled={!!why && !dependencies.includes(candidate.id)}
            onChange={(e) => setDependencies(e.target.checked ? [...dependencies, candidate.id] : dependencies.filter((id) => id !== candidate.id))} /><span>{candidate.title}{why && <small>{why}</small>}</span></label>;
        })}</fieldset>
        <ul>{dependencies.map((id) => <li key={id}>{task.title} will wait for {preview!.tasks.find((t) => t.id === id)?.title ?? "the unavailable prerequisite"} to be accepted.</li>)}</ul>
        {currentTask.depends_on.filter((id) => !dependencies.includes(id)).map((id) => <p key={id}>Remove the prerequisite {preview!.tasks.find((t) => t.id === id)?.title ?? "unavailable task"}; its task and history are kept.</p>)}
        <Button onClick={() => void review("dependencies")}>Review dependency change</Button>
        {checkedDependencies !== JSON.stringify(dependencies) && <p>Your prerequisite choices need a fresh review before saving.</p>}
      </>}
      {action === "stop" && <p>This sends a stop request. The task remains Stopping until Orcha confirms shutdown; requesting a stop is not confirmation that the worker is gone.</p>}
      {action === "retry" && <p>This begins a new attempt through the scheduler. Dependencies, holds and task autonomy still apply.</p>}
      {action === "retry" && <label>Reassign for this attempt<select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Keep the current assignment</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.alias}</option>)}</select></label>}
      {action === "reissue_stop" && <p>Send the existing stop instruction again. This does not restart the waiting period or confirm shutdown.</p>}
      {action === "submit_outside_result" && <><p>Done when: {currentTask.definition_of_done}</p><p>Saving a real outside result does not accept it. It waits for review under the same holds, dependencies and turn rules. No worker starts from this submission.</p>
        <label>Result<textarea maxLength={2000} value={resultText} onChange={(e) => setResultText(e.target.value)} /></label>
        <label>Produced by (optional)<input maxLength={200} value={producedBy} onChange={(e) => setProducedBy(e.target.value)} /></label></>}
      {(action === "submit_outside_result" || action === "add_evidence") && <label>Evidence<textarea maxLength={action === "add_evidence" ? 4000 : 1900} value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} /></label>}
      {action === "add_evidence" && <p>This saves a new evidence set for the missing current result. Earlier files and acceptance records remain unchanged. Review the newly saved evidence separately before accepting.</p>}
      {action === "withdraw_evidence" && <p>This withdraws the proposed outside result, not the required task. The task waits for an explicit owner decision; it will not restart automatically. Other holds stay in place.</p>}
      {action === "withdraw" && <p>The task leaves required scope without being accepted. This cannot be undone; remaining dependents must be resolved first. Goal acceptance will need review again.</p>}
      {action === "release_lost_worker" && <><p>This worker may still be running outside Orcha. Orcha will refuse anything it sends from now on. Releasing it does not accept the task or confirm shutdown.</p>
        <label className="wf-choice"><input type="checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} />I understand the worker may still be running outside Orcha.</label></>}
    </>}
  </fieldset>;
  const notice = <WorkflowOperationNotice scope={scope} slot={slot} onSaved={(result) => { onSaved(result); done(); }} canRetry={async () => {
    const originalAction = (Object.keys(taskActions) as Action[]).find((key) => taskActions[key].operation === operation?.operation
      && operation.url === actionUrl(key, detail.id, task));
    if (!originalAction) return false;
    const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
    const selected = latest.tasks.find((t) => t.id === task.id);
    return latest.container_id === scope.project && latest.id === detail.id && !!selected && !taskReason(latest, selected, originalAction, verified);
  }} />;
  const confirmButton = action && <Button disabled={disabled} variant={DANGER_ACTIONS.includes(action) ? "danger" : "primary"} onClick={() => void confirm()}>{label(action)}</Button>;
  if (inline) {
    // Inspector layout (§4.3 callout 4): enabled actions as buttons, grouped; every disabled
    // action listed under "Not available now" with the server's reason, so nothing is hidden.
    const enabled = TASK_ACTION_KEYS.filter((key) => !taskReason(detail, task, key, verified));
    const unavailable = TASK_ACTION_KEYS.filter((key) => taskReason(detail, task, key, verified));
    const frozen = busy || unresolved || stale;
    const button = (key: Action) => <Button key={key} size="sm" variant={DANGER_ACTIONS.includes(key) ? "danger" : "secondary"} disabled={frozen} onClick={() => void review(key)}>{label(key)}</Button>;
    const more = enabled.filter((key) => !PRIMARY_ACTIONS.includes(key) && !DANGER_ACTIONS.includes(key));
    return <>
      <div className="wf-actionsgrid">
        {leading}
        {enabled.filter((key) => PRIMARY_ACTIONS.includes(key)).map(button)}
        {enabled.filter((key) => DANGER_ACTIONS.includes(key)).map(button)}
        {more.length > 0 && <MenuButton label="More" size="sm" menuLabel="More task actions" placement="bottom-end" disabled={frozen}
          items={more.map((key) => ({ label: label(key), onSelect: () => void review(key) }))} />}
        {enabled.length === 0 && !leading && <p className="wf-muted">No actions are available for you right now.</p>}
      </div>
      {unavailable.length > 0 && <details className="wf-notavail-wrap"><summary className="wf-muted">Not available now ({unavailable.length})</summary>
        <dl className="wf-notavail">{unavailable.map((key) => <div key={key}><dt>{label(key)}</dt><dd>{taskReason(detail, task, key, verified)}</dd></div>)}</dl></details>}
      {/* A loop decision's save status shows in its own "Decision needed" section. */}
      {!action && operation?.operation !== "loop_decision" && notice}
      {action && <Dialog title={label(action)} description={<>{task.title}</>} onClose={dismiss} size="lg" className="wf-page"
        footer={<><Button disabled={busy || unresolved} onClick={done}>Close</Button>{confirmButton}</>}>{notice}{form}</Dialog>}
    </>;
  }
  return <>
    <Button onClick={() => setOpen(true)}>Manage {task.title}</Button>
    {open && <Dialog title={`Help ${task.title} progress`} onClose={dismiss} size="lg" className="wf-page"
      footer={<><Button disabled={busy || unresolved} onClick={() => setOpen(false)}>Close</Button>{confirmButton}</>}>
      <p>{task.display_state.label}</p><ul>{task.blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul>
      {task.display_state.warning && <p className="wf-warning">{task.display_state.warning}</p>}
      {task.display_state.release_available_at && <p>If the worker stays silent, Release lost worker becomes available at <time dateTime={task.display_state.release_available_at}>{new Date(task.display_state.release_available_at).toLocaleString()}</time>. Refresh to check availability.</p>}
      {task.acceptance && <WorkflowTaskAcceptanceRecord task={task} />}
      {task.status === "needs_verification" ? <WorkflowTaskDecision detail={detail} task={task} scope={scope} verified={verified} stale={stale} onSaved={(result) => { onSaved(result); setOpen(false); }} />
        : <WorkflowEvidencePanel detail={detail} taskId={task.id} />}
      <div className="wf-actions">{(Object.keys(taskActions) as Action[]).map((key) => <Button key={key} title={taskReason(detail, task, key, verified) ?? undefined}
        disabled={busy || unresolved || stale || !!taskReason(detail, task, key, verified)} onClick={() => void review(key)}>{label(key)}</Button>)}</div>
      <p>Task autonomy is ON or OFF. OFF requires plan and finished-work approval; ON lets the agent approve its own plan, start and complete this task. Dependencies, holds and workflow controls still apply. Direct requests are always allowed.</p>
      <p>Task autonomy {task.autonomy === "on" ? "ON" : "OFF"}. Only the human project owner can change it from the task page; changes apply to future actions.</p>
      {form}
      {notice}
    </Dialog>}
  </>;
}
