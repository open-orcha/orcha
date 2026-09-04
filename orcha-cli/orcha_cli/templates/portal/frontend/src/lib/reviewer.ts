/**
 * Collab v1 reviewer helpers — pure ports of the cloud vanilla's logic:
 *   - modules/app-data.js actingOwner (trust-off branch — open has no verified
 *     GitHub identity, so the acting human's snapshot member_role decides,
 *     PERMISSIVE when the field is absent);
 *   - pages/tasks-detail.js reviewerChip (label/face resolution);
 *   - pages/home-state.js renderQueue (someone-else's-review de-emphasis).
 *
 * Graceful absence on open backends: with no member_role on the roster AND no
 * reviewer fields on any task, reviewerSupported() is false — the pages render
 * nothing reviewer-related and never call PUT /api/tasks/{tid}/reviewer.
 */
import type { Agent, Snapshot, Task } from "../types";

/** The resolved reviewer as the pages render it (cloud sends
 *  {agent_id, alias, github_login}; open backends may omit everything). */
export interface ReviewerRef {
  agent_id?: string | null;
  alias?: string;
  github_login?: string | null;
}

/** Task.reviewer normalized: an object passes through; a bare string (a raw
 *  id from a snapshot that couldn't resolve it) renders as-is via alias;
 *  null/undefined -> null. */
export function reviewerRef(t: Pick<Task, "reviewer">): ReviewerRef | null {
  const r = t.reviewer;
  if (r == null) return null;
  if (typeof r === "string") return { alias: r };
  return r as ReviewerRef;
}

/** Chip label — vanilla: r.github_login || r.alias. */
export function reviewerLabel(r: ReviewerRef | null): string {
  if (!r) return "";
  return r.github_login || r.alias || "";
}

/** app-data.js actingOwner, trust-off branch: the acting human's snapshot
 *  member_role decides — permissive when the field is absent (open backends /
 *  old snapshot in flight), mirroring the backend's trust-off fallback. */
export function isActingOwner(h: Agent | null): boolean {
  return !!(h && (h.member_role === "owner" || h.member_role == null));
}

/** Does this snapshot speak collab v1 at all? Open backends ship neither
 *  member_role on agents nor reviewer fields on tasks — then the reviewer
 *  chip/picker render nothing and the endpoint is never called. */
export function reviewerSupported(snap: Pick<Snapshot, "agents" | "tasks"> | null): boolean {
  if (!snap) return false;
  if ((snap.agents || []).some((a) => a.member_role != null)) return true;
  return (snap.tasks || []).some((t) => t.reviewer != null || t.reviewer_agent_id != null);
}

/** home-state.js verify-card rule, with the acting human standing in for the
 *  cloud's verified identity: a verify card for a task whose owner-assigned
 *  reviewer is SOMEONE ELSE — and the actor is not an owner (permissive when
 *  member_role is absent) — is de-emphasized and labeled "review: <login>".
 *  Frontend-only: the backend verify gate stays permissive (any human CAN
 *  verify). Returns the reviewer label when the card is theirs-not-yours,
 *  else null (render normally). */
export function reviewFor(t: Pick<Task, "reviewer" | "reviewer_agent_id">, h: Agent | null): string | null {
  const r = reviewerRef(t);
  if (!r || !h) return null;
  const rid = t.reviewer_agent_id ?? r.agent_id;
  if (rid == null) return null;
  if (String(h.id) === String(rid)) return null; // it's YOUR review
  if (isActingOwner(h)) return null; // owners see every card normally
  return reviewerLabel(r);
}
