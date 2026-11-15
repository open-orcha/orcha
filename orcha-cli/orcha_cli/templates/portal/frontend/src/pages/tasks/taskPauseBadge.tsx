/**
 * GH #343: the paused badge for a task a person paused. It says who paused it and when
 * (and why, on hover); it reads differently from a failure or budget pause.
 */
import { HealthChip } from "../../components/primitives/HealthChip";
import { relTime } from "../../lib/format";
import type { Task } from "../../types";

export type PauseFields = Pick<Task, "paused_at" | "paused_by_alias" | "paused_reason" | "paused_via_workflow">;

export function isTaskPaused(t: PauseFields | null | undefined): boolean {
  return Boolean(t && t.paused_at);
}

/** "Paused by Kedar · 5m" — null when the task is not paused. */
export function pauseLabel(t: PauseFields): string | null {
  if (!t.paused_at) return null;
  const who = t.paused_by_alias || "a person";
  return "Paused by " + who + " · " + relTime(t.paused_at);
}

export function pauseTitle(t: PauseFields): string {
  const when = t.paused_at ? new Date(t.paused_at).toLocaleString() : "";
  const how = t.paused_via_workflow ? " (its workflow was paused)" : "";
  const why = t.paused_reason ? "\nReason: " + t.paused_reason : "";
  return "Paused by " + (t.paused_by_alias || "a person") + how + (when ? " on " + when : "") + why +
    "\nAgents don't start or continue this task until a person resumes it. You can still read and comment.";
}

export function TaskPausedChip({ t }: { t: PauseFields }) {
  const label = pauseLabel(t);
  if (!label) return null;
  return <HealthChip health="at_risk" label={label} title={pauseTitle(t)} className="td-pause-chip" />;
}

