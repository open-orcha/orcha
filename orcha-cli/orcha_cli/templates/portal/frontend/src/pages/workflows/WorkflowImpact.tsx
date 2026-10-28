import { Badge } from "../../components/primitives";
import type { Impact, WorkflowDetail, WorkflowImpact } from "./workflowContract.generated";
import { workflowPaths, workflowRequest } from "./workflowApi";

function sameChoices(a: string[], b: string[]) {
  return a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));
}

/** Confirm only the choices the server actually checked, never a local simulation. */
export function impactMatches(impact: Impact | null, taskIds: string[], holds: string[]) {
  return !!impact && sameChoices((impact.tasks ?? []).filter((t) => t.selected).map((t) => t.task_id), taskIds)
    && sameChoices(impact.holds ?? [], holds);
}

export async function readWorkflowImpact(detail: WorkflowDetail, kind: Impact["kind"], taskIds: string[] = [], holds: string[] = ["start"], actorId?: string): Promise<WorkflowImpact> {
  const query = new URLSearchParams();
  taskIds.forEach((id) => query.append("task_ids", id));
  if (kind === "release") holds.forEach((hold) => query.append("holds", hold));
  const current = await workflowRequest("WorkflowImpact", `${workflowPaths.detail(detail.id)}/${kind}-check${query.size ? `?${query}` : ""}`, { actorId });
  const impact = current.impact;
  if (current.id !== detail.id || current.container_id !== detail.container_id || impact.kind !== kind
    || impact.revision !== current.revision || impact.graph_revision !== current.graph_revision || impact.scope_revision !== current.scope_revision
    || current.tasks.some((t) => impact.task_revisions[t.id] !== t.work_revision)
    || (kind === "cancellation" ? !impact.counts_by_state || !impact.accepted_retained || !impact.workers_to_stop
      : !impact.tasks || current.tasks.some((t) => !impact.tasks!.some((row) => row.task_id === t.id && row.work_revision === t.work_revision)))) {
    throw new Error("The action preview is incomplete or changed. Refresh before confirming.");
  }
  return current;
}

const resultingLabels = {
  refused: "Cannot release", unchanged: "Unchanged", blocked: "Still blocked",
  waiting_for_prerequisites: "Waiting for prerequisites", ready: "Ready", takes_turn_alone: "Takes its turn alone",
};

export function WorkflowImpactView({ impact, detail }: { impact: Impact; detail: WorkflowDetail }) {
  const title = (id: string) => detail.tasks.find((t) => t.id === id)?.title ?? "Task no longer available";
  return <section className="wf-impact" aria-label="Checked action impact"><h3>What this action will do</h3>
    {impact.kind === "cancellation" ? <>
      <h4>Current task states</h4>
      <ul>{Object.entries(impact.counts_by_state ?? {}).map(([state, count]) => <li key={state}>{state.replaceAll("_", " ")}: {count}</li>)}</ul>
      <h4>Accepted results kept</h4>
      {impact.accepted_retained?.length ? <ul>{impact.accepted_retained.map((id) => <li key={id}>{title(id)}</li>)}</ul> : <p>No accepted results recorded.</p>}
      <h4>Workers to stop</h4>
      {impact.workers_to_stop?.length ? <ul>{impact.workers_to_stop.map((worker, i) => <li key={i}>{worker.name || "Worker name unavailable"} — {title(worker.task_id)}</li>)}</ul> : <p>No workers currently need a stop request.</p>}
    </> : <>
      <p>These are the server’s checked outcomes. Ready tasks still wait for their turn; a release does not promise an immediate start.</p>
      <ul>{impact.tasks?.map((task) => <li key={task.task_id}>
        <p>{task.title || "Task no longer available"} — <Badge>{resultingLabels[task.resulting_status]}</Badge>{!task.selected && " · Not selected"}</p>
        {task.refusal && <p>{task.refusal.message}</p>}
        {task.blockers?.map((blocker, i) => <p key={i}>{blocker.message}</p>)}
      </li>)}</ul>
    </>}
  </section>;
}
