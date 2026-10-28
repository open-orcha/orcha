/**
 * Expected route in the Start review (issue #362 screen 2, frame x02): each feedback loop with its
 * steps, exit rule, round limit and stall rule, every outcome rule that does not simply continue,
 * and the agent-turn allowance for this run. Shown only for flexible (semantics 2) workflows.
 */
import { Badge } from "../../components/primitives";
import type { StepRoute, WorkflowDetail } from "./workflowContract.generated";

export const ROUTE_LABELS: Record<StepRoute["destination"], string> = {
  next: "the next steps proceed", step: "goes to", return: "goes back to", ask_owner: "the owner decides what happens next",
  exit_group: "the loop ends", stop: "the workflow stops here",
};

const ARROWS: Record<StepRoute["destination"], string> = { next: "→", step: "→", return: "↺", ask_owner: "→", exit_group: "→", stop: "■" };

export function WorkflowRouteSummary({ detail }: { detail: WorkflowDetail }) {
  if (detail.semantics_version !== 2) return null;
  const title = (id?: string | null) => detail.tasks.find((t) => t.id === id)?.title ?? "a removed step";
  const groups = detail.repeat_groups ?? [];
  const steps = detail.tasks.filter((t) => !t.withdrawn_at);
  const number = (id: string) => steps.findIndex((t) => t.id === id) + 1;
  const rules = steps.flatMap((t) => (t.routes ?? [])
    .filter((r) => r.destination !== "next").map((r) => ({ task: t, route: r })));
  const stops = rules.filter(({ route }) => route.destination === "ask_owner" || route.destination === "stop");
  const allowance = detail.turn_allowance ?? 40;
  const most = groups.length ? Math.max(...groups.map((g) => g.max_rounds)) : 0;
  return <section className="wf-route-summary" aria-label="Expected route">
    <div className="wf-impact">
      <div className="wf-impact-h"><span>Expected route</span><span>{steps.length} {steps.length === 1 ? "step" : "steps"} · {groups.length} repeat {groups.length === 1 ? "group" : "groups"}</span></div>
      {!groups.length && !rules.length && <div className="wf-impact-row"><span className="t">Steps run in prerequisite order. No step changes the route.</span></div>}
      {groups.map((g) => <div key={g.id} className="wf-impact-row"><span className="t">{g.member_tasks.map((id) => `${number(id) || ""} ${title(id)}`.trim()).join(" → ")}, repeated until {title(g.review_task)} reports “{g.exit_outcome}”, at most {g.max_rounds} {g.max_rounds === 1 ? "round" : "rounds"}{g.stall_rule !== "off" ? "; pauses if a round brings back the same findings on unchanged work" : ""}</span><Badge tone="accent">Loop</Badge></div>)}
      {rules.filter(({ route }) => route.destination !== "ask_owner" && route.destination !== "stop").map(({ task, route }) => <div key={`${task.id}:${route.outcome}`} className="wf-impact-row">
        <span className="t">{task.title}: “{route.outcome}” {ARROWS[route.destination]} {route.destination_task ? title(route.destination_task) : ROUTE_LABELS[route.destination]}{route.destination === "return" ? ", a new round" : ""}</span>
        <Badge tone="neutral">{route.destination === "return" ? "Returns" : route.destination === "exit_group" ? "Exits loop" : "Route"}</Badge></div>)}
      <div className="wf-impact-row"><span className="t">{[...stops.map(({ task, route }) => `${task.title} reporting “${route.outcome}”`),
        ...(groups.length ? ["the last round still asking for changes"] : []), ...(groups.some((g) => g.stall_rule !== "off") ? ["a stalled loop"] : []), "the agent-turn allowance used up"].join(", ").replace(/, ([^,]*)$/, " or $1")} → waits for the owner; no new attempt starts</span><Badge tone="warn">Stops and asks</Badge></div>
    </div>
    <div className="wf-impact">
      <div className="wf-impact-h"><span>Limits</span><span>bounded automated work</span></div>
      <div className="wf-impact-row"><span className="t">{groups.length ? `Rounds: ${most} including the first · ` : ""}Agent-turn allowance for this run: {allowance} ({detail.turns_used ?? 0} used). When it runs out, no new agent turn starts until the owner raises it, reassigns, changes the scope or stops.</span></div>
      <div className="wf-impact-row"><span className="t">Project and agent budgets still apply. A reached limit never counts as success.</span></div>
    </div>
    <div className="wf-impact">
      <div className="wf-impact-h"><span>Incomplete settings</span><span>none</span></div>
      <div className="wf-impact-row"><span className="t">Every outcome has a destination{groups.length ? " and every loop has a round limit" : ""}. Orcha checked this when the workflow was saved.</span></div>
    </div>
  </section>;
}
