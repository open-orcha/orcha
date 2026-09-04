/**
 * API access over the UNCHANGED portal backend. This file is a faithful port
 * of static/data.js (mapSnapshot / resolveCid / refresh / threadOf) plus the
 * generic fetch helpers pages use for their own endpoints. The /api contract
 * is governed by /openapi.json — nothing here invents a route.
 */
import type { Agent, Snapshot, ThreadMsg } from "../types";

export async function getJSON<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " → " + r.status);
  return r.json() as Promise<T>;
}

export async function sendJSON<T = unknown>(
  method: "POST" | "PUT" | "DELETE" | "PATCH",
  url: string,
  body?: unknown,
): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = "";
    try {
      const d = (await r.json()) as { detail?: unknown };
      if (d && d.detail != null) detail = ": " + (typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail));
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(url + " → " + r.status + detail) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json() as Promise<T>;
}

function aliasFor(agents: Agent[], id: unknown): string | null {
  if (id == null) return null;
  const a = agents.find((x) => String(x.id) === String(id));
  return a ? a.alias : null;
}

interface RawMsg {
  message_id: string;
  is_human?: boolean;
  author_id?: string | null;
  author_alias?: string | null;
  body: string;
  created_at: string;
  attachments?: unknown;
}

// raw task_messages[] -> page thread shape (data.js mapThread, incl. the #271
// null-author → 'system' render path).
export function mapThread(messages: RawMsg[] | undefined, agents: Agent[]): ThreadMsg[] {
  return (messages || []).map((m) => ({
    id: m.message_id,
    is_human: !!m.is_human,
    from: m.is_human ? "human" : m.author_id ? m.author_alias || aliasFor(agents, m.author_id) || "—" : "system",
    body: m.body,
    at: m.created_at,
    attachments: Array.isArray(m.attachments) ? (m.attachments as ThreadMsg["attachments"]) : [],
  }));
}

// ISS-68: lazy-fetch a task's FULL thread on detail-expand.
export async function threadOf(tid: string, agents: Agent[]): Promise<ThreadMsg[]> {
  const d = await getJSON<{ messages: RawMsg[] }>("/api/tasks/" + encodeURIComponent(tid) + "/messages");
  return mapThread(d.messages, agents);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// pure: raw FastAPI snapshot -> component shape (data.js mapSnapshot, verbatim
// field-for-field so every page reads what the vanilla pages read).
export function mapSnapshot(rawIn: any): Snapshot {
  const raw = rawIn || {};
  const agents: Agent[] = (raw.agents || []).map((a: any) => ({
    id: a.id,
    alias: a.alias,
    kind: a.kind,
    github_login: a.github_login != null ? a.github_login : null,
    member_role: a.member_role != null ? a.member_role : null,
    reasoning_effort: a.reasoning_effort != null ? a.reasoning_effort : null,
    autonomy_override: a.autonomy_override != null ? a.autonomy_override : null,
    effective_autonomy: a.effective_autonomy != null ? a.effective_autonomy : null,
    role: a.role || "—",
    model: a.model != null ? a.model : null,
    status: a.status,
    embodiment: a.embodiment != null ? a.embodiment : null,
    wake_enabled: a.wake_enabled != null ? a.wake_enabled : null,
    auto_wake_interval_secs: a.auto_wake_interval_secs != null ? a.auto_wake_interval_secs : null,
    prompt_preview: a.prompt_preview != null ? a.prompt_preview : null,
    last_active: a.last_active || a.updated_at || null,
    current_task: a.current_task != null ? a.current_task : null,
    active_run: a.active_run != null ? a.active_run : null,
  }));
  const byAlias = Object.fromEntries(agents.map((a) => [a.alias, a]));

  const tasks = (raw.tasks || []).map((t: any) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    reviewer_agent_id: t.reviewer_agent_id != null ? t.reviewer_agent_id : null,
    reviewer: t.reviewer != null ? t.reviewer : null,
    assignees: t.assignees || [],
    assignee: (t.assignees || [])[0] || null,
    description: t.description || "",
    definition_of_done: t.definition_of_done || "",
    protocol: t.protocol != null ? t.protocol : null,
    result: t.result != null ? t.result : null,
    plan_decision: t.plan_decision != null ? t.plan_decision : null,
    runs: Array.isArray(t.runs) ? t.runs : [],
    runs_summary: t.runs && typeof t.runs === "object" && !Array.isArray(t.runs) ? t.runs : null,
    is_root: !!t.is_root,
    created_by: aliasFor(agents, t.created_by_agent_id) || "human",
    created_at: t.created_at,
    started_at: t.started_at || null,
    completed_at: t.completed_at || null,
    message_summary: t.message_summary || { count: 0, last: null },
    plan_message: t.plan_message || null,
    thread: mapThread(t.messages, agents),
  }));

  const requests = (raw.requests || []).map((r: any) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    priority: r.priority,
    requester_id: r.requester_id,
    target_id: r.target_id,
    from: aliasFor(agents, r.requester_id) || "human",
    to: aliasFor(agents, r.target_id) || "human",
    payload: r.payload,
    response: r.response != null ? r.response : null,
    rejection_reason: r.rejection_reason != null ? r.rejection_reason : null,
    in_service_of: r.parent_request_id || null,
    chain_depth: r.chain_depth || 0,
    task_link: r.task_link || (r.spawned_task_id ? { task_id: r.spawned_task_id } : null),
    escalated: r.status === "escalated",
    created_at: r.created_at,
    responded_at: r.responded_at || null,
    expires_at: r.expires_at || null,
  }));

  agents.forEach((a) => {
    if (a.current_task != null) return;
    const cur = tasks.find((t: any) => t.status === "in_progress" && (t.assignees || []).indexOf(a.alias) >= 0);
    a.current_task = cur ? { task_id: cur.id, title: cur.title } : null;
  });

  return {
    task_open_total: raw.task_open_total != null ? raw.task_open_total : null,
    request_open_total: raw.request_open_total != null ? raw.request_open_total : null,
    container: raw.container || null, agents, byAlias, tasks, requests,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// 1:1:1 auto-resolve: ?cid= wins, else the sole/active container.
export async function resolveCid(): Promise<string | null> {
  const q = new URLSearchParams(window.location.search).get("cid");
  if (q) return q;
  const list = await getJSON<unknown>("/api/containers");
  const arr = Array.isArray(list)
    ? (list as { id: string; status?: string }[])
    : ((list as { containers?: { id: string; status?: string }[] }).containers ?? []);
  const active = arr.find((c) => c.status === "active") || arr[0];
  return active ? active.id : null;
}

export async function fetchSnapshot(cid: string): Promise<Snapshot> {
  const raw = await getJSON("/api/containers/" + encodeURIComponent(cid));
  return mapSnapshot(raw);
}
