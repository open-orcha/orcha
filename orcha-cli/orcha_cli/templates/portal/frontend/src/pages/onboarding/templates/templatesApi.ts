/**
 * Industry templates API (portal_backend/templates_routes.py — contract in /openapi.json).
 * Writes carry the acting human as actor_agent_id (trust-off lane); under the trusted
 * proxy the server ignores it and uses the verified identity.
 */
import { errorDetailText, getJSON, sendJSON, type ApiError } from "../../../api/client";
import type { ProjectMode } from "../../../lib/projectMode";

export interface TemplateSummary {
  key: string;
  version: number;
  name: string;
  mode: ProjectMode;
  summary: string;
  roles: { key: string; alias: string; role: string }[];
  routine_count: number;
  dod_preset_count: number;
  objective_examples: string[];
}

export interface TemplateRole { key: string; alias: string; role: string; reports_to: string | null; prompt: string }
export interface TemplateRoutine {
  key: string; title: string; description: string; definition_of_done: string; cron: string;
  assignee: string | null; priority: number;
}
export interface TemplateFull extends Omit<TemplateSummary, "roles" | "routine_count" | "dod_preset_count"> {
  roles: TemplateRole[];
  routines: TemplateRoutine[];
  dod_presets: { key: string; label: string; text: string }[];
}

export type PlanAction = "create" | "reuse" | "skip";

export interface TemplatePlan {
  template: { key: string; version: number; name: string; mode: ProjectMode };
  agents: { key: string; alias: string; role: string; action: PlanAction; reason: string | null }[];
  reporting: { alias: string; reports_to: string }[];
  routines: {
    key: string; title: string; definition_of_done: string; cron: string; timezone: string; schedule_text: string;
    assignee_alias: string | null; assignee_note: string | null; enabled: boolean; action: PlanAction; reason: string | null;
  }[];
  mode: { from: ProjectMode; to: ProjectMode; change: boolean };
  dod_presets: { key: string; name: string; body: string; action: PlanAction; reason: string | null }[];
  objective: { from: string | null; to: string } | null;
  counts: { agents_to_create: number; routines_to_create: number; dod_presets_to_add: number; skipped: number };
  plan_fingerprint: string;
}

export interface TemplateSelection {
  roles: string[] | null;
  routines: string[] | null;
  enable_routines: boolean;
  timezone: string;
  set_mode: boolean;
  dod_presets: boolean;
  objective: string | null;
}

export type ItemStatus = "created" | "set" | "reuse" | "skip" | "failed";

export interface ApplyResult {
  /** the new application — or, for a no-op re-apply (`noop`), the latest existing one (null if none) */
  application_id: string | null;
  template: TemplatePlan["template"];
  /** true: nothing would change, so the server recorded nothing (200, no audit row) */
  noop?: boolean;
  ok: boolean;
  result: {
    agents: { alias: string; status: ItemStatus; reason?: string | null; agent_id?: string }[];
    reporting: { alias: string; reports_to: string; status: ItemStatus; reason?: string }[];
    routines: { title: string; status: ItemStatus; reason?: string | null; routine_id?: string; enabled?: boolean; assignee_alias?: string | null }[];
    mode: { from: ProjectMode; to: ProjectMode } | null;
    dod_presets: { name: string; status: ItemStatus; reason?: string | null }[];
    objective: string | null;
    failures: string[];
  };
}

const enc = encodeURIComponent;

export const listTemplates = (signal?: AbortSignal) =>
  getJSON<{ templates: TemplateSummary[]; modes: ProjectMode[] }>("/api/project-templates", signal);

export const getTemplate = (key: string, signal?: AbortSignal) =>
  getJSON<TemplateFull>(`/api/project-templates/${enc(key)}`, signal);

export const previewTemplate = (cid: string, key: string, actor: string | null, sel: TemplateSelection) =>
  sendJSON<TemplatePlan>("POST", `/api/containers/${enc(cid)}/templates/${enc(key)}/preview`, { ...sel, actor_agent_id: actor });

/** The project changed between preview and apply: the server's fresh plan to re-review. */
export class StalePlanError extends Error {
  plan: TemplatePlan;
  constructor(message: string, plan: TemplatePlan) { super(message); this.name = "StalePlanError"; this.plan = plan; }
}

/**
 * Apply a previewed plan. A 409 that carries a fresh plan (the roster/routines changed
 * since the preview) throws StalePlanError so the UI re-shows exactly what would happen;
 * every other failure is the usual ApiError (status + plain-text detail).
 */
export async function applyTemplate(cid: string, key: string, actor: string | null, sel: TemplateSelection, fingerprint: string): Promise<ApplyResult> {
  const url = `/api/containers/${enc(cid)}/templates/${enc(key)}/apply`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...sel, actor_agent_id: actor, confirm: true, plan_fingerprint: fingerprint }),
  });
  let body: unknown = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  if (r.ok) return body as ApplyResult;
  const detail = (body as { detail?: unknown } | null)?.detail;
  const d = detail as { message?: string; plan?: TemplatePlan } | undefined;
  if (r.status === 409 && d && typeof d === "object" && d.plan) throw new StalePlanError(d.message || "The project changed since the preview", d.plan);
  const text = errorDetailText(detail);
  const err = new Error(url + " → " + r.status + (text ? ": " + text : "")) as ApiError;
  err.status = r.status;
  if (text) err.detail = text;
  throw err;
}

/** "Create 5 agents, 2 routines and 4 presets" — the apply button's exact consequence. */
export function applyLabel(c: TemplatePlan["counts"]): string {
  const parts: string[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (c.agents_to_create) parts.push(n(c.agents_to_create, "agent", "agents"));
  if (c.routines_to_create) parts.push(n(c.routines_to_create, "routine", "routines"));
  if (c.dod_presets_to_add) parts.push(n(c.dod_presets_to_add, "preset", "presets"));
  if (!parts.length) return "Apply template";
  const last = parts.pop() as string;
  return "Create " + (parts.length ? parts.join(", ") + " and " + last : last);
}

/** A routine title with its scheduler tokens shown as placeholders: "Report ‹date›". */
export function prettyRoutineTitle(title: string): string {
  return title.replace(/\{\{\s*(date|time|weekday|routine)\s*\}\}/g, "‹$1›");
}
