import { Button, Chip, MenuButton } from "../../components/primitives";
import { dependencyReason, draftTaskName, type DraftTask } from "./workflowDraft";
import { WorkflowOutcomeFields } from "./WorkflowFlowDraftFields";

/** One draft and one dependency validator serve cards and graph authoring. */
export function WorkflowTaskDraftFields({ task, tasks, existing = [], agents, onChange, onRemove, removeLabel, flexible = false }: {
  task: DraftTask; tasks: DraftTask[]; existing?: { id: string; title: string }[]; flexible?: boolean;
  agents: { id: string; alias: string }[]; onChange: (patch: Partial<DraftTask>) => void;
  onRemove: () => void; removeLabel: string;
}) {
  const dependents = tasks.filter((t) => t.dependsOn.includes(task.key));
  const candidates = [
    ...tasks.filter((t) => t.key !== task.key).map((t) => ({ id: t.key, title: draftTaskName(t, tasks), reason: dependencyReason(tasks, task, t) })),
    ...existing.map((t) => ({ ...t, reason: !task.dependsOn.includes(t.id) && task.dependsOn.length >= 3 ? "Remove one prerequisite first (maximum three)." : null })),
  ];
  return <fieldset className="wf-task-draft wf-card" aria-label={`Task ${tasks.indexOf(task) + 1}`}>
    <legend>{draftTaskName(task, tasks)}</legend>
    <Chip>Draft · Autonomy OFF · Not saved</Chip>
    <label>Task summary<input maxLength={200} value={task.title} onChange={(e) => onChange({ title: e.target.value })} /></label>
    <label>Done when (optional while drafting)<textarea maxLength={4000} rows={2} value={task.doneWhen} onChange={(e) => onChange({ doneWhen: e.target.value })} /></label>
    <div className="wf-field"><span>Assignee</span><MenuButton menuLabel="Choose assignee" label={`Assignee: ${agents.find((a) => a.id === task.assignee)?.alias ?? "Choose later"}`}
      items={[{ label: "Choose later", onSelect: () => onChange({ assignee: "" }) }, ...agents.map((a) => ({ label: a.alias, icon: "agent", onSelect: () => onChange({ assignee: a.id }) }))]} /></div>
    <p className="wf-muted">OFF requires approval of the plan and finished work. Preparing and starting are separate actions after saving.</p>
    <div className="wf-field" role="group" aria-label="Task prerequisites">
      <span>Depends on — {task.dependsOn.length} of 3 selected</span>
      <div className="wf-chipline">{task.dependsOn.map((id) => <Chip key={id}>
        {candidates.find((c) => c.id === id)?.title ?? "Prerequisite unavailable"}
        <button type="button" className="wf-chip-remove" aria-label={`Remove prerequisite ${candidates.find((c) => c.id === id)?.title ?? "unavailable task"}`} onClick={() => onChange({ dependsOn: task.dependsOn.filter((key) => key !== id) })}>×</button>
      </Chip>)}</div>
      <MenuButton menuLabel="Choose prerequisite" label="Add prerequisite" items={candidates.filter((c) => !task.dependsOn.includes(c.id)).map((c) => ({ label: c.title, disabled: !!c.reason, disabledReason: c.reason ?? undefined, onSelect: () => onChange({ dependsOn: [...task.dependsOn, c.id] }) }))} />
      {!candidates.length && <p className="wf-muted">Add another task to choose a prerequisite.</p>}
    </div>
    {flexible && <WorkflowOutcomeFields task={task} tasks={tasks} onChange={(outcomes) => onChange({ outcomes })} />}
    <details><summary>Instructions</summary><label>Instructions<textarea maxLength={4000} rows={3} value={task.description} onChange={(e) => onChange({ description: e.target.value })} /></label></details>
    <Button variant="ghost" disabled={dependents.length > 0} title={dependents.length ? "Change dependents first" : undefined} onClick={onRemove}>{removeLabel}</Button>
    {dependents.length > 0 && <p>Remove or change dependencies in {dependents.map((t) => draftTaskName(t, tasks)).join(", ")} before removing this task.</p>}
  </fieldset>;
}
