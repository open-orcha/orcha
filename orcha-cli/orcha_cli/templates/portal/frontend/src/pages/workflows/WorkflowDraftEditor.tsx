import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/primitives/Button";
import { Segmented } from "../../components/primitives";
import { WorkflowGraph } from "./WorkflowGraph";
import { WorkflowTaskDraftFields } from "./WorkflowTaskDraftFields";
import { WorkflowLoopFields } from "./WorkflowFlowDraftFields";
import { Dialog, ConfirmDialog } from "../../components/primitives/Dialog";
import { discardDraft, draftTaskName, emptyDraft, keepDraft, newDraftTask, readDraft,
  type DraftScope, type DraftTask, type WorkflowDraft } from "./workflowDraft";
import { WorkflowDraftSave } from "./WorkflowDraftSave";
import { useWorkflowOperation } from "./workflowOperations";
import type { WorkflowDetail } from "./workflowContract.generated";
import { WorkflowImportChoices, type ImportChoice } from "./WorkflowImport";
import "./workflows.css";

interface Props { scope: DraftScope; saveUnavailableReason: string | null; agents?: { id: string; alias: string }[]; initialTaskId?: string; ownerName?: string; onSaved?: (detail: WorkflowDetail) => void;
  /** The server's `flexible_workflows` capability: outcomes, next-step rules and feedback loops. */
  flexible?: boolean }
export function WorkflowDraftEditor(props: Props) {
  return <ScopedDraftEditor key={JSON.stringify(props.scope)} {...props} />;
}

function ScopedDraftEditor({ scope, saveUnavailableReason, agents = [], initialTaskId, ownerName, onSaved, flexible = false }: Props) {
  const [draft, setDraft] = useState(() => readDraft(scope));
  const [existingTasks, setExistingTasks] = useState<ImportChoice[]>([]);
  const [graph, setGraph] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(!!initialTaskId);
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

  return <div className="wf-draft wf-create">
    <h1>Create workflow</h1><p className="wf-create-steps">Goal · Tasks · Review and save</p>
    <p className="wf-notice">Your draft stays in this page session for this project and signed-in person. Reloading or closing the page may discard it. No work starts while you are preparing it.</p>
    {frozen && <p>Checking the original save. Editing is paused so it cannot become a different request.</p>}
    <fieldset className="wf-form-body" disabled={frozen}>
    <section className="wf-card" aria-labelledby="wf-goal-heading">
      <h2 id="wf-goal-heading">Goal</h2>
      {ownerName && <p>Owner: {ownerName}</p>}
      <label>Workflow name<input maxLength={200} value={draft.name} onChange={(e) => change({ ...draft, name: e.target.value })} /></label>
      <label>Goal<textarea maxLength={4000} rows={3} value={draft.goal} onChange={(e) => change({ ...draft, goal: e.target.value })} /></label>
      <div className="wf-field"><span>How work runs</span><Segmented label="How work runs" value={draft.mode} onChange={(mode) => change({ ...draft, mode: mode as WorkflowDraft["mode"] })} items={[{ key: "serial", label: "One task at a time" }, { key: "parallel", label: "Independent tasks together" }]} /></div>
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
      <Segmented label="Task editor view" value={graph ? "graph" : "cards"} onChange={(k) => setGraph(k === "graph")} items={[{ key: "cards", label: "Cards" }, { key: "graph", label: "Graph" }]} />
      {graph && selected && <Button className="wf-back-graph" onClick={() => setSelected(null)}>Back to graph</Button>}
      <div className={graph && selected ? "wf-draft-graph has-selection" : "wf-draft-graph"}>{graph && <WorkflowGraph tasks={draft.tasks.map((t) => ({ id: t.key, title: draftTaskName(t, draft.tasks), status: "pending", label: "Draft", assignee: agents.find((a) => a.id === t.assignee)?.alias ?? "Unassigned", dependsOn: t.dependsOn, draft: true }))} selected={selected} onSelect={setSelected}
        onAdd={() => { const task = newDraftTask(); change({ ...draft, tasks: [...draft.tasks, task] }); setSelected(task.key); }}
        onAfter={(id) => { const task = { ...newDraftTask(), dependsOn: [id] }; change({ ...draft, tasks: [...draft.tasks, task] }); setSelected(task.key); }} disabledReason={draft.tasks.length >= 200 ? "The draft already has 200 tasks." : null} />}</div>
      {draft.tasks.filter((t) => !graph || t.key === selected).map((task) => <WorkflowTaskDraftFields key={task.key} task={task} tasks={draft.tasks} agents={agents} flexible={flexible} ownerName={ownerName}
        reviewLoop={draft.repeatGroups?.find((g) => g.review === task.key)?.name.trim() || (draft.repeatGroups?.some((g) => g.review === task.key) ? "this loop" : undefined)}
        loopMembers={draft.repeatGroups?.find((g) => g.review === task.key)?.members}
        existing={(draft.existingTaskIds ?? []).map((id) => ({ id, title: existingTasks.find((t) => t.id === id)?.title ?? "Selected existing task" }))}
        onChange={(patch) => update(task, patch)} removeLabel={`Remove task ${draft.tasks.indexOf(task) + 1}`}
        onRemove={() => { change({ ...draft, tasks: draft.tasks.filter((t) => t.key !== task.key).map((t) => ({ ...t, outcomes: t.outcomes?.map((o) => o.destinationTask === task.key ? { ...o, destination: "next", destinationTask: undefined } : o) })),
          repeatGroups: draft.repeatGroups?.map((g) => ({ ...g, members: g.members.filter((k) => k !== task.key), ...(g.review === task.key ? { review: "", exitOutcome: "" } : {}) })) }); setSelected(null); }} />)}
      <Button icon="plus" disabled={draft.tasks.length >= 200} onClick={() => { const task = newDraftTask(); change({ ...draft, tasks: [...draft.tasks, task] }); setSelected(task.key); }}>Add task summary</Button>
    </section>
    {flexible && <WorkflowLoopFields groups={draft.repeatGroups ?? []} tasks={draft.tasks} ownerName={ownerName} onChange={(repeatGroups) => change({ ...draft, repeatGroups })} />}
    <Button onClick={() => setImportOpen(true)}>Add existing tasks…</Button>
    {(draft.existingTaskIds ?? []).length > 0 && <p>{draft.existingTaskIds!.length} existing tasks selected.</p>}
    {importOpen && <Dialog title="Add existing tasks" className="wf-page" onClose={() => setImportOpen(false)} footer={<Button onClick={() => setImportOpen(false)}>Keep selections</Button>}>
    <WorkflowImportChoices scope={scope} selected={draft.existingTaskIds ?? []} onChange={(ids) => change({ ...draft, existingTaskIds: ids })} onSelectedChoices={setExistingTasks} />
    </Dialog>}
    </fieldset>
    <WorkflowDraftSave draft={draft} scope={scope} unavailableReason={saveUnavailableReason} onImportChange={(ids) => change({ ...draft, existingTaskIds: ids })} onSaved={(result) => { discardDraft(scope); onSaved?.(result); }} />
    <Button disabled={frozen} onClick={() => setDiscarding(true)}>Discard draft</Button>
    {discarding && <ConfirmDialog title="Discard this workflow draft?" description="The name, goal, task summaries and dependencies in this local draft will be removed. No saved workflow will change."
      confirmLabel="Discard draft" cancelLabel="Keep editing" danger onClose={() => setDiscarding(false)} onConfirm={() => { discardDraft(scope); setDraft(emptyDraft()); setDiscarding(false); }} />}
  </div>;
}
