import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { actionReason, workflowPaths, workflowRequest } from "./workflowApi";
import type { Impact, WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";
import { WorkflowTaskLink } from "./WorkflowTaskReturn";
import { WorkflowEvidencePanel } from "./WorkflowEvidence";
import { WorkflowAcceptance } from "./WorkflowAcceptance";
import { acceptanceAttributionUnavailable, samePersonOutsideAcceptance, WorkflowTaskAcceptanceRecord } from "./WorkflowTaskAcceptanceRecord";
import { useWorkflowForm } from "./workflowFormState";
import { impactMatches, readWorkflowImpact, WorkflowImpactView } from "./WorkflowImpact";
import { WorkflowRouteSummary } from "./WorkflowRouteSummary";

export type WorkflowAction = "start" | "pause" | "resume" | "cancel" | "finish";
type Action = WorkflowAction;
/** A header-menu request (issue #350 §4.2): `seq` lets the same action be requested twice in a row. */
export interface WorkflowActionRequest { action: WorkflowAction; seq: number }
const labels: Record<Action, string> = { start: "Review start", pause: "Pause new starts", resume: "Resume workflow", cancel: "Cancel workflow", finish: "Finish checklist" };
const confirmation: Record<Action, string> = { start: "Start selected tasks", pause: "Pause new starts", resume: "Resume workflow", cancel: "Cancel workflow", finish: "Finish workflow" };

const LOOP_ENDINGS: Record<string, string> = { exited: "the loop ended", stopped: "the loop was stopped", limit_reached: "waiting at its round limit",
  stalled: "waiting after a stall", awaiting_owner: "waiting for the owner" };

export function WorkflowActions({ detail, scope, verified, stale, onSaved, request }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; onSaved: (detail: WorkflowDetail) => void;
  /** When provided, the header menu opens dialogs and the inline button row is not rendered. */
  request?: WorkflowActionRequest | null;
}) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [action, setAction] = useState<Action | null>(null);
  const [preview, setPreview] = useState<WorkflowDetail | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useWorkflowForm<string[]>(scope, `start:${detail.id}`, []);
  const [reason, setReason] = useWorkflowForm(scope, `action-reason:${detail.id}`, "");
  const [evidenceTask, setEvidenceTask] = useState("");
  const slot = `workflow:${detail.id}`;
  const operation = useWorkflowOperation(scope, slot);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  const fresh = async () => workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
  const startEligible = (task: WorkflowDetail["tasks"][number]) => task.preparation_state === "prepared" && task.start_hold && !task.withdrawn_at && !["completed", "cancelled"].includes(task.status);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new seq is a new request; review() reads current props
  useEffect(() => { if (request) void review(request.action); }, [request?.seq]);

  async function review(next: Action) {
    setAction(next); setPreview(null); setImpact(null); setError("");
    setBusy(true);
    try {
      const current = next === "start" || next === "cancel"
        ? await readWorkflowImpact(detail, next === "start" ? "start" : "cancellation", next === "start" ? selected : [], ["start"], scope.identity)
        : await fresh();
      if (current.container_id !== scope.project || current.id !== detail.id) throw new Error("The workflow changed. Return to the list and open it again.");
      if (next === "finish") current.completion = await workflowRequest("CompletionCheck", workflowPaths.detail(detail.id) + "/completion-check", { actorId: scope.identity });
      setPreview(current);
      if ("impact" in current) setImpact(current.impact as Impact);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not check this action."); }
    finally { setBusy(false); }
  }
  const blocked = preview && action ? actionReason(preview, action, verified) : "Checking this action…";
  const allAccepted = preview && preview.progress.total > 0 && preview.progress.total === preview.progress.accepted;
  const samePersonAccepted = preview?.tasks.filter(samePersonOutsideAcceptance) ?? [];
  const checkedSelection = impactMatches(impact, selected, ["start"]);
  const confirmBlocked = busy || unresolved || stale || !!blocked || !preview || !action
    || (action === "start" && !selected.length && !allAccepted)
    || (action === "start" && selected.some((id) => !preview?.tasks.some((t) => t.id === id && startEligible(t))))
    || (action === "start" && (!checkedSelection || impact?.tasks?.some((t) => t.selected && (t.resulting_status === "refused" || t.refusal))))
    || (action === "cancel" && impact?.kind !== "cancellation")
    || (action === "finish" && (preview?.evidence_capability?.available !== true || preview?.completion.can_finish !== true || preview?.tasks.some(acceptanceAttributionUnavailable)))
    || (action === "cancel" && !reason.trim());

  async function confirm() {
    if (confirmBlocked || !action || !preview) return;
    const request = { operation: action, url: workflowPaths.detail(detail.id) + `/${action}`, expectedWorkflowId: detail.id,
      body: { expected_revision: preview.revision, reason: reason.trim(), ...(action === "start" ? {
        task_ids: selected, task_revisions: Object.fromEntries(selected.map((id) => [id, impact!.task_revisions[id]])), holds: ["start"],
      } : {}) } };
    const result = await sendWorkflowOperation(scope, slot, request);
    if (active.current && result.state === "saved" && result.result) { onSaved(result.result); setAction(null); }
    // Refusal consumes the preview, requiring a fresh check and new confirmation.
    else if (result.state === "refused") setPreview(null);
  }
  return <>
    {request === undefined && <div className="wf-actions" aria-label="Workflow actions">{(Object.keys(labels) as Action[]).map((a) => {
      const reason = actionReason(detail, a, verified);
      // The checklist stays discoverable for readers, even with unmet requirements.
      return <Button key={a} disabled={busy || (a !== "finish" && (stale || unresolved || !!reason))}
        title={a === "finish" ? "Review requirements before finishing" : reason ?? undefined} onClick={() => void review(a)}>{labels[a]}</Button>;
    })}</div>}
    {!action && <>
    <WorkflowOperationNotice scope={scope} slot={slot} onSaved={(result) => { onSaved(result); setAction(null); }}
      canRetry={async () => { const current = await fresh(); return current.container_id === scope.project && current.id === detail.id && !actionReason(current, operation?.operation ?? "", verified); }} />
    </>}
    {action && <Dialog title={labels[action]} onClose={() => { if (!busy && !unresolved) setAction(null); }} className="wf-page" size="lg"
      footer={<><Button onClick={() => setAction(null)} disabled={busy || unresolved}>{action === "start" ? "Keep preparing" : "Close"}</Button>
        <Button variant={action === "cancel" ? "danger" : "primary"} disabled={confirmBlocked} onClick={() => void confirm()}>{confirmation[action]}</Button></>}>
    <WorkflowOperationNotice scope={scope} slot={slot} onSaved={(result) => { onSaved(result); setAction(null); }}
      canRetry={async () => { const current = await fresh(); return current.container_id === scope.project && current.id === detail.id && !actionReason(current, operation?.operation ?? "", verified); }} />
      {busy && <p role="status">Checking the current workflow…</p>}
      {error && <p role="alert">{error}</p>}
      {!preview && !busy && <Button onClick={() => void review(action)}>Refresh review</Button>}
      {preview && <>
        <h3>{preview.title}</h3>
        {blocked && <p className="wf-notice">{blocked}</p>}
        {action === "start" && <>
          <p>Only selected prepared tasks are released. Tasks with prerequisites wait for acceptance and their own turn. Human holds stay in place.</p>
          {selected.some((id) => !preview.tasks.some((t) => t.id === id && startEligible(t))) && <p>Some selected tasks changed and can no longer be released. Your choices are kept. <Button onClick={() => setSelected((ids) => ids.filter((id) => preview.tasks.some((t) => t.id === id && startEligible(t))))}>Remove unavailable selections</Button></p>}
          {allAccepted && <p>All required tasks are already accepted. No tasks will run; continue to goal review after Start.</p>}
          <fieldset><legend>Tasks to release</legend>{preview.tasks.map((t) => <label className="wf-choice" key={t.id}>
            <input type="checkbox" checked={selected.includes(t.id)} disabled={!startEligible(t) && !selected.includes(t.id)}
              onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, t.id] : ids.filter((id) => id !== t.id))} />
            <span>{t.title} — {t.display_state.label}{t.blockers.map((b) => <small key={b.code}>{b.message}</small>)}</span>
          </label>)}</fieldset>
          {!checkedSelection && <p>Your task choices need a fresh check before Start.</p>}
          <Button disabled={busy || unresolved || stale || (!selected.length && !allAccepted)} onClick={() => void review("start")}>Check selected tasks</Button>
          {checkedSelection && impact && <WorkflowImpactView impact={impact} detail={preview} />}
          <WorkflowRouteSummary detail={preview} />
        </>}
        {action === "pause" && <p>Running work may finish. New tasks will not start until you resume the workflow.</p>}
        {action === "resume" && <p>Eligible tasks may start after resuming. Dependencies, holds and task autonomy still apply.</p>}
        {action === "cancel" && <>
          <p>Cancel unfinished work in this workflow. Accepted results, saved evidence and the record of what happened are kept. Workers may take time to stop; cancellation does not confirm shutdown.</p>
          {impact && <WorkflowImpactView impact={impact} detail={preview} />}
          <label>Reason for cancelling<textarea maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </>}
        {action === "finish" && <>
          <p>{preview.progress.accepted} of {preview.progress.total} tasks accepted. {preview.progress.objectives_accepted} of {preview.progress.objectives_total} objectives accepted.</p>
          {preview.semantics_version === 2 && <div className="wf-impact" aria-label="Loops and limits">
            <div className="wf-impact-h"><span>Loops and limits</span><span>agent turns {preview.turns_used ?? 0} of {preview.turn_allowance ?? 40}</span></div>
            {(preview.repeat_groups ?? []).map((g) => <div key={g.id} className="wf-impact-row"><span className="t">{g.state === "exited" ? `Loop “${g.name}” exited after round ${g.current_round} of ${g.max_rounds}`
              : g.state === "stopped" ? `Loop “${g.name}” was stopped at round ${g.current_round} of ${g.max_rounds}` : `Loop “${g.name}” has not exited · round ${g.current_round} of ${g.max_rounds} · ${LOOP_ENDINGS[g.state] ?? "running"}`}</span>
              <span className="wf-muted">{g.state === "exited" ? "done" : g.state === "stopped" ? "stopped" : "blocks Finish"}</span></div>)}
            {!(preview.repeat_groups ?? []).length && <div className="wf-impact-row"><span className="t">This workflow has no loops.</span></div>}
          </div>}
          {preview.tasks.some((t) => t.route_state === "not_selected") && <p className="wf-muted">Not selected on the path this workflow took: {preview.tasks.filter((t) => t.route_state === "not_selected").map((t) => t.title).join(", ")}. A Not selected step never counts toward Finish. Changing the scope needs an owner review and fresh goal acceptance; it cannot be done by marking work as unselected.</p>}
          <p>Goal: {preview.goal}</p><p>{preview.goal_accepted_revision === preview.goal_revision ? "Current goal accepted." : "The current goal still needs acceptance with saved evidence."}</p>

          <ul>{preview.completion.blockers.map((b, i) => <li key={i}>{b.message}{b.task_id && <> <WorkflowTaskLink cid={scope.project} taskId={b.task_id}>Open task</WorkflowTaskLink></>}</li>)}</ul>
          {samePersonAccepted.length > 0 && <p>{samePersonAccepted.length} owner-supplied {samePersonAccepted.length === 1 ? "result" : "results"} accepted by the same person. <Button onClick={() => setEvidenceTask(samePersonAccepted[0].id)}>View</Button></p>}
          {preview.tasks.some(acceptanceAttributionUnavailable) && <p>Finish is unavailable because one or more legacy acceptances do not record who submitted the result. There is no supported recovery path for those records yet.</p>}
          <label>Inspect a task’s saved evidence<select value={evidenceTask} onChange={(e) => setEvidenceTask(e.target.value)}><option value="">Choose a task</option>{preview.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
          <section className="wf-checklist" aria-label="Required tasks"><h3>Required tasks</h3>
            {preview.tasks.filter((t) => !t.withdrawn_at).map((t) => <details key={t.id} open={evidenceTask === t.id} onToggle={(e) => { if (e.currentTarget.open) setEvidenceTask(t.id); else setEvidenceTask((id) => id === t.id ? "" : id); }}>
              <summary><span>{t.title}</span><span className="wf-muted">{t.acceptance ? "Accepted" : t.display_state.label} · Evidence</span></summary>
              {evidenceTask === t.id && <>{t.acceptance && <WorkflowTaskAcceptanceRecord task={t} />}<WorkflowEvidencePanel detail={preview} taskId={t.id} /></>}
            </details>)}
          </section>
          {preview.tasks.filter((t) => t.withdrawn_at && t.id === evidenceTask).map((t) => <section key={t.id} aria-label="Withdrawn task evidence">
            <h3>{t.title} · Removed from required scope</h3>
            {t.acceptance && <WorkflowTaskAcceptanceRecord task={t} />}
            <WorkflowEvidencePanel detail={preview} taskId={t.id} />
          </section>)}
          <h3>Objectives</h3>
          {preview.objectives.filter((o) => o.accepted_revision === o.revision).map((o) => <p key={o.id}>{o.title} · Accepted</p>)}
          {preview.evidence_capability?.available !== true && <p>Saved evidence review is unavailable on this connection, so finishing remains unavailable.</p>}
          <p>Objective and goal acceptance are separate recorded steps before Finish.</p>
          {preview.objectives.filter((o) => o.accepted_revision !== o.revision).map((objective) => <details key={objective.id}><summary>Review {objective.title}</summary>
            <WorkflowAcceptance detail={preview} scope={scope} verified={verified} stale={stale} objectiveId={objective.id} onSaved={(result) => { onSaved(result); setPreview(null); }} /></details>)}
          {preview.goal_accepted_revision !== preview.goal_revision && <details><summary>Review current goal</summary>
            <WorkflowAcceptance detail={preview} scope={scope} verified={verified} stale={stale} onSaved={(result) => { onSaved(result); setPreview(null); }} /></details>}
          {preview.completion.can_finish && <p>All {preview.progress.total} required tasks and {preview.progress.objectives_total} objectives are accepted.</p>}
          <p>Finishing makes this workflow read-only. Your project stays open. Only its verified human owner can finish it; task autonomy never finishes a workflow.</p>
        </>}
      </>}
    </Dialog>}
  </>;
}
