import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../components/primitives/Button";
import { WorkflowApiError, workflowPaths, workflowRequest } from "./workflowApi";
import type { ActivityPage, WorkflowDetail } from "./workflowContract.generated";
import { WorkflowTaskLink } from "./WorkflowTaskReturn";

function eventLabel(event: string) {
  const labels: Record<string, string> = { workflow_created: "Workflow saved in Preparing", workflow_tasks_added: "Tasks added", workflow_goal_accepted: "Goal accepted",
    workflow_objective_accepted: "Objective accepted", workflow_task_accepted: "Task result accepted", workflow_finished: "Workflow finished", workflow_cancelled: "Workflow cancelled",
    workflow_started: "Workflow started", workflow_paused: "New starts paused", workflow_resumed: "Workflow resumed", workflow_outside_result_submitted: "Outside result saved",
    workflow_evidence_replaced: "Missing evidence replaced", workflow_task_released: "Task holds released", workflow_task_held: "Task put on hold",
    workflow_task_stopped: "Worker stop requested", workflow_lost_worker_released: "Worker released without stop confirmation" };
  return labels[event] ?? event.replace(/^workflow_/, "").replaceAll("_", " ");
}
export function WorkflowActivity({ detail }: { detail: WorkflowDetail }) {
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [cursor, setCursor] = useState<{ at: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setBusy(true); setError("");
    const q = new URLSearchParams({ limit: "50" });
    if (cursor) { q.set("before_at", cursor.at); q.set("before_id", cursor.id); }
    void workflowRequest("ActivityPage", workflowPaths.detail(detail.id) + `/activity?${q}`, { signal: controller.signal }).then((result) => {
      if (!active) return;
      if (cursor && result.next_before_at === cursor.at && result.next_before_id === cursor.id) throw new Error("The same history page was returned. Retry before loading more.");
      if (!!result.next_before_at !== !!result.next_before_id) throw new Error("The history page is incomplete. Retry before loading more.");
      setPage((previous) => ({ ...result, activity: cursor && previous ? [...new Map([...previous.activity, ...result.activity].map((entry) => [entry.id, entry])).values()] : result.activity }));
      setForbidden(false);
    }).catch((e) => { if (active) {
      const denied = e instanceof WorkflowApiError && (e.status === 401 || e.status === 403);
      if (denied) { setPage(null); setForbidden(true); }
      setError(denied ? "Access to this workflow’s activity changed. Check your sign-in and project membership."
        : e instanceof Error ? e.message : "Activity could not be loaded.");
    } }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; controller.abort(); };
  }, [detail.id, cursor, retry]);
  return <section aria-label="Workflow activity"><h3>Activity</h3>
    <Button disabled={busy} onClick={() => { setCursor(null); setRetry((n) => n + 1); }}>Refresh activity</Button>
    {error && <p role="alert">{error} <Button onClick={() => setRetry((n) => n + 1)}>Retry history</Button></p>}
    {error && !forbidden && page && <p>Showing previously loaded activity. The latest history could not be confirmed.</p>}
    {busy && <p role="status">Loading activity…</p>}
    {page && page.activity.length === 0 && <p>No activity recorded.</p>}
    <ol>{(forbidden ? [] : page?.activity ?? detail.activity ?? []).map((entry) => <li key={entry.id}><p>{eventLabel(entry.event)} · {entry.actor_alias} ({entry.actor_kind === "human" ? "person" : "agent"})</p>
      <time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString()}</time>
      {typeof entry.detail.reason === "string" && <p>{entry.detail.reason}</p>}
      {typeof entry.detail.warning === "string" && <p className="wf-warning">{entry.detail.warning}</p>}
      {entry.task_id && <WorkflowTaskLink cid={detail.container_id} taskId={entry.task_id}>{detail.tasks.find((t) => t.id === entry.task_id)?.title ?? "Open related task"}</WorkflowTaskLink>}
    </li>)}</ol>
    {page?.next_before_at && page.next_before_id && <Button disabled={busy} onClick={() => setCursor({ at: page.next_before_at!, id: page.next_before_id! })}>Load earlier activity</Button>}
  </section>;
}
export function WorkflowReviewHistory({ detail, renderActions }: { detail: WorkflowDetail; renderActions?: (taskId: string) => ReactNode }) {
  return <section aria-label="Review history"><h3>Review history</h3><p>Each correction and review uses a fresh task. Accepting a report does not resolve its findings or finish this workflow.</p>
    {detail.review_rounds === undefined ? <p>Review history is unavailable on this server version.</p> : detail.review_rounds.length === 0 ? <p>No review rounds recorded yet.</p>
      : <ol>{detail.review_rounds.map((round) => <li key={round.id}><h4>Round {round.round_number} — {round.outcome?.replaceAll("_", " ") ?? "Awaiting review"}</h4>
        <WorkflowTaskLink cid={detail.container_id} taskId={round.review_task_id}>{detail.tasks.find((t) => t.id === round.review_task_id)?.title ?? "Open review task"}</WorkflowTaskLink>
        {round.outcome && <p>{round.review_work_revision != null ? `Review report work revision ${round.review_work_revision}.` : "The review report’s work revision is unavailable on this server version."}</p>}
        {round.correction_task_id && <> · <WorkflowTaskLink cid={detail.container_id} taskId={round.correction_task_id}>{detail.tasks.find((t) => t.id === round.correction_task_id)?.title ?? "Open correction task"}</WorkflowTaskLink></>}
        {round.outcome && round.reviewed_task_id && round.reviewed_work_revision != null ? <>
          <p>Reviewed <WorkflowTaskLink cid={detail.container_id} taskId={round.reviewed_task_id}>{detail.tasks.find((t) => t.id === round.reviewed_task_id)?.title ?? "the recorded task"}</WorkflowTaskLink> · work revision {round.reviewed_work_revision}.</p>
          <p>Reviewed saved evidence: {round.reviewed_artifact.items.length} exact file versions.</p>
          <ul>{round.reviewed_artifact.items.map((item, index) => <li key={item.item_id}>
            <a href={`/api/tasks/${encodeURIComponent(round.reviewed_task_id!)}/deliverables/${encodeURIComponent(item.deliverable_id)}/versions/${item.deliverable_version}/raw`}>Reviewed file {index + 1} — version {item.deliverable_version}</a>
          </li>)}</ul>
        </> : <p>{round.outcome ? "The exact reviewed-task reference is unavailable on this server version." : "Saved evidence will appear after this review outcome is recorded."}</p>}
        {round.resolved_by_owner && <p>Resolved by owner decision: {round.resolved_reason}</p>}
        {!round.resolved_by_owner && round.outcome !== "accepted" && renderActions?.(round.review_task_id)}
      </li>)}</ol>}
    {detail.limit_reached && <p className="wf-warning">Limit reached — no new starts. The owner can review the limits; the workflow has not finished.</p>}
  </section>;
}
