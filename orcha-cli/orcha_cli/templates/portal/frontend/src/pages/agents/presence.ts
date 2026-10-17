/**
 * ONE presence value for the agent workspace (review blocker: the header, the
 * meta line, the conversation chip, the runtime banner and the Runs tab used to
 * disagree — "Working · in convo" beside "No active run" beside "1 running").
 *
 * Everything is derived from real signals, strongest first:
 *   1. agent.status === failed            → Failed   (the newest failed run's reason)
 *   2. agent.status awaiting_human/blocked→ Needs you / Blocked — an attention
 *      state is never hidden behind "Working" (r2 blocker: the header said
 *      Working while the roster, board and sidebar said Needs human / Blocked)
 *   3. a RUNNING worker run (/runs), the snapshot's running_run / active_run, or
 *      agent.status working                            → Working  (r3 parity: the header reads /runs,
 *      the roster/board/sidebar read the snapshot — both rank "working" the SAME way;
 *      when no host runtime has reported in, the tooltip says so)
 *   4. no host runtime serves the project → No runtime (messages only queue)
 *   5. wakes paused for the project       → Paused
 *   6. the conversation's presence field  → Working / Waking / Busy / Offline …
 *   7. agent.status                       → Waiting / Idle …
 * The label renders ONCE (header pill); the reason + lease go in its tooltip.
 * Every surface (workspace header, sidebar, Agents board + roster) calls THIS.
 */
import type { Agent, Run, Snapshot } from "../../types";
import { leaseOf } from "../../lib/status";

/** Is a host-side notifier serving this project's wakes? (stamp within ~2 min) */
export const WAKES_SERVED_WINDOW_MS = 2 * 60 * 1000;
export function wakesServed(c: Snapshot["container"] | null | undefined, now = Date.now()): boolean {
  const t = Date.parse((c && c.last_wake_scan_at) || "");
  return !!t && now - t <= WAKES_SERVED_WINDOW_MS;
}
/** Absent data (snapshot not loaded yet) reads as SERVED so nothing false-alarms while booting.
 *  The server's own reading (`container.runtime_served`, DB clock) wins over the
 *  browser-clock `wakesServed` fallback, which only older backends need. */
export function projectServed(snap: Snapshot | null | undefined, now = Date.now()): boolean {
  const c = snap && snap.container;
  if (!c) return true;
  if (typeof c.runtime_served === "boolean") return c.runtime_served;
  return wakesServed(c, now);
}

export type PresenceKey = "failed" | "working" | "noruntime" | "paused" | "busy" | "waking" | "needs" | "waiting" | "blocked" | "offline" | "idle";
export interface AgentPresence {
  k: PresenceKey;
  label: string;
  /** tooltip: why, in one or two short sentences */
  reason: string;
  /** dot tone for the pill */
  tone: "progress" | "warn" | "danger" | "muted" | "hollow";
}

export interface ConvPresence {
  presence: string | null;
  reason: string | null;
}

const LEASE_NOTE: Record<string, string> = {
  live: "In a live terminal session.",
  resident: "Holding a live conversation.",
  ephemeral: "Running a task.",
};

export const RUNTIME_REASON = "This project has no agent runtime yet — messages queue until a workspace binds on the host.";
/** Tooltip note on a Working agent whose project has no live host runtime (scanner offline). */
export const SCANNER_OFFLINE_NOTE = "No host runtime has reported in the last 2 minutes, so this may be out of date and new messages only queue.";
export const PAUSED_REASON = "Wakes are paused for this project — nothing wakes this agent until they resume.";
/** Tooltip note on a run the snapshot reports running whose lease has lapsed. */
export const STALE_RUN_NOTE = "Its lease has lapsed, so this run may have stopped and not been cleaned up yet.";
const PAUSE_WHY: Record<string, string> = {
  project_status: "This project isn't active, so no new wakes start.",
  project_wakes_off: "Wakes are paused for this project.",
  agent_wakes_off: "Wakes are paused for this agent.",
};
/** A pause only refuses NEW wakes — a run already in flight keeps going (backend
 *  `pause_stops_running_run: false`), so a paused agent with a run still reads Working. */
function pauseNote(a: Agent): string {
  if (!a.wakes_paused) return "";
  const why = PAUSE_WHY[a.wakes_paused_reason || ""] || "New wakes are paused.";
  return a.pause_stops_running_run ? why : why + " The current run keeps going until it finishes.";
}

export function agentPresence(
  a: Agent,
  opts: { snap: Snapshot | null; runs?: Run[] | null; conv?: ConvPresence | null; failReason?: string | null; now?: number },
): AgentPresence {
  const lease = leaseOf(a);
  const leaseNote = lease && lease !== "idle" ? LEASE_NOTE[lease] || "" : "";
  const withLease = (s: string) => [s, leaseNote].filter(Boolean).join(" ");
  if (a.kind === "human") return { k: "idle", label: "Human", reason: "Humans are the authority — no runs, wakes or model.", tone: "muted" };
  if (a.status === "failed") {
    return { k: "failed", label: "Failed", reason: opts.failReason || "The agent is marked failed.", tone: "danger" };
  }
  const convReason0 = (opts.conv && opts.conv.reason) || "";
  if (a.status === "awaiting_human") return { k: "needs", label: "Needs you", reason: convReason0 || "Waiting on a human decision.", tone: "warn" };
  if (a.status === "blocked") return { k: "blocked", label: "Blocked", reason: convReason0 || "Blocked.", tone: "danger" };
  const running = (opts.runs || []).find((r) => r.status === "running");
  const served = projectServed(opts.snap, opts.now);
  const marked = a.status === "working" || a.status === "in_progress";
  // `running_run` is the snapshot's copy of what /runs reports as running (not
  // lease-gated), so the roster/board agree with the header even before /runs loads.
  const snapRun = a.running_run || null;
  if (running || snapRun || a.active_run || marked) {
    const base = running || snapRun || a.active_run ? "A worker run is in progress." : "Marked working.";
    const stale = !running && !a.active_run && snapRun && snapRun.lease_live === false ? STALE_RUN_NOTE : "";
    const reason = [base, stale, served ? "" : SCANNER_OFFLINE_NOTE, pauseNote(a)].filter(Boolean).join(" ");
    return { k: "working", label: "Working", reason: withLease(reason), tone: "progress" };
  }
  // Waiting on a request answer is the agent's own fact (like awaiting_human / blocked
  // above): a stale wake scan must not hide it behind the project-wide "No runtime".
  if (a.status === "awaiting_request") return { k: "waiting", label: "Waiting", reason: convReason0 || "Waiting on a request answer.", tone: "muted" };
  if (!served) return { k: "noruntime", label: "No runtime", reason: RUNTIME_REASON, tone: "hollow" };
  const conv = opts.conv;
  const convReason = (conv && conv.reason) || "";
  const wakesPaused = !!(opts.snap?.container && opts.snap.container.wakes_enabled === false);
  if (conv && conv.presence === "stopped") {
    // the backend's reason is the truth: "Wakes are paused for this agent" reads Paused, not Offline
    if (/paused/i.test(convReason)) return { k: "paused", label: "Paused", reason: convReason, tone: "hollow" };
    return { k: "offline", label: "Offline", reason: convReason || "The agent's session is stopped.", tone: "hollow" };
  }
  if (conv && conv.presence === "busy") return { k: "busy", label: "Busy", reason: convReason || withLease("Busy with another task — messages queue."), tone: "warn" };
  if (conv && (conv.presence === "working" || conv.presence === "waking")) {
    return { k: conv.presence === "working" ? "working" : "waking", label: conv.presence === "working" ? "Working" : "Waking", reason: withLease(convReason || "Replying in the conversation."), tone: "progress" };
  }
  if (wakesPaused) return { k: "paused", label: "Paused", reason: PAUSED_REASON, tone: "hollow" };
  if (a.wakes_paused && a.wakes_paused_reason === "agent_wakes_off") {
    return { k: "paused", label: "Paused", reason: "Wakes are paused for this agent — nothing wakes it until they resume.", tone: "hollow" };
  }
  switch (a.status) {
    case "working":
    case "in_progress":
      return { k: "working", label: "Working", reason: withLease(convReason || "Marked working."), tone: "progress" };
    case "awaiting_human":
      return { k: "needs", label: "Needs you", reason: convReason || "Waiting on a human decision.", tone: "warn" };
    case "awaiting_request":
      return { k: "waiting", label: "Waiting", reason: convReason || "Waiting on a request answer.", tone: "muted" };
    case "blocked":
      return { k: "blocked", label: "Blocked", reason: convReason || "Blocked.", tone: "danger" };
    case "terminated":
      return { k: "offline", label: "Terminated", reason: "The agent was terminated.", tone: "hollow" };
    default:
      return { k: "idle", label: "Idle", reason: withLease(convReason || "Nothing running."), tone: "muted" };
  }
}

/** Legacy / uncurated model ids read as a product name: claude-opus-4-1-20250805 → "Opus 4.1". */
export function humanizeModelId(id: string): string {
  const s = String(id || "").trim();
  const cl = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(s);
  if (cl) return cl[1].charAt(0).toUpperCase() + cl[1].slice(1) + " " + cl[2] + (cl[3] ? "." + cl[3] : "");
  const cl2 = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/i.exec(s); // claude-3-5-sonnet-20241022
  if (cl2) return cl2[3].charAt(0).toUpperCase() + cl2[3].slice(1) + " " + cl2[1] + (cl2[2] ? "." + cl2[2] : "");
  if (/^gpt-/i.test(s)) return "GPT-" + s.slice(4);
  return s;
}
