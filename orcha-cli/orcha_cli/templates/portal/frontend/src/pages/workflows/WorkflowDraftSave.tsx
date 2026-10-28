import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/primitives/Button";
import { workflowPaths, workflowRequest } from "./workflowApi";
import type { Preview, WorkflowDetail, WorkflowDraft as WireDraft } from "./workflowContract.generated";
import { draftProblems, type DraftScope, type WorkflowDraft } from "./workflowDraft";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";
import { WorkflowImportImpact } from "./WorkflowImport";
import { WorkflowImportReview, importAcceptances, missingImportReview, type ImportReviews } from "./WorkflowImportReview";

export function toWireDraft(draft: WorkflowDraft): WireDraft {
  return { title: draft.name.trim(), goal: draft.goal.trim(), execution_mode: draft.mode,
    objectives: draft.objectives.map((o) => ({ title: o.title.trim(), criteria: o.criteria.trim() })),
    tasks: draft.tasks.map((t) => ({ client_key: t.key, title: t.title.trim(), definition_of_done: t.doneWhen.trim(),
      description: t.description.trim(), assignee_id: t.assignee || null, depends_on: t.dependsOn, priority: 100,
      ...(t.outcomes?.length ? {
        outcomes: t.outcomes.map((o) => ({ name: o.name.trim(), kind: o.kind })),
        routes: t.outcomes.map((o) => ({ outcome: o.name.trim(), destination: o.destination, destination_task: o.destinationTask ?? null })),
      } : {}) })),
    existing_task_ids: draft.existingTaskIds ?? [], import_acceptances: {},
    ...(draft.repeatGroups?.length ? { repeat_groups: draft.repeatGroups.map((g) => ({ name: g.name.trim(), member_tasks: g.members, review_task: g.review,
      exit_outcome: g.exitOutcome, max_rounds: g.maxRounds })) } : {}) };
}

export function WorkflowDraftSave({ draft, scope, unavailableReason, onSaved, onImportChange }: {
  draft: WorkflowDraft; scope: DraftScope; unavailableReason: string | null; onSaved?: (detail: WorkflowDetail) => void; onImportChange?: (ids: string[]) => void;
}) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [preview, setPreview] = useState<{ basis: string; draftBasis: string; value: Preview } | null>(null);
  const [reviews, setReviews] = useState<ImportReviews>({});
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useWorkflowOperation(scope, "create");
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  const draftBasis = JSON.stringify(toWireDraft(draft));
  const visiblePreview = preview?.draftBasis === draftBasis ? preview.value : null;
  const body = { ...toWireDraft(draft), import_acceptances: importAcceptances(visiblePreview, reviews) };
  const basis = JSON.stringify(body);
  const alreadySaved = operation?.state === "saved" && JSON.stringify({ ...operation.body, preview_digest: undefined }) === basis;
  const current = preview?.basis === basis ? preview.value : null;
  const importBlocked = !!current?.required_task_ids.some((id) => !draft.existingTaskIds?.includes(id)) || !!current?.task_impacts?.some((t) => !t.eligible) || !!current && missingImportReview(current, reviews);
  const problems = draftProblems(draft);
  const access = async () => {
    if (unavailableReason) return false;
    const capability = await workflowRequest("Capability", workflowPaths.collection(scope.project) + "/capability", { actorId: scope.identity });
    return capability.workflow_human_write === true;
  };
  async function review() {
    setReviewing(true); setError(""); setPreview(null);
    if (unavailableReason || problems.length || unresolved) return;
    setBusy(true);
    try { setPreview({ basis, draftBasis, value: await workflowRequest("Preview", workflowPaths.collection(scope.project) + "/preview", { method: "POST", body, actorId: scope.identity }) }); }
    catch (e) { setError(e instanceof Error ? e.message : "The preview could not be checked. Your draft is kept."); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!current || current.blockers.length || importBlocked || problems.length || unavailableReason || unresolved || busy || alreadySaved) return;
    setBusy(true); setError("");
    try {
      if (!await access()) { setError("Workflow changes are no longer available. Your draft is kept."); setPreview(null); return; }
      if (!active.current) return;
      const result = await sendWorkflowOperation(scope, "create", { operation: "create", url: workflowPaths.collection(scope.project), body: { ...body, preview_digest: current.preview_digest } });
      if (active.current && result.state === "saved" && result.result) onSaved?.(result.result);
      if (result.state === "refused") setPreview(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not check permission to save."); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="wf-review-heading">
    <h2 id="wf-review-heading">Review and save</h2>
    <Button disabled={busy || unresolved} onClick={() => void review()}>Review draft</Button>
    {reviewing && <div aria-live="polite">{problems.length ? <ul>{problems.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
      : <p>{draft.name}: {draft.tasks.length} task summaries and {draft.objectives.length} objectives. Saved in Preparing. No work starts yet.</p>}</div>}
    {current && <><p>Orcha checked this draft. New tasks stay Draft until you explicitly prepare them. All new tasks have autonomy OFF.</p>
      <ul>{current.blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul></>}
    {visiblePreview && (draft.existingTaskIds?.length ?? 0) > 0 && <><WorkflowImportImpact preview={visiblePreview} selected={draft.existingTaskIds ?? []} onChange={(ids) => onImportChange?.(ids)} cid={scope.project} />
      <WorkflowImportReview preview={visiblePreview} reviews={reviews} onChange={setReviews} disabled={busy || unresolved} /></>}
    {error && <p role="alert">{error}</p>}
    <p id="wf-save-reason">{unavailableReason || (!current ? "Review this draft with Orcha before saving." : "Starting work is a separate action after saving.")}</p>
    <Button variant="primary" disabled={!!unavailableReason || !current || !!current.blockers.length || importBlocked || problems.length > 0 || busy || unresolved || alreadySaved}
      aria-describedby="wf-save-reason" onClick={() => void save()}>Save workflow</Button>
    <WorkflowOperationNotice scope={scope} slot="create" canRetry={access} onSaved={(result) => onSaved?.(result)} />
    {alreadySaved && operation?.result && <p role="status">Workflow saved. <a href={`/workflows/${encodeURIComponent(operation.result.id)}?${new URLSearchParams({ cid: scope.project })}`}>Open saved workflow</a> to prepare tasks and review Start.</p>}
  </section>;
}
