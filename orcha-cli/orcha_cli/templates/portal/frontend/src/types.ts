/**
 * Component-shape types — the exact output of the vanilla data.js mapSnapshot
 * (static/data.js), so React pages read the same fields the HTML pages did.
 */
import type { CodeThreadRef } from "./lib/requestText";

export interface ActiveRun {
  run_id: string;
  wake_event?: string | null;
  wake_kind?: string | null;
  runtime?: string | null;
  task_id?: string | null;
  task_title?: string | null;
  has_conversation?: boolean;
  started_at?: string | null;
}

/** Snapshot `running_run`: the newest run the runs list reports as running,
 *  NOT gated on a live lease (`lease_live: false` = probably an orphan the
 *  host reaper has not reconciled yet). Additive; older backends omit it. */
export interface RunningRun extends ActiveRun {
  lane?: string | null;
  lease_live?: boolean;
  /** L13b: the run's checkout (worktree, or base checkout). Older backends omit both. */
  worktree?: string | null;
  base_cwd?: string | null;
}

export interface Agent {
  id: string;
  alias: string;
  kind: string; // "ai" | "human"
  github_login?: string | null; // cloud backends enrich humans; open may omit
  member_role?: string | null; // cloud collab: owner|member|viewer
  reasoning_effort?: string | null; // cloud: per-agent effort setting
  autonomy_override?: string | null; // #64 mig-043: per-agent level (null = inherit); open backends omit
  effective_autonomy?: string | null; // #64: server-computed effective level; open backends omit
  role: string;
  model: string | null;
  status: string;
  embodiment: string | null; // idle|ephemeral|resident|live
  wake_enabled: boolean | null;
  auto_wake_interval_secs: number | null;
  prompt_preview: string | null;
  last_active: string | null;
  current_task: { task_id: string; title: string } | null;
  active_run: ActiveRun | null;
  /** agent-status parity (additive): undefined = the backend does not send it. */
  running_run?: RunningRun | null;
  /** new wakes are refused (project inactive / kill-switch / agent opted out) */
  wakes_paused?: boolean;
  wakes_paused_reason?: "project_status" | "project_wakes_off" | "agent_wakes_off" | string | null;
  /** always false today: a pause never stops a run already in flight */
  pause_stops_running_run?: boolean;
  /** Org chart (mig 052): the manager's agent id (null = root / unassigned). undefined = older backend. */
  reports_to?: string | null;
  /** PS-33: human members' last sign-in heartbeat (null = invited, never signed in). undefined = not sent. */
  last_heartbeat_at?: string | null;
}

export interface Attachment {
  id: string;
  name: string;
  size?: number;
  content_type?: string;
  kind?: string;
  url?: string;
}

export interface ThreadMsg {
  id: string;
  is_human: boolean;
  from: string; // "human" | alias | "system"
  body: string;
  at: string;
  attachments: Attachment[];
}

/** mig 057 — tasks.review_routing: why this reviewer (routed_via) and the chain facts. */
export interface ReviewRouting {
  routed_via: "reports_to" | "owner" | "fallback" | "manual" | string;
  reviewer_alias?: string | null;
  assignee_alias?: string | null;
  manager_depth?: number | null;
  pre_review_by?: string | null;
  reports_to_skipped?: { alias: string; why: string }[];
  set_by_alias?: string | null;
  routed_at?: string | null;
}

/** mig 057 — tasks.manager_review: the AI manager's pre-review (advisory; a human verifies). */
export interface ManagerReview {
  status: "pending" | "approved" | "sent_back" | "commented" | "superseded" | "overridden" | string;
  manager_agent_id?: string | null;
  manager_alias?: string | null;
  request_id?: string | null;
  recommendation?: "approve" | "send_back" | null;
  reasons?: string | null;
  requested_at?: string | null;
  decided_at?: string | null;
}

export interface Task {
  id: string;
  title: string;
  status: string;
  reviewer_agent_id?: string | null; // cloud collab v1: owner-assigned reviewer
  reviewer?: { alias?: string; github_login?: string | null } | string | null;
  /** mig 057: how the reviewer was chosen (null = never routed; undefined = older backend) */
  review_routing?: ReviewRouting | null;
  /** mig 057: the AI manager pre-review record (null = none) */
  manager_review?: ManagerReview | null;
  priority: string | number | null;
  assignees: string[];
  assignee: string | null;
  description: string;
  definition_of_done: string;
  protocol: unknown | null;
  result: string | null;
  plan_decision: { decision: string; reason?: string; actor?: string; at?: string } | null;
  runs: Run[];
  runs_summary: { count: number; latest?: Run } | null;
  is_root: boolean;
  created_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  message_summary: { count: number; last: { body?: string; author_alias?: string; at?: string; is_human?: boolean } | null };
  plan_message: { body: string; author_alias?: string | null; at?: string } | null;
  thread: ThreadMsg[];
}

export interface Run {
  run_id?: string;
  id?: string;
  status: string;
  exit_code?: number | null;
  wake_kind?: string | null;
  started_at?: string;
  started?: string;
  ended_at?: string | null;
  ended?: string | null;
  kill_reason?: string | null;
  diff?: string | null;
  output?: string | null;
  agent_id?: string | null;
  agent?: string | null;
}

export interface OrchaRequest {
  id: string;
  type: string;
  status: string;
  priority: string | number | null;
  requester_id: string | null;
  target_id: string | null;
  from: string;
  to: string;
  payload: unknown;
  response: unknown | null;
  rejection_reason: string | null;
  in_service_of: string | null;
  chain_depth: number;
  task_link: { task_id: string; title?: string; status?: string } | null;
  escalated: boolean;
  /** when the latest escalation happened (backend `escalated_at`; null = unknown) */
  escalated_at?: string | null;
  /** alias the request was addressed to before it was escalated (backend `escalated_from_alias`) */
  escalated_from?: string | null;
  /** alias of whoever closed it (backend `closed_by_alias`; null = system/unknown) */
  closed_by?: string | null;
  /** the reason given on a human force-close (backend `close_decision.reason`) */
  close_reason?: string | null;
  /** when it was closed, if known (backend `close_decision.at`) */
  closed_at?: string | null;
  created_at: string;
  responded_at: string | null;
  expires_at: string | null;
  /** Backend `requests.detail` jsonb, unchanged (roster suggestions carry `proposed_alias`). */
  detail?: Record<string, unknown> | null;
  /** Display title when the request has one (code-thread questions, lib/requestText.ts); else derive from payload. */
  title?: string | null;
  /** The code thread a Code › Learn/Ask question lives in (its conversation is there). */
  code_thread?: CodeThreadRef | null;
}

export interface Container {
  id: string;
  name?: string;
  description?: string | null;
  status?: string;
  autonomy_level?: string; // plan | pr | full
  autonomy_enforced?: boolean; // #64 mig-043: container level governs everyone (overrides ignored)
  worktrees_disabled?: boolean; // project routes every agent run through the main checkout
  autonomy_paused?: boolean;
  wakes_enabled?: boolean; // notifier kill-switch (POST /api/containers/{cid}/wakes); absent on old backends
  /** mig 056 agent limit: how many agents created from suggestions the project may hold (PUT …/limits) */
  max_auto_agents?: number;
  /** live AI agents created from suggestions — what max_auto_agents is checked against */
  auto_agents_in_use?: number;
  last_wake_scan_at?: string | null; // mig 037: daemon wake-scan stamp — drives wakesServed
  /** server-side (DB clock) reading of "a host runtime serves this project" — preferred over wakesServed */
  runtime_served?: boolean;
  wake_scan_age_secs?: number | null;
  /** mig 057: where finished work goes for verification; undefined = older backend */
  review_route?: "manager_chain" | "owner" | "anyone";
  /** mig 057: AI managers pre-review before the human verifies */
  ai_manager_prereview?: boolean;
  /** mig 050 (D14): the project's icon; null = default glyph, undefined = old backend */
  icon?: { kind: string; value: string; color?: number | null } | null;
  root_task_id?: string | null;
  created_at?: string;
}

export interface Snapshot {
  // GAP-05: authoritative ALL-row totals (the task/request lists are capped at
  // 1000 server-side). null = the backend did not send them (truncation unknown).
  task_total?: number | null;
  request_total?: number | null;
  // cloud: authoritative open totals (additive; open backends omit — compute instead)
  task_open_total?: number | null;
  request_open_total?: number | null;
  container: Container | null;
  agents: Agent[];
  byAlias: Record<string, Agent>;
  tasks: Task[];
  requests: OrchaRequest[];
}
