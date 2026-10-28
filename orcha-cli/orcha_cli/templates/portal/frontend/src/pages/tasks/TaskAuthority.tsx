import { useEffect, useState } from "react";
import { fetchSnapshot, getJSON } from "../../api/client";
import { Button, Property, PropertySection } from "../../components/primitives";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import type { Task } from "../../types";
import { workflowRequest, WorkflowApiError } from "../workflows/workflowApi";
import type { TaskApprovalHistory, TaskAutonomyResult } from "../workflows/workflowContract.generated";
import { useTaskWorkflow } from "../workflows/WorkflowTaskContext";

/** The existing task plan route permits a verified human member; it is not
 * restricted to the workflow owner. Result acceptance uses different routes. */
export function useWorkflowPlanApproval(taskId: string): boolean {
  const { member, stale } = useTaskWorkflow(taskId);
  const { identityPending } = useSnapshot();
  const authority = useActingAuthority();
  const capabilityReason = member?.detail.capability.reason;
  return !!member && !member.detail.hidden && !stale && !identityPending && !!authority.human
    && authority.human.member_role !== "viewer"
    && member.task.autonomy === "off" && typeof member.task.autonomy_revision === "number"
    && member.detail.capability.workflow_read === true
    && (member.detail.capability.workflow_human_write === true || capabilityReason === "workflow_owner_required");
}

export function TaskAuthority({ task }: { task: Task }) {
  const { cid, identity, identityTrusted, identityPending } = useSnapshot();
  return <TaskAuthorityState key={JSON.stringify([window.location.origin, cid, identity?.agent_id, identityTrusted, identityPending, task.id])} task={task} />;
}

function TaskAuthorityState({ task }: { task: Task }) {
  const { cid, refresh, identityPending } = useSnapshot();
  const { index, member, stale } = useTaskWorkflow(task.id);
  const authority = useActingAuthority();
  const [support, setSupport] = useState<{ autonomy: boolean; approvals: boolean } | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");
  const [retry, setRetry] = useState(0);
  const [saved, setSaved] = useState<Pick<TaskAutonomyResult, "autonomy" | "autonomy_revision"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"off" | "on" | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<TaskApprovalHistory | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const mode = saved && saved.autonomy_revision > (task.autonomy_revision ?? 0) ? saved.autonomy : task.autonomy === "on" ? "on" : "off";
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setSupport(null); setDiscoveryError("");
    void getJSON<{ paths?: Record<string, Record<string, unknown>> }>("/openapi.json", controller.signal).then((spec) => {
      if (!spec.paths || typeof spec.paths !== "object" || Array.isArray(spec.paths)) throw new Error("Missing routes");
      const supports = (suffix: string, method: string) => Object.entries(spec.paths!).some(([path, verbs]) =>
        new RegExp(`^/api/tasks/\\{[^}]+\\}/${suffix}$`).test(path) && !!verbs && typeof verbs === "object" && method in verbs);
      if (active) setSupport({ autonomy: supports("autonomy", "put"), approvals: supports("approvals", "get") });
    }).catch(() => { if (active) setDiscoveryError("Task authority could not be checked. Refresh before changing it."); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [retry]);
  useEffect(() => { setConfirm(null); }, [task.autonomy, task.autonomy_revision, task.status, authority.human?.id]);
  const blocked = authority.reason || (!authority.human || authority.human.member_role !== "owner" ? "Only the human project owner can change task autonomy." : null)
    || (index && index.state !== "unsupported" && stale ? "Check workflow membership before changing task authority." : null)
    || (member && (identityPending || !authority.human) ? "Choose a current human member of this project to change a workflow task." : null)
    || (member?.detail.capability.reason === "local_workflow_writes_unavailable" ? "Workflow task changes require an updated Orcha server." : null)
    || (member?.detail.capability.reason === "integration_required" ? "Workflow task changes are unavailable on this server." : null)
    || (task.is_root ? "The project goal always needs a person’s approval." : null)
    || (["completed", "cancelled"].includes(task.status) ? "Finished tasks keep their recorded autonomy history." : null)
    || discoveryError || (support === null ? "Checking task authority support…" : !support.autonomy ? "Task autonomy changes are unavailable on this server." : null);
  async function save() {
    if (!confirm || blocked || busy || uncertain || !authority.human) return;
    const desired = confirm; setBusy(true); setMessage("");
    try {
      const result = await workflowRequest("TaskAutonomyResult", `/api/tasks/${encodeURIComponent(task.id)}/autonomy`, {
        method: "PUT", body: { autonomy: desired, actor_agent_id: authority.human.id },
      });
      if (result.task_id !== task.id || result.autonomy !== desired) throw new WorkflowApiError("The saved setting could not be matched to this task.", 0, "scope_mismatch", true);
      setSaved(result); setMessage(`Task autonomy ${result.autonomy.toUpperCase()} saved. It applies to future actions.`);
      void refresh();
    } catch (e) {
      const unknown = !(e instanceof WorkflowApiError) || e.uncertain;
      setUncertain(unknown);
      setMessage(unknown ? "The change is unconfirmed. Check the current setting before choosing another change; nothing will be retried automatically."
        : e instanceof Error ? e.message : "Orcha refused the change. Refresh before trying again.");
      if (e instanceof WorkflowApiError && [401, 403, 404, 405].includes(e.status)) setSupport(null);
    } finally { setBusy(false); setConfirm(null); }
  }
  async function checkCurrent() {
    if (!cid || busy) return;
    setBusy(true);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const snapshot = await fetchSnapshot(cid, controller.signal);
      const current = snapshot.tasks.find((t) => t.id === task.id);
      if (!current || (current.autonomy !== "on" && current.autonomy !== "off") || !current.autonomy_revision) throw new Error("Setting unavailable");
      setSaved({ autonomy: current.autonomy, autonomy_revision: current.autonomy_revision });
      // A read is a current-state observation, not a receipt for the lost PUT.
      setMessage(`Current setting: ${current.autonomy.toUpperCase()}. The earlier change has no save receipt. Review any further change before saving.`);
      setUncertain(false); void refresh(); setRetry((n) => n + 1);
    } catch { setMessage("The current setting could not be confirmed. The earlier change remains unconfirmed; reconnect and check again."); }
    finally { clearTimeout(timer); setBusy(false); }
  }
  async function readHistory() {
    if (!support?.approvals || historyBusy) return;
    setHistoryOpen(true); setHistoryBusy(true); setHistory(null); setHistoryError("");
    try {
      const result = await workflowRequest("TaskApprovalHistory", `/api/tasks/${encodeURIComponent(task.id)}/approvals`);
      if (result.task_id !== task.id) throw new Error("Approval history did not match this task.");
      setHistory(result);
    } catch (e) { setHistoryError(e instanceof Error ? e.message : "Approval history is unavailable."); }
    finally { setHistoryBusy(false); }
  }
  return <PropertySection title="Task authority">
    <Property label="Autonomy" layout="stack"><div className="td-task-authority" data-task-autonomy={mode}>
      <strong>{mode.toUpperCase()}</strong>
      <p>{mode === "on" ? "The agent may approve its plan, start work and accept its finished result." : "The plan and finished work each need approval."}</p>
      <p>Changes apply to future actions. Completed work, dependencies, holds and stop instructions stay in effect. A person still finishes the workflow. Direct requests are always allowed.</p>
      {blocked && <p>{blocked}</p>}
      <button type="button" role="switch" aria-label="Task autonomy" aria-checked={mode === "on"} className="wf-switch" disabled={!!blocked || busy || uncertain} title={blocked ?? undefined} onClick={() => setConfirm(mode === "on" ? "off" : "on")}><span aria-hidden="true" />{mode.toUpperCase()}</button>
      {confirm && <div role="group" aria-label="Confirm task autonomy change">
        <p>{confirm === "on" ? "Allow this agent to approve its own future plan and finished work?" : "Require approval for this task’s future plan and finished work?"}</p>
        <Button disabled={busy} onClick={() => setConfirm(null)}>Keep current setting</Button>
        <Button disabled={!!blocked || busy || uncertain} onClick={() => void save()}>Save {confirm.toUpperCase()}</Button>
      </div>}
      {message && <p role="status">{message}</p>}
      {uncertain && <Button disabled={busy} onClick={() => void checkCurrent()}>Check current setting</Button>}
      {!uncertain && (discoveryError || !support) && <Button disabled={busy} onClick={() => setRetry((n) => n + 1)}>Check task authority</Button>}
    </div></Property>
    <Property label="Approval history" layout="stack">
      {support && !support.approvals && <p>Separate plan and finished-work history is unavailable on this server.</p>}
      <Button size="sm" disabled={!support?.approvals || historyBusy} onClick={() => void readHistory()}>{historyBusy ? "Loading approvals…" : historyOpen ? "Refresh approval history" : "Read approval history"}</Button>
      {historyError && <p role="alert">{historyError}</p>}
      {history && <div aria-label="Recorded task approvals">{(["plan", "completion"] as const).map((phase) => <section key={phase}>
        <h4>{phase === "plan" ? "Plan approvals" : "Finished-work approvals"}</h4>
        {!history.approvals.some((r) => r.phase === phase) && <p>No {phase === "plan" ? "plan" : "finished-work"} approval recorded.</p>}
        {history.approvals.filter((r) => r.phase === phase).map((record) => <div key={record.id}>
          <p>{record.actor_alias} ({record.actor_kind === "human" ? "person" : "agent"}) approved work revision {record.work_revision} on <time dateTime={record.approved_at}>{new Date(record.approved_at).toLocaleString()}</time>.</p>
          <p>Task autonomy {record.autonomy_at_approval.toUpperCase()} at the time · setting revision {record.autonomy_revision}.</p>
          <details><summary>Recorded permission and file fingerprints</summary><p>Permission source: {record.permission_source}</p><p className="wf-fingerprint">Requirements: {record.requirements_sha256}</p><p className="wf-fingerprint">Submission: {record.submission_sha256}</p></details>
        </div>)}
      </section>)}</div>}
    </Property>
  </PropertySection>;
}
