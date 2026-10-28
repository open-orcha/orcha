import { useEffect, useState, type ReactNode } from "react";
import { Avatar, Badge, Button, Chip, EmptyState, IconButton, Timeline, TimelineCard, TimelineEvent, type Tone } from "../../components/primitives";
import { Icon } from "../../components/ui";
import { WorkflowApiError, workflowPaths, workflowRequest } from "./workflowApi";
import type { Activity, ActivityPage, ReviewHistory, WorkflowDetail } from "./workflowContract.generated";
import { WorkflowTaskLink } from "./WorkflowTaskReturn";

function eventLabel(event: string) {
  const labels: Record<string, string> = { workflow_created: "Workflow saved in Preparing", workflow_tasks_added: "Tasks added", workflow_goal_accepted: "Goal accepted",
    workflow_objective_accepted: "Objective accepted", workflow_task_accepted: "Task result accepted", workflow_finished: "Workflow finished", workflow_cancelled: "Workflow cancelled",
    workflow_started: "Workflow started", workflow_paused: "New starts paused", workflow_resumed: "Workflow resumed", workflow_outside_result_submitted: "Outside result saved",
    workflow_evidence_replaced: "Missing evidence replaced", workflow_task_released: "Task holds released", workflow_task_held: "Task put on hold",
    workflow_task_stopped: "Worker stop requested", workflow_lost_worker_released: "Worker released without stop confirmation" };
  return labels[event] ?? event.replace(/^workflow_/, "").replaceAll("_", " ");
}
/** §4.9 stale bar / warn banner: one warn-toned strip with an alert glyph. */
function HistoryBar({ children }: { children: ReactNode }) {
  return <div className="wf-tl-bar"><Icon name="alert" cls="v2-ico" /><div className="wf-tl-bar-text">{children}</div></div>;
}
/** Body lines under an activity entry: same-person, supplier, reason, warning (warn) — in that order. */
function activityNotes(entry: Activity): ReactNode[] {
  const notes: ReactNode[] = [];
  if (entry.event === "workflow_task_accepted" && entry.detail.same_person_supplier === true) notes.push(<span key="same" className="wf-tl-note">Owner-supplied result, accepted by the same person.</span>);
  if (entry.event === "workflow_task_accepted" && typeof entry.detail.supplier_alias === "string") notes.push(<span key="supplier" className="wf-tl-note">Submitted by {entry.detail.supplier_alias} (verified).</span>);
  if (typeof entry.detail.reason === "string") notes.push(<span key="reason" className="wf-tl-note">{entry.detail.reason}</span>);
  if (typeof entry.detail.warning === "string") notes.push(<span key="warning" className="wf-tl-note is-warn"><Icon name="alert" cls="v2-ico" />{entry.detail.warning}</span>);
  return notes;
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
  const entries = forbidden ? [] : page?.activity ?? detail.activity ?? [];
  const more = !!(page?.next_before_at && page.next_before_id);
  return <section className="wf-history" aria-label="Workflow activity">
    <div className="wf-tl-head"><h3>Activity</h3>
      <IconButton icon="refresh" label="Refresh activity" variant="outline" size="sm" disabled={busy} onClick={() => { setCursor(null); setRetry((n) => n + 1); }} /></div>
    {error && <HistoryBar>
      <span role="alert">{error} <Button variant="link" size="sm" onClick={() => setRetry((n) => n + 1)}>Retry history</Button></span>
      {!forbidden && page && <span>Showing previously loaded activity. The latest history could not be confirmed.</span>}
    </HistoryBar>}
    {busy && <p role="status" className="wf-tl-status">Loading activity…</p>}
    {page && page.activity.length === 0 && <EmptyState compact title="No activity recorded." />}
    {(entries.length > 0 || more) && <Timeline label="Activity entries" className="wf-tl">
      {entries.map((entry) => { const notes = activityNotes(entry); return <TimelineEvent key={entry.id} at={entry.created_at} body={notes.length ? notes : undefined}
        glyph={<Avatar alias={entry.actor_alias} kind={entry.actor_kind === "human" ? "human" : "ai"} size={16} decorative />}
        actor={<>{entry.actor_alias}<span className="v2-sr"> ({entry.actor_kind === "human" ? "person" : "agent"})</span></>}>
        <span className="v2-tl-sep" aria-hidden="true">· </span>{eventLabel(entry.event)}
        {entry.task_id && <> · <WorkflowTaskLink cid={detail.container_id} taskId={entry.task_id}>{detail.tasks.find((t) => t.id === entry.task_id)?.title ?? "Open related task"}</WorkflowTaskLink></>}
      </TimelineEvent>; })}
      {page?.next_before_at && page.next_before_id && <TimelineEvent className="wf-tl-more">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setCursor({ at: page.next_before_at!, id: page.next_before_id! })}>Load earlier activity</Button></TimelineEvent>}
    </Timeline>}
  </section>;
}
function outcomeTone(outcome: string | null | undefined): Tone {
  return outcome === "accepted" ? "ok" : outcome === "changes_requested" ? "warn" : "neutral";
}
function ReviewRoundCard({ detail, round, renderActions }: { detail: WorkflowDetail; round: ReviewHistory; renderActions?: (taskId: string) => ReactNode }) {
  const title = (taskId: string, fallback: string) => detail.tasks.find((t) => t.id === taskId)?.title ?? fallback;
  return <TimelineCard className="wf-round" label={`Round ${round.round_number}`}>
    <div className="wf-round-h"><h4>Round {round.round_number}</h4><Badge tone={outcomeTone(round.outcome)}>{round.outcome?.replaceAll("_", " ") ?? "Awaiting review"}</Badge></div>
    <dl className="wf-round-kv">
      <dt>Review task</dt><dd><WorkflowTaskLink cid={detail.container_id} taskId={round.review_task_id}>{title(round.review_task_id, "Open review task")}</WorkflowTaskLink>
        {round.outcome && <> · <span>{round.review_work_revision != null ? `Review report work revision ${round.review_work_revision}.` : "The review report’s work revision is unavailable on this server version."}</span></>}</dd>
      {round.outcome && round.reviewed_task_id && round.reviewed_work_revision != null ? <>
        <dt>Reviewed</dt><dd><WorkflowTaskLink cid={detail.container_id} taskId={round.reviewed_task_id}>{title(round.reviewed_task_id, "the recorded task")}</WorkflowTaskLink> · work revision {round.reviewed_work_revision}.</dd>
        <dt>Reviewed evidence</dt><dd><span className="wf-muted">Reviewed saved evidence: {round.reviewed_artifact.items.length} exact file versions.</span>
          <span className="wf-chipline">{round.reviewed_artifact.items.map((item, index) => <Chip key={item.item_id} size="sm"
            href={`/api/tasks/${encodeURIComponent(round.reviewed_task_id!)}/deliverables/${encodeURIComponent(item.deliverable_id)}/versions/${item.deliverable_version}/raw`}>Reviewed file {index + 1} — version {item.deliverable_version}</Chip>)}</span></dd>
      </> : <><dt>Reviewed</dt><dd className="wf-muted">{round.outcome ? "The exact reviewed-task reference is unavailable on this server version." : "Saved evidence will appear after this review outcome is recorded."}</dd></>}
      {round.correction_task_id && <><dt>Correction</dt><dd><WorkflowTaskLink cid={detail.container_id} taskId={round.correction_task_id}>{title(round.correction_task_id, "Open correction task")}</WorkflowTaskLink></dd></>}
    </dl>
    {round.resolved_by_owner && <p className="wf-round-resolved"><Icon name="check" cls="v2-ico" />Resolved by owner decision: {round.resolved_reason}</p>}
    {!round.resolved_by_owner && round.outcome !== "accepted" && renderActions && <div className="wf-round-actions">{renderActions(round.review_task_id)}</div>}
  </TimelineCard>;
}
export function WorkflowReviewHistory({ detail, renderActions }: { detail: WorkflowDetail; renderActions?: (taskId: string) => ReactNode }) {
  // "used" follows the server's own rule for the limit: the highest recorded round number (workflow_service round_limit checks).
  const used = detail.review_rounds && Math.max(0, ...detail.review_rounds.map((round) => round.round_number));
  return <section className="wf-history" aria-label="Review history">
    <div className="wf-tl-head"><h3>Review history</h3></div>
    <p className="wf-tl-intro">Each correction and review uses a fresh task. Accepting a report does not resolve its findings or finish this workflow.
      <span className="wf-muted"> Round limit {detail.round_limit}{used !== undefined && <> · used {used}</>}.</span></p>
    {detail.review_rounds === undefined ? <EmptyState compact title="Review history is unavailable on this server version." />
      : detail.review_rounds.length === 0 ? <EmptyState compact title="No review rounds recorded yet." />
      : <Timeline label="Review rounds" className="wf-tl">{detail.review_rounds.map((round) => <ReviewRoundCard key={round.id} detail={detail} round={round} renderActions={renderActions} />)}</Timeline>}
    {detail.limit_reached && <HistoryBar><span>Limit reached — no new starts. The owner can review the limits; the workflow has not finished.</span></HistoryBar>}
  </section>;
}
