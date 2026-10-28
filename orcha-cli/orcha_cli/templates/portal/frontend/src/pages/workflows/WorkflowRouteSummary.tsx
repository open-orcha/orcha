/**
 * Expected route in the Start review (issue #362 screen 2, frame x02): each feedback loop with its
 * steps, exit rule, round limit and stall rule, every outcome rule that does not simply continue,
 * and the agent-turn allowance for this run. Shown only for flexible (semantics 2) workflows.
 */
import { Badge } from "../../components/primitives";
import type { StepRoute, WorkflowDetail, WorkflowTask } from "./workflowContract.generated";

export const ROUTE_LABELS: Record<StepRoute["destination"], string> = {
  next: "the next steps proceed", step: "goes to", return: "goes back to", ask_owner: "the owner decides what happens next",
  exit_group: "the loop ends", stop: "the workflow stops here",
};

const ARROWS: Record<StepRoute["destination"], string> = { next: "→", step: "→", return: "↺", ask_owner: "→", exit_group: "→", stop: "■" };

/** The route rows alone (#362 x02 first panel, and the Route tab in x07): each loop, every
 * outcome rule that changes the route, and what stops and asks the owner. */
export function WorkflowRoutePanel({ detail, heading = "Expected route" }: { detail: WorkflowDetail; heading?: string }) {
  if (detail.semantics_version !== 2) return null;
  const title = (id?: string | null) => detail.tasks.find((t) => t.id === id)?.title ?? "a removed step";
  const groups = detail.repeat_groups ?? [];
  const steps = detail.tasks.filter((t) => !t.withdrawn_at);
  const number = (id: string) => steps.findIndex((t) => t.id === id) + 1;
  const rules = steps.flatMap((t) => (t.routes ?? [])
    .filter((r) => r.destination !== "next").map((r) => ({ task: t, route: r })));
  const stops = rules.filter(({ route }) => route.destination === "ask_owner" || route.destination === "stop");
  return <>
    <div className="wf-impact">
      <div className="wf-impact-h"><span>{heading}</span><span>{steps.length} {steps.length === 1 ? "step" : "steps"} · {groups.length} repeat {groups.length === 1 ? "group" : "groups"}</span></div>
      {!groups.length && !rules.length && <div className="wf-impact-row"><span className="t">Steps run in prerequisite order. No step changes the route.</span></div>}
      {groups.map((g) => <div key={g.id} className="wf-impact-row"><span className="t">{g.member_tasks.map((id) => `${number(id) || ""} ${title(id)}`.trim()).join(" → ")}, repeated until {title(g.review_task)} reports “{g.exit_outcome}”, at most {g.max_rounds} {g.max_rounds === 1 ? "round" : "rounds"}{g.stall_rule !== "off" ? "; pauses if a round brings back the same findings on unchanged work" : ""}</span><Badge tone="accent">Loop</Badge></div>)}
      {rules.filter(({ route }) => route.destination !== "ask_owner" && route.destination !== "stop").map(({ task, route }) => <div key={`${task.id}:${route.outcome}`} className="wf-impact-row">
        <span className="t">{task.title}: “{route.outcome}” {ARROWS[route.destination]} {route.destination_task ? title(route.destination_task) : ROUTE_LABELS[route.destination]}{route.destination === "return" ? ", a new round" : ""}</span>
        <Badge tone="neutral">{route.destination === "return" ? "Returns" : route.destination === "exit_group" ? "Exits loop" : "Route"}</Badge></div>)}
      <div className="wf-impact-row"><span className="t">{[...stops.map(({ task, route }) => `${task.title} reporting “${route.outcome}”`),
        ...(groups.length ? ["the last round still asking for changes"] : []), ...(groups.some((g) => g.stall_rule !== "off") ? ["a stalled loop"] : []), "the agent-turn allowance used up"].join(", ").replace(/, ([^,]*)$/, " or $1")} → waits for the owner; no new attempt starts</span><Badge tone="warn">Stops and asks</Badge></div>
    </div>
  </>;
}

export function WorkflowRouteSummary({ detail }: { detail: WorkflowDetail }) {
  if (detail.semantics_version !== 2) return null;
  const groups = detail.repeat_groups ?? [];
  const allowance = detail.turn_allowance ?? 40;
  const most = groups.length ? Math.max(...groups.map((g) => g.max_rounds)) : 0;
  return <section className="wf-route-summary" aria-label="Expected route">
    <WorkflowRoutePanel detail={detail} />
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

/** The step whose reported outcome chose the path through `task` (#362 x07): the nearest
 * prerequisite, direct or not, that reported an applied outcome and has rules. */
export function pathDecider(detail: WorkflowDetail, task: WorkflowTask): WorkflowTask | null {
  const byId = new Map(detail.tasks.map((t) => [t.id, t]));
  const seen = new Set<string>(); let frontier = [...task.depends_on];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue; seen.add(id);
      const t = byId.get(id); if (!t) continue;
      if (t.reported_outcome?.applied && (t.routes ?? []).some((r) => r.destination !== "next")) return t;
      next.push(...t.depends_on);
    }
    frontier = next;
  }
  return null;
}

/** "Why this path" in the task inspector (#362 x07): the deciding step, its outcome, its rules,
 * the steps not selected and how the choice can change. */
export function WorkflowWhyPath({ detail, task }: { detail: WorkflowDetail; task: WorkflowTask }) {
  if (detail.semantics_version !== 2) return null;
  const decider = pathDecider(detail, task);
  if (!decider?.reported_outcome) return null;
  const title = (id?: string | null) => detail.tasks.find((t) => t.id === id)?.title ?? "a removed step";
  const skipped = detail.tasks.filter((t) => t.route_state === "not_selected");
  return <section className="v2-section wf-why" aria-label="Why this path">
    <div className="v2-section-h"><h3 className="v2-section-title">Why this path</h3></div>
    <dl className="wf-kv">
      <dt>Deciding step</dt><dd>{decider.title}</dd>
      <dt>Outcome</dt><dd><Badge tone="ok">{decider.reported_outcome.outcome}</Badge></dd>
      <dt>Rule</dt><dd>{(decider.routes ?? []).map((r) => <div key={r.outcome}>{r.outcome} {ARROWS[r.destination]} {r.destination_task ? title(r.destination_task) : ROUTE_LABELS[r.destination]}</div>)}</dd>
      {skipped.length > 0 && <><dt>Not selected</dt><dd>{skipped.map((t) => t.title).join(", ")} · neither failed nor accepted</dd></>}
      <dt>Can it change?</dt><dd>Only an owner override, recorded beside the original outcome.</dd>
    </dl>
  </section>;
}
