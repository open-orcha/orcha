/**
 * Routines API (portal_backend/routine_routes.py — contract in /openapi.json).
 * Writes carry the acting human as actor_agent_id (trust-off lane); under the trusted
 * proxy the server ignores it and uses the verified identity.
 */
import { getJSON, sendJSON } from "../../api/client";

export type RunOutcome = "pending" | "created" | "skipped" | "failed";
export type RunTrigger = "schedule" | "catch_up" | "manual";

export interface RoutineLastRun {
  run_id: string;
  outcome: RunOutcome;
  trigger: RunTrigger;
  detail: string | null;
  created_at: string;
  task_id: string | null;
  task_status: string | null;
  task_title: string | null;
  missed_count: number;
}

export interface Routine {
  id: string;
  container_id: string;
  title: string;
  description: string | null;
  definition_of_done: string;
  assignee_agent_id: string | null;
  assignee_alias: string | null;
  assignee_retired: boolean;
  priority: number;
  cron: string;
  timezone: string;
  schedule_text: string;
  enabled: boolean;
  skip_if_open: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_by_alias: string | null;
  updated_by_alias: string | null;
  created_at: string;
  updated_at: string;
  last_run: RoutineLastRun | null;
  /** server-rendered title for the next run, when the backend provides it */
  title_preview?: string | null;
  /** "Make recurring…": the task this routine was copied from (provenance only) */
  origin_task_id?: string | null;
  /** that task's current title (null when there is no origin or it was removed) */
  origin_task_title?: string | null;
}

/** Local {{date}}/{{time}}/{{weekday}} values for `at` in `tz` (mirrors
 *  routine_routes._task_texts' ctx; an unknown zone falls back to the browser's). */
function templateCtx(at: Date, tz: string, routineTitle: string): Record<string, string> {
  const parts = (zone: string | undefined) => {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long",
    });
    const o: Record<string, string> = {};
    for (const p of f.formatToParts(at)) o[p.type] = p.value;
    return o;
  };
  let o: Record<string, string>;
  try { o = parts(tz || undefined); } catch { o = parts(undefined); }
  return {
    date: `${o.year}-${o.month}-${o.day}`,
    time: `${o.hour}:${o.minute}`,
    weekday: o.weekday,
    routine: routineTitle,
  };
}

/** Render a routine template the way the scheduler does ("{{date}}" and "{{ date }}"). */
export function renderTemplate(template: string, ctx: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(ctx)) out = out.split("{{" + k + "}}").join(v).split("{{ " + k + " }}").join(v);
  return out;
}

/** True when the title carries a {{token}} the scheduler fills in. */
export function hasTemplateTokens(title: string): boolean {
  return /\{\{\s*(date|time|weekday|routine)\s*\}\}/.test(title);
}

/** The title the NEXT run's task will get (KG-2/R14): the server's preview when
 *  present, else the template resolved at next_run_at (or now) in the routine's zone. */
export function routineTitle(r: Pick<Routine, "title" | "timezone" | "next_run_at" | "enabled"> & { title_preview?: string | null }, now: Date = new Date()): string {
  if (r.title_preview) return r.title_preview;
  if (!hasTemplateTokens(r.title)) return r.title;
  const at = r.enabled && r.next_run_at ? new Date(r.next_run_at) : now;
  return renderTemplate(r.title, templateCtx(Number.isNaN(at.getTime()) ? now : at, r.timezone, r.title));
}

export interface RoutineRun {
  run_id: string;
  routine_id: string;
  trigger: RunTrigger;
  scheduled_for: string | null;
  missed_count: number;
  outcome: RunOutcome;
  task_id: string | null;
  task_title: string | null;
  task_status: string | null;
  detail: string | null;
  actor_alias: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface RoutineList {
  routines: Routine[];
  scheduler: { last_tick_at: string | null };
}

export interface RoutineInput {
  title: string;
  description: string | null;
  definition_of_done: string;
  assignee_agent_id: string | null;
  priority: number;
  cron: string;
  timezone: string;
  enabled: boolean;
  skip_if_open: boolean;
  /** create only: the task this routine is a copy of ("Created from task #…") */
  origin_task_id?: string | null;
}

export interface SchedulePreview {
  valid: boolean;
  error: string | null;
  schedule_text: string | null;
  next_runs: string[];
}

export interface RunResult {
  run_id: string;
  outcome: RunOutcome;
  task_id: string | null;
  detail: string | null;
}

const enc = encodeURIComponent;

export const listRoutines = (cid: string, signal?: AbortSignal) =>
  getJSON<RoutineList>(`/api/containers/${enc(cid)}/routines`, signal);

/** Routines made from one task — the task's "Recurring" link. */
export const listRoutinesFromTask = (cid: string, taskId: string, signal?: AbortSignal) =>
  getJSON<RoutineList>(`/api/containers/${enc(cid)}/routines?origin_task_id=${enc(taskId)}`, signal);

export const listRuns = (rid: string, signal?: AbortSignal) =>
  getJSON<{ runs: RoutineRun[] }>(`/api/routines/${enc(rid)}/runs?limit=25`, signal);

export const previewSchedule = (cid: string, cron: string, timezone: string) =>
  sendJSON<SchedulePreview>("POST", `/api/containers/${enc(cid)}/routines/preview`, { cron, timezone, count: 3 });

export const createRoutine = (cid: string, actor: string | null, body: RoutineInput) =>
  sendJSON<Routine>("POST", `/api/containers/${enc(cid)}/routines`, { ...body, actor_agent_id: actor });

export const updateRoutine = (rid: string, actor: string | null, body: Partial<RoutineInput>) =>
  sendJSON<Routine>("PATCH", `/api/routines/${enc(rid)}`, { ...body, actor_agent_id: actor });

export const deleteRoutine = (rid: string, actor: string | null) =>
  sendJSON<{ deleted: boolean }>("DELETE", `/api/routines/${enc(rid)}${actor ? "?actor_agent_id=" + enc(actor) : ""}`);

export const runRoutineNow = (rid: string, actor: string | null) =>
  sendJSON<RunResult>("POST", `/api/routines/${enc(rid)}/run`, { actor_agent_id: actor });
