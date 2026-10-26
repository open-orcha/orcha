import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/primitives/Button";
import { ConfirmDialog } from "../../components/primitives/Dialog";
import { dependencyReason, discardDraft, draftTaskName, emptyDraft, keepDraft, newDraftTask, readDraft,
  type DraftScope, type DraftTask, type WorkflowDraft } from "./workflowDraft";
import { WorkflowDraftSave } from "./WorkflowDraftSave";
import { useWorkflowOperation } from "./workflowOperations";
import type { WorkflowDetail } from "./workflowContract.generated";
import { WorkflowImportChoices, type ImportChoice } from "./WorkflowImport";
import "./workflows.css";

interface Props { scope: DraftScope; saveUnavailableReason: string | null; agents?: { id: string; alias: string }[]; existingTasks?: ImportChoice[]; initialTaskId?: string; ownerName?: string; onSaved?: (detail: WorkflowDetail) => void }
export function WorkflowDraftEditor(props: Props) {
  return <ScopedDraftEditor key={JSON.stringify(props.scope)} {...props} />;
}

function ScopedDraftEditor({ scope, saveUnavailableReason, agents = [], existingTasks = [], initialTaskId, ownerName, onSaved }: Props) {
  const [draft, setDraft] = useState(() => readDraft(scope));
  const [discarding, setDiscarding] = useState(false);
  const change = (next: WorkflowDraft) => { keepDraft(scope, next); setDraft(next); };
  const update = (task: DraftTask, patch: Partial<DraftTask>) => change({ ...draft, tasks: draft.tasks.map((t) => t.key === task.key ? { ...t, ...patch } : t) });
  const operation = useWorkflowOperation(scope, "create");
  const frozen = operation?.state === "sending" || operation?.state === "uncertain";
  const seeded = useRef<string>();
  useEffect(() => {
    if (initialTaskId && seeded.current !== initialTaskId && !frozen) {
      seeded.current = initialTaskId;
      change({ ...draft, existingTaskIds: [...new Set([...(draft.existingTaskIds ?? []), initialTaskId])] });
    }
  }, [initialTaskId, frozen]);

  return <div className="wf-draft">
    <p className="wf-notice">Your draft stays in this page session for this project and signed-in person. Reloading or closing the page may discard it. No work starts while you are preparing it.</p>
    {frozen && <p>Checking the original save. Editing is paused so it cannot become a different request.</p>}
    <fieldset className="wf-form-body" disabled={frozen}>
    <section aria-labelledby="wf-goal-heading">
      <h2 id="wf-goal-heading">Goal</h2>
      {ownerName && <p>Owner: {ownerName}</p>}
      <label>Workflow name<input maxLength={200} value={draft.name} onChange={(e) => change({ ...draft, name: e.target.value })} /></label>
      <label>Goal<textarea maxLength={4000} rows={3} value={draft.goal} onChange={(e) => change({ ...draft, goal: e.target.value })} /></label>
      <label>How work runs<select value={draft.mode} onChange={(e) => change({ ...draft, mode: e.target.value as WorkflowDraft["mode"] })}>
        <option value="serial">One task at a time</option><option value="parallel">Independent tasks together</option>
      </select></label>
      <p>Tasks with dependencies take a turn on their own, including review and worker stopping. The server decides when a task can start.</p>
      <h3>Objectives (optional)</h3>
      {draft.objectives.map((objective, index) => <fieldset key={objective.key}><legend>Objective {index + 1}</legend>
        <label>Objective title<input maxLength={200} value={objective.title} onChange={(e) => change({ ...draft, objectives: draft.objectives.map((o) => o.key === objective.key ? { ...o, title: e.target.value } : o) })} /></label>
        <label>Objective done when<textarea maxLength={4000} value={objective.criteria} onChange={(e) => change({ ...draft, objectives: draft.objectives.map((o) => o.key === objective.key ? { ...o, criteria: e.target.value } : o) })} /></label>
        <Button onClick={() => change({ ...draft, objectives: draft.objectives.filter((o) => o.key !== objective.key) })}>Remove objective {index + 1}</Button>
      </fieldset>)}
      <Button disabled={draft.objectives.length >= 50} onClick={() => change({ ...draft, objectives: [...draft.objectives, { key: crypto.randomUUID(), title: "", criteria: "" }] })}>Add objective</Button>
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
          <label>Assignee<select value={task.assignee} onChange={(e) => update(task, { assignee: e.target.value })}><option value="">Choose later</option>{agents.map((a) => <option value={a.id} key={a.id}>{a.alias}</option>)}</select></label>
          <p>Draft · {agents.find((a) => a.id === task.assignee)?.alias || "Unassigned"} · Task autonomy OFF</p>
          <p className="wf-muted">OFF requires approval of the plan and finished work. Direct requests are always allowed. Preparing and starting are separate actions after saving.</p>
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
            {(draft.existingTaskIds ?? []).map((id) => <label className="wf-choice" key={id}>
              <input type="checkbox" checked={task.dependsOn.includes(id)} disabled={!task.dependsOn.includes(id) && task.dependsOn.length >= 3}
                onChange={(e) => update(task, { dependsOn: e.target.checked ? [...task.dependsOn, id] : task.dependsOn.filter((key) => key !== id) })} />
              {existingTasks.find((t) => t.id === id)?.title ?? "Selected existing task"}
            </label>)}
          </fieldset>
          <Button disabled={dependents.length > 0} onClick={() => change({ ...draft, tasks: draft.tasks.filter((t) => t.key !== task.key) })}>Remove task {index + 1}</Button>
          {dependents.length > 0 && <p>Remove or change dependencies in {dependents.map((t) => draftTaskName(t, draft.tasks)).join(", ")} before removing this task.</p>}
        </fieldset>;
      })}
      <Button icon="plus" disabled={draft.tasks.length >= 200} onClick={() => change({ ...draft, tasks: [...draft.tasks, newDraftTask()] })}>Add task summary</Button>
    </section>
    <WorkflowImportChoices tasks={existingTasks} selected={draft.existingTaskIds ?? []} onChange={(ids) => change({ ...draft, existingTaskIds: ids })} />
    </fieldset>
    <WorkflowDraftSave draft={draft} scope={scope} unavailableReason={saveUnavailableReason} onImportChange={(ids) => change({ ...draft, existingTaskIds: ids })} onSaved={(result) => { discardDraft(scope); onSaved?.(result); }} />
    <Button disabled={frozen} onClick={() => setDiscarding(true)}>Discard draft</Button>
    {discarding && <ConfirmDialog title="Discard this workflow draft?" description="The name, goal, task summaries and dependencies in this local draft will be removed. No saved workflow will change."
      confirmLabel="Discard draft" cancelLabel="Keep editing" danger onClose={() => setDiscarding(false)} onConfirm={() => { discardDraft(scope); setDraft(emptyDraft()); setDiscarding(false); }} />}
  </div>;
}
