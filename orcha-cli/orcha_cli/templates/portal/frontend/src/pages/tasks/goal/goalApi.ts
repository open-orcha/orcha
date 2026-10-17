/**
 * Goal ancestry — data layer for the "Project objective → parent(s) → this task"
 * breadcrumb. Contract (backend portal_backend/goal_ancestry*.py, see /openapi.json):
 *
 *   GET /api/tasks/{tid}/goal-chain → { task_id, goal_chain: GoalNode[], truncated, cycle }
 *   PUT /api/tasks/{tid}/parent {parent_task_id: uuid|null, actor_agent_id}
 *       → same shape + parent_task_id
 *
 * Nodes are ordered top-down: the objective first, this task last. Every node is
 * a stored fact (no inferred parents): see the backend module docstring.
 */
import { getJSON, sendJSON } from "../../../api/client";
import type { Task } from "../../../types";

export type GoalNodeKind = "objective" | "parent" | "task";

export interface GoalNode {
  kind: GoalNodeKind;
  id: string | null;
  title: string;
  /** objective only: the stated objective, null when the project has none */
  text?: string | null;
  source?: "project_description" | "root_task" | null;
  status?: string | null;
  /** parent only: explicit link, or derived from the task request that spawned the child */
  via?: "parent_link" | "task_request" | null;
  request_id?: string | null;
}

export interface GoalChain {
  task_id: string;
  goal_chain: GoalNode[];
  truncated: boolean;
  cycle: boolean;
  parent_task_id?: string | null;
}

const enc = encodeURIComponent;

export function fetchGoalChain(tid: string, signal?: AbortSignal): Promise<GoalChain> {
  return getJSON<GoalChain>("/api/tasks/" + enc(tid) + "/goal-chain", signal);
}

export function putTaskParent(tid: string, parentId: string | null, actorId: string): Promise<GoalChain> {
  return sendJSON<GoalChain>("PUT", "/api/tasks/" + enc(tid) + "/parent", {
    parent_task_id: parentId,
    actor_agent_id: actorId,
  });
}

export function objectiveOf(chain: GoalChain | null): GoalNode | null {
  return chain?.goal_chain.find((n) => n.kind === "objective") ?? null;
}

export function parentsOf(chain: GoalChain | null): GoalNode[] {
  return chain ? chain.goal_chain.filter((n) => n.kind === "parent") : [];
}

/** The nearest parent (the one right above this task), or null. */
export function directParent(chain: GoalChain | null): GoalNode | null {
  const ps = parentsOf(chain);
  return ps.length ? ps[ps.length - 1] : null;
}

/** Plain-text chain, e.g. for the breadcrumb's accessible summary / tooltips. */
export function chainText(chain: GoalChain | null): string {
  if (!chain) return "";
  return chain.goal_chain
    .map((n) =>
      n.kind === "objective"
        ? n.text
          ? "Objective: " + n.text
          : (n.title ? n.title + " — " : "") + "no objective set"
        : n.kind === "parent"
          ? "Parent: " + n.title
          : "This task: " + n.title,
    )
    .join(" → ");
}

export function viaLabel(n: GoalNode): string {
  if (n.via === "task_request") return "Parent task — this task was spawned from a task request raised while working on it";
  return "Parent task";
}

/**
 * Tasks offered as a new parent: same project (the snapshot is project-scoped),
 * never the root (it is the objective) and never this task. Descendants are not
 * filtered client-side — the server is the authority on cycles (409, surfaced as
 * a toast). Open work first, then by title.
 */
export function parentCandidates(tasks: Task[] | undefined, taskId: string, query: string): Task[] {
  const q = query.trim().toLowerCase();
  const rank = (s: string) => (["completed", "cancelled"].includes(s) ? 1 : 0);
  return (tasks ?? [])
    .filter((t) => !t.is_root && t.id !== taskId)
    .filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().startsWith(q))
    .sort((a, b) => rank(a.status) - rank(b.status) || a.title.localeCompare(b.title));
}

export function clip(text: string, n: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}
