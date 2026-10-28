import { useWorkflowOperation } from "./workflowOperations";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchSnapshot, getJSON, mapSnapshot, sendJSON } from "../../api/client";
import { Button, Dialog, EmptyState, Inspector, List, Row, SplitPane } from "../../components/primitives";
import { Linkified } from "../../components/ui";
import { selectAttention, markAttentionDecided } from "../../state/attention";
import { planMessageOf, useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import type { OrchaRequest, Task } from "../../types";
import { RequestDetail, requestNextStep } from "../requests/RequestsPage";
import { reqTitle } from "../requests/requestPayload";
import { WorkflowTaskDecision } from "./WorkflowTaskDecision";
import { availableActionReason } from "./workflowApi";
import type { WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { WorkflowTaskLink } from "./WorkflowTaskReturn";

interface RequestPage { requests: Record<string, unknown>[]; total: number; has_more: boolean }
export function workflowQuestionsSupported(spec: { paths?: Record<string, { get?: { parameters?: { name: string }[] } }> }) {
  return Object.entries(spec.paths ?? {}).some(([path, ops]) => /^\/api\/containers\/\{[^}]+\}\/requests$/.test(path) && ops.get?.parameters?.some((p) => p.name === "workflow"));
}

export function WorkflowInput({ detail, scope, stale, open, onOpen, onClose, onSaved, onChecklist }: {
  detail: WorkflowDetail; scope: DraftScope; stale: boolean; open: boolean; onOpen: () => void; onClose: () => void;
  onSaved: (detail: WorkflowDetail) => void; onChecklist: () => void;
}) {
  const { snap, refresh } = useSnapshot();
  const authority = useActingAuthority();
  const operation = useWorkflowOperation(scope, `workflow:${detail.id}`);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  const [requests, setRequests] = useState<OrchaRequest[]>([]);
  const [support, setSupport] = useState<boolean | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const [extraTasks, setExtraTasks] = useState<Task[]>([]);
  const [taskOffset, setTaskOffset] = useState(0);
  const [taskMore, setTaskMore] = useState(true);
  const [taskBusy, setTaskBusy] = useState(false);
  const [others, setOthers] = useState(false);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    setBusy(true); setError("");
    async function load() {
      const spec = await getJSON<Parameters<typeof workflowQuestionsSupported>[0]>("/openapi.json", controller.signal);
      const supported = workflowQuestionsSupported(spec);
      if (!active) return;
      setSupport(supported);
      if (!supported) return;
      const query = new URLSearchParams({ workflow: detail.id, limit: "30", offset: String(offset) });
      const page = await getJSON<RequestPage>(`/api/containers/${encodeURIComponent(scope.project)}/requests?${query}`, controller.signal);
      if (!Array.isArray(page.requests) || !Number.isSafeInteger(page.total) || page.total < 0 || typeof page.has_more !== "boolean") throw new Error("Incomplete question list");
      // Reject a server that ignored the filter. Spawned tasks are never origin links.
      if (page.requests.some((r) => !r.originating_task_id || (r.origin_task as { workflow_id?: string } | null)?.workflow_id !== detail.id)) throw new Error("Workflow questions could not be matched to this workflow.");
      const rows = mapSnapshot({ agents: snap?.agents, requests: page.requests }).requests;
      if (active) { setRequests((old) => offset ? [...new Map([...old, ...rows].map((r) => [r.id, r])).values()] : rows); setMore(page.has_more || page.total > offset + page.requests.length); }
    }
    void load().catch(() => { if (active) setError("Some questions could not be checked. Your drafts are kept."); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; controller.abort(); };
  }, [detail.id, detail.revision, scope.identity, offset, retry]);
  const tasks = [...new Map([...extraTasks, ...(snap?.tasks ?? [])].map((t) => [t.id, t])).values()].filter((t) => detail.tasks.some((wt) => wt.id === t.id));
  const attention = selectAttention(snap ? { ...snap, tasks, requests } : null, authority.human?.id ?? null, { readOnly: authority.readOnly, pending: authority.pending });
  const plans = attention.items.filter((i) => i.kind === "plan" && i.task).map((i) => ({ ...i, kind: "plan" as const, task: i.task! }));
  const questionItems = requests.filter((r) => ["open", "answered", "escalated"].includes(r.status)).map((r) => ({
    key: `request:${r.id}`, title: reqTitle(r), kind: "request" as const, request: r,
    assignedToOther: authority.readOnly || !requestNextStep(snap, r, authority.human).mine,
  }));
  const results = detail.tasks.filter((t) => t.status === "needs_verification" && !t.withdrawn_at).map((t) => ({ key: `verify:${t.id}`, title: t.title, kind: "verify" as const, task: t, assignedToOther: !!availableActionReason(detail.capability, t.available_actions, "accept", !!authority.human) }));
  const items = [...plans, ...results, ...questionItems];
  const taskPartial = detail.tasks.some((t) => !tasks.some((s) => s.id === t.id));
  const partial = taskPartial || more || !!error || support !== true;
  const count = plans.filter((i) => !i.assignedToOther).length + results.filter((i) => !i.assignedToOther).length
    + attention.items.filter((i) => i.kind === "request" && !i.assignedToOther).length;
  const shown = items.filter((i) => others || !i.assignedToOther);
  const chosen = items.find((i) => i.key === selection);
  const resolved = () => { setOffset(0); setRetry((r) => r + 1); void refresh(); };
  async function loadTasks() {
    if (taskBusy || !taskMore) return;
    setTaskBusy(true);
    try {
      const page = await getJSON<{ tasks: Record<string, unknown>[]; has_more: boolean }>(`/api/containers/${encodeURIComponent(scope.project)}/tasks?limit=100&offset=${taskOffset}`);
      const next = mapSnapshot({ agents: snap?.agents, tasks: page.tasks }).tasks;
      setExtraTasks((old) => [...new Map([...old, ...next].map((t) => [t.id, t])).values()]); setTaskOffset((v) => v + page.tasks.length); setTaskMore(page.has_more);
    } catch { setError("Some task approvals could not be checked. Try loading again."); }
    finally { setTaskBusy(false); }
  }
  if (detail.hidden) return null;
  return <>
    <div className="wf-input-strip" role="status"><strong>Needs your input</strong><span>{busy || authority.pending || !snap ? "Checking decisions…" : `${partial ? "At least " : ""}${count} ${count === 1 ? "decision" : "decisions"}`}</span>
      <Button size="sm" variant="ghost" onClick={open ? onClose : onOpen}>{open ? "Back to workflow" : "View"}</Button>
      {detail.owner_human_id === scope.identity && <Button size="sm" variant="ghost" onClick={onChecklist}>Finish checklist</Button>}
    </div>
    {open && <div className="wf-input-view">
      <div className="wf-tab-pad">
        {support === false && <p>Workflow questions are not available on this server.</p>}
        <Link to={`/requests?${new URLSearchParams({ cid: scope.project })}`}>Project Requests (including unlinked questions)</Link>
        {error && <p role="alert">{error} <Button onClick={resolved}>Retry questions</Button></p>}
        <Button variant="ghost" aria-pressed={others} onClick={() => setOthers((v) => !v)}>Assigned to someone else</Button>
        {taskPartial && <><p>Some task approvals have not been loaded yet.</p><Button disabled={taskBusy || !taskMore} onClick={() => void loadTasks()}>Load more task approvals</Button></>}
        {more && <Button disabled={busy} onClick={() => setOffset(offset + 30)}>Load more questions</Button>}
      </div>
      <SplitPane storageKey="orcha:v2:workflowInput" list={<List label="Workflow decisions">{shown.map((i) => <Row key={i.key} selected={selection === i.key} onActivate={() => setSelection(i.key)} className="wf-row is-two">
        <span className="wf-title"><span>{i.title}</span><span className="wf-sub">{i.kind === "plan" ? "Plan approval" : i.kind === "verify" ? "Finished work" : `Question · ${i.request?.from} → ${i.request?.to} · ${i.request?.status === "answered" ? "Answered · awaiting follow-up" : i.request?.status}`}{i.assignedToOther ? " · Assigned to someone else" : ""}</span></span>
      </Row>)}{!shown.length && !busy && <EmptyState title={partial ? "No decisions in the loaded items" : "No input needed right now"} />}</List>} inspector={chosen && chosen.kind !== "verify" ? <Inspector title={chosen.title} label="Workflow decision" onClose={() => setSelection(null)}>
        {chosen.kind === "plan" && chosen.task && <WorkflowPlan key={chosen.key} task={chosen.task} scope={scope} disabled={stale || chosen.assignedToOther} onSaved={resolved} />}
        {chosen.kind === "request" && <>
          {chosen.request.originating_task_id && <p className="wf-p">From task: <WorkflowTaskLink cid={scope.project} taskId={chosen.request.originating_task_id}>{detail.tasks.find((t) => t.id === chosen.request.originating_task_id)?.title ?? "Open originating task"}</WorkflowTaskLink></p>}
          <RequestDetail key={chosen.key} r={chosen.request} idShown draftScope={scope} readOnlyReason={stale || busy || !!error ? "Refresh workflow decisions before responding." : undefined} onSelect={(id) => {
            if (requests.some((r) => r.id === id)) setSelection(`request:${id}`);
            else window.location.assign(`/requests?${new URLSearchParams({ cid: scope.project, req: id })}`);
          }} onResolved={resolved} />
        </>}
      </Inspector> : null} />
      {chosen?.kind === "verify" && <Dialog title={`Review result: ${chosen.title}`} size="lg" className="wf-page wf-review-dialog" onClose={() => { if (!unresolved) setSelection(null); }}>
        <WorkflowTaskDecision detail={detail} task={chosen.task} scope={scope} stale={stale} verified={!!authority.human} onSaved={(result) => { onSaved(result); resolved(); setSelection(null); }} />
      </Dialog>}
    </div>}
  </>;
}

function WorkflowPlan({ task, scope, disabled, onSaved }: { task: Task; scope: DraftScope; disabled: boolean; onSaved: () => void }) {
  const authority = useActingAuthority();
  const [reason, setReason] = useWorkflowForm(scope, `plan:${task.id}`, "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useWorkflowForm(scope, `plan-pending:${task.id}`, false);
  const plan = planMessageOf(task);
  async function decide(approve: boolean) {
    if (busy || disabled || uncertain || !authority.human || (!approve && !reason.trim())) return;
    setBusy(true); setError("");
    let sent = false;
    try {
      const latest = await fetchSnapshot(scope.project);
      const current = latest.tasks.find((t) => t.id === task.id);
      const item = selectAttention(latest, scope.identity).items.find((i) => i.kind === "plan" && i.id === task.id);
      if (!current || !item || item.assignedToOther || JSON.stringify(planMessageOf(current)) !== JSON.stringify(plan) || current.work_revision !== task.work_revision || current.definition_of_done !== task.definition_of_done) throw new Error("The plan or task changed. Refresh and read it again before deciding. Your feedback is kept.");
      const target = latest.agents.find((a) => a.alias === plan?.from);
      if (!target) throw new Error("The plan author is unavailable. Refresh before deciding.");
      sent = true; setUncertain(true);
      await sendJSON("POST", "/api/decisions", { subject_type: "plan_approval", subject_id: task.id, decision: approve ? "approve" : "reject", reason: reason.trim() || undefined, actor_agent_id: scope.identity, target_agent_id: target.id });
      setUncertain(false); setReason(""); markAttentionDecided(`plan:${task.id}`); onSaved();
    } catch (e) { const status = (e as { status?: number }).status; if (!sent || (status && status < 500)) setUncertain(false); setError(sent && !status ? "The decision is unconfirmed. Check the saved decision before trying again." : e instanceof Error ? e.message : "The decision could not be saved."); }
    finally { setBusy(false); }
  }
  async function check() {
    setBusy(true);
    try { const latest = await fetchSnapshot(scope.project); const current = latest.tasks.find((t) => t.id === task.id); if (current?.plan_decision) { setUncertain(false); onSaved(); } else setError("The decision is still unconfirmed. Refresh again; do not send a duplicate."); }
    catch { setError("The saved decision could not be checked."); } finally { setBusy(false); }
  }
  return <section className="wf-plan"><h3>Plan approval</h3><p>Done when: {task.definition_of_done}</p><Linkified text={plan?.body ?? "Plan unavailable"} />
    <p>Autonomy OFF: the plan and finished work each need approval. Approving this plan does not accept finished work or finish the workflow.</p>
    <label>Feedback<textarea maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy || uncertain} /></label>
    {error && <p role="alert">{error}</p>}<div className="wf-actionsgrid"><Button variant="primary" disabled={disabled || busy || uncertain || !authority.human} onClick={() => void decide(true)}>Approve plan</Button>
      <Button disabled={disabled || busy || uncertain || !authority.human || !reason.trim()} onClick={() => void decide(false)}>Request changes</Button>
      {uncertain && <Button disabled={busy} onClick={() => void check()}>Check saved decision</Button>}
    </div></section>;
}
