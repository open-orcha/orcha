/**
 * The run log: `GET /api/qa/run-log`, one timeline for a run in plain words, and the headline a
 * person reads first (pure; tested). The server composes it; a page only merges what each poll
 * brings, by the line's id, since a line can change (a holder, a count) and comes back.
 */
import { getJSON, sendJSON } from "../../../api/client";
import { elapsed } from "./runFlow";

export type RunLogLevel = "info" | "wait" | "warn" | "error" | "done";

export interface RunLogEntry {
  id: string;
  at: string;
  level: RunLogLevel;
  kind: string;
  text: string;
  detail?: string;
}

export interface RunNow {
  state: "waiting" | "blocked" | "working" | "building" | "done" | "ended";
  level: RunLogLevel;
  text: string;
  since?: string;
  device?: string;
  held_by?: string;
  session_id?: string;
  free_device?: string;
  moving_to?: string;
  request_id?: string;
}

export interface RunLogAnswer {
  entries: RunLogEntry[];
  cursor: string;
  now: RunNow;
  live: boolean;
  truncated: boolean;
  task_id?: string;
  session_id?: string;
  platform?: string;
}

export interface RunLogTarget { taskId?: string | null; sessionId?: string | null }

export function getRunLog(target: RunLogTarget, after: string | null, signal?: AbortSignal): Promise<RunLogAnswer> {
  const q = new URLSearchParams();
  if (target.taskId) q.set("task_id", target.taskId);
  if (target.sessionId) q.set("session_id", target.sessionId);
  if (after) q.set("after", after);
  return getJSON<RunLogAnswer>(`/api/qa/run-log?${q}`, signal);
}

/** Send a run in line for a device to another one. */
export const sendToDevice = (sid: string, device: string, actor: string | null) =>
  sendJSON<unknown>("POST", `/api/qa/sessions/${encodeURIComponent(sid)}/use-device`, { device, actor_agent_id: actor });

/** At most this many lines stay on the page. */
export const MAX_LINES = 1000;

/** The lines on screen with what a poll brought: a known id is replaced, the rest join in time order. */
export function mergeEntries(have: readonly RunLogEntry[], got: readonly RunLogEntry[]): RunLogEntry[] {
  if (!got.length) return have as RunLogEntry[];
  const byId = new Map(have.map((e) => [e.id, e]));
  for (const e of got) byId.set(e.id, e);
  const rows = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
  return rows.length > MAX_LINES ? rows.slice(-MAX_LINES) : rows;
}

const TICKS = new Set<RunNow["state"]>(["waiting", "blocked", "building"]);

/** "Waiting for iPhone 17 Pro · held by another tool · 2:14", "Building the app · 4:02",
 * "QAEngineer is reading the code". What waits or builds says for how long. */
export function headline(now: RunNow, at: number): string {
  const t = TICKS.has(now.state) ? elapsed(now.since, at) : "";
  return t ? `${now.text} · ${t}` : now.text;
}

/** "iPad Pro 13-inch (M5)" as a button says it: "iPad Pro". */
export function deviceWord(name: string): string {
  return name.replace(/\s+\d+(\.\d+)?-inch.*$/i, "").replace(/\s+\([^)]*\)$/, "");
}

/** The hour on a line, with seconds: what happened when, on a run that lasts minutes. */
export function lineTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** The panel's quiet note when the poll has not landed for a while. Slow is no outage. */
export function behindWords(lastOkAt: number | null, at: number, afterMs = 20_000): string | null {
  if (lastOkAt == null || at - lastOkAt < afterMs) return null;
  return `Embodent is slow to answer · last update ${elapsed(new Date(lastOkAt).toISOString(), at)} ago`;
}
