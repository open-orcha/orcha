/**
 * Create authoring for flexible workflows (issue #362 screens 1-2, frames x01, x06): a step's
 * outcomes with the rule each one follows, and the feedback-loop card. Shown only when the
 * server reports `flexible_workflows`; the server's preview runs the full flow check.
 */
import { Button } from "../../components/primitives/Button";
import { draftAncestors, draftTaskName, type DraftOutcome, type DraftRepeatGroup, type DraftTask, type RouteDestination } from "./workflowDraft";

const KINDS: { key: DraftOutcome["kind"]; label: string }[] = [
  { key: "success", label: "Success" }, { key: "changes", label: "Needs changes" }, { key: "failure", label: "Failed" }, { key: "custom", label: "Other" },
];

/** Outcomes and their next-step rules for one draft step. */
export function WorkflowOutcomeFields({ task, tasks, onChange }: { task: DraftTask; tasks: DraftTask[]; onChange: (outcomes: DraftOutcome[]) => void }) {
  const outcomes = task.outcomes ?? [];
  const dependents = tasks.filter((t) => t.dependsOn.includes(task.key));
  const earlier = draftAncestors(tasks, task.key).map((key) => tasks.find((t) => t.key === key)).filter((t): t is DraftTask => !!t);
  const choices: { value: string; label: string }[] = [
    { value: "next", label: "The next steps proceed" },
    ...dependents.map((t) => ({ value: `step:${t.key}`, label: `Go to ${draftTaskName(t, tasks)} only` })),
    ...earlier.map((t) => ({ value: `return:${t.key}`, label: `Send back to ${draftTaskName(t, tasks)} (loop)` })),
    { value: "exit_group", label: "End the feedback loop" },
    { value: "ask_owner", label: "Ask the owner" },
    { value: "stop", label: "Stop: later steps are not needed" },
  ];
  const set = (i: number, patch: Partial<DraftOutcome>) => onChange(outcomes.map((o, j) => j === i ? { ...o, ...patch } : o));
  return <details open={outcomes.length > 0}><summary>Outcomes and next steps ({outcomes.length})</summary>
    {outcomes.length === 0 && <p className="wf-muted">Without outcomes this step just lets the next steps start once its work is accepted.</p>}
    {outcomes.map((o, i) => <fieldset key={i} className="wf-outcome"><legend>Outcome {i + 1}</legend>
      <label>Outcome name<input maxLength={40} value={o.name} onChange={(e) => set(i, { name: e.target.value })} /></label>
      <label>Kind<select value={o.kind} onChange={(e) => set(i, { kind: e.target.value as DraftOutcome["kind"] })}>{KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select></label>
      <label>Then<select value={o.destinationTask ? `${o.destination}:${o.destinationTask}` : o.destination} onChange={(e) => {
        const [destination, key] = e.target.value.split(":");
        set(i, { destination: destination as RouteDestination, destinationTask: key });
      }}>{choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
      <Button variant="ghost" onClick={() => onChange(outcomes.filter((_, j) => j !== i))}>Remove outcome {i + 1}</Button>
    </fieldset>)}
    <Button disabled={outcomes.length >= 8} onClick={() => onChange([...outcomes, { name: "", kind: outcomes.length ? "changes" : "success", destination: "next" }])}>Add outcome</Button>
  </details>;
}

/** Bounded repeat-until loops: the steps that repeat, the review step and its ending outcome. */
export function WorkflowLoopFields({ groups, tasks, onChange }: { groups: DraftRepeatGroup[]; tasks: DraftTask[]; onChange: (groups: DraftRepeatGroup[]) => void }) {
  const set = (key: string, patch: Partial<DraftRepeatGroup>) => onChange(groups.map((g) => g.key === key ? { ...g, ...patch } : g));
  return <section className="wf-card" aria-labelledby="wf-loops-heading">
    <h2 id="wf-loops-heading">Feedback loops (optional)</h2>
    <p>A loop repeats its steps until the review step reports the ending outcome, up to the most rounds you allow. Then the owner decides.</p>
    {groups.map((g, index) => {
      const members = tasks.filter((t) => g.members.includes(t.key));
      const review = tasks.find((t) => t.key === g.review);
      return <fieldset key={g.key}><legend>Loop {index + 1}</legend>
        <label>Loop name<input maxLength={80} value={g.name} onChange={(e) => set(g.key, { name: e.target.value })} /></label>
        <div className="wf-field" role="group" aria-label={`Steps in loop ${index + 1}`}><span>Steps that repeat</span>
          {tasks.map((t) => <label key={t.key} className="wf-choice"><input type="checkbox" checked={g.members.includes(t.key)} onChange={(e) => set(g.key, {
            members: e.target.checked ? [...g.members, t.key] : g.members.filter((k) => k !== t.key), ...(e.target.checked || t.key !== g.review ? {} : { review: "", exitOutcome: "" }),
          })} />{draftTaskName(t, tasks)}</label>)}</div>
        <label>Review step<select value={g.review} onChange={(e) => set(g.key, { review: e.target.value, exitOutcome: "" })}>
          <option value="">Choose…</option>{members.map((t) => <option key={t.key} value={t.key}>{draftTaskName(t, tasks)}</option>)}</select></label>
        <label>Ends when the review reports<select value={g.exitOutcome} onChange={(e) => set(g.key, { exitOutcome: e.target.value })}>
          <option value="">Choose…</option>{(review?.outcomes ?? []).filter((o) => o.name.trim()).map((o) => <option key={o.name} value={o.name.trim()}>{o.name.trim()}</option>)}</select></label>
        {review && !(review.outcomes ?? []).length && <p className="wf-muted">Add outcomes to {draftTaskName(review, tasks)} first.</p>}
        <label>Most rounds<input type="number" min={1} max={20} value={g.maxRounds} onChange={(e) => set(g.key, { maxRounds: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} /></label>
        <Button variant="ghost" onClick={() => onChange(groups.filter((x) => x.key !== g.key))}>Remove loop {index + 1}</Button>
      </fieldset>;
    })}
    <Button disabled={groups.length >= 5 || tasks.length < 2} onClick={() => onChange([...groups, { key: crypto.randomUUID(), name: "", members: [], review: "", exitOutcome: "", maxRounds: 3 }])}>Add feedback loop</Button>
  </section>;
}
