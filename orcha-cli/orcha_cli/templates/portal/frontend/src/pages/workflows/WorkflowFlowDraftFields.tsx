/**
 * Create authoring for flexible workflows (issue #362 screen 1, frames x01 and x01b): the outcomes a
 * step can report as chips, a "What happens next" rule per outcome, and the repeat-group card. Shown
 * only when the server reports `flexible_workflows`; the server's preview runs the full flow check.
 */
import { Badge } from "../../components/primitives/Badge";
import { Button } from "../../components/primitives/Button";
import { draftTaskName, type DraftOutcome, type DraftRepeatGroup, type DraftTask, type RouteDestination } from "./workflowDraft";

const KINDS: { key: DraftOutcome["kind"]; label: string }[] = [
  { key: "success", label: "Success" }, { key: "changes", label: "Needs changes" }, { key: "failure", label: "Failed" }, { key: "custom", label: "Other" },
];
const TONE = { success: "ok", changes: "warn", failure: "danger", custom: "neutral" } as const;
/** The right-hand words on a rule row (x01): what kind of move the destination is. */
const MOVE: Record<RouteDestination, string> = {
  next: "next step", step: "this branch only", return: "return inside the loop", exit_group: "leaves the loop", ask_owner: "stop and ask", stop: "ends the route",
};

/** Outcomes and their next-step rules for one draft step. */
export function WorkflowOutcomeFields({ task, tasks, ownerName, loopMembers, onChange }: {
  task: DraftTask; tasks: DraftTask[]; ownerName?: string; loopMembers?: string[]; onChange: (outcomes: DraftOutcome[]) => void;
}) {
  const outcomes = task.outcomes ?? [];
  const dependents = tasks.filter((t) => t.dependsOn.includes(task.key));
  // Only a loop's review step can send work back (to another step of its loop) or end the loop.
  const loop = loopMembers ? tasks.filter((t) => t.key !== task.key && loopMembers.includes(t.key)) : [];
  const owner = ownerName ? `Ask the owner (${ownerName})` : "Ask the owner";
  const choices: { value: string; label: string }[] = [
    { value: "next", label: "The next steps proceed" },
    ...dependents.map((t) => ({ value: `step:${t.key}`, label: `Go to ${draftTaskName(t, tasks)} only` })),
    ...loop.map((t) => ({ value: `return:${t.key}`, label: `Send back to ${draftTaskName(t, tasks)} (loop)` })),
    ...(loopMembers ? [{ value: "exit_group", label: "End the feedback loop" }] : []),
    { value: "ask_owner", label: owner },
    { value: "stop", label: "Stop: later steps are not needed" },
  ];
  const set = (i: number, patch: Partial<DraftOutcome>) => onChange(outcomes.map((o, j) => j === i ? { ...o, ...patch } : o));
  const add = () => onChange([...outcomes, { name: "", kind: outcomes.length ? "changes" : "success", destination: "next" }]);
  return <div className="wf-flow-fields">
    <div className="wf-field" role="group" aria-label="Outcomes this step can report"><span>Outcomes this step can report</span>
      <div className="wf-chipline">
        {outcomes.map((o, i) => <Badge key={i} tone={TONE[o.kind]}>{o.name.trim() || `Outcome ${i + 1}`}</Badge>)}
        <Button size="sm" variant="secondary" icon="plus" disabled={outcomes.length >= 8} onClick={add}>Add outcome</Button>
      </div>
      {outcomes.length === 0 && <span className="wf-muted">Without outcomes this step just lets the next steps start once its work is accepted.</span>}
    </div>
    {outcomes.length > 0 && <div className="wf-field"><span>What happens next</span>
      <div className="wf-impact wf-rules">{outcomes.map((o, i) => {
        const value = o.destinationTask ? `${o.destination}:${o.destinationTask}` : o.destination;
        return <div key={i} className="wf-route is-edit" role="group" aria-label={`Outcome ${i + 1}`}>
          <span className="wf-route-name">
            <input className={`wf-in wf-tone-${TONE[o.kind]}`} aria-label="Outcome name" maxLength={40} placeholder={`Outcome ${i + 1}`} value={o.name} onChange={(e) => set(i, { name: e.target.value })} />
            <select className="wf-sel" aria-label="Kind" value={o.kind} onChange={(e) => set(i, { kind: e.target.value as DraftOutcome["kind"] })}>{KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select>
          </span>
          <span className="arr" aria-hidden="true">{o.destination === "return" ? "↺" : "→"}</span>
          <select className="wf-sel dest" aria-label="Then" value={value} onChange={(e) => {
            const [destination, key] = e.target.value.split(":");
            set(i, { destination: destination as RouteDestination, destinationTask: key });
          }}>{!choices.some((c) => c.value === value) && <option value={value} disabled>Choose where this goes…</option>}
            {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
          <span className="wf-muted">{MOVE[o.destination]}</span>
          <Button size="sm" variant="ghost" onClick={() => onChange(outcomes.filter((_, j) => j !== i))}>Remove outcome {i + 1}</Button>
        </div>;
      })}</div>
      <span className="wf-muted">Every outcome needs one destination or “ask the owner”. Two rules for one outcome are refused when you review the draft.</span>
      {!loopMembers && <span className="wf-muted">To send work back or end a loop, make this step a feedback loop’s review point first.</span>}
    </div>}
  </div>;
}

/** Bounded repeat-until groups (x01b): the steps that repeat, the review point, the exit outcome and the limit. */
export function WorkflowLoopFields({ groups, tasks, ownerName, onChange }: { groups: DraftRepeatGroup[]; tasks: DraftTask[]; ownerName?: string; onChange: (groups: DraftRepeatGroup[]) => void }) {
  const set = (key: string, patch: Partial<DraftRepeatGroup>) => onChange(groups.map((g) => g.key === key ? { ...g, ...patch } : g));
  return <section aria-labelledby="wf-loops-heading">
    <h2 id="wf-loops-heading">Feedback loops <span className="wf-muted">optional</span></h2>
    <p className="wf-muted">A loop repeats its steps until the review point reports the exit outcome, up to the most rounds you allow. Then the owner decides.</p>
    {groups.map((g, index) => {
      const members = tasks.filter((t) => g.members.includes(t.key));
      const review = tasks.find((t) => t.key === g.review);
      return <fieldset key={g.key} className="wf-card wf-loop-card" aria-label={`Loop ${index + 1}`}>
        <div className="wf-card-h">Repeat group · <b>{g.name.trim() || `Loop ${index + 1}`}</b>
          <Button size="sm" variant="ghost" className="wf-push" onClick={() => onChange(groups.filter((x) => x.key !== g.key))}>Remove loop {index + 1}</Button></div>
        <label className="wf-field"><span>Loop name</span><input className="wf-in" maxLength={80} value={g.name} onChange={(e) => set(g.key, { name: e.target.value })} /></label>
        <div className="wf-grid2">
          <div className="wf-field" role="group" aria-label={`Steps in loop ${index + 1}`}><span>Steps in the group</span>
            <div className="wf-chipline">{tasks.map((t, i) => <label key={t.key} className={`wf-choice-chip${g.members.includes(t.key) ? " is-on" : ""}`}><input type="checkbox" checked={g.members.includes(t.key)} onChange={(e) => set(g.key, {
              members: e.target.checked ? [...g.members, t.key] : g.members.filter((k) => k !== t.key), ...(e.target.checked || t.key !== g.review ? {} : { review: "", exitOutcome: "" }),
            })} /><span aria-hidden="true">{i + 1} </span>{draftTaskName(t, tasks)}</label>)}</div></div>
          <label className="wf-field"><span>Review point</span><select className="wf-sel" value={g.review} onChange={(e) => set(g.key, { review: e.target.value, exitOutcome: "" })}>
            <option value="">Choose…</option>{members.map((t) => <option key={t.key} value={t.key}>{draftTaskName(t, tasks)}</option>)}</select></label>
          <div className="wf-field"><label htmlFor={`wf-exit-${g.key}`}>Leave the group when</label><select id={`wf-exit-${g.key}`} className="wf-sel" value={g.exitOutcome} onChange={(e) => set(g.key, { exitOutcome: e.target.value })}>
            <option value="">Choose…</option>{(review?.outcomes ?? []).filter((o) => o.name.trim()).map((o) => <option key={o.name} value={o.name.trim()}>{review ? `${draftTaskName(review, tasks)} reports ${o.name.trim()}` : o.name.trim()}</option>)}</select>
            {review && !(review.outcomes ?? []).length && <span className="wf-muted">Add outcomes to {draftTaskName(review, tasks)} first.</span>}</div>
          <div className="wf-field"><label htmlFor={`wf-max-${g.key}`}>Most rounds, including the first</label><input id={`wf-max-${g.key}`} className="wf-in wf-in-num" type="number" min={1} max={20} value={g.maxRounds} onChange={(e) => set(g.key, { maxRounds: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
            <span className="wf-muted">Required. The default is 5; you can lower it. Raising it later is a separate owner decision.</span></div>
          <div className="wf-field"><span>When the limit is reached or the loop stalls</span><span>{ownerName ? `Ask ${ownerName} (owner)` : "Ask the owner"}</span></div>
          <div className="wf-field"><span>Each new round receives</span><span className="wf-muted">The last reviewed work, the reviewer’s findings, the reason for the return and links to earlier rounds. Always on.</span></div>
        </div>
      </fieldset>;
    })}
    <Button icon="plus" disabled={groups.length >= 5 || tasks.length < 2} onClick={() => onChange([...groups, { key: crypto.randomUUID(), name: "", members: [], review: "", exitOutcome: "", maxRounds: 5 }])}>Add feedback loop</Button>
  </section>;
}
