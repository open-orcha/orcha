/**
 * Where QA work came from, both ways: a request's source task and workflow, and the same line on a
 * session, a finding or a scenario (found through the request that ran it). Shows nothing when the
 * work was started from Quality itself.
 */
import { Link } from "react-router-dom";
import { useSnapshot } from "../../../state/SnapshotProvider";
import { TaskLink, useLoad } from "../parts";
import { listRequests, type QaRequest } from "./api";
import { requestIdHref, workflowHref } from "./links";
import { requestTitle } from "./words";

/** The source task and workflow, as links. */
export function SourceLinks({ r, none = null }: { r: Pick<QaRequest, "source_task_id" | "source_task_title" | "source_workflow_id" | "source_workflow_title">; none?: string | null }) {
  const { cid } = useSnapshot();
  const parts = [
    r.source_task_id ? <TaskLink key="t" id={r.source_task_id} title={r.source_task_title} /> : null,
    r.source_workflow_id ? <Link key="w" className="qa-tasklink" to={workflowHref(r.source_workflow_id, cid)}>{r.source_workflow_title || "Open workflow"}</Link> : null,
  ].filter(Boolean);
  if (!parts.length) return none ? <span className="qa-muted">{none}</span> : null;
  return <span className="qa-source">{parts}</span>;
}

/** The row's plain words for its source: inside a row, so no link. */
export function sourceWords(r: Pick<QaRequest, "source_task_title" | "source_workflow_title" | "source_task_id" | "source_workflow_id">, taskTitle?: string | null): string {
  const task = r.source_task_title || taskTitle || (r.source_task_id ? "A task" : null);
  const flow = r.source_workflow_title || (r.source_workflow_id ? "A workflow" : null);
  return [task, flow].filter(Boolean).join(" · ") || "From Quality";
}

/** Which request a session, or the QA task behind it, belongs to. */
export function requestFor(rows: readonly QaRequest[], ids: { requestId?: string | null; sessionId?: string | null; taskId?: string | null }): QaRequest | null {
  const { requestId, sessionId, taskId } = ids;
  return rows.find((r) => requestId && r.id === requestId)
    ?? rows.find((r) => sessionId && (r.session_id === sessionId || r.result?.session_ids.includes(sessionId)))
    ?? rows.find((r) => taskId && (r.qa_task_id === taskId || r.source_task_id === taskId))
    ?? null;
}

/* One read serves every line on a page: a report can show many findings. */
const shared = new Map<string, { at: number; rows: Promise<QaRequest[]> }>();
const SHARED_MS = 15_000;

function sharedRequests(cid: string): Promise<QaRequest[]> {
  const hit = shared.get(cid);
  if (hit && Date.now() - hit.at < SHARED_MS) return hit.rows;
  const rows = listRequests(cid).catch(() => [] as QaRequest[]);
  shared.set(cid, { at: Date.now(), rows });
  return rows;
}

/** The request behind a session, finding or scenario; null when it did not come from one. */
export function useProvenance(cid: string | null, ids: { requestId?: string | null; sessionId?: string | null; taskId?: string | null }): QaRequest | null {
  const res = useLoad(cid ? () => sharedRequests(cid) : null, [cid]);
  return res.data ? requestFor(res.data, ids) : null;
}

/** The source and the way to the request. */
export function ProvenanceLinks({ r }: { r: QaRequest }) {
  return (
    <span className="qa-prov" data-qa-provenance={r.id}>
      <SourceLinks r={r} none="Quality" />
      <Link className="qa-tasklink" to={requestIdHref(r.id)} title={requestTitle(r)}>Open the request</Link>
    </span>
  );
}

/** The line on a finding, which knows only its session. */
export function FindingSource({ sessionId, requestId }: { sessionId: string; requestId?: string | null }) {
  const { cid } = useSnapshot();
  return <QaProvenance cid={cid} sessionId={sessionId} requestId={requestId} />;
}

/** "Came from <task> · <workflow> · Open the request", on a finding or a scenario. */
export function QaProvenance({ cid, requestId, sessionId, taskId }: { cid: string | null; requestId?: string | null; sessionId?: string | null; taskId?: string | null }) {
  const r = useProvenance(cid, { requestId, sessionId, taskId });
  if (!r) return null;
  return <span className="qa-prov"><span className="qa-muted">Came from</span><ProvenanceLinks r={r} /></span>;
}
