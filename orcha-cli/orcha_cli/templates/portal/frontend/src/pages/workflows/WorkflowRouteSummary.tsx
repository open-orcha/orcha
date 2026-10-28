/**
 * Expected route in the Start review (issue #362 screen 2, frame x02): each feedback loop with its
 * steps, exit rule, round limit and stall rule, every outcome rule that does not simply continue,
 * and the agent-turn allowance for this run. Shown only for flexible (semantics 2) workflows.
 */
import type { StepRoute, WorkflowDetail } from "./workflowContract.generated";

export const ROUTE_LABELS: Record<StepRoute["destination"], string> = {
  next: "the next steps proceed", step: "goes to", return: "goes back to", ask_owner: "the owner decides what happens next",
  exit_group: "the loop ends", stop: "the workflow stops here",
};

export function WorkflowRouteSummary({ detail }: { detail: WorkflowDetail }) {
  if (detail.semantics_version !== 2) return null;
  const title = (id?: string | null) => detail.tasks.find((t) => t.id === id)?.title ?? "a removed step";
  const groups = detail.repeat_groups ?? [];
  const rules = detail.tasks.filter((t) => !t.withdrawn_at).flatMap((t) => (t.routes ?? [])
    .filter((r) => r.destination !== "next").map((r) => ({ task: t, route: r })));
  return <section className="wf-route-summary" aria-label="Expected route">
    <h3>Expected route</h3>
    {!groups.length && !rules.length && <p>Steps run in prerequisite order. No step changes the route.</p>}
    {groups.map((g) => <p key={g.id}><strong>Loop: {g.name}.</strong> {g.member_tasks.map(title).join(", ")} repeat until {title(g.review_task)} reports “{g.exit_outcome}”.
      {" "}Up to {g.max_rounds} {g.max_rounds === 1 ? "round" : "rounds"}; at the limit the owner decides.
      {g.stall_rule !== "off" && " If a round brings back the same findings on unchanged work, the loop pauses for the owner."}</p>)}
    {rules.length > 0 && <ul>{rules.map(({ task, route }) => <li key={`${task.id}:${route.outcome}`}>
      {task.title}: if “{route.outcome}”, {ROUTE_LABELS[route.destination]}{route.destination_task ? ` ${title(route.destination_task)}` : ""}.
      {(route.destination === "ask_owner" || route.destination === "stop") && <span className="wf-muted"> Stops and asks.</span>}
    </li>)}</ul>}
    <p>Agent-turn allowance for this run: {detail.turn_allowance ?? 40} ({detail.turns_used ?? 0} used). When it runs out, no new agent turn starts until the owner raises it.</p>
  </section>;
}
