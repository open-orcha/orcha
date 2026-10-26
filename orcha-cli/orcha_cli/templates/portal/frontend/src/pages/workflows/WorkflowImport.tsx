import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import type { Task } from "../../types";
import { actionReason, workflowPaths, workflowRequest } from "./workflowApi";
import type { Preview, WorkflowDetail } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";
import { workflowTaskHref } from "./WorkflowReadViews";
import { WorkflowImportReview, importAcceptances, missingImportReview, type ImportReviews } from "./WorkflowImportReview";

export type ImportChoice = Pick<Task, "id" | "title" | "status" | "is_root">;
export function WorkflowImportChoices({ tasks, selected, onChange, members = [] }: {
  tasks: ImportChoice[]; selected: string[]; onChange: (ids: string[]) => void; members?: string[];
}) {
  const [search, setSearch] = useState("");
  const rows = tasks.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()));
  return <fieldset><legend>Existing tasks</legend>
    <label>Find an existing task<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
    <p>Search covers loaded project tasks. Orcha checks membership, workers and the whole connected dependency group before saving.</p>
    {rows.length === 0 && <p>No loaded tasks match.</p>}
    {rows.map((t) => {
      const reason = members.includes(t.id) ? "Already in this workflow" : t.is_root ? "Project objectives cannot join a workflow"
        : ["in_progress", "needs_verification"].includes(t.status) ? "Wait for the current work and review to end"
        : t.status === "cancelled" ? "Retry this task before adding it" : null;
      return <label className="wf-choice" key={t.id}><input type="checkbox" checked={selected.includes(t.id)} disabled={!!reason && !selected.includes(t.id)}
        onChange={(e) => onChange(e.target.checked ? [...selected, t.id] : selected.filter((id) => id !== t.id))} />
        <span>{t.title}<small>{reason ?? (t.status === "completed" ? "Review its saved result before adding" : "Will stay held until explicitly released")}</small></span></label>;
    })}
  </fieldset>;
}

export function WorkflowImportImpact({ preview, selected, onChange, cid, releaseIds = [], onReleaseChange, canRelease = false }: {
  preview: Preview; selected: string[]; onChange: (ids: string[]) => void; cid: string;
  releaseIds?: string[]; onReleaseChange?: (ids: string[]) => void; canRelease?: boolean;
}) {
  const missing = preview.required_task_ids.filter((id) => !selected.includes(id));
  const groupCount = new Set([...preview.selected_task_ids, ...preview.required_task_ids]).size;
  return <section aria-label="Import impact"><h3>Review the complete task group</h3>
    <p>{groupCount} {groupCount === 1 ? "task" : "tasks"} in the connected group. Threads, results and assignments stay with their tasks. {releaseIds.length ? "Selected tasks may start when ready after saving. Human holds, prerequisites and turn rules still apply." : "No work starts from this save; holds remain in place."}</p>
    <ul>{preview.task_impacts?.map((t) => <li key={t.id}><Link to={workflowTaskHref(cid, t.id)}>{t.title}</Link>
      <p>{t.eligible ? t.preparation_state === "draft" ? "Draft" : "Prepared" : "Cannot be added"}{t.start_hold && " · Awaiting release"}</p>
      {t.human_hold_reason && <p>Hold retained: {t.human_hold_reason}</p>}
      {t.requires_acceptance && <p>This finished task needs explicit review of its exact saved result before import.</p>}
      {onReleaseChange && (canRelease || releaseIds.length > 0) && <label className="wf-choice"><input type="checkbox"
        checked={releaseIds.includes(t.id)} disabled={(!canRelease || !t.releasable || !t.eligible || !selected.includes(t.id)) && !releaseIds.includes(t.id)}
        onChange={(e) => onReleaseChange(e.target.checked ? [...releaseIds, t.id] : releaseIds.filter((id) => id !== t.id))} />
        <span>Start this task when it is ready: {t.title}
        {(!canRelease || !t.releasable || !t.eligible) && <small>Starting this task from import is unavailable in this preview.</small>}</span>
      </label>}
    </li>)}</ul>
    <ul>{preview.blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul>
    {missing.length > 0 && <><p>Adding your selection also requires {missing.length} related tasks. Nothing has been added.</p>
      <Button onClick={() => onChange([...new Set([...selected, ...preview.required_task_ids])])}>Include the whole group and review again</Button></>}
  </section>;
}

export function WorkflowImport({ detail, scope, verified, stale, tasks, initialTaskId, onSaved }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; tasks: ImportChoice[]; initialTaskId?: string; onSaved: (result: WorkflowDetail) => void;
}) {
  const [open, setOpen] = useState(!!initialTaskId);
  const [selected, setSelected] = useWorkflowForm<string[]>(scope, `import:${detail.id}`, initialTaskId ? [initialTaskId] : []);
  const [releaseIds, setReleaseIds] = useWorkflowForm<string[]>(scope, `import-release:${detail.id}`, []);
  const [reviews, setReviews] = useState<ImportReviews>({});
  const [preview, setPreview] = useState<{ workflow: WorkflowDetail; impact: Preview; basis: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slot = `workflow:${detail.id}`;
  const op = useWorkflowOperation(scope, slot);
  const frozen = busy || op?.state === "sending" || op?.state === "uncertain";
  const seeded = useRef<string>();
  useEffect(() => {
    if (initialTaskId && seeded.current !== initialTaskId && !frozen) {
      seeded.current = initialTaskId; setSelected((ids) => [...new Set([...ids, initialTaskId])]); setOpen(true);
    }
  }, [initialTaskId, frozen]);
  const current = preview?.basis === JSON.stringify(selected) ? preview : null;
  const canRelease = current?.workflow.status === "active" && current.workflow.launch_enabled;
  const invalidReleaseIds = releaseIds.filter((id) => !canRelease || !selected.includes(id)
    || !current?.impact.task_impacts?.some((task) => task.id === id && task.eligible && task.releasable));
  async function review() {
    if (frozen || stale || actionReason(detail, "import", verified) || !selected.length) return;
    setBusy(true); setError(""); setPreview(null);
    try {
      const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id));
      if (latest.id !== detail.id || latest.container_id !== scope.project || actionReason(latest, "import", verified)) throw new Error("Access or workflow state changed. Refresh before adding tasks.");
      const impact = await workflowRequest("Preview", workflowPaths.detail(detail.id) + "/import-preview", { method: "POST", body: { task_ids: selected, acceptances: {} } });
      setPreview({ workflow: latest, impact, basis: JSON.stringify(selected) });
    } catch (e) { setError(e instanceof Error ? e.message : "The import could not be checked. Your choices are kept."); }
    finally { setBusy(false); }
  }
  const blocked = frozen || stale || !current || !!actionReason(current?.workflow ?? detail, "import", verified)
    || !!current?.impact.blockers.length || !!current?.impact.required_task_ids.some((id) => !selected.includes(id))
    || !!current?.impact.task_impacts?.some((t) => !t.eligible) || !!current && missingImportReview(current.impact, reviews) || invalidReleaseIds.length > 0;
  async function save() {
    if (blocked || !current) return;
    const result = await sendWorkflowOperation(scope, slot, { operation: "import", expectedWorkflowId: detail.id, url: workflowPaths.detail(detail.id) + "/import",
      body: { task_ids: selected, release_task_ids: releaseIds, acceptances: importAcceptances(current.impact, reviews), expected_revision: current.workflow.revision, preview_digest: current.impact.preview_digest, reason: "" } });
    if (result.state === "saved" && result.result) { setSelected([]); setReleaseIds([]); setOpen(false); onSaved(result.result); }
    else if (result.state === "refused") setPreview(null);
  }
  return <><Button disabled={stale || !!actionReason(detail, "import", verified)} onClick={() => setOpen(true)}>Add existing tasks</Button>
    {open && <Dialog title="Add existing tasks" size="lg" className="wf-page" onClose={() => { if (!frozen) setOpen(false); }}
      footer={<><Button disabled={frozen} onClick={() => setOpen(false)}>Keep draft and close</Button><Button disabled={blocked} variant="primary" onClick={() => void save()}>Confirm addition</Button></>}>
      <fieldset className="wf-form-body" disabled={frozen}>
        <WorkflowImportChoices tasks={tasks} selected={selected} onChange={setSelected} members={detail.tasks.map((t) => t.id)} />
        <Button disabled={!selected.length || frozen || stale} onClick={() => void review()}>Review selected tasks</Button>
        {current && <WorkflowImportImpact preview={current.impact} selected={selected} onChange={setSelected} cid={scope.project}
          releaseIds={releaseIds} onReleaseChange={setReleaseIds} canRelease={canRelease} />}
        {current && invalidReleaseIds.length > 0 && <p role="alert">Some saved start choices are no longer available. Your choices are kept; remove them before confirming. <Button onClick={() => setReleaseIds((ids) => ids.filter((id) => !invalidReleaseIds.includes(id)))}>Remove unavailable start choices</Button></p>}
        {current && <WorkflowImportReview preview={current.impact} reviews={reviews} onChange={setReviews} />}
      </fieldset>
      {busy && <p role="status">Checking tasks and their dependencies…</p>}{error && <p role="alert">{error}</p>}
      <WorkflowOperationNotice scope={scope} slot={slot} onSaved={(result) => { setSelected([]); setReleaseIds([]); setOpen(false); onSaved(result); }} canRetry={async () => {
        const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id));
        return latest.container_id === scope.project && latest.id === detail.id && !actionReason(latest, "import", verified);
      }} />
    </Dialog>}
  </>;
}
