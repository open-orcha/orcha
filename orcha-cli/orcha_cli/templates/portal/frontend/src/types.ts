/**
 * Component-shape types — the exact output of the vanilla data.js mapSnapshot
 * (static/data.js), so React pages read the same fields the HTML pages did.
 */
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

export interface Task {
  id: string;
  title: string;
  status: string;
  reviewer_agent_id?: string | null; // cloud collab v1: owner-assigned reviewer
  reviewer?: { alias?: string; github_login?: string | null } | string | null;
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
  created_at: string;
  responded_at: string | null;
  expires_at: string | null;
}

export interface Container {
  id: string;
  name?: string;
  description?: string | null;
  status?: string;
  autonomy_level?: string; // plan | pr | full
  autonomy_enforced?: boolean; // #64 mig-043: container level governs everyone (overrides ignored)
  autonomy_paused?: boolean;
  last_wake_scan_at?: string | null; // mig 037: daemon wake-scan stamp — drives wakesServed
  root_task_id?: string | null;
  created_at?: string;
}

export interface Snapshot {
  // cloud: authoritative open totals (additive; open backends omit — compute instead)
  task_open_total?: number | null;
  request_open_total?: number | null;
  container: Container | null;
  agents: Agent[];
  byAlias: Record<string, Agent>;
  tasks: Task[];
  requests: OrchaRequest[];
}
