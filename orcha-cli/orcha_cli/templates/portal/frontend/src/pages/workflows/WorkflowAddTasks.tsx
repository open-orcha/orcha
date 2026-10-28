import { useEffect, useRef } from "react";
import { WorkflowTaskDraftFields } from "./WorkflowTaskDraftFields";
import { WorkflowGraph } from "./WorkflowGraph";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { actionReason, workflowPaths } from "./workflowApi";
import { WorkflowChange } from "./WorkflowChange";
import type { WorkflowDetail } from "./workflowContract.generated";
import { draftProblems, emptyDraft, newDraftTask, type DraftScope, type DraftTask } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { useWorkflowOperation } from "./workflowOperations";
import { useDialogOpen, type DialogControl } from "./workflowDialogs";

export function WorkflowAddTasks({ detail, scope, verified, stale, agents, onSaved, control, seed }: {
  detail: WorkflowDetail; scope: DraftScope; verified: boolean; stale: boolean; agents: { id: string; alias: string }[]; onSaved: (detail: WorkflowDetail) => void; control?: DialogControl; seed?: { after: string | null; seq: number } | null;
}) {
  const [open, setOpen] = useDialogOpen(control);
  const [tasks, setTasks] = useWorkflowForm<DraftTask[]>(scope, `add:${detail.id}`, []);
  const op = useWorkflowOperation(scope, `workflow:${detail.id}`);
  const frozen = op?.state === "sending" || op?.state === "uncertain";
  const update = (key: string, patch: Partial<DraftTask>) => setTasks(tasks.map((t) => t.key === key ? { ...t, ...patch } : t));
  const seeded = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !seed || seed.seq === seeded.current || frozen) return;
    seeded.current = seed.seq;
    const task = newDraftTask();
    setTasks((current) => [...current, { ...task, dependsOn: seed.after ? [seed.after] : [] }]);
  }, [open, seed?.seq, frozen]);
  const problems = draftProblems({ ...emptyDraft(), name: detail.title, goal: detail.goal, tasks, existingTaskIds: detail.tasks.filter((t) => !t.withdrawn_at).map((t) => t.id) });
  const body = { tasks: tasks.map((t) => ({ client_key: t.key, title: t.title.trim(), description: t.description.trim(), definition_of_done: t.doneWhen.trim(), assignee_id: t.assignee || null, priority: 100, depends_on: t.dependsOn })), reason: "" };
  const saved = (result: WorkflowDetail) => { setTasks([]); setOpen(false); onSaved(result); };
  return <>{!control && <Button disabled={stale || !!actionReason(detail, "add_tasks", verified)} onClick={() => setOpen(true)}>Add new tasks</Button>}
    {open && <Dialog title="Add new tasks" className="wf-page" size="lg" onClose={() => { if (!frozen) setOpen(false); }} footer={<Button disabled={frozen} onClick={() => setOpen(false)}>Keep draft and close</Button>}>
      <p>New tasks start with autonomy OFF. They are saved as drafts, with start holds. {detail.launch_enabled
        ? "This Workflow has already started, so preparing a new task after saving also releases its start hold and it can begin once it is eligible."
        : "Prepare and release them explicitly after saving."}</p>
      <fieldset disabled={frozen || stale} className="wf-form-body">
        {seed && <WorkflowGraph tasks={[
          ...detail.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, label: t.display_state.label, assignee: agents.find((a) => t.assignee_ids.includes(a.id))?.alias ?? "Unassigned", dependsOn: t.depends_on })),
          ...tasks.map((t) => ({ id: t.key, title: t.title || "New task", status: "pending", label: "Draft", assignee: agents.find((a) => a.id === t.assignee)?.alias ?? "Unassigned", dependsOn: t.dependsOn, draft: true })),
        ]} selected={tasks.at(-1)?.key ?? null} onSelect={() => {}} />}
        {tasks.map((task, index) => <WorkflowTaskDraftFields key={task.key} task={task} tasks={tasks} agents={agents} existing={detail.tasks.filter((t) => !t.withdrawn_at).map((t) => ({ id: t.id, title: t.title }))}
          onChange={(patch) => update(task.key, patch)} onRemove={() => setTasks(tasks.filter((t) => t.key !== task.key))} removeLabel={`Remove new task ${index + 1}`} />)}
        <Button disabled={tasks.length >= 200} onClick={() => setTasks([...tasks, newDraftTask()])}>Add task summary</Button>
      </fieldset>
      <WorkflowChange detail={detail} scope={scope} verified={verified} stale={stale} operation="add_tasks" url={workflowPaths.detail(detail.id) + "/tasks"}
        label="Task addition" body={body} invalid={!tasks.length ? "Add at least one task summary." : problems[0]?.message}
        check={(latest) => actionReason(latest, "add_tasks", verified) || draftProblems({ ...emptyDraft(), name: latest.title, goal: latest.goal, tasks, existingTaskIds: latest.tasks.filter((t) => !t.withdrawn_at).map((t) => t.id) })[0]?.message || null} onSaved={saved}>
        {() => <><p>{tasks.length} new tasks will join this workflow atomically. Existing progress may decrease as scope grows; goal acceptance will need review.</p><ul>{tasks.map((t) => <li key={t.key}>{t.title} — Draft · Autonomy OFF · Start hold · {agents.find((a) => a.id === t.assignee)?.alias ?? "Choose assignee later"}. {t.dependsOn.length ? `Starts after ${t.dependsOn.map((id) => tasks.find((p) => p.key === id)?.title || detail.tasks.find((p) => p.id === id)?.title || "unavailable prerequisite").join(", ")} is accepted.` : "No prerequisites."}</li>)}</ul></>}
      </WorkflowChange>
    </Dialog>}
  </>;
}
