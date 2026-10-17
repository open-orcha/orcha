/**
 * Agent config history — API shapes + pure formatting (tested). Routes (additive,
 * portal_backend/agent_config_history_routes.py; contract = /openapi.json):
 *   GET  /api/agents/{aid}/config-revisions?field=&actor_kind=&kind=&before=&limit=
 *   GET  /api/agents/{aid}/config-revisions/{n}          (+ snapshot, restore_preview)
 *   POST /api/agents/{aid}/config-revisions/{n}/restore  {actor_agent_id, reason?}
 */
import { getJSON, sendJSON } from "../../../api/client";
import { humanizeModelId } from "../presence";

export type ConfigField =
  | "alias"
  | "role"
  | "system_prompt"
  | "model"
  | "reasoning_effort"
  | "auto_wake_interval_secs"
  | "autonomy_override"
  | "provider";

export type ConfigValue = string | number | null;

export interface FieldChange {
  field: ConfigField;
  before: ConfigValue;
  after: ConfigValue;
  /** display-only (provider follows the model; not restorable on its own) */
  derived?: boolean;
}

export interface RevisionActor {
  agent_id: string;
  alias: string | null;
  kind: "human" | "ai" | null;
}

export interface ConfigRevision {
  revision_no: number;
  kind: "initial" | "change" | "restore";
  source: string;
  changes: FieldChange[];
  /** null = no identity was recorded (never guessed) */
  actor: RevisionActor | null;
  restored_from: number | null;
  reason: string | null;
  redacted_fields: ConfigField[];
  created_at: string | null;
}

export interface RevisionPage {
  agent_id: string;
  latest_revision_no: number | null;
  total: number;
  revisions: ConfigRevision[];
  next_before: number | null;
}

export interface RestorePreviewItem {
  field: ConfigField;
  current: ConfigValue;
  target: ConfigValue;
  grant: "manage_agents" | "manage_autonomy";
}

export interface RevisionDetail extends ConfigRevision {
  snapshot: Partial<Record<ConfigField, ConfigValue>>;
  restore_preview: RestorePreviewItem[];
  restore_blocked: { field: ConfigField; reason: string }[];
}

export interface RestoreResult {
  agent_id: string;
  restored_from: number;
  applied: ConfigField[];
  revisions: ConfigRevision[];
}

/* ---- filters (one pill row) ---- */
export type HistoryFilter = "all" | "system_prompt" | "model" | "auto_wake_interval_secs" | "autonomy_override" | "restore";
export const HISTORY_FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: "all", label: "All changes" },
  { key: "system_prompt", label: "Prompt" },
  { key: "model", label: "Model" },
  { key: "auto_wake_interval_secs", label: "Auto-wake" },
  { key: "autonomy_override", label: "Autonomy" },
  { key: "restore", label: "Restores" },
];

export const PAGE_SIZE = 30;

export function historyQuery(filter: HistoryFilter, before?: number | null): string {
  const p = new URLSearchParams();
  if (filter === "restore") p.set("kind", "restore");
  else if (filter !== "all") p.set("field", filter);
  if (before != null) p.set("before", String(before));
  p.set("limit", String(PAGE_SIZE));
  return p.toString();
}

const base = (aid: string) => "/api/agents/" + encodeURIComponent(aid) + "/config-revisions";

export function fetchRevisions(aid: string, filter: HistoryFilter, before?: number | null, signal?: AbortSignal): Promise<RevisionPage> {
  return getJSON<RevisionPage>(base(aid) + "?" + historyQuery(filter, before), signal);
}
export function fetchRevision(aid: string, n: number, signal?: AbortSignal): Promise<RevisionDetail> {
  return getJSON<RevisionDetail>(base(aid) + "/" + n, signal);
}
export function restoreRevision(aid: string, n: number, actorId: string | null, reason: string): Promise<RestoreResult> {
  const body: { actor_agent_id: string | null; reason?: string } = { actor_agent_id: actorId };
  if (reason.trim()) body.reason = reason.trim();
  return sendJSON<RestoreResult>("POST", base(aid) + "/" + n + "/restore", body);
}

/* ---- formatting ---- */
export const FIELD_LABEL: Record<ConfigField, string> = {
  alias: "Name",
  role: "Role",
  system_prompt: "Prompt",
  model: "Model",
  reasoning_effort: "Reasoning effort",
  auto_wake_interval_secs: "Auto-wake",
  autonomy_override: "Autonomy",
  provider: "Provider",
};

/** Field order for snapshots / previews (matches the Configuration tab). */
export const FIELD_ORDER: ConfigField[] = [
  "alias",
  "role",
  "system_prompt",
  "model",
  "provider",
  "reasoning_effort",
  "auto_wake_interval_secs",
  "autonomy_override",
];

export function fieldLabel(f: string): string {
  return (FIELD_LABEL as Record<string, string>)[f] || f.replace(/_/g, " ");
}

function interval(secs: number): string {
  if (secs % 86400 === 0) return secs === 86400 ? "Daily" : "Every " + secs / 86400 + " days";
  if (secs % 3600 === 0) return secs === 3600 ? "Hourly" : "Every " + secs / 3600 + " h";
  if (secs % 60 === 0) return "Every " + secs / 60 + " min";
  return "Every " + secs + " s";
}

const AUTONOMY: Record<string, string> = { plan: "Plan", pr: "PR", full: "Full" };
const PROVIDER: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** A value as the Configuration tab would show it. Unset ≠ empty: each field says what null MEANS. */
export function formatValue(field: string, v: ConfigValue | undefined): string {
  if (field === "auto_wake_interval_secs") return v == null ? "Off" : interval(Number(v));
  if (field === "autonomy_override") return v == null ? "Inherit project" : AUTONOMY[String(v)] || String(v);
  if (field === "reasoning_effort") return v == null ? "Default" : String(v).charAt(0).toUpperCase() + String(v).slice(1);
  if (field === "model") return v == null ? "Default" : humanizeModelId(String(v));
  if (field === "provider") return v == null ? "Unknown" : PROVIDER[String(v)] || String(v);
  if (v == null || v === "") return "Not set";
  return String(v);
}

export const isTextField = (f: string) => f === "system_prompt";

/** "prompt, model" — the fields a revision touched, derived ones last. */
export function changedSummary(r: ConfigRevision): string {
  const own = r.changes.filter((c) => !c.derived).map((c) => fieldLabel(c.field).toLowerCase());
  return own.join(", ");
}

/** Who did it, truthfully: an alias, or "Unattributed" (no identity was recorded). */
export function actorName(r: ConfigRevision): string {
  if (r.kind === "initial") return "Embodent";
  return r.actor?.alias || "Unattributed";
}

export const UNATTRIBUTED_TIP =
  "No signed-in identity was recorded for this change (e.g. a model or effort change on a self-hosted stack without a proxy login).";
