/**
 * Owner decision sheet (issue #362 screen 6, frames x04, x05, x07): a loop at its round limit,
 * a stalled loop, a step accepted without an outcome, or a rule that asks the owner. Each choice
 * says what it does; the server records it beside the outcome that caused it.
 */
import { useState } from "react";
import { Button } from "../../components/primitives/Button";
import type { WorkflowDetail, WorkflowTask } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";

type Kind = "raise_limit" | "reassign_continue" | "accept_override" | "resume_stalled" | "pick_outcome" | "stop";
type Wait = NonNullable<WorkflowTask["awaiting_loop_decision"]>;

const OPTIONS: Record<Wait, Kind[]> = {
  limit_reached: ["raise_limit", "reassign_continue", "accept_override", "stop"],
  stalled: ["resume_stalled", "reassign_continue", "accept_override", "stop"],
  missing_outcome: ["pick_outcome", "stop"],
  ask_owner: ["pick_outcome", "stop"],
};
const HEADINGS: Record<Wait, string> = {
  limit_reached: "The loop reached its round limit",
  stalled: "The loop stalled: the same findings came back on unchanged work",
  missing_outcome: "This step was accepted without an outcome",
  ask_owner: "This step's rule asks you what happens next",
};
const LABELS: Record<Kind, string> = {
  raise_limit: "Allow more rounds",
  reassign_continue: "Reassign and run one more round",
  accept_override: "Accept as it is",
  resume_stalled: "Resume with guidance",
  pick_outcome: "Choose the outcome",
  stop: "Stop the loop",
};
const CONSEQUENCES: Record<Kind, string> = {
  raise_limit: "A new round starts now with the last findings. Rounds already used still count.",
  reassign_continue: "The step goes to the person or agent you choose and one more round starts.",
  accept_override: "The loop ends and the next steps can start. The reported outcome is kept beside your override.",
  resume_stalled: "A new round starts and carries your guidance to the workers.",
  pick_outcome: "Your choice takes that outcome's rule, as if the step had reported it.",
  stop: "The loop ends here and later steps that depend on it are not needed. Finished work is kept.",
};

export function WorkflowLoopDecision({ detail, task, scope, stale, agents, onSaved }: {
  detail: WorkflowDetail; task: WorkflowTask; scope: DraftScope; stale: boolean;
  agents: { id: string; alias: string }[]; onSaved: (detail: WorkflowDetail) => void;
}) {
  const wait = task.awaiting_loop_decision;
  const group = detail.repeat_groups?.find((g) => g.review_task === task.id);
  const [kind, setKind] = useState<Kind | null>(null);
  const [rounds, setRounds] = useState((group?.max_rounds ?? 0) + 1);
  const [assignee, setAssignee] = useState("");
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useWorkflowForm(scope, `task:${task.id}:loop-decision`, "");
  const slot = `workflow:${detail.id}`;
  const operation = useWorkflowOperation(scope, slot);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  if (!wait) return null;
  if (detail.owner_human_id !== scope.identity) return <p>{HEADINGS[wait]}. The workflow owner decides what happens next.</p>;
  const outcomes = (task.outcomes ?? []).filter((o) => wait !== "ask_owner" || o.name !== task.routes?.find((r) => r.destination === "ask_owner")?.outcome);
  const invalid = !kind ? "Choose what happens next."
    : kind === "raise_limit" && (!group || rounds <= group.max_rounds || rounds > 20) ? `Choose more than ${group?.max_rounds ?? 0} rounds (at most 20).`
    : kind === "reassign_continue" && !assignee ? "Choose who takes the step."
    : kind === "pick_outcome" && !outcome ? "Choose an outcome."
    : kind === "resume_stalled" && !note.trim() ? "Write the guidance the next round should follow."
    : null;
  async function send() {
    if (!kind || invalid || stale || unresolved) return;
    const body: Record<string, unknown> = { expected_revision: detail.revision, kind, task_id: task.id, note: note.trim(), reason: note.trim() };
    if (kind === "raise_limit") body.new_max_rounds = rounds;
    if (kind === "reassign_continue") body.assignee_id = assignee;
    if (kind === "pick_outcome") body.outcome = outcome;
    const op = await sendWorkflowOperation(scope, slot, { operation: "loop_decision", url: `/api/workflows/${encodeURIComponent(detail.id)}/decisions`, expectedWorkflowId: detail.id, body });
    if (op.state === "saved" && op.result) onSaved(op.result);
  }
  return <section className="wf-loop-decision" aria-label="Owner decision">
    <h3>{HEADINGS[wait]}</h3>
    {group && <p>{group.name}: round {group.current_round} of {group.max_rounds}. The loop ends when {task.title} reports “{group.exit_outcome}”.</p>}
    <fieldset disabled={stale || unresolved}><legend>What happens next</legend>
      {OPTIONS[wait].map((k) => <label key={k} className="wf-choice"><input type="radio" name={`loop-decision-${task.id}`} checked={kind === k} onChange={() => setKind(k)} />
        <span><strong>{LABELS[k]}</strong> <span className="wf-muted">{CONSEQUENCES[k]}</span></span></label>)}
      {kind === "raise_limit" && <label>Most rounds<input type="number" min={(group?.max_rounds ?? 0) + 1} max={20} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} /></label>}
      {kind === "reassign_continue" && <label>Assign to<select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
        <option value="">Choose…</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.alias}</option>)}</select></label>}
      {kind === "pick_outcome" && <label>Outcome<select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
        <option value="">Choose…</option>{outcomes.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}</select></label>}
      <label>{kind === "resume_stalled" ? "Guidance for the next round" : "Reason (kept with the decision)"}<textarea maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
    </fieldset>
    {invalid && kind && <p>{invalid}</p>}
    <Button variant={kind === "stop" ? "danger" : "primary"} disabled={stale || unresolved || !!invalid} onClick={() => void send()}>{kind ? LABELS[kind] : "Decide"}</Button>
    <WorkflowOperationNotice scope={scope} slot={slot} onSaved={onSaved} canRetry={async () => operation?.operation === "loop_decision" && !stale} />
  </section>;
}
