/* ---- notifier: three honest states (wakes_enabled + the daemon's stamp) ---
 * The daemon's per-tick wake scan stamps containers.last_wake_scan_at (mig
 * 037). `wakes_enabled` alone says the kill-switch is ON, not that anything is
 * actually waking agents — so a null stamp is "No wake service", a stale one
 * "Not running". An absent field (old backend) can't tell: "On".
 * Shared by the Overview and the header's Execution button. */
import type { Container } from "../types";

export const WAKE_WINDOW_MS = 2 * 60 * 1000;
export type NotifierState = "paused" | "running" | "stale" | "none" | "on";
export function notifierState(c: Pick<Container, "wakes_enabled" | "last_wake_scan_at" | "runtime_served"> | null | undefined, now = Date.now()): NotifierState {
  if (c && c.wakes_enabled === false) return "paused";
  if (!c || c.last_wake_scan_at === undefined) return "on";
  const t = Date.parse(c.last_wake_scan_at || "");
  if (!t) return "none";
  // The server's DB-clock reading (snapshot `runtime_served`) wins, so the header
  // chip and the agent presence (pages/agents/presence.ts) read ONE fact.
  if (typeof c.runtime_served === "boolean") return c.runtime_served ? "running" : "stale";
  return now - t <= WAKE_WINDOW_MS ? "running" : "stale";
}
