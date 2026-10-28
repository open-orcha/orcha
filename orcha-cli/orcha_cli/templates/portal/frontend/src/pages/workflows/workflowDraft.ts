/** Local form state, NOT an API request schema. Bind only after the generated
 * Workflows contract is available. No create/assign/readiness staging calls. */
export interface DraftTask {
  key: string;
  title: string;
  doneWhen: string;
  description: string;
  assignee: string;
  dependsOn: string[];
  autonomy: false;
  /** Version 2 only: results this step may report and the rule each one follows. */
  outcomes?: DraftOutcome[];
}

export type RouteDestination = "next" | "step" | "return" | "ask_owner" | "exit_group" | "stop";
export interface DraftOutcome { name: string; kind: "success" | "changes" | "failure" | "custom"; destination: RouteDestination; destinationTask?: string }
export interface DraftRepeatGroup { key: string; name: string; members: string[]; review: string; exitOutcome: string; maxRounds: number }

export interface WorkflowDraft {
  name: string;
  goal: string;
  mode: "serial" | "parallel";
  tasks: DraftTask[];
  objectives: { key: string; title: string; criteria: string }[];
  existingTaskIds?: string[];
  /** Version 2 only: bounded repeat-until loops. */
  repeatGroups?: DraftRepeatGroup[];
}

export function emptyDraft(): WorkflowDraft {
  return { name: "", goal: "", mode: "serial", tasks: [], objectives: [] };
}

export function newDraftTask(): DraftTask {
  return { key: crypto.randomUUID(), title: "", doneWhen: "", description: "", assignee: "", dependsOn: [], autonomy: false };
}

/** Duplicate titles get a visible ordinal; opaque draft keys never appear in copy. */
export function draftTaskName(task: DraftTask, tasks: DraftTask[]): string {
  const title = task.title.trim() || "Untitled task";
  const same = tasks.filter((t) => (t.title.trim() || "Untitled task") === title);
  return same.length > 1 ? `${title} (task ${tasks.indexOf(task) + 1})` : title;
}

/** Does candidate already depend on target? Adding target → candidate would cycle. */
export function dependencyReason(tasks: DraftTask[], target: DraftTask, candidate: DraftTask): string | null {
  if (target.key === candidate.key) return "A task cannot depend on itself.";
  if (target.dependsOn.includes(candidate.key)) return null; // selected edges stay removable
  const seen = new Set<string>();
  const visit = (key: string): boolean => {
    if (key === target.key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return (tasks.find((t) => t.key === key)?.dependsOn ?? []).some(visit);
  };
  if (visit(candidate.key)) return `${draftTaskName(candidate, tasks)} already depends on this task.`;
  if (target.dependsOn.length >= 3) return "Remove one dependency to add another.";
  return null;
}

export interface DraftProblem { key: string; message: string }
export function draftProblems(draft: WorkflowDraft): DraftProblem[] {
  const result: DraftProblem[] = [];
  if (!draft.name.trim()) result.push({ key: "name", message: "Name this workflow." });
  if (!draft.goal.trim()) result.push({ key: "goal", message: "Describe the goal of this workflow." });
  for (const objective of draft.objectives) {
    if (!objective.title.trim() || !objective.criteria.trim()) result.push({ key: objective.key, message: "Give each objective a title and completion criteria, or remove it." });
  }
  for (const group of draft.repeatGroups ?? []) {
    const review = draft.tasks.find((t) => t.key === group.review);
    if (!group.name.trim()) result.push({ key: group.key, message: "Name each feedback loop." });
    if (group.members.length < 2) result.push({ key: group.key, message: `${group.name.trim() || "A feedback loop"} needs at least two steps.` });
    else if (!review || !group.members.includes(group.review)) result.push({ key: group.key, message: `${group.name.trim() || "A feedback loop"} needs a review step that is one of its steps.` });
    else if (!(review.outcomes ?? []).some((o) => o.name.trim() === group.exitOutcome)) result.push({ key: group.key, message: `${group.name.trim() || "A feedback loop"} ends on an outcome its review step does not have.` });
  }
  for (const task of draft.tasks) {
    const name = draftTaskName(task, draft.tasks);
    // Outcome names compare without case, as the server does.
    const names = (task.outcomes ?? []).map((o) => o.name.trim().toLowerCase());
    if (names.some((n) => !n) || new Set(names).size !== names.length) result.push({ key: task.key, message: `${name}: give each outcome a different name.` });
    if ((task.outcomes ?? []).some((o) => (o.destination === "step" || o.destination === "return") && !o.destinationTask)) result.push({ key: task.key, message: `${name}: choose where each outcome goes.` });
    // Rules left pointing at a step after a prerequisite or loop change (the server's branch_not_dependent / return_outside_group).
    const loop = (draft.repeatGroups ?? []).find((g) => g.review === task.key);
    for (const o of task.outcomes ?? []) {
      const label = o.name.trim() || "An outcome";
      if (o.destination === "step" && o.destinationTask && !draft.tasks.some((t) => t.key === o.destinationTask && t.dependsOn.includes(task.key))) {
        result.push({ key: task.key, message: `${name}: “${label}” goes to a step that no longer waits for this one. Choose where it goes.` });
      }
      if ((o.destination === "return" || o.destination === "exit_group") && !loop) {
        result.push({ key: task.key, message: `${name}: only a feedback loop’s review step can send work back or end the loop. Choose where “${label}” goes.` });
      } else if (o.destination === "return" && o.destinationTask && (o.destinationTask === task.key || !loop!.members.includes(o.destinationTask))) {
        result.push({ key: task.key, message: `${name}: “${label}” sends work back to a step outside its loop. Choose where it goes.` });
      }
    }
    if (!task.title.trim()) result.push({ key: task.key, message: `Name task ${draft.tasks.indexOf(task) + 1}.` });
    if (task.dependsOn.length > 3 || new Set(task.dependsOn).size !== task.dependsOn.length) {
      result.push({ key: task.key, message: `${name} needs no more than three different dependencies.` });
    }
    const withoutEdges = { ...task, dependsOn: [] };
    for (const key of task.dependsOn) {
      const candidate = draft.tasks.find((t) => t.key === key);
      if (!candidate && !draft.existingTaskIds?.includes(key)) result.push({ key: task.key, message: `${name} refers to a task that is no longer in this draft.` });
      else if (candidate) {
        const reason = dependencyReason(draft.tasks, withoutEdges, candidate);
        if (reason) result.push({ key: task.key, message: `${name}: ${reason}` });
      }
    }
  }
  return result;
}

/** Scope is supplied by the verified identity adapter; no actor-picker authority.
 * Memory lasts for this page session only. It never transfers across connections,
 * projects or identities. Storage persistence can be added with the API adapter. */
export interface DraftScope { origin: string; project: string; identity: string }
const drafts = new Map<string, WorkflowDraft>();
const scopeKey = (scope: DraftScope) => JSON.stringify([scope.origin, scope.project, scope.identity]);
export function readDraft(scope: DraftScope): WorkflowDraft { return drafts.get(scopeKey(scope)) ?? emptyDraft(); }
export function keepDraft(scope: DraftScope, draft: WorkflowDraft): void { drafts.set(scopeKey(scope), draft); }
export function discardDraft(scope: DraftScope): void { drafts.delete(scopeKey(scope)); }
