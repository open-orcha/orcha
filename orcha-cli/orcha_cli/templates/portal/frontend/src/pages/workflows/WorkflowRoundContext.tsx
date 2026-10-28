/**
 * Round context in the task inspector (issue #362 screen 3, frames x02, x03): the outcomes the
 * step can report and what each leads to, and for a repeat-group member its round, the rule that
 * ends the loop, what this round must address and the earlier rounds. Read from the same
 * server view the step's worker gets in its prompt.
 */
import { useEffect, useState } from "react";
import { workflowRequest } from "./workflowApi";
import type { RoundContext, WorkflowDetail, WorkflowTask } from "./workflowContract.generated";

const TRIGGERS: Record<string, string> = {
  initial: "First round", return: "Sent back by the review", owner_raise_limit: "The owner allowed more rounds",
  owner_reassign: "The owner reassigned the step", owner_resume: "The owner resumed the loop with guidance",
};
const ENDINGS: Record<string, string> = {
  return: "sent back", limit: "stopped at the round limit", stall: "stalled", exit: "loop ended", ask_owner: "waited for the owner",
  stopped: "stopped", accepted_override: "accepted by the owner",
};

export function WorkflowRoundContext({ detail, task }: { detail: WorkflowDetail; task: WorkflowTask }) {
  const [context, setContext] = useState<RoundContext | null>(null);
  const [error, setError] = useState("");
  const wanted = detail.semantics_version === 2 && ((task.outcomes ?? []).length > 0 || !!task.repeat_group_id);
  useEffect(() => {
    if (!wanted) return;
    let active = true; const controller = new AbortController();
    setError("");
    void workflowRequest("RoundContext", `/api/tasks/${encodeURIComponent(task.id)}/round-context`, { signal: controller.signal }).then((result) => {
      if (!active) return;
      if (result.task_id !== task.id) throw new Error("This round does not match the current task.");
      setContext(result);
    }).catch((e) => { if (active) { setContext(null); setError(e instanceof Error ? e.message : "The round could not be read."); } });
    return () => { active = false; controller.abort(); };
  }, [task.id, task.work_revision, task.round, wanted]);
  if (!wanted) return null;
  if (error) return <p role="alert">{error}</p>;
  if (!context) return <p className="wf-muted">Reading the round…</p>;
  const group = context.group;
  const title = (id?: string | null) => detail.tasks.find((t) => t.id === id)?.title ?? "a removed step";
  const rule = (name: string) => {
    const r = task.routes?.find((x) => x.outcome === name);
    if (!r || r.destination === "next") return "the next steps proceed";
    return { step: `goes to ${title(r.destination_task)}`, return: `goes back to ${title(r.destination_task)} for another round`,
      ask_owner: "the owner decides", exit_group: "the loop ends", stop: "the workflow stops here" }[r.destination];
  };
  const round = group?.this_round;
  return <div className="wf-round-context">
    {group && <>
      <p><strong>{group.name}</strong>: round {group.round} of {group.max_rounds}. It ends when {group.is_review_step ? "this step" : group.review_step ?? "the review step"} reports “{group.exit_outcome}”.</p>
      {round && <>
        <p>{TRIGGERS[round.trigger ?? ""] ?? "This round"}{round.outcome ? ` with “${round.outcome}”` : ""}.</p>
        {!!round.findings?.length && <><p>This round must address:</p><ul>{round.findings.map((f, i) => <li key={i}>{f.severity ? `${f.severity}: ` : ""}{f.text}</li>)}</ul></>}
        {round.note && <p>Reviewer note: {round.note}</p>}
        {round.owner_note && <p>Owner guidance: {round.owner_note}</p>}
      </>}
      {!!group.earlier_rounds?.length && <details><summary>Earlier rounds ({group.earlier_rounds.length})</summary><ul>
        {group.earlier_rounds.map((r) => <li key={r.round}>Round {r.round}{r.ended ? `, ${ENDINGS[r.ended] ?? r.ended}` : ""}{r.findings?.length ? `: ${r.findings.map((f) => f.text).join("; ")}` : ""}</li>)}
      </ul></details>}
    </>}
    {context.outcomes && context.outcomes.length > 0 && <><p>Outcomes this step can report:</p><ul>
      {context.outcomes.map((o) => <li key={o.name}>“{o.name}”: {rule(o.name)}.</li>)}
    </ul></>}
  </div>;
}
