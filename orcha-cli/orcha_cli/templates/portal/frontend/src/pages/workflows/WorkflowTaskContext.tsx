import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { getJSON, type ApiError } from "../../api/client";
import { Button } from "../../components/primitives/Button";
import { Property, PropertySection, StatusIcon } from "../../components/primitives";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { WorkflowEvidencePanel } from "./WorkflowEvidence";
import { WorkflowTaskAcceptanceRecord } from "./WorkflowTaskAcceptanceRecord";
import { hasWorkflowRoutes, WorkflowApiError, workflowPaths, workflowRequest, workflowWriteReason } from "./workflowApi";
import type { WorkflowDetail, WorkflowTask } from "./workflowContract.generated";
import "./workflows.css";

type ReadState = "loading" | "ready" | "unsupported" | "unavailable" | "forbidden";
type Membership = { detail: WorkflowDetail; task: WorkflowTask };
type Index = { state: ReadState; members: Map<string, Membership>; error: string; refresh: () => void };
const Context = createContext<Index | null>(null);

/** One paginated read for the Tasks page, not one request per row. The existing
 * task snapshot does not project membership yet, so never infer it from a URL
 * hint, stored task status, assignee, or an incomplete first page. */
export function WorkflowTaskProvider({ children }: { children: ReactNode }) {
  const { cid, identityTrusted, identityPending } = useSnapshot();
  const authority = useActingAuthority();
  const actorId = !identityPending ? authority.human?.id ?? null : null;
  const scope = JSON.stringify([window.location.origin, cid, actorId, identityTrusted, identityPending]);
  return <MembershipIndex scope={scope} cid={cid} actorId={actorId}>{children}</MembershipIndex>;
}

function MembershipIndex({ scope, cid, actorId, children }: { scope: string; cid: string | null; actorId: string | null; children: ReactNode }) {
  const [stored, setValue] = useState<Omit<Index, "refresh"> & { scope: string }>({ scope, state: "loading", members: new Map(), error: "" });
  const value = stored.scope === scope ? stored : { scope, state: "loading" as const, members: new Map<string, Membership>(), error: "" };
  const [retry, setRetry] = useState(0);
  const refresh = () => setRetry((n) => n + 1);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    if (!cid) return;
    let active = true;
    const controller = new AbortController();
    setValue((old) => ({ scope, members: old.scope === scope ? old.members : new Map(), state: "loading", error: "" }));
    const timer = setTimeout(() => controller.abort(), 15_000);
    async function load() {
      const spec = await getJSON<unknown>("/openapi.json", controller.signal);
      if (!hasWorkflowRoutes(spec)) {
        if (active) setValue({ scope, state: "unsupported", members: new Map(), error: "" });
        return;
      }
      const capability = await workflowRequest("Capability", workflowPaths.collection(cid!) + "/capability", { signal: controller.signal, actorId });
      if (!capability.workflow_read) throw new WorkflowApiError("Workflow access is unavailable. Check your sign-in and project membership.", 403);
      const members = new Map<string, Membership>();
      const workflowIds = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        // Hidden membership must still guard legacy task mutations.
        const query = new URLSearchParams({ limit: "50", visibility: "all" });
        if (cursor) query.set("cursor", cursor);
        const page = await workflowRequest("WorkflowList", workflowPaths.collection(cid!) + `?${query}`, { signal: controller.signal, actorId });
        if (!page.capability.workflow_read || page.workflows.some((w) => w.container_id !== cid || !w.capability.workflow_read)) {
          throw new WorkflowApiError("Workflow access changed. Refresh before continuing.", 403);
        }
        for (const detail of page.workflows) {
          if (workflowIds.has(detail.id)) throw new Error("Workflow membership changed while loading. Refresh before continuing.");
          workflowIds.add(detail.id);
          for (const task of detail.tasks) {
            if (members.has(task.id)) throw new Error("Workflow membership changed while loading. Refresh before continuing.");
            members.set(task.id, { detail, task });
          }
        }
        cursor = page.next_cursor ?? null;
        if (cursor && cursors.has(cursor)) throw new Error("Workflow pages could not be checked. Refresh before continuing.");
        if (cursor) cursors.add(cursor);
      } while (cursor && active && !controller.signal.aborted);
      if (active && !controller.signal.aborted) setValue({ scope, state: "ready", members, error: "" });
    }
    void load().catch((error: unknown) => {
      if (!active) return;
      const forbidden = error instanceof Error && [401, 403].includes((error as ApiError).status ?? 0);
      setValue((old) => ({ scope, state: forbidden ? "forbidden" : "unavailable", members: forbidden || old.scope !== scope ? new Map() : old.members,
        error: forbidden ? "Workflow access is unavailable. Check your sign-in and project membership."
          : "Workflow membership could not be checked. Refresh before changing this task." }));
    }).finally(() => clearTimeout(timer));
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [cid, scope, retry, actorId]);
  return <Context.Provider value={{ ...value, refresh }}>{children}</Context.Provider>;
}

export function useTaskWorkflow(taskId: string | null) {
  const index = useContext(Context);
  const member = taskId ? index?.members.get(taskId) : undefined;
  const blockLegacy = !!index && index.state !== "unsupported" && (index.state !== "ready" || !!member);
  return { index, member, blockLegacy, stale: !!index && index.state !== "ready" };
}

export function workflowMemberHref(detail: WorkflowDetail, taskId?: string) {
  return `/workflows/${encodeURIComponent(detail.id)}?${new URLSearchParams({ cid: detail.container_id })}${taskId ? `#workflow-task-${encodeURIComponent(taskId)}` : ""}`;
}

export function WorkflowTaskStatus({ taskId, fallback, showLabel = false, className, size }: {
  taskId: string; fallback: string; showLabel?: boolean; className?: string; size?: number;
}) {
  const { member, stale } = useTaskWorkflow(taskId);
  if (!member || member.detail.hidden) return <StatusIcon status={fallback} showLabel={showLabel} className={className} size={size} />;
  const listWarning = member.task.display_state.list_warning === true;
  const warningText = member.task.display_state.warning || "Released without stop confirmation: the worker may still be running outside Orcha.";
  const label = `${member.task.display_state.label}${stale ? " (last loaded)" : ""}${listWarning ? ` · ${warningText}` : ""}`;
  if (!showLabel) return <span className={className} role="img" aria-label={label} title={label}>
    <StatusIcon status={member.task.status} size={size} />
  </span>;
  return <span className={`wf-task-state ${className ?? ""}`} title={member.task.display_state.label}>
    {member.task.display_state.label}{stale && " (last loaded)"}{listWarning && <span aria-label={warningText}> · Warning</span>}
  </span>;
}

/** Saved results precede diagnostics, including when reached from a direct
 * task URL. Acceptance attribution comes only from the immutable server
 * record; it is never inferred from the assignee or current owner. */
export function WorkflowTaskInspector({ taskId }: { taskId: string }) {
  const { index, member, stale } = useTaskWorkflow(taskId);
  const { snap, identityPending } = useSnapshot();
  const authority = useActingAuthority();
  if (!index || index.state === "unsupported" || member?.detail.hidden) return null;
  const verified = !identityPending && !!authority.human;
  return <PropertySection title="Workflow"><Property label="Membership" layout="stack"><section aria-label="Task workflow" className="wf-task-context">
    {index.state === "loading" && <p role="status">Checking workflow membership… Task changes wait until this check finishes.</p>}
    {index.error && <p role="alert">{index.error}</p>}
    {member && <>
      <h2>Workflow: <Link to={workflowMemberHref(member.detail, taskId)}>{member.detail.title}</Link></h2>
      {stale && <p role="status">Showing last loaded workflow information. Refresh before continuing.</p>}
      <p>{member.task.display_state.label}</p>
      {member.task.withdrawn_at && <p>Withdrawn by {snap?.agents.find((agent) => agent.id === member.task.withdrawn_by)?.alias ?? "Name unavailable"}: {member.task.withdrawn_reason ?? "Reason unavailable"}</p>}
      <p>Task autonomy {member.task.autonomy === "on" ? "ON" : "OFF"}. Only the human project owner can change it. Changes affect future actions.</p>
      <p>{member.task.autonomy === "on" ? "The agent may approve its plan and finished work." : "The plan and finished work need approval."} Holds, prerequisites, stop instructions and the human Finish action still apply.</p>
      <WorkflowTaskAcceptanceRecord task={member.task} />
      <p>Review finished results in the workflow task controls. Plan approval is a separate decision.</p>
      {workflowWriteReason(member.detail.capability, verified) && <p>{workflowWriteReason(member.detail.capability, verified)}</p>}
      {member.task.blockers.length > 0 && <ul aria-label="Workflow blockers">{member.task.blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul>}
      {member.task.display_state.warning && <p className="wf-warning">{member.task.display_state.warning}</p>}
      {member.task.display_state.release_available_at && <p>If the worker stays silent, lost-worker release becomes available at <time dateTime={member.task.display_state.release_available_at}>{new Date(member.task.display_state.release_available_at).toLocaleString()}</time>. Refresh to check availability.</p>}
      <p><Link to={workflowMemberHref(member.detail, taskId)}>Open workflow task controls</Link> to review holds, dependencies, stop and recovery options.</p>
      {!stale && <WorkflowEvidencePanel key={`${member.detail.id}:${taskId}:${member.detail.revision}`} detail={member.detail} taskId={taskId} />}
    </>}
    {(member || index.state !== "ready") && <Button disabled={index.state === "loading"} onClick={index.refresh}>Refresh task workflow</Button>}
  </section></Property></PropertySection>;
}
