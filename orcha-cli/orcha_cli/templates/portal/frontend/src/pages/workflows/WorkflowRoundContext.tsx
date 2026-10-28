/**
 * Round context in the task inspector (issue #362 screen 4, frame x03: Round / Why it runs / Waiting on, "Received this round"): the outcomes the
 * step can report and what each leads to, and for a repeat-group member its round, the rule that
 * ends the loop, what this round must address and the earlier rounds. Read from the same
 * server view the step's worker gets in its prompt.
 */
import { useEffect, useState } from "react";
import { Badge, Section } from "../../components/primitives";
import { workflowRequest } from "./workflowApi";
import type { RoundContext, WorkflowDetail, WorkflowTask } from "./workflowContract.generated";

const TRIGGERS: Record<string, string> = {
  initial: "First round", return: "Sent back by the review", owner_raise_limit: "The owner allowed more rounds",
  owner_reassign: "The owner reassigned the step", owner_resume: "The owner resumed the loop with guidance",
};
const TONE = { success: "ok", changes: "warn", failure: "danger", custom: "neutral" } as const;
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
  const back = task.routes?.find((r) => r.outcome === round?.outcome);
  const why = !round || round.trigger === "initial" || !round.trigger ? "First round of the loop."
    : round.trigger === "return" ? <>Round {group!.round - 1} review reported <b>{round.outcome}</b>{back ? ` (rule: ${round.outcome} ${back.destination === "return" ? "↺" : "→"} ${back.destination_task ? title(back.destination_task) : "the next step"})` : ""}.</>
    : `${TRIGGERS[round.trigger] ?? "This round"}.`;
  const received = !!round && (!!round.findings?.length || !!round.note || !!round.owner_note);
  return <div className="wf-round-context">
    {group && <Section>
      <dl className="wf-kv">
        <dt>Round</dt><dd>{group.round} of {group.max_rounds} in “{group.name}”</dd>
        <dt>Ends when</dt><dd>{group.is_review_step ? "This step" : group.review_step ?? "The review step"} reports “{group.exit_outcome}”</dd>
        <dt>Why it runs</dt><dd>{why}</dd>
        <dt>Waiting on</dt><dd>{task.blockers[0]?.message ?? task.display_state.label}</dd>
      </dl>
    </Section>}
    {group && received && <Section title="Received this round">
      <div className="wf-evi">
        {round!.findings?.map((f, i) => <div key={i} className="wf-finding"><code>F{i + 1}</code><span>{f.severity ? `${f.severity}: ` : ""}{f.text}</span></div>)}
        {round!.note && <div className="wf-finding"><code>Note</code><span>Reviewer note: {round!.note}</span></div>}
        {round!.owner_note && <div className="wf-finding"><code>Owner</code><span>Owner guidance: {round!.owner_note}</span></div>}
        <div className="wf-muted">The reviewer’s original words are kept with the findings.{round!.outcome ? ` Reason for return: ${round!.outcome}, round ${group.round - 1}.` : ""}</div>
      </div>
    </Section>}
    {group && !!group.earlier_rounds?.length && <Section><details><summary>Earlier rounds ({group.earlier_rounds.length})</summary><ul className="wf-earlier">
      {group.earlier_rounds.map((r) => <li key={r.round}>Round {r.round}{r.ended ? `, ${ENDINGS[r.ended] ?? r.ended}` : ""}{r.findings?.length ? `: ${r.findings.map((f) => f.text).join("; ")}` : ""}</li>)}
    </ul></details></Section>}
    {context.outcomes && context.outcomes.length > 0 && <Section title="What happens next"><div className="wf-impact wf-rules">
      {context.outcomes.map((o) => { const r = task.routes?.find((x) => x.outcome === o.name);
        return <div key={o.name} className="wf-route is-read"><Badge tone={TONE[o.kind as keyof typeof TONE] ?? "neutral"}>{o.name}</Badge><span className="arr" aria-hidden="true">{r?.destination === "return" ? "↺" : "→"}</span><span className="dest">{rule(o.name)}</span></div>; })}
    </div></Section>}
  </div>;
}
