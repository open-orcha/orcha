/**
 * Live frames of a running session. While it runs the tool server pushes the device screen to the
 * portal, which keeps only the latest frame in memory (`qa_live_routes.py`), and the page polls
 * `GET /api/qa/sessions/{id}/live`: `{ n, cmd_seq, ... }`, how many frames came (the image changes
 * when `n` does), and the newest input of the person driving that the frame shows the result of.
 *
 * A session that could not start a stream gets each step's frame instead, through the same route.
 */
import { QA_NO_HUMAN_REASON } from "../../authority";
import type { RecordingCommand } from "./recording";

const enc = encodeURIComponent;

export interface LiveFrame {
  /** The route of the newest live JPEG. */
  path: string;
  /** Frames so far: the cache-busting token for `path`. */
  n: number;
  /** The newest input (`seq`) the frame shows the result of. */
  cmdSeq: number;
}

/** Who is driving the device, when it is not the agent. */
export interface LiveTakeover {
  by_id: string;
  by: string;
  since: string;
}

/** What `GET .../live` answers. */
export interface LiveMeta {
  status: string;
  n: number;
  cmd_seq: number;
  at: number | null;
  /** How long nothing has moved on the device. */
  activity_age_ms: number | null;
  /** How long since the tool server was last heard. */
  beat_age_ms: number | null;
  /** The device streams its screen; false: a frame per step. */
  stream: boolean;
  screen_w: number | null;
  screen_h: number | null;
  takeover: LiveTakeover | null;
  inputs: { seq: number; kind: RecordingCommand["kind"]; args: RecordingCommand["args"]; status: RecordingCommand["status"]; result: string | null }[];
  /** Why the last takeover ended on its own. */
  notice: string | null;
}

export function liveFramePath(sessionId: string): string {
  return `/api/qa/sessions/${enc(sessionId)}/live/frame`;
}

export function liveMetaPath(sessionId: string): string {
  return `/api/qa/sessions/${enc(sessionId)}/live`;
}

/** The live frame a live state describes, or null when it isn't one. */
export function parseLiveMeta(sessionId: string, raw: unknown): LiveFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const { n, cmd_seq } = raw as { n?: unknown; cmd_seq?: unknown };
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return null;
  return { path: liveFramePath(sessionId), n, cmdSeq: typeof cmd_seq === "number" && Number.isFinite(cmd_seq) ? cmd_seq : 0 };
}

/** The session is over, by what the portal said. An answer that names no status says nothing. */
export function sessionEnded(meta: Pick<LiveMeta, "status"> | null): boolean {
  return typeof meta?.status === "string" && meta.status !== "running";
}

/** The same but for its clocks, down to the minute: most reads change nothing on the page. */
export function sameLiveMeta(a: LiveMeta | null, b: LiveMeta): boolean {
  if (!a) return false;
  const key = (m: LiveMeta) =>
    JSON.stringify({ ...m, activity_age_ms: staleMinutesOf(m), beat_age_ms: toolServerGone(m) });
  return key(a) === key(b);
}

/** Poll this soon after it changed (the stream's frame interval)... */
export const LIVE_FAST_MS = 66;
/** ...backing off by this factor while it doesn't, up to... */
export const LIVE_BACKOFF = 1.5;
export const LIVE_SLOW_MS = 400;
/** ...and this slowly while there is no live frame at all (none yet, or the stream ended). */
export const LIVE_ABSENT_MS = 1_000;
/** A read of the live state (and the load of its frame) not done by then is abandoned. */
export const LIVE_TIMEOUT_MS = 5_000;

/** How long until the next read, after a read that `changed` it or not. */
export function nextLiveDelay(previousMs: number, changed: boolean, present: boolean): number {
  if (!present) return LIVE_ABSENT_MS;
  if (changed) return LIVE_FAST_MS;
  return Math.min(LIVE_SLOW_MS, Math.max(LIVE_FAST_MS, Math.round(previousMs * LIVE_BACKOFF)));
}

/** Minutes without activity before the stale banner shows. */
export const STALE_BANNER_MINUTES = 2;
/** ...and before it turns from a caution to a warning. */
export const STALE_WARNING_MINUTES = 5;
/** Without a beat for this long nothing is running the session any more. */
export const TOOL_SERVER_GONE_MS = 30_000;

export function staleMinutesOf(meta: LiveMeta | null): number | null {
  if (!meta || meta.status !== "running" || meta.activity_age_ms == null) return null;
  return Math.floor(meta.activity_age_ms / 60_000);
}

export function staleBannerTone(staleMinutes: number | null | undefined): "warning" | "danger" | null {
  if (staleMinutes == null || staleMinutes < STALE_BANNER_MINUTES) return null;
  return staleMinutes >= STALE_WARNING_MINUTES ? "danger" : "warning";
}

/** The session is still `running` but its tool server is gone, so nothing will ever finish it. */
export function toolServerGone(meta: LiveMeta | null): boolean {
  return Boolean(meta && meta.status === "running" && meta.beat_age_ms != null && meta.beat_age_ms > TOOL_SERVER_GONE_MS);
}

export type LivePhase = "waiting" | "live" | "abandoned" | "ended";

/** What the view says about the device. `waiting`: running, no screen has come yet. */
export function livePhase(meta: LiveMeta | null, status: string | null | undefined, hasFrame: boolean): LivePhase {
  if (sessionEnded(meta) || (typeof meta?.status !== "string" && status != null && status !== "running")) return "ended";
  if (toolServerGone(meta)) return "abandoned";
  return hasFrame ? "live" : "waiting";
}

/** Why a person can't take the device over right now, or null. */
export function takeoverBlock(phase: LivePhase, meta: LiveMeta | null, auth: { can: boolean; human: { id: string } | null; reason: string | null } | undefined): string | null {
  if (!auth) return "View-only";
  if (!auth.can) return auth.reason || QA_NO_HUMAN_REASON;
  if (phase === "ended") return "The session has ended.";
  if (phase === "abandoned") return "Nothing is running this session.";
  if (!meta || meta.beat_age_ms == null) return "The device isn’t connected yet.";
  const held = meta.takeover;
  if (held && held.by_id !== auth.human?.id) return `${held.by} is driving this device.`;
  return null;
}
