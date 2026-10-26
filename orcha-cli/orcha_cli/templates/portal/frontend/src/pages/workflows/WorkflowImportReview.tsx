import type { ImportAcceptance, ImportTaskImpact, Preview } from "./workflowContract.generated";

export type ImportReviews = Record<string, { source: string; narrative: string; accepted: boolean }>;
function source(task: ImportTaskImpact) { return JSON.stringify([task.result_digest, task.result_text, task.definition_of_done, task.description, task.completed_at, task.result_by_agent_id]); }
export function importAcceptances(preview: Preview | null, reviews: ImportReviews): Record<string, ImportAcceptance> {
  return Object.fromEntries((preview?.task_impacts ?? []).filter((task) => task.requires_acceptance && task.result_text != null && /^[a-f0-9]{64}$/.test(task.result_digest ?? "")
    && reviews[task.id]?.accepted && reviews[task.id].source === source(task) && reviews[task.id].narrative.trim()).map((task) => [task.id,
    { reviewed_result_digest: task.result_digest!, evidence: { narrative: reviews[task.id].narrative.trim(), task_revisions: {}, evidence_sets: [] } }]));
}
export function missingImportReview(preview: Preview, reviews: ImportReviews) {
  const accepted = importAcceptances(preview, reviews);
  return (preview.task_impacts ?? []).some((task) => task.requires_acceptance && !accepted[task.id]);
}

export function WorkflowImportReview({ preview, reviews, onChange, disabled }: {
  preview: Preview; reviews: ImportReviews; onChange: (next: ImportReviews) => void; disabled?: boolean;
}) {
  return <>{preview.task_impacts?.filter((task) => task.requires_acceptance).map((task) => {
    const review = reviews[task.id];
    const same = review?.source === source(task);
    const unavailable = !task.eligible || task.result_text == null || !/^[a-f0-9]{64}$/.test(task.result_digest ?? "");
    const update = (patch: Partial<NonNullable<typeof review>>) => onChange({ ...reviews, [task.id]: { source: source(task), narrative: review?.narrative ?? "", accepted: same && review.accepted, ...patch } });
    return <fieldset key={task.id} disabled={disabled || unavailable} aria-label={`Review finished result: ${task.title}`}>
      <legend>Review finished result: {task.title}</legend>
      <p>This accepts the exact saved result while adding the task. It does not finish the workflow.</p>
      <p>Done when: {task.definition_of_done || "No completion criteria recorded"}</p>
      {task.description && <p className="wf-preserve-text">{task.description}</p>}
      {task.result_text != null && <pre className="wf-result">{task.result_text}</pre>}
      {task.completed_at && <p>Completed: <time dateTime={task.completed_at}>{new Date(task.completed_at).toLocaleString()}</time></p>}
      {unavailable && <p role="status">The exact saved result is unavailable. Refresh the preview before accepting this import.</p>}
      <label>Why this result satisfies {task.title}<textarea maxLength={4000} value={review?.narrative ?? ""} onChange={(e) => update({ narrative: e.target.value, accepted: false })} /></label>
      <label className="wf-choice"><input type="checkbox" checked={same && review.accepted} disabled={!review?.narrative.trim()}
        onChange={(e) => update({ accepted: e.target.checked })} />I accept this saved result for {task.title}.</label>
      {review && !same && <p>The result or its criteria changed. Read this preview and accept it again.</p>}
    </fieldset>;
  })}</>;
}
