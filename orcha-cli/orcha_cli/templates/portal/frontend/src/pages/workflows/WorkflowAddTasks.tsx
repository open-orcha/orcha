import { useState } from "react";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { actionReason, workflowPaths } from "./workflowApi";
import { WorkflowChange } from "./WorkflowChange";
import type { WorkflowDetail } from "./workflowContract.generated";
import { dependencyReason, draftProblems, emptyDraft, newDraftTask, type DraftScope, type DraftTask } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { useWorkflowOperation } from "./workflowOperations";

export function WorkflowAddTasks({ detail, scope, verified, stale, agents, onSaved }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; agents: { id: string; alias: string }[]; onSaved: (detail: WorkflowDetail) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useWorkflowForm<DraftTask[]>(scope, `add:${detail.id}`, []);
  const op = useWorkflowOperation(scope, `workflow:${detail.id}`);
  const frozen = op?.state === "sending" || op?.state === "uncertain";
  const update = (key: string, patch: Partial<DraftTask>) => setTasks(tasks.map((t) => t.key === key ? { ...t, ...patch } : t));
  const problems = draftProblems({ ...emptyDraft(), name: detail.title, goal: detail.goal, tasks, existingTaskIds: detail.tasks.map((t) => t.id) });
  const body = { tasks: tasks.map((t) => ({ client_key: t.key, title: t.title.trim(), description: t.description.trim(), definition_of_done: t.doneWhen.trim(), assignee_id: t.assignee || null, priority: 100, depends_on: t.dependsOn })), reason: "" };
  const saved = (result: WorkflowDetail) => { setTasks([]); setOpen(false); onSaved(result); };
  return <><Button disabled={stale || !!actionReason(detail, "add_tasks", verified)} onClick={() => setOpen(true)}>Add new tasks</Button>
    {open && <Dialog title="Add new tasks" className="wf-page" size="lg" onClose={() => { if (!frozen) setOpen(false); }} footer={<Button disabled={frozen} onClick={() => setOpen(false)}>Keep draft and close</Button>}>
      <p>New tasks start with autonomy OFF. They are saved as drafts, with start holds. Prepare and release them explicitly after saving.</p>
      <fieldset disabled={frozen} className="wf-form-body">
        {tasks.map((task, index) => <fieldset key={task.key} className="wf-task-draft"><legend>New task {index + 1}</legend>
          <label>Task summary<input maxLength={200} value={task.title} onChange={(e) => update(task.key, { title: e.target.value })} /></label>
          <label>Done when<textarea maxLength={4000} value={task.doneWhen} onChange={(e) => update(task.key, { doneWhen: e.target.value })} /></label>
          <label>Instructions<textarea maxLength={4000} value={task.description} onChange={(e) => update(task.key, { description: e.target.value })} /></label>
          <label>Assignee<select value={task.assignee} onChange={(e) => update(task.key, { assignee: e.target.value })}><option value="">Choose later</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.alias}</option>)}</select></label>
          <fieldset><legend>Depends on — {task.dependsOn.length} of 3</legend>{[
            ...detail.tasks.filter((t) => !t.withdrawn_at).map((t) => ({ key: t.id, title: t.title, reason: !task.dependsOn.includes(t.id) && task.dependsOn.length >= 3 ? "Remove one dependency first" : null })),
            ...tasks.filter((t) => t.key !== task.key).map((t) => ({ key: t.key, title: t.title || `New task ${tasks.indexOf(t) + 1}`, reason: dependencyReason(tasks, task, t) })),
          ].map((candidate) => <label className="wf-choice" key={candidate.key}><input type="checkbox" checked={task.dependsOn.includes(candidate.key)} disabled={!!candidate.reason}
            onChange={(e) => update(task.key, { dependsOn: e.target.checked ? [...task.dependsOn, candidate.key] : task.dependsOn.filter((id) => id !== candidate.key) })} />
            <span>{candidate.title}{candidate.reason && <small>{candidate.reason}</small>}</span></label>)}</fieldset>
          <Button disabled={tasks.some((t) => t.dependsOn.includes(task.key))} onClick={() => setTasks(tasks.filter((t) => t.key !== task.key))}>Remove new task {index + 1}</Button>
          {tasks.some((t) => t.dependsOn.includes(task.key)) && <p>Change dependent tasks before removing this task.</p>}
        </fieldset>)}
        <Button disabled={tasks.length >= 200} onClick={() => setTasks([...tasks, newDraftTask()])}>Add task summary</Button>
      </fieldset>
      <WorkflowChange detail={detail} scope={scope} verified={verified} stale={stale} operation="add_tasks" url={workflowPaths.detail(detail.id) + "/tasks"}
        label="Task addition" body={body} invalid={!tasks.length ? "Add at least one task summary." : problems[0]?.message}
        check={(latest) => actionReason(latest, "add_tasks", verified)} onSaved={saved}>
        {() => <><p>{tasks.length} new tasks will join this workflow atomically. Existing progress may decrease as scope grows; goal acceptance will need review.</p><ul>{tasks.map((t) => <li key={t.key}>{t.title} — Draft · Autonomy OFF · {t.dependsOn.length} prerequisites</li>)}</ul></>}
      </WorkflowChange>
    </Dialog>}
  </>;
}
