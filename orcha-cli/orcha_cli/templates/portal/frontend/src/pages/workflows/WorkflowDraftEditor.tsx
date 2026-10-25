import { useState } from "react";
import { Button } from "../../components/primitives/Button";
import { ConfirmDialog } from "../../components/primitives/Dialog";
import { dependencyReason, discardDraft, draftProblems, draftTaskName, emptyDraft, keepDraft, newDraftTask, readDraft,
  type DraftScope, type DraftTask, type WorkflowDraft } from "./workflowDraft";
import "./workflows.css";

/** Local preparation slice. Deliberately has no submit callback until the
 * preview/receipt/permission API is bound. Every task is OFF by default. */
export function WorkflowDraftEditor(props: { scope: DraftScope; saveUnavailableReason: string }) {
  return <ScopedDraftEditor key={JSON.stringify(props.scope)} {...props} />;
}

function ScopedDraftEditor({ scope, saveUnavailableReason }: { scope: DraftScope; saveUnavailableReason: string }) {
  const [draft, setDraft] = useState(() => readDraft(scope));
  const [reviewing, setReviewing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const change = (next: WorkflowDraft) => { keepDraft(scope, next); setDraft(next); };
  const update = (task: DraftTask, patch: Partial<DraftTask>) => change({ ...draft, tasks: draft.tasks.map((t) => t.key === task.key ? { ...t, ...patch } : t) });
  const problems = draftProblems(draft);

  return <div className="wf-draft">
    <p className="wf-notice">Your draft stays in this page session for this project and signed-in person. Reloading or closing the page may discard it. No work starts while you are preparing it.</p>
    <section aria-labelledby="wf-goal-heading">
      <h2 id="wf-goal-heading">Goal</h2>
      <label>Workflow name<input maxLength={200} value={draft.name} onChange={(e) => change({ ...draft, name: e.target.value })} /></label>
      <label>Goal<textarea maxLength={4000} rows={3} value={draft.goal} onChange={(e) => change({ ...draft, goal: e.target.value })} /></label>
      <label>How work runs<select value={draft.mode} onChange={(e) => change({ ...draft, mode: e.target.value as WorkflowDraft["mode"] })}>
        <option value="serial">One task at a time</option><option value="parallel">Independent tasks together</option>
      </select></label>
      <p>Tasks with dependencies take a turn on their own, including review and worker stopping. The server decides when a task can start.</p>
    </section>
    <section aria-labelledby="wf-tasks-heading">
      <h2 id="wf-tasks-heading">Tasks and dependencies</h2>
      {draft.tasks.length === 0 && <p>No tasks yet. Add a summary to begin planning.</p>}
      {draft.tasks.map((task, index) => {
        const dependents = draft.tasks.filter((t) => t.dependsOn.includes(task.key));
        return <fieldset className="wf-task-draft" key={task.key}>
          <legend>Task {index + 1}</legend>
          <label>Task summary<input maxLength={200} value={task.title} onChange={(e) => update(task, { title: e.target.value })} /></label>
          <label>Done when (optional while drafting)<textarea maxLength={4000} rows={2} value={task.doneWhen} onChange={(e) => update(task, { doneWhen: e.target.value })} /></label>
          <details><summary>Details</summary><label>Instructions<textarea maxLength={4000} rows={3} value={task.description} onChange={(e) => update(task, { description: e.target.value })} /></label></details>
          <p>Draft · Unassigned · Task autonomy OFF</p>
          <p className="wf-muted">OFF requires approval of the plan and finished work. Direct requests are always allowed. Assignment and preparation will be checked when saving is available.</p>
          <fieldset className="wf-dependencies"><legend>Depends on — {task.dependsOn.length} of 3 selected</legend>
            {draft.tasks.length === 1 && <p>Add another task to choose a dependency.</p>}
            {draft.tasks.filter((t) => t.key !== task.key).map((candidate) => {
              const reason = dependencyReason(draft.tasks, task, candidate);
              return <label className="wf-choice" key={candidate.key}>
                <input type="checkbox" checked={task.dependsOn.includes(candidate.key)} disabled={reason !== null}
                  onChange={(e) => update(task, { dependsOn: e.target.checked ? [...task.dependsOn, candidate.key] : task.dependsOn.filter((k) => k !== candidate.key) })} />
                <span>{draftTaskName(candidate, draft.tasks)}{reason && <small>{reason}</small>}</span>
              </label>;
            })}
          </fieldset>
          <Button disabled={dependents.length > 0} onClick={() => change({ ...draft, tasks: draft.tasks.filter((t) => t.key !== task.key) })}>Remove task {index + 1}</Button>
          {dependents.length > 0 && <p>Remove or change dependencies in {dependents.map((t) => draftTaskName(t, draft.tasks)).join(", ")} before removing this task.</p>}
        </fieldset>;
      })}
      <Button icon="plus" onClick={() => change({ ...draft, tasks: [...draft.tasks, newDraftTask()] })}>Add task summary</Button>
    </section>
    <section aria-labelledby="wf-review-heading">
      <h2 id="wf-review-heading">Review and save</h2>
      <Button onClick={() => setReviewing(true)}>Review draft</Button>
      {reviewing && <div aria-live="polite">
        {problems.length > 0 ? <ul>{problems.map((p, i) => <li key={`${p.key}-${i}`}>{p.message}</li>)}</ul> : <p>{draft.name}: {draft.tasks.length} task summaries. Saved workflows start in Preparing; starting work is a separate action.</p>}
      </div>}
      <p id="wf-save-reason">{saveUnavailableReason}</p>
      <div className="wf-actions"><Button variant="primary" disabled aria-describedby="wf-save-reason">Save workflow</Button><Button onClick={() => setDiscarding(true)}>Discard draft</Button></div>
    </section>
    {discarding && <ConfirmDialog title="Discard this workflow draft?" description="The name, goal, task summaries and dependencies in this local draft will be removed. No saved workflow will change."
      confirmLabel="Discard draft" cancelLabel="Keep editing" danger onClose={() => setDiscarding(false)} onConfirm={() => { discardDraft(scope); setDraft(emptyDraft()); setReviewing(false); setDiscarding(false); }} />}
  </div>;
}
