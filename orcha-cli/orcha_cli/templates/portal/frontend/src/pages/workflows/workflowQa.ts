/**
 * Quality and Triage steps in a workflow draft. A Quality step is still a task: it carries `qa`,
 * reports `pass` or `fail`, and a `fail` goes back to the build step inside a bounded feedback loop,
 * so the fix round receives the findings. A Triage step sits between them: a fail goes to it first,
 * and only what it confirms goes back. Pure draft edits (tested); the server's preview runs the full
 * flow check. On screen the tab's name is Quality; `qa` stays the word on the wire.
 */
import { platformWord } from "../qa/qaWords";
import { requestKindWord } from "../qa/requests/words";
import { prettyAvd } from "../qa/onboarding/device-picker";
import { newDraftTask, draftTaskName, type DraftOutcome, type DraftQaStep, type DraftRepeatGroup, type DraftTask, type RouteDestination, type WorkflowDraft } from "./workflowDraft";

export const PASS_OUTCOME = "pass";
export const FAIL_OUTCOME = "fail";
export const DEFAULT_QA_ROUNDS = 3;

/** The server's "QA", as the tab now names it. */
export const qualityWord = (s: string) => s.replace(/\bQA\b/g, "Quality");

/** Off for now: a new workflow offers no Quality or Triage steps. Steps already in a draft or a
 * saved workflow still show and run. Turn it on to bring the Add buttons back. */
export const QUALITY_IN_WORKFLOWS = false;

/** The word for a step of this kind. */
export const stepKindWord = (q: Pick<DraftQaStep, "kind">) => (q.kind === "triage" ? "Triage step" : "Quality step");

export interface QaStepInput {
  qa: DraftQaStep;
  assignee: string;
  /** The step QA tests: it waits for it, and a failure goes back to it. */
  buildKey: string | null;
  maxRounds: number;
  /** The server supports outcomes and loops. */
  flexible: boolean;
  /** Routes the person changed: outcome name to a `routeChoices` value. */
  routes?: Record<string, string>;
}

/** `qa` on the wire: only what was chosen. */
export function wireQa(q: DraftQaStep) {
  return {
    kind: q.kind,
    ...(q.platform ? { platform: q.platform } : {}),
    ...(q.device ? { device: q.device } : {}),
    ...(q.scenarioIds?.length ? { scenario_ids: q.scenarioIds } : {}),
    ...(q.tags?.length ? { tags: q.tags } : {}),
    ...(q.focus?.trim() ? { focus: q.focus.trim() } : {}),
    ...(q.minutes ? { minutes: q.minutes } : {}),
  };
}

/** "Explore · iOS · 20 min", for a QA step's card. */
export function qaStepWords(q: DraftQaStep): string {
  const picked = q.scenarioIds?.length ? `${q.scenarioIds.length} ${q.scenarioIds.length === 1 ? "scenario" : "scenarios"}` : null;
  const tags = q.tags?.length ? `tagged ${q.tags.join(", ")}` : null;
  return [requestKindWord(q.kind), q.platform ? platformWord(q.platform) : "Default platform", q.device ? prettyAvd(q.device) : null, picked, tags, q.focus?.trim() || null, q.minutes ? `${q.minutes} min` : null].filter(Boolean).join(" · ");
}

function qaTitle(q: DraftQaStep): string {
  const focus = q.focus?.trim();
  return `Quality: ${focus ? (focus.length > 60 ? focus.slice(0, 59).trimEnd() + "…" : focus) : requestKindWord(q.kind).toLowerCase()}`;
}

const QA_DONE = "Quality reports pass or fail, with a screenshot behind each line it checked.";

/** Is `key` free to join a new loop? A step belongs to one loop at most. */
export function inOtherLoop(draft: WorkflowDraft, key: string, ownReview?: string | null): boolean {
  return (draft.repeatGroups ?? []).some((g) => g.review !== ownReview && g.members.includes(key));
}

function loopName(groups: readonly DraftRepeatGroup[]): string {
  const taken = new Set(groups.map((g) => g.name.trim().toLowerCase()));
  for (let i = 1; ; i++) {
    const name = i === 1 ? "Quality loop" : `Quality loop ${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** The step's outcomes and its loop, for the routing the input asks for. */
function routed(draft: WorkflowDraft, key: string, input: QaStepInput): { outcomes?: DraftOutcome[]; group: DraftRepeatGroup | null } {
  if (!input.flexible) return { group: null };
  const build = input.buildKey;
  const canLoop = !!build && !inOtherLoop(draft, build, key);
  const pass: DraftOutcome = { name: PASS_OUTCOME, kind: "success", destination: canLoop ? "exit_group" : "next" };
  const fail: DraftOutcome = canLoop ? { name: FAIL_OUTCOME, kind: "failure", destination: "return", destinationTask: build! } : { name: FAIL_OUTCOME, kind: "failure", destination: "ask_owner" };
  const others = (draft.repeatGroups ?? []).filter((g) => g.review !== key);
  const own = (draft.repeatGroups ?? []).find((g) => g.review === key);
  return {
    outcomes: [pass, fail],
    group: canLoop ? { key: own?.key ?? crypto.randomUUID(), name: own?.name ?? loopName(others), members: own?.members.includes(build!) ? own.members : [build!, key], review: key, exitOutcome: PASS_OUTCOME, maxRounds: input.maxRounds } : null,
  };
}

/** The input's route changes, in order. */
function withRoutes(draft: WorkflowDraft, key: string, input: { routes?: Record<string, string>; maxRounds: number }): WorkflowDraft {
  return Object.entries(input.routes ?? {}).reduce((d, [outcome, value]) => setRoute(d, key, outcome, value, input.maxRounds), draft);
}

export function addQaStep(draft: WorkflowDraft, input: QaStepInput): { draft: WorkflowDraft; key: string } {
  const task: DraftTask = { ...newDraftTask(), title: qaTitle(input.qa), doneWhen: QA_DONE, assignee: input.assignee, dependsOn: input.buildKey ? [input.buildKey] : [], qa: input.qa };
  const { outcomes, group } = routed(draft, task.key, input);
  const groups = [...(draft.repeatGroups ?? []), ...(group ? [group] : [])];
  const next: WorkflowDraft = { ...draft, tasks: [...draft.tasks, { ...task, ...(outcomes ? { outcomes } : {}) }], ...(groups.length ? { repeatGroups: groups } : {}) };
  return { key: task.key, draft: withRoutes(next, task.key, input) };
}

/** The Triage step that diagnoses this Quality step, if it has one. */
export const triageOf = (draft: WorkflowDraft, key: string) => draft.tasks.find((t) => t.qa?.kind === "triage" && t.dependsOn.includes(key)) ?? null;

export function editQaStep(draft: WorkflowDraft, key: string, input: QaStepInput): { draft: WorkflowDraft; key: string } {
  const triage = triageOf(draft, key);
  // A step with Triage after it routes through Triage, and a step in a loop another step reviews
  // (a block's Map, Explore or platform check) keeps that loop's wiring: an edit must not take it apart.
  const reviewedElsewhere = (draft.repeatGroups ?? []).some((g) => g.review !== key && g.members.includes(key));
  const { outcomes, group } = triage || reviewedElsewhere ? { outcomes: undefined, group: null } : routed(draft, key, input);
  const groups = (draft.repeatGroups ?? []).filter((g) => g.review !== key).map((g) => (triage && g.review === triage.key ? { ...g, maxRounds: input.maxRounds } : g));
  const next: WorkflowDraft = {
    ...draft,
    tasks: draft.tasks.map((t) => t.key === key ? { ...t, qa: input.qa, assignee: input.assignee, dependsOn: input.buildKey ? [...new Set([...t.dependsOn, input.buildKey])] : t.dependsOn, ...(outcomes ? { outcomes } : {}) } : t),
    repeatGroups: [...groups, ...(group ? [group] : [])],
  };
  return { key, draft: withRoutes(next, key, input) };
}

export interface TriageStepInput {
  assignee: string;
  /** The Quality step whose failures it diagnoses. */
  qaKey: string;
  maxRounds: number;
  flexible: boolean;
  /** What the run is limited to. Findings come from the Quality step. */
  platform?: DraftQaStep["platform"];
  focus?: string;
  minutes?: number | null;
  routes?: Record<string, string>;
}

/** The Quality steps a Triage step can diagnose. */
export const triageableSteps = (draft: WorkflowDraft) => draft.tasks.filter((t) => t.qa && t.qa.kind !== "triage");

const triageQa = (input: TriageStepInput, fallback: DraftQaStep["platform"]): DraftQaStep => ({
  kind: "triage", platform: input.platform === undefined ? fallback ?? null : input.platform,
  ...(input.focus?.trim() ? { focus: input.focus.trim() } : {}), ...(input.minutes ? { minutes: input.minutes } : {}),
});

/**
 * A Triage step after a Quality step: a fail goes to triage, not straight to a fix. `fix` goes back to
 * the build with only the confirmed findings, `clear` goes on, `needs_person` asks the owner, and a
 * pass skips triage. The loop now covers build, Quality and Triage, with one round limit for all of it.
 */
export function addTriageStep(draft: WorkflowDraft, input: TriageStepInput): { draft: WorkflowDraft; key: string } {
  const qa = draft.tasks.find((t) => t.key === input.qaKey)!;
  const task: DraftTask = { ...newDraftTask(), title: "Triage", doneWhen: "Every finding has a diagnosis.", assignee: input.assignee, dependsOn: [qa.key], qa: triageQa(input, qa.qa?.platform) };
  if (!input.flexible) return { key: task.key, draft: { ...draft, tasks: [...draft.tasks, task] } };
  const group = (draft.repeatGroups ?? []).find((g) => g.review === qa.key);
  const build = group?.members.find((k) => k !== qa.key) ?? qa.dependsOn[0] ?? null;
  const loops = !!group || (!!build && !inOtherLoop(draft, build, qa.key));
  const later = draft.tasks.filter((t) => t.dependsOn.includes(qa.key));
  const outcomes: DraftOutcome[] = [
    loops ? { name: "fix", kind: "changes", destination: "return", destinationTask: build! } : { name: "fix", kind: "changes", destination: "ask_owner" },
    { name: "clear", kind: "success", destination: loops ? "exit_group" : "next" },
    { name: "needs_person", kind: "custom", destination: "ask_owner" },
  ];
  const qaOutcomes: DraftOutcome[] = [
    later[0] ? { name: PASS_OUTCOME, kind: "success", destination: "step", destinationTask: later[0].key } : { name: PASS_OUTCOME, kind: "success", destination: "stop" },
    { name: FAIL_OUTCOME, kind: "failure", destination: "step", destinationTask: task.key },
  ];
  const others = (draft.repeatGroups ?? []).filter((g) => g !== group);
  const loop: DraftRepeatGroup | null = !loops ? null : group
    ? { ...group, members: [...group.members, task.key], review: task.key, exitOutcome: "clear", maxRounds: input.maxRounds }
    : { key: crypto.randomUUID(), name: loopName(others), members: [build!, qa.key, task.key], review: task.key, exitOutcome: "clear", maxRounds: input.maxRounds };
  // What came after QA now also waits for triage, so a `clear` reaches it.
  const tasks = draft.tasks.map((t) => t.key === qa.key ? { ...t, outcomes: qaOutcomes } : later.includes(t) && t.dependsOn.length < 3 ? { ...t, dependsOn: [...t.dependsOn, task.key] } : t);
  const next = { ...draft, tasks: [...tasks, { ...task, outcomes }], repeatGroups: [...others, ...(loop ? [loop] : [])] };
  return { key: task.key, draft: withRoutes(next, task.key, input) };
}

export function editTriageStep(draft: WorkflowDraft, key: string, input: TriageStepInput): { draft: WorkflowDraft; key: string } {
  const step = draft.tasks.find((t) => t.key === key)!;
  const next: WorkflowDraft = {
    ...draft,
    tasks: draft.tasks.map((t) => t.key === key ? { ...t, assignee: input.assignee, qa: triageQa(input, step.qa?.platform) } : t),
    repeatGroups: (draft.repeatGroups ?? []).map((g) => g.review === key ? { ...g, maxRounds: input.maxRounds } : g),
  };
  return { key, draft: withRoutes(next, key, input) };
}

/* ---- where each outcome goes ---------------------------------------------- */

const OUTCOME_WORD: Record<string, string> = { pass: "Passes", fail: "Fails", fix: "Bugs confirmed", clear: "Nothing blocks", needs_person: "A judgement call", blocked: "Could not test" };
const OUTCOME_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = { pass: "ok", clear: "ok", fail: "danger", fix: "danger", needs_person: "warn", blocked: "warn" };

/** A step's outcome in plain words: "Passes", "Bugs confirmed". */
export const outcomeWord = (name: string) => OUTCOME_WORD[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
export const outcomeTone = (name: string) => OUTCOME_TONE[name] ?? "neutral";

export interface RouteChoice { value: string; label: string }
export interface RouteRow { outcome: string; value: string; label: string; choices: RouteChoice[] }

export const routeValue = (o: Pick<DraftOutcome, "destination" | "destinationTask">) => (o.destinationTask ? `${o.destination}:${o.destinationTask}` : o.destination);

/** The build step a Quality or Triage step could send work back to. */
/** Every step that comes before this one. */
export function stepsBefore(draft: WorkflowDraft, key: string): Set<string> {
  const seen = new Set<string>();
  const up = (k: string) => { for (const p of draft.tasks.find((t) => t.key === k)?.dependsOn ?? []) if (!seen.has(p)) { seen.add(p); up(p); } };
  up(key);
  return seen;
}

/** The step a Quality step tests: an ordinary step before it, never one that comes after it (a
 * Map's Coverage summary shares its loop and would make a cycle). */
export function testedBy(draft: WorkflowDraft, key: string): string | null {
  const before = stepsBefore(draft, key);
  const plain = (k: string) => !draft.tasks.find((t) => t.key === k)?.qa;
  const loop = draft.repeatGroups?.find((g) => g.members.includes(key));
  return loop?.members.find((k) => before.has(k) && plain(k)) ?? draft.tasks.find((t) => t.key === key)?.dependsOn[0] ?? null;
}

export function buildOf(draft: WorkflowDraft, task: DraftTask): string | null {
  const own = (draft.repeatGroups ?? []).find((g) => g.members.includes(task.key));
  if (own) return own.members.find((k) => !draft.tasks.find((t) => t.key === k)?.qa) ?? null;
  const up = (key: string): string | null => {
    const t = draft.tasks.find((x) => x.key === key);
    if (!t) return null;
    if (!t.qa) return key;
    for (const p of t.dependsOn) { const found = up(p); if (found) return found; }
    return null;
  };
  return up(task.key);
}

/**
 * Where one outcome of a Quality or Triage step can go, as the server allows it: only a loop's review
 * step sends work back or ends the loop, a branch leads to a step that waits for this one, and the
 * outcome that ends a loop must lead out of it.
 */
export function routeChoices(draft: WorkflowDraft, key: string, outcome: string, ownerName?: string): RouteChoice[] {
  const task = draft.tasks.find((t) => t.key === key);
  if (!task) return [];
  const name = (k: string) => draftTaskName(draft.tasks.find((t) => t.key === k)!, draft.tasks);
  const review = (draft.repeatGroups ?? []).find((g) => g.review === key);
  const inLoop = (draft.repeatGroups ?? []).some((g) => g.members.includes(key));
  const dependents = draft.tasks.filter((t) => t.dependsOn.includes(key));
  const ends = review?.exitOutcome === outcome;
  const out: RouteChoice[] = [];
  if (review) out.push({ value: "exit_group", label: "The loop ends and the next steps proceed" });
  else if (!triageOf(draft, key)) out.push({ value: "next", label: "The next steps proceed" });
  for (const t of dependents) out.push({ value: `step:${t.key}`, label: `Go to ${name(t.key)}` });
  if (!ends) {
    const with_ = task.qa?.kind === "triage" ? "with only the confirmed findings" : "with the findings";
    const build = buildOf(draft, task);
    const targets = review ? review.members.filter((k) => k !== key && !draft.tasks.find((t) => t.key === k)?.qa) : build && !inLoop ? [build] : [];
    for (const k of targets) out.push({ value: `return:${k}`, label: `Back to ${name(k)} ${with_}` });
    out.push({ value: "ask_owner", label: ownerName ? `Stop and ask ${ownerName}` : "Stop and ask the owner" });
  }
  out.push({ value: "stop", label: "End here: later steps are not needed" });
  return out;
}

/** Each outcome of a Quality or Triage step, where it goes now and where else it can go. */
export function routeRows(draft: WorkflowDraft, key: string, ownerName?: string): RouteRow[] {
  const task = draft.tasks.find((t) => t.key === key);
  return (task?.outcomes ?? []).map((o) => {
    const value = routeValue(o);
    const offered = routeChoices(draft, key, o.name, ownerName);
    // A block's own way back can lead to a Quality step, which no menu offers: it stays what it is.
    const to = o.destination === "return" ? draft.tasks.find((t) => t.key === o.destinationTask) : null;
    const kept = to && !offered.some((c) => c.value === value) ? { value, label: `Back to ${draftTaskName(to, draft.tasks)}` } : null;
    const choices = kept ? [kept, ...offered] : offered;
    return { outcome: o.name, value, label: choices.find((c) => c.value === value)?.label ?? "Choose where this goes", choices };
  });
}

/** The steps from `from` up to `to`, following what each one waits for. */
export function chain(tasks: readonly DraftTask[], from: string, to: string): string[] {
  const walk = (key: string, seen: string[]): string[] | null => {
    if (key === from) return [key, ...seen];
    for (const p of tasks.find((t) => t.key === key)?.dependsOn ?? []) {
      if (seen.includes(p)) continue;
      const found = walk(p, [key, ...seen]);
      if (found) return found;
    }
    return null;
  };
  return walk(to, []) ?? [from, to];
}

/**
 * Change where one outcome goes, and keep the draft's loop true to it: the last way back removes the
 * loop, and a first way back makes one, with `maxRounds`.
 */
export function setRoute(draft: WorkflowDraft, key: string, outcome: string, value: string, maxRounds = DEFAULT_QA_ROUNDS): WorkflowDraft {
  const task = draft.tasks.find((t) => t.key === key);
  if (!task?.outcomes?.some((o) => o.name === outcome)) return draft;
  const [destination, destinationTask] = value.split(":") as [RouteDestination, string | undefined];
  let outcomes = task.outcomes.map((o) => (o.name === outcome ? { name: o.name, kind: o.kind, destination, ...(destinationTask ? { destinationTask } : {}) } : o));
  let groups = draft.repeatGroups ?? [];
  const own = groups.find((g) => g.review === key);
  const back = outcomes.find((o) => o.destination === "return");
  if (own && !back) {
    groups = groups.filter((g) => g !== own);
    outcomes = outcomes.map((o) => (o.destination === "exit_group" ? { name: o.name, kind: o.kind, destination: "next" as const } : o));
  } else if (!own && back?.destinationTask) {
    const exit = outcomes.find((o) => o.kind === "success")?.name ?? "";
    outcomes = outcomes.map((o) => (o.name === exit ? { name: o.name, kind: o.kind, destination: "exit_group" as const } : o));
    groups = [...groups, { key: crypto.randomUUID(), name: loopName(groups), members: chain(draft.tasks, back.destinationTask, key), review: key, exitOutcome: exit, maxRounds }];
  }
  return { ...draft, tasks: draft.tasks.map((t) => (t.key === key ? { ...t, outcomes } : t)), repeatGroups: groups };
}

/** Remove a step; a loop it reviewed goes too, since nothing can send work back any more. */
export function removeStep(draft: WorkflowDraft, key: string): WorkflowDraft {
  const owned = (draft.repeatGroups ?? []).find((g) => g.review === key);
  const dropLoop = !!owned && !!draft.tasks.find((t) => t.key === key)?.qa;
  const left = draft.tasks.filter((t) => t.key !== key);
  return {
    ...draft,
    tasks: left.map((t) => ({ ...t, outcomes: t.outcomes?.map((o) => o.destinationTask === key || (dropLoop && o.destination === "exit_group") ? { name: o.name, kind: o.kind, destination: "next" as const } : o) })),
    repeatGroups: (draft.repeatGroups ?? []).filter((g) => !(dropLoop && g === owned)).map((g) => ({ ...g, members: g.members.filter((k) => k !== key), ...(g.review === key ? { review: "", exitOutcome: "" } : {}) })),
  };
}

/** The ways back to an earlier step: a draft's arrows on the graph. */
export function draftReturns(task: DraftTask, tasks: readonly DraftTask[]): { to: string; label: string }[] {
  return (task.outcomes ?? []).filter((o) => o.destination === "return" && o.destinationTask).map((o) => ({
    to: o.destinationTask!, label: `${outcomeWord(o.name)}: back to ${tasks.find((t) => t.key === o.destinationTask)?.title.trim() || "the build"}`,
  }));
}

const wireList = <T,>(v: unknown) => (Array.isArray(v) ? v as T[] : []);

/**
 * A wire draft's steps and loops in this editor's terms, with `key` turning its keys into the draft's.
 * `quality` fills a Quality or Triage step the server left open, `build` the other steps.
 */
export function readWireSteps(wire: Record<string, unknown>, key: (k: string) => string, assignees: { quality?: string; build?: string } = {}): { tasks: DraftTask[]; groups: DraftRepeatGroup[] } {
  const list = wireList;
  const rawTasks = list<Record<string, unknown>>(wire.tasks);
  const tasks: DraftTask[] = rawTasks.map((t) => {
    const routes = list<{ outcome: string; destination: DraftOutcome["destination"]; destination_task?: string | null }>(t.routes);
    const outcomes = list<{ name: string; kind: DraftOutcome["kind"] }>(t.outcomes).map((o) => {
      const r = routes.find((x) => x.outcome === o.name);
      return { name: o.name, kind: o.kind, destination: r?.destination ?? "next", ...(r?.destination_task ? { destinationTask: key(String(r.destination_task)) } : {}) };
    });
    const q = t.qa as { kind: DraftQaStep["kind"]; platform?: DraftQaStep["platform"]; device?: string | null; scenario_ids?: string[]; tags?: string[]; focus?: string | null; minutes?: number | null } | null | undefined;
    return {
      key: key(String(t.client_key)), title: qualityWord(String(t.title ?? "")), doneWhen: qualityWord(String(t.definition_of_done ?? "")), description: String(t.description ?? ""),
      assignee: String(t.assignee_id ?? ((q ? assignees.quality : assignees.build) ?? "")), dependsOn: list<string>(t.depends_on).map((d) => key(String(d))), autonomy: false,
      ...(outcomes.length ? { outcomes } : {}),
      ...(q ? { qa: { kind: q.kind, platform: q.platform ?? null, device: q.device ?? null, scenarioIds: q.scenario_ids ?? [], tags: q.tags ?? [], focus: q.focus ?? "", minutes: q.minutes ?? null } } : {}),
    };
  });
  const groups: DraftRepeatGroup[] = list<{ name: string; member_tasks: string[]; review_task: string; exit_outcome: string; max_rounds: number }>(wire.repeat_groups).map((g) => ({
    key: crypto.randomUUID(), name: qualityWord(g.name), members: g.member_tasks.map(key), review: key(g.review_task), exitOutcome: g.exit_outcome, maxRounds: g.max_rounds,
  }));
  return { tasks, groups };
}
