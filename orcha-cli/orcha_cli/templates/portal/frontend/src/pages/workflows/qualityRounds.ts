/**
 * The story of a workflow's Quality loop, read from its requests and steps: each round, how it ended,
 * and when it went back, why. Pure (tested). The route of an outcome applies when a person accepts
 * the step, so a result that has not been accepted yet says "goes back", never "went back".
 */
import type { QaRequest } from "../qa/requests/api";
import { isOpenRequest, roundsOf } from "../qa/requests/model";
import { plural } from "../qa/qaWords";
import { decisionOf } from "../qa/triage/words";
import type { StepRoute, WorkflowDetail, WorkflowTask } from "./workflowContract.generated";
import { outcomeWord } from "./workflowQa";

export type RoundState = "running" | "waiting" | "back" | "passed" | "clear" | "person" | "blocked" | "cancelled";

export interface RoundFinding { id: string; title: string; severity: string | null; rate: string | null; rootCause: string | null }

export interface QualityRound {
  round: number;
  quality: QaRequest | null;
  triage: QaRequest | null;
  /** The step this round is waiting on or ended at. */
  stepId: string | null;
  state: RoundState;
  /** "Triage confirmed 1 of 3 findings". */
  headline: string;
  /** "Went back to Build", "Goes back to Build when a person accepts Triage". */
  next: string | null;
  backTo: { id: string; title: string } | null;
  /** What went back, or what stands in the way. */
  findings: RoundFinding[];
}

const TERMINAL: Partial<Record<QaRequest["status"], RoundState>> = { blocked: "blocked", cancelled: "cancelled" };

function outcomeOf(r: QaRequest): string | null {
  if (r.kind === "triage") return decisionOf(r.result, r.status);
  return r.status === "passed" ? "pass" : r.status === "failed" ? "fail" : null;
}

function confirmed(r: QaRequest): RoundFinding[] {
  const ids = r.result?.confirmed_ids ?? [];
  return (r.result?.diagnoses ?? []).filter((d) => ids.includes(d.id)).map((d) => ({ id: d.id, title: d.title, severity: d.severity, rate: d.rate, rootCause: d.root_cause }));
}

const found = (r: QaRequest): RoundFinding[] => (r.result?.findings ?? []).map((f) => ({ id: f.id, title: f.title, severity: f.severity, rate: null, rootCause: null }));

/** Applied once a later round began, once the step itself moved past this round (the server clears
 * what it reported when work goes back), or once a person accepted it. */
function isApplied(step: WorkflowTask | undefined, outcome: string | null, later: boolean, round: number): boolean {
  if (later || (step?.round ?? 0) > round) return true;
  const reported = step?.reported_outcome;
  return !!reported?.applied && reported.outcome === outcome;
}

function routeWords(route: StepRoute | undefined, applied: boolean, step: WorkflowTask | undefined, title: (id?: string | null) => string): { next: string | null; backTo: QualityRound["backTo"]; state: RoundState | null } {
  if (!route || !step) return { next: null, backTo: null, state: null };
  const accept = `when a person accepts ${step.title}`;
  if (route.destination === "return" && route.destination_task) {
    const name = title(route.destination_task);
    return { next: applied ? `Went back to ${name}` : `Goes back to ${name} ${accept}`, backTo: { id: route.destination_task, title: name }, state: applied ? "back" : "waiting" };
  }
  if (route.destination === "step" && route.destination_task) return { next: applied ? `Went on to ${title(route.destination_task)}` : `Goes to ${title(route.destination_task)} ${accept}`, backTo: null, state: applied ? null : "waiting" };
  if (route.destination === "ask_owner") return { next: "The owner decides what happens next", backTo: null, state: "person" };
  if (route.destination === "stop") return { next: applied ? "The workflow stopped here" : `The workflow stops here ${accept}`, backTo: null, state: applied ? null : "waiting" };
  return { next: applied ? "The next steps went on" : `The next steps go on ${accept}`, backTo: null, state: applied ? null : "waiting" };
}

/** The workflow's rounds, first to last. Empty when it has no Quality work yet. */
/** Why it could not test, in the agent's first sentence, so nobody has to open the run to find out. */
function blockedHeadline(r: QaRequest): string {
  const note = r.result?.lines?.find((l) => l.verdict === "blocked")?.note?.trim();
  const first = note?.split(/(?<=\.)\s/)[0]?.replace(/\.$/, "");
  return first ? `Quality could not test it: ${first}` : "Quality could not test it";
}

export function qualityRounds(detail: Pick<WorkflowDetail, "tasks">, requests: readonly QaRequest[]): QualityRound[] {
  const task = (id?: string | null) => detail.tasks.find((t) => t.id === id);
  const title = (id?: string | null) => task(id)?.title ?? "a removed step";
  const byRound = new Map<number, QaRequest[]>();
  for (const r of roundsOf(requests)) byRound.set(r.round, [...(byRound.get(r.round) ?? []), r]);
  const numbers = [...byRound.keys()].sort((a, b) => a - b);
  return numbers.map((round, i) => {
    const rows = byRound.get(round)!;
    const quality = rows.filter((r) => r.kind !== "triage").at(-1) ?? null;
    const triage = rows.filter((r) => r.kind === "triage").at(-1) ?? null;
    const last = triage ?? quality!;
    const step = task(last.source_task_id);
    const later = i < numbers.length - 1;
    const base = { round, quality, triage, stepId: step?.id ?? null };
    if (isOpenRequest(last) && step?.awaiting_owner_decision) return { ...base, state: "person" as const, headline: `Stopped. ${step.title} waits for the owner: open it to retry, or change the path`, next: null, backTo: null, findings: [] };
    if (isOpenRequest(last)) return { ...base, state: "running" as const, headline: `${last.kind === "triage" ? "Triage" : "Quality"} is ${last.status === "running" ? "running" : step?.status === "in_progress" ? "getting ready" : "waiting to start"}`, next: null, backTo: null, findings: [] };
    const terminal = TERMINAL[last.status];
    if (last.kind !== "triage" && terminal) return { ...base, state: terminal, headline: terminal === "blocked" ? blockedHeadline(last) : "Quality was cancelled", next: null, backTo: null, findings: [] };
    const outcome = outcomeOf(last);
    const route = step?.routes?.find((r) => r.outcome === outcome);
    const applied = isApplied(step, outcome, later, round);
    const words = routeWords(route, applied, step, title);
    if (last.kind === "triage") {
      const all = last.result?.diagnoses.length ?? 0;
      if (outcome === "fix") {
        const rows2 = confirmed(last);
        return { ...base, ...words, state: words.state ?? "back", headline: `Triage confirmed ${rows2.length} of ${plural(all, "finding")}`, findings: rows2 };
      }
      if (outcome === "clear") return { ...base, ...words, state: words.state === "waiting" ? "waiting" as const : "clear" as const, backTo: null, headline: "Triage found nothing that blocks", findings: [] };
      return { ...base, ...words, state: "person" as const, backTo: null, headline: "Triage needs a person to decide", next: words.next, findings: [] };
    }
    if (outcome === "fail") {
      const rows2 = found(last);
      return { ...base, ...words, state: words.state ?? "back", headline: `Quality failed with ${plural(rows2.length, "finding")}`, findings: rows2 };
    }
    return { ...base, ...words, state: words.state === "waiting" ? "waiting" as const : "passed" as const, backTo: null, headline: "Quality passed", findings: [] };
  });
}

/** The one line a person reads first. */
export function roundsHeadline(rounds: readonly QualityRound[]): string | null {
  const latest = rounds.at(-1);
  if (!latest) return null;
  const back = [...rounds].reverse().find((r) => r.state === "back" || (r.state === "waiting" && r.backTo));
  if (latest.next) return `${latest.headline}. ${latest.next}.`;
  if (back && latest.round > back.round && latest.state === "running") return `Round ${latest.round}: ${lower(latest.headline)}, after round ${back.round} ${lower(back.next ?? "went back")}.`;
  return `${latest.headline}.`;
}

const lower = (s: string) => (/^(Triage|Quality)\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** A step's ways back on the graph; the one a round really took stands out. */
export function graphReturns(task: WorkflowTask, tasks: readonly WorkflowTask[], rounds: readonly QualityRound[]): { to: string; label: string; active: boolean }[] {
  const settled = ["passed", "clear"].includes(rounds.at(-1)?.state ?? "");
  return (task.routes ?? []).filter((r) => r.destination === "return" && r.destination_task).map((r) => {
    const took = [...rounds].reverse().find((x) => x.stepId === task.id && x.backTo?.id === r.destination_task && (x.state === "back" || x.state === "waiting"));
    const name = tasks.find((t) => t.id === r.destination_task)?.title ?? "the build";
    return took
      ? { to: r.destination_task!, active: !settled, label: `Round ${took.round}: ${plural(took.findings.length, took.triage ? "confirmed finding" : "finding")} ${took.state === "back" ? "went back" : "to go back"}` }
      : { to: r.destination_task!, active: false, label: `${outcomeWord(r.outcome)}: back to ${name}` };
  });
}
