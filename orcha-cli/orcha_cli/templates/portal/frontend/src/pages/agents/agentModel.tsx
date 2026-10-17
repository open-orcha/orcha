/**
 * Agents page — snapshot-derived helpers shared by the roster list, the D9
 * board (AgentsBoard.tsx) and the workspace header (AgentsPage.tsx).
 *
 * Truthfulness: everything here derives from real snapshot fields; nothing
 * invents a status, a run or a count.
 */
import type { Agent, Snapshot, Task } from "../../types";
import { leaseOf } from "../../lib/status";
import { trunc } from "../../lib/format";
import { actingHuman, planAwaitsHuman } from "../../state/SnapshotProvider";
import type { Identity } from "../../extensions";
import { liveStateFor, type LiveState } from "../../components/primitives";
import { agentPresence, type AgentPresence, type PresenceKey } from "./presence";

/* ---------- ISS-69(a): embodiment lease badge ------------------------------ */
export const EMBOD_LBL: Record<string, string> = { live: "live", resident: "in convo", ephemeral: "task" };
export const EMBOD_TITLE: Record<string, string> = {
  live: "In a live terminal — busy and can't be woken until the terminal closes",
  resident: "In a live conversation — busy until the conversation yields or ends",
  ephemeral: "Running a task — busy until the task completes",
};
export function EmbodBadge({ a }: { a: Agent }) {
  const kind = leaseOf(a);
  if (!kind || kind === "idle") return null;
  return (
    <span className={"rlive " + kind} title={EMBOD_TITLE[kind] || ""}>
      <span className="d" />
      {EMBOD_LBL[kind] || kind}
    </span>
  );
}

/* ---------- #340 real current activity: the LIVE run, else the assigned task */
export function activityOf(a: Agent): string | null {
  const ar = a.active_run;
  if (ar) {
    if (ar.task_id) return trunc(ar.task_title || (a.current_task && a.current_task.title) || "On a task", 48);
    if (ar.has_conversation) return "In conversation";
    return ar.wake_event ? ar.wake_event.replace(/_/g, " ") : "Running";
  }
  const ct = a.current_task;
  if (ct && ct.task_id) return trunc(ct.title || "", 48);
  return null;
}

/** The task this agent is on right now (live run's task, else its current task), or null.
 *  r3 roster rule: the sub-line is this task (with its status glyph) when there is
 *  one, otherwise the role — never a conversation / wake-event word in place of the role. */
export function onTaskTitle(a: Agent): string | null {
  return onTask(a)?.title ?? null;
}
export function onTask(a: Agent): { id: string; title: string } | null {
  const ar = a.active_run;
  if (ar && ar.task_id) return { id: ar.task_id, title: trunc(ar.task_title || (a.current_task && a.current_task.task_id === ar.task_id && a.current_task.title) || "On a task", 48) };
  const ct = a.current_task;
  if (ct && ct.task_id && ct.title) return { id: ct.task_id, title: trunc(ct.title, 48) };
  return null;
}

/* ---------- D9 board model -------------------------------------------------- */
export type BoardFilter = "all" | "active" | "backlog";
export const BOARD_FILTERS: { key: BoardFilter; label: string }[] = [
  { key: "all", label: "All tasks" },
  { key: "active", label: "Active" },
  { key: "backlog", label: "Backlog" },
];
/** Not started yet (Linear "Backlog"): ready to pick up, or waiting on deps. */
const BACKLOG = new Set(["ready", "pending"]);
/** Finished one way or another. */
const CLOSED = new Set(["completed", "cancelled"]);
export function taskInFilter(t: Task, f: BoardFilter): boolean {
  if (f === "all") return true;
  if (f === "backlog") return BACKLOG.has(t.status);
  return !BACKLOG.has(t.status) && !CLOSED.has(t.status);
}

/** Card order inside a column: attention first, then live work, backlog, closed; newest first within. */
const RANK: Record<string, number> = { needs_verification: 0, in_progress: 1, awaiting_human: 1, awaiting_request: 1, blocked: 2, failed: 2, ready: 3, pending: 4, completed: 5, cancelled: 6 };
export function boardCmp(a: Task, b: Task): number {
  const r = (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3);
  if (r) return r;
  const ta = Date.parse(a.completed_at || a.started_at || a.created_at || "") || 0;
  const tb = Date.parse(b.completed_at || b.started_at || b.created_at || "") || 0;
  return tb - ta;
}

function reviewerAlias(snap: Snapshot | null, t: Task): string | null {
  const r = t.reviewer;
  if (r && typeof r === "object" && r.alias) return r.alias;
  if (typeof r === "string" && r) return r;
  if (t.reviewer_agent_id) {
    const a = (snap?.agents ?? []).find((x) => x.id === t.reviewer_agent_id);
    if (a) return a.alias;
  }
  return null;
}

export interface ColumnTask {
  task: Task;
  /** "review" = the human is the task's reviewer (not an assignee). */
  role: "assignee" | "review";
}

/** A column's tasks: the actor's assigned tasks, plus (humans) the tasks they review. */
export function columnTasks(snap: Snapshot | null, a: Agent): ColumnTask[] {
  const out: ColumnTask[] = [];
  for (const t of snap?.tasks ?? []) {
    if ((t.assignees || []).indexOf(a.alias) >= 0 || t.assignee === a.alias) out.push({ task: t, role: "assignee" });
    else if (a.kind === "human" && reviewerAlias(snap, t) === a.alias) out.push({ task: t, role: "review" });
  }
  return out;
}

/** Is this agent running THIS task right now (its live run / current task)? */
export function isOnTask(a: Agent | null | undefined, t: Task): boolean {
  if (!a) return false;
  if (a.active_run && a.active_run.task_id) return a.active_run.task_id === t.id;
  return !!(a.current_task && a.current_task.task_id === t.id);
}

/** Real evidence a run is working on THIS task right now: the task's latest run
 *  is running, or an assignee's live run is on it. The same test the Tasks list
 *  uses (TaskListView.taskIsWorking), so the two pages never disagree on "Working…". */
export function taskRunIsLive(snap: Snapshot | null, t: Task): boolean {
  if (t.runs_summary?.latest?.status === "running") return true;
  const als = (t.assignees || []).length ? t.assignees : t.assignee ? [t.assignee] : [];
  return als.some((al) => {
    const a = (snap?.agents ?? []).find((x) => x.alias === al);
    return !!a?.active_run?.task_id && String(a.active_run.task_id) === String(t.id);
  });
}

/**
 * The card's live pill — ONLY from real signals, with ONE precedence (D8, shared
 * with the Tasks list): a run live on this task → "Working…"; awaiting
 * verification → "Needs review"; a plan that actually waits on a human
 * (planAwaitsHuman: the author runs at plan autonomy) → "Waiting"; then the
 * task/actor status (failed → Error, completed → Finished …). An in-progress
 * task with nobody on it has nothing live to say and no pill renders.
 */
export function cardLiveState(snap: Snapshot | null, t: Task): LiveState | null {
  if (taskRunIsLive(snap, t) && t.status !== "completed" && t.status !== "cancelled") return "working";
  if (t.status === "needs_verification") return "needs_review";
  const actors = (t.assignees || []).map((al) => (snap?.agents ?? []).find((x) => x.alias === al)).filter(Boolean) as Agent[];
  const on = actors.find((x) => isOnTask(x, t));
  if (t.status === "in_progress" && planAwaitsHuman(snap, t)) return "waiting";
  if (on) {
    return liveStateFor({ taskStatus: t.status, agentStatus: on.status, runStatus: on.active_run && on.active_run.task_id === t.id ? "running" : null });
  }
  return liveStateFor({ taskStatus: t.status, agentStatus: "idle" });
}

/* ---------- D9 column / roster presence (agent status, NOT a task glyph) ---- */
/** One muted word for an agent's live status; null when idle (the avatar dot says it). */
const PRESENCE_WORD: Record<string, string> = {
  working: "Working",
  awaiting_human: "Needs you",
  awaiting_request: "Waiting",
  blocked: "Blocked",
  failed: "Failed",
  terminated: "Terminated",
};
export function presenceWord(status: string | null | undefined): string | null {
  return (status && PRESENCE_WORD[status]) || null;
}
/**
 * The roster / board word for an agent: exactly agentPresence()'s label (the
 * function the workspace header and the sidebar read — r2 parity blocker), or
 * null when there is nothing to say beyond the avatar dot. Project-wide states
 * ("No runtime", project "Paused") are the header execution chip's fact, so an
 * IDLE agent does not repeat them on every column/row (D12); an agent whose own
 * status claims something (working…) shows them, so it never reads "Working"
 * while the header says "No runtime".
 */
const PROJECT_WIDE = new Set<PresenceKey>(["noruntime", "paused"]);
export function agentPresenceWord(a: Agent, snap: Snapshot | null, now?: number): AgentPresence | null {
  if (a.kind === "human") return null;
  const p = agentPresence(a, { snap, now });
  if (p.k === "idle") return null;
  if (PROJECT_WIDE.has(p.k) && (!a.status || a.status === "idle")) return null;
  return p;
}
/** Label-only form of agentPresenceWord. */
export function agentWord(a: Agent, snap: Snapshot | null = null, now?: number): string | null {
  return agentPresenceWord(a, snap, now)?.label ?? null;
}

/** Column order: live work first, then waiting on someone, then trouble, then idle. */
const AGENT_RANK: Record<string, number> = { working: 0, awaiting_human: 1, awaiting_request: 1, blocked: 2, failed: 2, terminated: 2 };
export function agentRank(a: Agent): number {
  return AGENT_RANK[a.status] ?? 3;
}

/** Statuses where an agent with no cards still needs a reason on the board. */
export function needsReason(a: Agent): boolean {
  return a.kind !== "human" && agentRank(a) > 0 && agentRank(a) < 3;
}

/* ---------- access model (mig 039): owner-or-grant affordances ---------------
   The server is the enforcer (enforce_grant in portal_backend/identity_routes.py);
   these only gate the AFFORDANCE so a member without the grant never reaches a
   confirm that is bound to 403. model / reasoning effort / runtime / persona /
   new agent are owner-or-`manage_agents`; auto-wake and the autonomy override
   are owner-or-`manage_autonomy`. Viewers never write. Trust off (no identity
   registered — the self-host default) keeps the server's permissive lane: any
   acting human may act. */
export type AgentGrant = "manage_agents" | "manage_autonomy";
export const GRANT_REASON: Record<AgentGrant, string> = {
  manage_agents: "Requires the owner role or the manage_agents permission",
  manage_autonomy: "Requires the owner role or the manage_autonomy permission",
};
export function canGrant(snap: Snapshot | null, identity: Identity | null, grant: AgentGrant): boolean {
  if (!actingHuman(snap)) return false;
  if (!identity) return true;
  if (identity.member_role === "viewer") return false;
  if (identity.member_role === "owner") return true;
  return (identity.grants || []).indexOf(grant) >= 0;
}
/** Why a grant-gated control is unavailable, or null when it is available.
 *  `noHuman` is the authority reason (viewer / non-member / pick a human). */
export function grantDenied(snap: Snapshot | null, identity: Identity | null, grant: AgentGrant, noHuman: string): string | null {
  if (!actingHuman(snap) || identity?.member_role === "viewer") return noHuman;
  return canGrant(snap, identity, grant) ? null : GRANT_REASON[grant];
}
/** The server's detail from a sendJSON error ("… → 403: <detail>"), else "". */
export function errDetail(e: unknown): string {
  const m = /→ \d{3}: (.+)$/.exec(String((e as Error)?.message || ""));
  return m ? m[1] : "";
}
/** Fallback copy when no acting human is available and the authority has no reason. */
export const NO_ACTING_HUMAN = "Pick an acting human first (sidebar, bottom-left) — actions are recorded under a human identity.";
