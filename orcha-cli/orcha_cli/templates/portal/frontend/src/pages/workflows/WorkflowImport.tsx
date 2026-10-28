import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { actionReason, workflowPaths, workflowRequest } from "./workflowApi";
import type { Preview, WorkflowDetail, WorkflowTaskChoice } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";
import { workflowTaskHref } from "./WorkflowReadViews";
import { WorkflowImportReview, importAcceptances, missingImportReview, type ImportReviews } from "./WorkflowImportReview";
import { useDialogOpen, type DialogControl } from "./workflowDialogs";

export type ImportChoice = WorkflowTaskChoice;
const SEARCH_LIMIT = 5;
const SEARCH_DELAY_MS = 200;

export function WorkflowImportChoices({ scope, selected, onChange, members = [], onSelectedChoices }: {
  scope: DraftScope; selected: string[]; onChange: (ids: string[]) => void; members?: string[];
  onSelectedChoices?: (tasks: ImportChoice[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ImportChoice[]>([]);
  const [selectedChoices, setSelectedChoices] = useState<ImportChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const selectedKey = selected.join("\0");
  useEffect(() => {
    if (!search.trim() && selected.length === 0) {
      setResults([]); setSelectedChoices([]); setLoading(false); setError("");
      onSelectedChoices?.([]);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ query: search.trim(), limit: String(SEARCH_LIMIT) });
      selected.forEach((id) => query.append("selected", id));
      void workflowRequest("WorkflowTaskSearch", `${workflowPaths.taskSearch(scope.project)}?${query}`, {
        signal: controller.signal, actorId: scope.identity,
      }).then((response) => {
        if (!active) return;
        setResults(response.results);
        setSelectedChoices(response.selected);
        onSelectedChoices?.(response.selected);
      }).catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Task search is unavailable.");
      }).finally(() => { if (active) setLoading(false); });
    }, SEARCH_DELAY_MS);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [scope.project, scope.identity, search, selectedKey, retry, onSelectedChoices]);

  const known = new Map([...selectedChoices, ...results].map((task) => [task.id, task]));
  const chosen = selected.map((id, index) => known.get(id) ?? {
    id, title: `Selected task ${index + 1}`, status: "unknown", is_root: false, workflow_id: null,
  });
  const reason = (task: ImportChoice) => members.includes(task.id) ? "Already in this workflow"
    : task.workflow_id ? "Already in another workflow"
    : task.is_root ? "Project objectives cannot join a workflow"
    : ["in_progress", "needs_verification"].includes(task.status) ? "Wait for the current work and review to end"
    : task.status === "cancelled" ? "Retry this task before adding it" : null;
  const note = (task: ImportChoice) => task.status === "unknown" ? "Details unavailable; this selection is kept"
    : reason(task) ?? (task.status === "completed" ? "Review its saved result before adding" : "Will stay held until explicitly released");
  const changeChoice = (task: ImportChoice, checked: boolean) => {
    const ids = checked ? [...selected, task.id] : selected.filter((id) => id !== task.id);
    const rows = ids.map((id) => id === task.id ? task : known.get(id)).filter((row): row is ImportChoice => !!row);
    setSelectedChoices(rows); onSelectedChoices?.(rows); onChange(ids);
  };
  const choice = (task: ImportChoice, checked: boolean) => <label className="wf-choice" key={task.id}><input type="checkbox" checked={checked}
    disabled={!checked && !!reason(task)} onChange={(event) => changeChoice(task, event.target.checked)} />
    <span>{task.title}<small>{note(task)}</small></span></label>;
  return <fieldset><legend>Existing tasks</legend>
    <label>Find an existing task<input type="search" maxLength={200} value={search} aria-describedby="wf-task-search-help" onChange={(e) => { setResults([]); setSearch(e.target.value); }} /></label>
    <p id="wf-task-search-help">Search runs on the server and shows up to five matches. Orcha checks membership, workers and the whole connected dependency group before saving.</p>
    {chosen.length > 0 && <div role="group" aria-label="Selected existing tasks"><h4>Selected tasks</h4>{chosen.map((task) => choice(task, true))}</div>}
    {loading && <p role="status">Searching project tasks…</p>}
    {error && <><p role="alert">{error} Your selected tasks are kept.</p><Button onClick={() => setRetry((value) => value + 1)}>Try task search again</Button></>}
    {!loading && !error && results.length === 0 && <p>{search.trim() ? "No tasks match this search." : "Enter a task name to search."}</p>}
    {!error && results.length > 0 && <div role="group" aria-label="Task search results">{results.filter((task) => !selected.includes(task.id)).map((task) => choice(task, false))}</div>}
  </fieldset>;
}

export function WorkflowImportImpact({ preview, selected, onChange, cid, releaseIds = [], onReleaseChange, canRelease = false }: {
  preview: Preview; selected: string[]; onChange: (ids: string[]) => void; cid: string;
  releaseIds?: string[]; onReleaseChange?: (ids: string[]) => void; canRelease?: boolean;
}) {
  const missing = preview.required_task_ids.filter((id) => !selected.includes(id));
  const groupCount = new Set([...preview.selected_task_ids, ...preview.required_task_ids]).size;
  return <section className="wf-impact" aria-label="Import impact"><h3>Review the complete task group</h3>
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

export function WorkflowImport({ detail, scope, verified, stale, initialTaskId, onSaved, control }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; initialTaskId?: string; onSaved: (result: WorkflowDetail) => void; control?: DialogControl;
}) {
  const [open, setOpen] = useDialogOpen(control, !!initialTaskId);
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
      const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
      if (latest.id !== detail.id || latest.container_id !== scope.project || actionReason(latest, "import", verified)) throw new Error("Access or workflow state changed. Refresh before adding tasks.");
      const impact = await workflowRequest("Preview", workflowPaths.detail(detail.id) + "/import-preview", { method: "POST", body: { task_ids: selected, acceptances: {} }, actorId: scope.identity });
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
  return <>{!control && <Button disabled={stale || !!actionReason(detail, "import", verified)} onClick={() => setOpen(true)}>Add existing tasks</Button>}
    {open && <Dialog title="Add existing tasks" size="lg" className="wf-page" onClose={() => { if (!frozen) setOpen(false); }}
      footer={<><Button disabled={frozen} onClick={() => setOpen(false)}>Keep draft and close</Button><Button disabled={blocked} variant="primary" onClick={() => void save()}>Confirm addition</Button></>}>
      <fieldset className="wf-form-body" disabled={frozen}>
        <WorkflowImportChoices scope={scope} selected={selected} onChange={setSelected} members={detail.tasks.map((t) => t.id)} />
        <Button disabled={!selected.length || frozen || stale} onClick={() => void review()}>Review selected tasks</Button>
        {current && <WorkflowImportImpact preview={current.impact} selected={selected} onChange={setSelected} cid={scope.project}
          releaseIds={releaseIds} onReleaseChange={setReleaseIds} canRelease={canRelease} />}
        {current && invalidReleaseIds.length > 0 && <p role="alert">Some saved start choices are no longer available. Your choices are kept; remove them before confirming. <Button onClick={() => setReleaseIds((ids) => ids.filter((id) => !invalidReleaseIds.includes(id)))}>Remove unavailable start choices</Button></p>}
        {current && <WorkflowImportReview preview={current.impact} reviews={reviews} onChange={setReviews} />}
      </fieldset>
      {busy && <p role="status">Checking tasks and their dependencies…</p>}{error && <p role="alert">{error}</p>}
      <WorkflowOperationNotice scope={scope} slot={slot} onSaved={(result) => { setSelected([]); setReleaseIds([]); setOpen(false); onSaved(result); }} canRetry={async () => {
        const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
        return latest.container_id === scope.project && latest.id === detail.id && !actionReason(latest, "import", verified);
      }} />
    </Dialog>}
  </>;
}
