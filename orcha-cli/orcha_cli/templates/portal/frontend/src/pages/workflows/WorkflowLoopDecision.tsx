/**
 * Owner decision dialog (issue #362 frames x04 and x05): a loop at its round limit, a stalled
 * loop, a step accepted without an outcome, or a rule that asks the owner. It says what is still
 * open, sets the last two rounds side by side when the loop stalled, and words each choice with
 * its numbers and consequence. The server records the choice beside the outcome that caused it.
 */
import { useEffect, useState } from "react";
import { Badge } from "../../components/primitives";
import { Button } from "../../components/primitives/Button";
import { Dialog } from "../../components/primitives/Dialog";
import { workflowRequest } from "./workflowApi";
import type { RoundContext, WorkflowDetail, WorkflowTask } from "./workflowContract.generated";
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
const TITLES: Record<Wait, string> = {
  limit_reached: "The loop reached its limit. What should happen?",
  stalled: "The loop stopped making progress. What should happen?",
  missing_outcome: "This step finished without an outcome. What should happen?",
  ask_owner: "This step asks you what happens next",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: (string | number)[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
const same = (text: string) => text.split(/\s+/).join(" ").toLowerCase().trim();

/** The round context of the waiting step: earlier rounds' findings, read when the dialog opens. */
export function useRounds(task: WorkflowTask, open: boolean) {
  const [context, setContext] = useState<RoundContext | null>(null);
  useEffect(() => {
    if (!open || !task.repeat_group_id) return;
    let active = true; const controller = new AbortController();
    void workflowRequest("RoundContext", `/api/tasks/${encodeURIComponent(task.id)}/round-context`, { signal: controller.signal })
      .then((result) => { if (active && result.task_id === task.id) setContext(result); }).catch(() => { if (active) setContext(null); });
    return () => { active = false; controller.abort(); };
  }, [open, task.id, task.repeat_group_id, task.work_revision]);
  return context;
}

export function WorkflowLoopDecision({ detail, task, scope, stale, agents, onSaved, onClose }: {
  detail: WorkflowDetail; task: WorkflowTask; scope: DraftScope; stale: boolean;
  agents: { id: string; alias: string }[]; onSaved: (detail: WorkflowDetail) => void; onClose: () => void;
}) {
  const wait = task.awaiting_loop_decision;
  const group = detail.repeat_groups?.find((g) => g.review_task === task.id);
  const used = group?.current_round ?? 0;
  const [kind, setKind] = useState<Kind | null>(wait ? OPTIONS[wait][0] : null);
  const [extra, setExtra] = useState(2);
  const [assignee, setAssignee] = useState("");
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useWorkflowForm(scope, `task:${task.id}:loop-decision`, "");
  const slot = `workflow:${detail.id}`;
  const operation = useWorkflowOperation(scope, slot);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  const context = useRounds(task, !!wait && !!group);
  if (!wait) return null;
  const title = (id?: string | null) => detail.tasks.find((t) => t.id === id)?.title;
  const worker = title(task.routes?.find((r) => r.destination === "return")?.destination_task) ?? "the step it returns to";
  const reported = task.reported_outcome?.outcome;
  const open = task.reported_outcome?.findings ?? [];
  const next = used + 1;
  const rounds = used + extra;
  // Rounds whose review raised a finding: round N's inputs hold round N-1's findings.
  const history = context?.group ? [
    ...(context.group.earlier_rounds ?? []).map((r) => ({ round: r.round - 1, findings: r.findings ?? [] })),
    { round: context.group.round - 1, findings: context.group.this_round.findings ?? [] },
  ].filter((r) => r.round >= 1) : [];
  const raisedIn = (text: string) => [...history.filter((r) => r.findings.some((f) => same(f.text) === same(text))).map((r) => r.round), used];
  const resolved = new Set(history.flatMap((r) => r.findings.map((f) => same(f.text))).filter((t) => !open.some((f) => same(f.text) === t))).size;
  const previous = context?.group?.this_round;
  const labels: Record<Kind, string> = {
    raise_limit: `Allow ${plural(extra, "more round")} (new maximum ${rounds}, ${used} used)`,
    reassign_continue: wait === "stalled" ? `Reassign ${worker} and resume` : `Reassign ${worker}, then allow 1 more round`,
    accept_override: "Accept the work as it is and move on",
    resume_stalled: "Resume with guidance for the worker",
    pick_outcome: "Choose the outcome",
    stop: "Stop the loop",
  };
  const consequences: Record<Kind, string> = {
    raise_limit: `Round ${next} starts with the last review${open.length ? ` and ${plural(open.length, "open finding")}` : ""}. Rounds already used stay counted; this never makes the loop unlimited.`,
    reassign_continue: `Pick who does ${worker} in round ${next}. The review step stays the same.`,
    accept_override: `Records that you overrode the round-${used} review.${reported ? ` The original “${reported}” stays in history beside your decision.` : ""}`,
    resume_stalled: `Round ${next} starts with the same findings and your note.${group ? ` Rounds remaining: ${Math.max(group.max_rounds - used, 0)}.` : ""}`,
    pick_outcome: "Your choice takes that outcome's rule, as if the step had reported it.",
    stop: `Keeps ${used ? `all ${plural(used, "round")}` : "the finished work"}. Later steps that depend on the loop are not needed.`,
  };
  const actions: Record<Kind, string> = {
    raise_limit: `Allow ${plural(extra, "more round")}`, reassign_continue: "Reassign and continue", accept_override: "Accept as it is",
    resume_stalled: `Resume round ${next}`, pick_outcome: "Use this outcome", stop: "Stop the loop",
  };
  const outcomes = (task.outcomes ?? []).filter((o) => wait !== "ask_owner" || o.name !== task.routes?.find((r) => r.destination === "ask_owner")?.outcome);
  const invalid = !kind ? "Choose what happens next."
    : kind === "raise_limit" && (!group || extra < 1 || rounds > 20) ? `Allow between 1 and ${Math.max(20 - used, 1)} more rounds (at most 20 in all).`
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
    if (op.state === "saved" && op.result) { onSaved(op.result); onClose(); }
  }
  const close = () => { if (!unresolved) onClose(); };
  const description = group
    ? `${group.name} · ${used} of ${group.max_rounds} rounds used${reported ? ` · last outcome: ${reported} (round ${used})` : ""}${open.length ? ` · ${plural(open.length, "unresolved finding")}` : ""}`
    : `${task.title}${reported ? ` · reported ${reported}` : ""}`;
  return <Dialog title={TITLES[wait]} description={description} size="lg" className="wf-page wf-decide" onClose={close}
    footer={<><Button disabled={unresolved} onClick={close}>Not now</Button>
      <Button variant={kind === "stop" ? "danger" : "primary"} disabled={stale || unresolved || !!invalid} onClick={() => void send()}>{kind ? actions[kind] : "Decide"}</Button></>}>
    {wait === "stalled" && group && <>
      <div className="wf-card-h">Why Orcha paused: rounds {used - 1} and {used} side by side <span className="wf-muted" style={{ marginLeft: "auto" }}>Compared by finding text and file versions.</span></div>
      <div className="wf-compare">
        <div className="wf-card"><div className="wf-card-h">Round {used - 1}{previous?.outcome ? ` · ${previous.outcome}` : ""}</div>
          {(previous?.findings ?? []).map((f, i) => <div key={i} className="wf-finding is-same"><code>F{i + 1}</code><span>{f.text}</span></div>)}
          {!previous && <div className="wf-muted">Reading the round…</div>}</div>
        <div className="wf-card"><div className="wf-card-h">Round {used}{reported ? ` · ${reported}` : ""}</div>
          <div className="wf-muted">The work it reviewed did not change since round {used - 1}.</div>
          {open.map((f, i) => <div key={i} className="wf-finding is-same"><code>F{i + 1}</code><span>{f.text}{previous?.findings?.some((p) => same(p.text) === same(f.text)) && <> <Badge tone="warn">unchanged</Badge></>}</span></div>)}</div>
      </div>
    </>}
    {wait === "limit_reached" && open.length > 0 && <div className="wf-card"><div className="wf-card-h">Still open after round {used}</div>
      {open.map((f, i) => { const raised = raisedIn(f.text); return <div key={i} className="wf-finding"><code>{f.id || `F${i + 1}`}</code><span>{f.text}{raised.length > 1 && <span className="wf-muted"> · raised in rounds {list(raised)}</span>}</span></div>; })}
      <div className="wf-muted">{resolved > 0 ? `${plural(resolved, "earlier finding was", "earlier findings were")} resolved along the way. ` : ""}Every round’s work and review is in Review history.</div>
    </div>}
    {(wait === "missing_outcome" || wait === "ask_owner") && <p className="wf-muted">{HEADINGS[wait]}.{task.reported_outcome?.note ? ` Note: ${task.reported_outcome.note}` : ""}</p>}
    <fieldset className="wf-decide-options" disabled={stale || unresolved}><legend className="v2-sr">What happens next</legend>
      {OPTIONS[wait].map((k) => <label key={k} className="wf-choice"><input type="radio" name={`loop-decision-${task.id}`} checked={kind === k} onChange={() => setKind(k)} />
        <span>{labels[k]}<small>{consequences[k]}</small></span></label>)}
      {kind === "raise_limit" && <label className="wf-field">More rounds<input className="wf-in" type="number" min={1} max={Math.max(20 - used, 1)} value={extra} onChange={(e) => setExtra(Number(e.target.value))} /></label>}
      {kind === "reassign_continue" && <label className="wf-field">Assign {worker} to<select className="wf-sel" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
        <option value="">Choose…</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.alias}</option>)}</select></label>}
      {kind === "pick_outcome" && <label className="wf-field">Outcome<select className="wf-sel" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
        <option value="">Choose…</option>{outcomes.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}</select></label>}
      <label className="wf-field">{kind === "resume_stalled" ? "Note to the worker" : "Reason (shown in Activity)"}<textarea className="wf-ta" maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
    </fieldset>
    {invalid && kind && <p className="wf-muted">{invalid}</p>}
    {operation?.operation === "loop_decision" && <WorkflowOperationNotice scope={scope} slot={slot} onSaved={(d) => { onSaved(d); onClose(); }} canRetry={async () => !stale} />}
  </Dialog>;
}

/** The inspector's short form: what the step waits on, and for the owner a button to the decision. */
export function WorkflowLoopDecisionPrompt({ detail, task, viewer, onDecide }: {
  detail: WorkflowDetail; task: WorkflowTask; viewer: string; onDecide: () => void;
}) {
  const wait = task.awaiting_loop_decision;
  if (!wait) return null;
  if (detail.owner_human_id !== viewer) return <p>{HEADINGS[wait]}. The workflow owner decides what happens next.</p>;
  return <p>{HEADINGS[wait]}. <Button size="sm" variant="primary" onClick={onDecide}>Decide…</Button></p>;
}

/** The bar across the workflow page when a loop or rule waits for the owner (issue #362 x04 callout 1):
 * what happened in words, and for the owner a Decide button that opens the step with the decision. */
export function WorkflowOwnerBar({ detail, viewer, ownerName, onDecide }: {
  detail: WorkflowDetail; viewer: string; ownerName: string; onDecide: (taskId: string) => void;
}) {
  const task = detail.tasks.find((t) => t.awaiting_loop_decision);
  if (!task?.awaiting_loop_decision) return null;
  const group = detail.repeat_groups?.find((g) => g.id === task.repeat_group_id);
  const reported = task.reported_outcome?.outcome;
  const what = {
    limit_reached: group ? `“${group.name}” used all ${group.max_rounds} rounds${reported ? ` and the last review reported “${reported}”` : ""}. No round ${group.max_rounds + 1} was started. Nothing is lost: every round’s work and review is kept.` : HEADINGS.limit_reached + ".",
    stalled: group ? `“${group.name}” is paused: round ${group.current_round} brought back the same findings on unchanged work, so another round would likely repeat them.` : HEADINGS.stalled + ".",
    missing_outcome: `${task.title} was accepted without an outcome, so Orcha did not guess what comes next.`,
    ask_owner: `${task.title} reported${reported ? ` “${reported}”` : " an outcome"}, and its rule asks you what happens next.`,
  }[task.awaiting_loop_decision];
  const owner = detail.owner_human_id === viewer;
  return <div className="wf-ownerbar" role="status">
    <span><b>{owner ? "Needs you." : `Waiting for ${ownerName}.`}</b> {what}</span>
    {owner && <Button size="sm" variant="primary" onClick={() => onDecide(task.id)}>Decide…</Button>}
  </div>;
}
