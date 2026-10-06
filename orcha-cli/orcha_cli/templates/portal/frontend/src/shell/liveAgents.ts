/**
 * Live-agent preview for the sidebar (and the desktop host's `liveAgents`
 * message): AI agents only, most active first — working / running first, then
 * most recent `last_active`. Status is the agent's REAL status; the task is
 * the current task title or null (rendered "idle"); `stale` is set only when
 * the last activity is older than 2 minutes. No branch/worktree is invented.
 */
import type { Agent, Snapshot } from "../types";
import type { RemoteLiveAgent } from "../state/projects";

export const LIVE_STALE_MS = 2 * 60_000;

export interface LiveAgent {
  alias: string;
  status: string;
  task: string | null;
  updatedAt: string | null;
  stale: boolean;
  model: string | null;
  agent: Agent;
}

/** VD-09: the SAME "working" rule as pages/agents/presence.ts — a running
 *  worker run (the snapshot's `active_run` OR `running_run`, even when its lease
 *  has lapsed) or a working status. The roster, board and sidebar must agree. */
export function isActive(a: Agent): boolean {
  const run = (a as Agent & { running_run?: unknown }).running_run;
  return a.active_run != null || run != null || a.status === "working" || a.status === "in_progress";
}

export function liveAgents(snap: Snapshot | null, cap = 5, now = Date.now()): LiveAgent[] {
  const ai = (snap?.agents ?? []).filter((a) => a.kind !== "human" && a.status !== "terminated");
  const t = (a: Agent) => {
    const n = a.last_active ? Date.parse(a.last_active) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  return ai
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || t(b) - t(a) || a.alias.localeCompare(b.alias))
    .slice(0, cap)
    .map((a) => {
      const last = t(a);
      return {
        alias: a.alias,
        status: a.status || "unknown",
        // a task only for an agent actually working on it; the active run's
        // task wins over the (possibly lagging) current_task
        task: isActive(a) ? a.active_run?.task_title || (a as Agent & { running_run?: { task_title?: string | null } | null }).running_run?.task_title || a.current_task?.title || null : null,
        updatedAt: a.last_active,
        stale: last > 0 && now - last > LIVE_STALE_MS,
        model: a.model,
        agent: a,
      };
    });
}

export function aiAgentCount(snap: Snapshot | null): number {
  return (snap?.agents ?? []).filter((a) => a.kind !== "human" && a.status !== "terminated").length;
}

/* ---- D11: live agents nested under their project row ---------------------- */
const NEEDS_REVIEW = new Set(["awaiting_human", "needs_verification"]);
const TROUBLE = new Set(["blocked", "failed", "error"]);

export type ProjectAgentState = "working" | "review" | "trouble";

export interface ProjectAgentRow {
  alias: string;
  status: string;
  state: ProjectAgentState;
  /** ONE short muted fragment: task title · "needs review" · status · age */
  fragment: string;
  agent: Agent;
}

/**
 * The agents worth showing under a project row: working, needing review, or
 * blocked / failed — never idle ones. Working first, then review, then
 * trouble; most recent first within each. `more` = how many were cut by `cap`.
 */
export function projectAgents(
  snap: Snapshot | null, cap = 3, ago: (iso: string) => string = () => "", now = Date.now(),
): { rows: ProjectAgentRow[]; more: number } {
  const t = (a: Agent) => {
    const n = a.last_active ? Date.parse(a.last_active) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  const rank: Record<ProjectAgentState, number> = { working: 0, review: 1, trouble: 2 };
  const all: ProjectAgentRow[] = [];
  for (const a of snap?.agents ?? []) {
    if (a.kind === "human" || a.status === "terminated") continue;
    const state: ProjectAgentState | null = isActive(a) ? "working"
      : NEEDS_REVIEW.has(a.status || "") ? "review"
      : TROUBLE.has(a.status || "") ? "trouble" : null;
    if (!state) continue;
    const rr = (a as Agent & { running_run?: { task_title?: string | null } | null }).running_run;
    const task = state === "working" ? a.active_run?.task_title || rr?.task_title || a.current_task?.title || null : null;
    const last = t(a);
    const stale = last > 0 && now - last > LIVE_STALE_MS;
    const fragment = state === "review" ? "needs review"
      : state === "trouble" ? (a.status || "").replace(/_/g, " ")
      : task || (stale && a.last_active ? ago(a.last_active) : "") || "working";
    all.push({ alias: a.alias, status: a.status || "unknown", state, fragment, agent: a });
  }
  all.sort((x, y) => rank[x.state] - rank[y.state] || t(y.agent) - t(x.agent) || x.alias.localeCompare(y.alias));
  return { rows: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

/**
 * Parity r2: a NON-selected project's live agents, from GET /api/containers
 * `live_agents` (the backend applies the snapshot's own "working" rule and
 * caps the list). Rows carry a minimal Agent built only from those fields —
 * nothing is invented; `more` counts the ones cut by the server cap or `cap`.
 */
export function remoteProjectAgents(
  list: RemoteLiveAgent[] | null | undefined, total: number | null | undefined, cap = 3,
): { rows: ProjectAgentRow[]; more: number } {
  const src = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.alias === "string" && x.alias);
  const rows: ProjectAgentRow[] = src.slice(0, cap).map((x) => {
    const status = x.status || "working";
    // VD-09: awaiting_request is a neutral "waiting" (the roster's word), never
    // "needs review" — the agent is waiting on an answer, not on a human review.
    const review = NEEDS_REVIEW.has(status);
    // (a running run still reads Working — presence.ts ranks the run first)
    const waiting = status === "awaiting_request" && !x.started_at;
    const agent = {
      id: "", alias: x.alias, kind: "ai", status,
      last_active: x.last_active ?? null,
      current_task: x.task_title ? { title: x.task_title } : null,
      active_run: x.started_at ? { task_title: x.task_title ?? null, started_at: x.started_at } : null,
    } as unknown as Agent;
    const state: ProjectAgentState = review ? "review" : "working";
    return { alias: x.alias, status, state, fragment: review ? "needs review" : waiting ? "waiting" : x.task_title || "working", agent };
  });
  const n = Math.max(typeof total === "number" ? total : 0, src.length);
  return { rows, more: Math.max(0, n - rows.length) };
}
