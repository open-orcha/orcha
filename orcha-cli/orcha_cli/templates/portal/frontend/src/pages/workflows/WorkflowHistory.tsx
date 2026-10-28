import { useEffect, useState, type ReactNode } from "react";
import { Avatar, Badge, Button, Chip, EmptyState, IconButton, Timeline, TimelineCard, TimelineEvent, type Tone } from "../../components/primitives";
import { Icon } from "../../components/ui";
import { WorkflowApiError, workflowPaths, workflowRequest } from "./workflowApi";
import type { Activity, ActivityPage, RepeatGroupView, ReviewHistory, WorkflowDetail } from "./workflowContract.generated";
import { useRounds } from "./WorkflowLoopDecision";
import { ENDINGS } from "./WorkflowRoundContext";
import { WorkflowTaskLink } from "./WorkflowTaskReturn";

function eventLabel(event: string) {
  const labels: Record<string, string> = { workflow_created: "Workflow saved in Preparing", workflow_tasks_added: "Tasks added", workflow_goal_accepted: "Goal accepted",
    workflow_objective_accepted: "Objective accepted", workflow_task_accepted: "Task result accepted", workflow_finished: "Workflow finished", workflow_cancelled: "Workflow cancelled",
    workflow_started: "Workflow started", workflow_paused: "New starts paused", workflow_resumed: "Workflow resumed", workflow_outside_result_submitted: "Outside result saved",
    workflow_evidence_replaced: "Missing evidence replaced", workflow_task_released: "Task holds released", workflow_task_held: "Task put on hold",
    workflow_task_stopped: "Worker stop requested", workflow_lost_worker_released: "Worker released without stop confirmation",
    workflow_outcome_reported: "Outcome reported", workflow_route_applied: "Next step decided", workflow_outcome_missing: "Accepted without an outcome",
    workflow_loop_decided: "Owner decided how the loop continues", workflow_flow_changed: "Outcomes and loops changed" };
  return labels[event] ?? event.replace(/^workflow_/, "").replaceAll("_", " ");
}
/** §4.9 stale bar / warn banner: one warn-toned strip with an alert glyph. */
function HistoryBar({ children }: { children: ReactNode }) {
  return <div className="wf-tl-bar"><Icon name="alert" cls="v2-ico" /><div className="wf-tl-bar-text">{children}</div></div>;
}
const LOOP_PAUSES: Record<string, string> = { limit_reached: "The loop reached its round limit. Waiting for the owner.",
  stalled: "The loop stalled: the same findings came back on unchanged work. Waiting for the owner.", ask_owner: "Waiting for the owner to choose what happens next." };
const LOOP_DECISIONS: Record<string, string> = { raise_limit: "Allowed more rounds.", reassign_continue: "Reassigned the step and ran another round.",
  accept_override: "Accepted the work as it is and ended the loop.", resume_stalled: "Resumed the loop with guidance.", pick_outcome: "Chose the outcome.", stop: "Stopped the loop." };
/** Body lines under an activity entry: same-person, supplier, reason, warning (warn) — in that order. */
function activityNotes(entry: Activity): ReactNode[] {
  const notes: ReactNode[] = [];
  if (entry.event === "workflow_task_accepted" && entry.detail.same_person_supplier === true) notes.push(<span key="same" className="wf-tl-note">Owner-supplied result, accepted by the same person.</span>);
  if (entry.event === "workflow_task_accepted" && typeof entry.detail.supplier_alias === "string") notes.push(<span key="supplier" className="wf-tl-note">Submitted by {entry.detail.supplier_alias} (verified).</span>);
  if (entry.event === "workflow_outcome_reported" || entry.event === "workflow_route_applied") {
    const findings = typeof entry.detail.findings === "number" && entry.detail.findings > 0 ? ` ${entry.detail.findings} ${entry.detail.findings === 1 ? "finding" : "findings"}.` : "";
    notes.push(<span key="outcome" className="wf-tl-note">“{String(entry.detail.outcome)}”: {String(entry.detail.route ?? "")}{findings}</span>);
  }
  if (entry.event === "workflow_route_applied" && typeof entry.detail.result === "string" && LOOP_PAUSES[entry.detail.result])
    notes.push(<span key="pause" className="wf-tl-note is-warn"><Icon name="alert" cls="v2-ico" />{LOOP_PAUSES[entry.detail.result]}</span>);
  if (entry.event === "workflow_outcome_missing") notes.push(<span key="missing" className="wf-tl-note is-warn"><Icon name="alert" cls="v2-ico" />This step declares outcomes but none was reported. The owner picks one before the workflow continues.</span>);
  if (entry.event === "workflow_loop_decided") notes.push(<span key="decided" className="wf-tl-note">{LOOP_DECISIONS[String(entry.detail.chosen)] ?? String(entry.detail.chosen)}{typeof entry.detail.original_outcome === "string" && entry.detail.original_outcome ? ` The reported outcome “${entry.detail.original_outcome}” is kept in the record.` : ""}</span>);
  if (typeof entry.detail.reason === "string" && entry.detail.reason) notes.push(<span key="reason" className="wf-tl-note">{entry.detail.reason}</span>);
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
/** #362 loop rounds: one card per round of a feedback loop, with the review's outcome and findings. */
function LoopRounds({ detail, group }: { detail: WorkflowDetail; group: RepeatGroupView }) {
  const review = detail.tasks.find((t) => t.id === group.review_task);
  const context = useRounds(review ?? { id: group.review_task, repeat_group_id: group.id } as WorkflowDetail["tasks"][number], !!review);
  if (!review) return null;
  const g = context?.group;
  // Round N's inputs hold round N-1's findings; the latest review's findings are on its reported outcome.
  // Round 0 means the loop has not opened yet, so there is no round to list.
  const rounds = Array.from({ length: Math.max(group.current_round, 0) }, (_, i) => i + 1).map((n) => {
    const later = n + 1 === g?.round ? g.this_round : g?.earlier_rounds?.find((r) => r.round === n + 1);
    const ended = g?.earlier_rounds?.find((r) => r.round === n)?.ended;
    const latest = n === group.current_round ? review.reported_outcome : null;
    return { n, findings: latest?.findings ?? later?.findings ?? [], outcome: latest?.outcome ?? later?.outcome ?? null, ended };
  });
  return <TimelineCard className="wf-round" label={group.name}>
    <div className="wf-round-h"><h4><Icon name="refresh" cls="v2-ico" /> {group.name}</h4><Badge tone="neutral">{group.current_round < 1 ? `Not started · up to ${group.max_rounds} rounds` : `Round ${group.current_round} of ${group.max_rounds}`}</Badge></div>
    <p className="wf-muted">Exits when {review.title} reports {group.exit_outcome.replaceAll("_", " ")}.</p>
    {rounds.length === 0 && <p className="wf-muted">No rounds yet: the loop opens when its first step starts.</p>}
    <ol className="wf-earlier">{rounds.map((r) => <li key={r.n}><strong>Round {r.n}</strong>
      {r.outcome ? <> · <Badge tone={outcomeTone(r.outcome === group.exit_outcome ? "accepted" : "changes_requested")}>{r.outcome.replaceAll("_", " ")}</Badge></> : r.n === group.current_round ? <span className="wf-muted"> · in progress</span> : null}
      {r.ended && <span className="wf-muted"> · {ENDINGS[r.ended] ?? r.ended}</span>}
      {r.findings.length > 0 && <ul>{r.findings.map((f, i) => <li key={i}>{f.text}</li>)}</ul>}</li>)}</ol>
  </TimelineCard>;
}
export function WorkflowReviewHistory({ detail, renderActions }: { detail: WorkflowDetail; renderActions?: (taskId: string) => ReactNode }) {
  // "used" follows the server's own rule for the limit: the highest recorded round number (workflow_service round_limit checks).
  const used = detail.review_rounds && Math.max(0, ...detail.review_rounds.map((round) => round.round_number));
  return <section className="wf-history" aria-label="Review history">
    <div className="wf-tl-head"><h3>Review history</h3></div>
    <p className="wf-tl-intro">Each correction and review uses a fresh task. Accepting a report does not resolve its findings or finish this workflow.
      <span className="wf-muted"> Round limit {detail.round_limit}{used !== undefined && <> · used {used}</>}.</span></p>
    {detail.semantics_version === 2 && !!detail.repeat_groups?.length && <Timeline label="Feedback loop rounds" className="wf-tl">
      {detail.repeat_groups.map((g) => <LoopRounds key={g.id} detail={detail} group={g} />)}</Timeline>}
    {detail.review_rounds === undefined ? <EmptyState compact title="Review history is unavailable on this server version." />
      : detail.review_rounds.length === 0 ? <EmptyState compact title="No review rounds recorded yet." />
      : <Timeline label="Review rounds" className="wf-tl">{detail.review_rounds.map((round) => <ReviewRoundCard key={round.id} detail={detail} round={round} renderActions={renderActions} />)}</Timeline>}
    {detail.limit_reached && <HistoryBar><span>Limit reached — no new starts. The owner can review the limits; the workflow has not finished.</span></HistoryBar>}
  </section>;
}
