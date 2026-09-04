/** Status system + lease helpers, ported from app.js. */
import type { Agent } from "../types";

export const STAT: Record<string, { l: string; c: string }> = {
  working: { l: "Working", c: "s-working" },
  in_progress: { l: "In progress", c: "s-working" },
  idle: { l: "Idle", c: "s-idle" },
  pending: { l: "Pending", c: "s-idle" },
  ready: { l: "Ready", c: "s-ready" },
  blocked: { l: "Blocked", c: "s-bad" },
  awaiting_request: { l: "Waiting", c: "s-warn" },
  awaiting_human: { l: "Needs human", c: "s-warn" },
  needs_verification: { l: "Needs verify", c: "s-attn" },
  completed: { l: "Completed", c: "s-done" },
  cancelled: { l: "Cancelled", c: "s-idle" },
  failed: { l: "Failed", c: "s-bad" },
  terminated: { l: "Terminated", c: "s-bad" },
  open: { l: "Open", c: "s-warn" },
  accepted: { l: "Accepted", c: "s-ready" },
  rejected: { l: "Rejected", c: "s-bad" },
  answered: { l: "Answered", c: "s-ok" },
  converted_to_task: { l: "Converted", c: "s-acc" },
  closed: { l: "Closed", c: "s-idle" },
  escalated: { l: "Escalated", c: "s-bad" },
};

export function statusMeta(status: string | null | undefined): { l: string; c: string } {
  return STAT[status || ""] || { l: status || "unknown", c: "s-idle" };
}
export function statusClass(status: string | null | undefined): string {
  return statusMeta(status).c;
}

// S3 §3b single-embodiment lease: idle | ephemeral | resident | live.
const LEASES = ["idle", "ephemeral", "resident", "live"];
export function leaseOf(agent: (Agent & { lease_kind?: string; lease?: string }) | null | undefined): string {
  const v = agent && (agent.embodiment || agent.lease_kind || agent.lease);
  return v && LEASES.indexOf(v) >= 0 ? v : "idle";
}
