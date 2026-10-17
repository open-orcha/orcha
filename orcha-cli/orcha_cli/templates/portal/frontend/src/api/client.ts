/**
 * API access over the UNCHANGED portal backend. This file is a faithful port
 * of static/data.js (mapSnapshot / resolveCid / refresh / threadOf) plus the
 * generic fetch helpers pages use for their own endpoints. The /api contract
 * is governed by /openapi.json — nothing here invents a route.
 */
import type { Agent, Snapshot, ThreadMsg } from "../types";
import { humanizeRequest } from "../lib/requestText";

/** A failed API call: the message keeps the legacy "<url> → <status>[: detail]"
 *  shape (parsers depend on it), and `status` / `detail` carry the HTTP status
 *  and the server's detail as PLAIN text, so a toast never has to show the
 *  request URL or container id (EX-09). */
export type ApiError = Error & { status?: number; detail?: string };

/**
 * The server's `detail` as readable text (pure, tested). FastAPI sends a string
 * for HTTPException, an ARRAY of {loc,msg,type} for 422 validation errors, and
 * some routes an object {message,…} (plan gating). Never "[object Object]".
 */
export function errorDetailText(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d === "string") return d;
        if (d && typeof d === "object") {
          const o = d as { msg?: unknown; loc?: unknown };
          const msg = typeof o.msg === "string" ? o.msg : "";
          const loc = Array.isArray(o.loc) ? o.loc.filter((x) => x !== "body" && x !== "query" && x !== "path") : [];
          const field = loc.length ? String(loc[loc.length - 1]).replace(/_/g, " ") : "";
          return msg ? (field ? field + ": " + msg : msg) : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("; ");
  }
  if (typeof detail === "object") {
    const o = detail as { message?: unknown; detail?: unknown };
    if (typeof o.message === "string") return o.message;
    if (o.detail != null) return errorDetailText(o.detail);
    return "";
  }
  return String(detail);
}

async function apiError(url: string, r: Response, withDetailInMessage: boolean): Promise<ApiError> {
  let detail = "";
  try {
    const d = (await r.json()) as { detail?: unknown };
    if (d && d.detail != null) detail = errorDetailText(d.detail);
  } catch {
    /* non-JSON error body */
  }
  const err = new Error(url + " → " + r.status + (withDetailInMessage && detail ? ": " + detail : "")) as ApiError;
  err.status = r.status;
  if (detail) err.detail = detail;
  // PS-16: a write refused for a role/membership reason means the identity on
  // screen may be stale (e.g. demoted to viewer) — ask the SnapshotProvider to
  // re-check it now (state/SnapshotProvider IDENTITY_STALE_EVENT).
  if (r.status === 403 && withDetailInMessage && /\b(role|viewer|read-only|not a member|member of)\b/i.test(detail)) {
    try { if (typeof window !== "undefined") window.dispatchEvent(new Event("orcha:identity-stale")); } catch { /* no window */ }
  }
  return err;
}

export async function getJSON<T = unknown>(url: string, signal?: AbortSignal): Promise<T> {
  const r = signal ? await fetch(url, { signal }) : await fetch(url);
  if (!r.ok) throw await apiError(url, r, false);
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
  if (!r.ok) throw await apiError(url, r, true);
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

// Who wrote a human-authored message: the author's own alias when it resolves,
// else the project's ONLY human (self-host: portal posts carry no author id),
// else the generic "human" (never a guess between several humans).
function humanAuthor(m: RawMsg, agents: Agent[]): string {
  const own = m.author_alias || aliasFor(agents, m.author_id);
  if (own) return own;
  const hs = agents.filter((a) => a.kind === "human");
  return hs.length === 1 && hs[0].alias ? hs[0].alias : "human";
}

// raw task_messages[] -> page thread shape (data.js mapThread, incl. the #271
// null-author → 'system' render path). An agent author that no longer
// resolves (removed agent) reads "unknown agent" — never a bare "—".
export function mapThread(messages: RawMsg[] | undefined, agents: Agent[]): ThreadMsg[] {
  return (messages || []).map((m) => ({
    id: m.message_id,
    is_human: !!m.is_human,
    from: m.is_human
      ? humanAuthor(m, agents)
      : m.author_id ? m.author_alias || aliasFor(agents, m.author_id) || "unknown agent" : "system",
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
    // agent-status parity (additive): only carried when the backend sends them,
    // so `undefined` still means "older backend — fall back to the old rules".
    ...("running_run" in a ? { running_run: a.running_run != null ? a.running_run : null } : {}),
    ...("wakes_paused" in a ? { wakes_paused: !!a.wakes_paused } : {}),
    ...("wakes_paused_reason" in a ? { wakes_paused_reason: a.wakes_paused_reason != null ? a.wakes_paused_reason : null } : {}),
    ...("pause_stops_running_run" in a ? { pause_stops_running_run: !!a.pause_stops_running_run } : {}),
    // Org chart (mig 052, additive): only carried when the backend sends it.
    ...("reports_to" in a ? { reports_to: a.reports_to != null ? String(a.reports_to) : null } : {}),
    // PS-33 (additive): null = an invited member who has never signed in.
    ...("last_heartbeat_at" in a ? { last_heartbeat_at: a.last_heartbeat_at ?? null } : {}),
  }));
  const byAlias = Object.fromEntries(agents.map((a) => [a.alias, a]));

  const tasks = (raw.tasks || []).map((t: any) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    reviewer_agent_id: t.reviewer_agent_id != null ? t.reviewer_agent_id : null,
    reviewer: t.reviewer != null ? t.reviewer : null,
    // mig 057 (additive): only carried when the backend sends them
    ...("review_routing" in t ? { review_routing: t.review_routing ?? null } : {}),
    ...("manager_review" in t ? { manager_review: t.manager_review ?? null } : {}),
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

  const closeFields = (r: any) => {
    let cd: any = r.close_decision;
    if (typeof cd === "string") { try { cd = JSON.parse(cd); } catch { cd = null; } }
    cd = cd && typeof cd === "object" ? cd : null;
    return {
      closed_by: r.closed_by_alias || (cd && typeof cd.actor === "string" ? cd.actor : null) || null,
      close_reason: cd && typeof cd.reason === "string" && cd.reason.trim() ? cd.reason.trim() : null,
      closed_at: cd && typeof cd.at === "string" ? cd.at : null,
    };
  };
  const requests = (raw.requests || []).map((r: any) => {
    const detail = r.detail && typeof r.detail === "object" ? r.detail : null;
    // mig 065: people read the question, never the agent's wake instructions (legacy rows stripped)
    const human = humanizeRequest(r.payload, detail);
    return {
    id: r.id,
    type: r.type,
    status: r.status,
    priority: r.priority,
    requester_id: r.requester_id,
    target_id: r.target_id,
    // UR-08: a retired agent is not in the snapshot roster. An id that is
    // present but unknown is never "human" (the UI renders that as "you"):
    // prefer the backend's joined alias, else say "retired agent".
    from: r.requester_alias || aliasFor(agents, r.requester_id) || (r.requester_id != null ? "retired agent" : "human"),
    to: r.target_alias || aliasFor(agents, r.target_id) || (r.target_id != null ? "retired agent" : "human"),
    payload: human.payload,
    title: human.title,
    code_thread: human.codeThread,
    response: r.response != null ? r.response : null,
    rejection_reason: r.rejection_reason != null ? r.rejection_reason : null,
    in_service_of: r.parent_request_id || null,
    chain_depth: r.chain_depth || 0,
    task_link: r.task_link || (r.spawned_task_id ? { task_id: r.spawned_task_id } : null),
    // Escalation (REQ-013/071/100): the legacy status, OR an additive backend
    // flag (`escalated` / `escalated_at`) — the escalate route and the expiry
    // sweep keep status 'open' and only re-target the request to a human.
    escalated: r.status === "escalated" || r.escalated === true || !!r.escalated_at,
    escalated_at: r.escalated_at || null,
    escalated_from: r.escalated_from_alias || aliasFor(agents, r.escalated_from_id) || null,
    // parity r2 (additive): who closed it and why (request_ownership.REQUEST_CLOSE_COLUMNS)
    ...closeFields(r),
    created_at: r.created_at,
    responded_at: r.responded_at || null,
    expires_at: r.expires_at || null,
    // backend request.detail (e.g. roster suggestion marker `proposed_alias`), passed through unchanged
    detail,
  };
  });

  // current_task: what the agent is actually working on. The project's ROOT
  // task (the objective, is_root) is never an agent's "current task" — it used
  // to win over the active run's real task (screen review: sidebar live agents
  // showed "Working · Ship the Orcha V2 portal"). Precedence: a non-root
  // backend current_task → the active run's task → a non-root in_progress
  // task the agent is assigned to.
  const rootIds = new Set(tasks.filter((t: any) => t.is_root).map((t: any) => String(t.id)));
  agents.forEach((a) => {
    const cur0 = a.current_task as { task_id?: unknown } | null;
    if (cur0 != null && !(cur0.task_id != null && rootIds.has(String(cur0.task_id)))) return;
    const run = a.active_run;
    if (run && run.task_id != null && !rootIds.has(String(run.task_id))) {
      const rt = tasks.find((t: any) => String(t.id) === String(run.task_id));
      const title = run.task_title || (rt && rt.title);
      if (title) { a.current_task = { task_id: String(run.task_id), title }; return; }
    }
    const cur = tasks.find((t: any) => !t.is_root && t.status === "in_progress" && (t.assignees || []).indexOf(a.alias) >= 0);
    a.current_task = cur ? { task_id: cur.id, title: cur.title } : null;
  });

  return {
    // GAP-05: keep the all-row totals so consumers can disclose a truncated list.
    task_total: raw.task_total != null ? raw.task_total : null,
    request_total: raw.request_total != null ? raw.request_total : null,
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

export async function fetchSnapshot(cid: string, signal?: AbortSignal): Promise<Snapshot> {
  const raw = await getJSON("/api/containers/" + encodeURIComponent(cid), signal);
  return mapSnapshot(raw);
}
