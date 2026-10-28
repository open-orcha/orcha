import { useEffect, useState } from "react";
import { Badge } from "../../components/primitives";
import { Button } from "../../components/primitives/Button";
import { workflowPaths, workflowRequest } from "./workflowApi";
import type { EvidenceBasis, EvidenceReference, SavedEvidenceSet, WorkflowDetail, WorkflowTaskEvidence } from "./workflowContract.generated";

export type EvidenceSupplier = { id: string; alias: string; kind: "human" | "ai" };
export type EvidenceSupplierAssessment = { required: boolean; supplier: EvidenceSupplier | null };

/** Outside and owner submissions must carry one immutable supplier snapshot.
 * Worker evidence also exposes its capturer, but does not need this guard. */
export function evidenceSupplier(set: SavedEvidenceSet): EvidenceSupplierAssessment {
  const supplied = set.items.filter((item) => item.source === "outside" || item.source === "owner");
  if (!supplied.length) return { required: false, supplier: null };
  const first = supplied[0];
  if (!first.captured_by || !first.captured_by_alias || !first.captured_by_kind) return { required: true, supplier: null };
  if (supplied.some((item) => item.captured_by !== first.captured_by || item.captured_by_alias !== first.captured_by_alias || item.captured_by_kind !== first.captured_by_kind)) {
    return { required: true, supplier: null };
  }
  return { required: true, supplier: { id: first.captured_by, alias: first.captured_by_alias, kind: first.captured_by_kind } };
}

export function evidenceReference(set: SavedEvidenceSet): EvidenceReference {
  return { evidence_set_id: set.evidence_set_id, items: set.items.map(({ item_id, deliverable_id, deliverable_version, sha256 }) => ({ item_id, deliverable_id, deliverable_version, sha256 })) };
}
export function evidenceUsable(set: SavedEvidenceSet, revision: number): boolean {
  return set.state === "saved" && set.purpose === "acceptance" && set.work_revision === revision && set.items.length > 0 && set.items.every((item) => item.storage_state === "readable");
}
const kindName = { result_summary: "Result summary", file_changes: "Saved file changes", log_excerpt: "Saved log excerpt", owner_result: "Owner-supplied result", outside_result: "Outside result", import_result: "Imported result review" };
const sourceName = { worker: "Worker", owner: "Owner", outside: "Outside result", import: "Completed before it joined this workflow", cancelled_attempt: "From a cancelled attempt", released_attempt: "From a released attempt" };

export function WorkflowEvidencePanel({ detail, taskId, selected, onSelect }: {
  detail: WorkflowDetail; taskId: string; selected?: string;
  onSelect?: (reference: EvidenceReference | null, revision: number, set: SavedEvidenceSet | null) => void;
}) {
  const task = detail.tasks.find((t) => t.id === taskId);
  const [page, setPage] = useState<WorkflowTaskEvidence | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const available = detail.evidence_capability?.available === true;
  useEffect(() => {
    if (!task || !available) return;
    let active = true; const controller = new AbortController();
    setBusy(true); setError("");
    void workflowRequest("WorkflowTaskEvidence", workflowPaths.detail(detail.id) + `/tasks/${encodeURIComponent(taskId)}/evidence${before ? `?before_revision=${before}` : ""}`, { signal: controller.signal }).then((result) => {
      if (!active) return;
      if (result.task_id !== taskId || result.workflow_id !== detail.id || result.sets.some((set) => set.task_id !== taskId || set.workflow_id !== detail.id)) throw new Error("This evidence does not match the current task.");
      if (before && result.next_before_revision != null && result.next_before_revision >= before) throw new Error("The evidence history cursor did not advance. Refresh before continuing.");
      setPage((previous) => ({ ...result, sets: before && previous ? [...new Map([...previous.sets, ...result.sets].map((set) => [set.evidence_set_id, set])).values()] : result.sets }));
    }).catch((e) => { if (active) { setError(e instanceof Error ? e.message : "Saved evidence could not be read."); setPage(null); } }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; controller.abort(); };
  }, [detail.id, taskId, task?.work_revision, available, before, retry]);
  if (!task) return <p>Task evidence unavailable.</p>;
  if (!available) return <p>Saved evidence is unavailable on this connection. Acceptance and Finish remain unavailable.</p>;
  const current = page?.sets.find((set) => set.evidence_set_id === page.current_evidence_set_id);
  const usable = !!current && evidenceUsable(current, task.work_revision) && task.current_evidence_set_id === current.evidence_set_id;
  return <section aria-label={`Saved evidence for ${task.title}`} className="wf-evidence"><h3>Saved evidence — {task.title}</h3>
    {busy && <p role="status">Loading saved evidence…</p>}{error && <p role="alert">{error}</p>}
    <Button disabled={busy} onClick={() => { setBefore(null); setRetry((n) => n + 1); onSelect?.(null, task.work_revision, null); }}>Refresh evidence</Button>
    {page && !current && <p>No current saved result is available. Earlier attempts do not count as acceptance.</p>}
    {current && !usable && <p className="wf-warning">{current.state === "pending" ? "Saving evidence… Acceptance is unavailable until it is saved." : "Evidence missing or changed — refresh the task or add evidence before accepting."}</p>}
    {onSelect && <label className="wf-choice"><input type="checkbox" checked={usable && selected === current?.evidence_set_id} disabled={busy || !usable || !!error}
      onChange={(e) => onSelect(e.target.checked && current ? evidenceReference(current) : null, task.work_revision, e.target.checked && current ? current : null)} />Use current saved evidence from {task.title}</label>}
    {page?.sets.map((set) => <section className="wf-evi" key={set.evidence_set_id} aria-label={`Evidence revision ${set.result_revision}`}>
      <h4>{set.evidence_set_id === page.current_evidence_set_id ? "Current evidence" : "Earlier evidence"} · result revision {set.result_revision} · work revision {set.work_revision}</h4>
      <p><Badge tone={set.state === "saved" ? "ok" : set.state === "missing" ? "danger" : set.state === "pending" ? "warn" : "neutral"}>{set.state === "pending" ? "Saving evidence…" : set.state === "missing" ? "Evidence missing" : set.state === "superseded" ? "Superseded evidence" : "Saved evidence"}</Badge>{set.purpose === "attempt_record" && " · Attempt record; not a result for acceptance"}</p>
      {set.missing_reason && <p>{set.missing_reason}</p>}
      <ul>{set.items.map((item) => <li key={item.item_id}>
        {item.storage_state === "readable" ? <a href={`/api/tasks/${encodeURIComponent(taskId)}/deliverables/${encodeURIComponent(item.deliverable_id)}/versions/${item.deliverable_version}/raw`}>{kindName[item.kind]} — version {item.deliverable_version}</a>
          : <span>{kindName[item.kind]} — version {item.deliverable_version}: {item.storage_state === "missing_after_restore" ? "file missing after restore" : item.storage_state}</span>}
        <details className="wf-fingerprint"><summary>Fingerprint {item.sha256.slice(0, 12)}</summary><code>{item.sha256}</code></details>
        <p>{sourceName[item.source]} · {item.snapshot_phase === "terminal" ? "Final snapshot" : "Submission snapshot"}</p>
        {item.source === "import" && item.captured_by_alias
          ? <p>Reviewed and accepted on import by {item.captured_by_alias}.</p>
          : item.captured_by_alias && item.captured_by_kind && <p>Submitted by {item.captured_by_alias} (verified).</p>}
        {!item.complete && <p className="wf-warning">Incomplete saved evidence{item.note ? `: ${item.note}` : ". Read its limits before accepting."}</p>}
        {item.complete && item.note && <p>{item.note}</p>}
      </li>)}</ul>
    </section>)}
    {page?.next_before_revision && <Button disabled={busy} onClick={() => setBefore(page.next_before_revision!)}>Load earlier evidence</Button>}
    <p>Worker diagnostics are supplementary and may be removed by routine cleanup. These links address exact saved file versions.</p>
  </section>;
}

export function WorkflowEvidenceBasis({ detail, value, onChange, disabled }: { detail: WorkflowDetail; value: EvidenceBasis; onChange: (basis: EvidenceBasis) => void; disabled?: boolean }) {
  const [taskId, setTaskId] = useState("");
  // Explicit task→set association avoids guessing which task owns a selected file.
  const [selections, setSelections] = useState<Record<string, EvidenceReference>>({});
  return <fieldset disabled={disabled} className="wf-form-body"><legend>Evidence for this decision</legend>
    <label>Why this satisfies the criteria<textarea maxLength={4000} value={value.narrative} onChange={(e) => onChange({ ...value, narrative: e.target.value })} /></label>
    <label>Review evidence from a task<select value={taskId} onChange={(e) => setTaskId(e.target.value)}><option value="">Choose a task</option>{detail.tasks.filter((t) => !t.withdrawn_at).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
    {taskId && <WorkflowEvidencePanel key={`${detail.id}:${taskId}`} detail={detail} taskId={taskId} selected={selections[taskId]?.evidence_set_id} onSelect={(reference, revision) => {
      const next = { ...selections }; const revisions = { ...value.task_revisions };
      if (reference) { next[taskId] = reference; revisions[taskId] = revision; } else { delete next[taskId]; delete revisions[taskId]; }
      setSelections(next); onChange({ ...value, evidence_sets: Object.values(next), task_revisions: revisions });
    }} />}
    <p>{value.evidence_sets?.length ?? 0} current saved evidence sets selected. Missing or stale files cannot be accepted.</p>
  </fieldset>;
}
