/**
 * D8/D9 live status pill on agent work (Linear "Agent tasks"): a rounded-full
 * outline chip reading "Working…", "Waiting", "Needs review", "Error" or
 * "Finished", followed by the actor avatar(s).
 *
 * Calm (Linear reference): the TEXT is always neutral. States that need
 * attention ("Error", "Needs review") add a small coloured dot before the word;
 * the word itself carries the meaning, so colour is never the only signal.
 *
 * Truthfulness: `liveStateFor` derives the state ONLY from real statuses and
 * returns null when there is nothing live to say (ready/pending/cancelled/idle
 * with no run) — callers render no pill then. It never invents "Working".
 */
import { AvatarStack, type AvatarActor } from "./Avatar";

export type LiveState = "working" | "waiting" | "needs_review" | "error" | "finished";

export const LIVE_LABEL: Record<LiveState, string> = {
  working: "Working…",
  waiting: "Waiting",
  needs_review: "Needs review",
  error: "Error",
  finished: "Finished",
};

/** Attention dot tone per state (null = no dot; the pill stays fully neutral). */
export const LIVE_DOT: Record<LiveState, "danger" | "warn" | null> = {
  working: null,
  waiting: null,
  needs_review: "warn",
  error: "danger",
  finished: null,
};

/**
 * Map real statuses to a live state. Pass whatever you have:
 *  - `runStatus`   a run's status (running / failed / completed …) — strongest signal
 *  - `agentStatus` the actor's status (working / awaiting_request / awaiting_human …)
 *  - `taskStatus`  the task's status (in_progress / needs_verification / failed / completed …)
 */
export function liveStateFor(s: { taskStatus?: string | null; agentStatus?: string | null; runStatus?: string | null }): LiveState | null {
  const { taskStatus: t, agentStatus: a, runStatus: r } = s;
  if (t === "needs_verification") return "needs_review";
  if (r === "running" || r === "working" || r === "active") return "working";
  if (r === "failed" || r === "error" || r === "terminated") return "error";
  if (t === "failed" || t === "terminated") return "error";
  if (a === "working" && (t == null || t === "in_progress")) return "working";
  if (a === "awaiting_request" || a === "awaiting_human" || t === "awaiting_request" || t === "awaiting_human") return "waiting";
  if (t === "completed") return "finished";
  // in_progress with no actor info → the task itself says work is under way; an idle/other actor → no pill
  if (t === "in_progress") return a == null ? "working" : null;
  return null;
}

export interface LivePillProps {
  state: LiveState;
  /** Actor(s) doing the work — rendered as an overlapping stack after the label. */
  actors?: AvatarActor[];
  /** Override the label text (keep it one of the canonical words). */
  label?: string;
  title?: string;
  className?: string;
}

export function LivePill({ state, actors, label, title, className }: LivePillProps) {
  const text = label ?? LIVE_LABEL[state];
  const who = (actors || []).map((a) => a.alias).filter(Boolean).join(", ");
  const tip = title ?? (who ? `${text} — ${who}` : text);
  return (
    <span className={`v2-live is-${state}${className ? " " + className : ""}`} title={tip} data-live={state}>
      {LIVE_DOT[state] ? <span className={`v2-live-dot is-${LIVE_DOT[state]}`} aria-hidden="true" /> : null}
      <span className="v2-live-text">{text}</span>
      {actors && actors.length ? <AvatarStack actors={actors} size={16} max={3} /> : null}
    </span>
  );
}
