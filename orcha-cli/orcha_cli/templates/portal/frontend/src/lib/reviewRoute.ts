/**
 * Manager review handoff (mig 057) — pure read-side helpers.
 *
 * The backend routes a finished task's review through the finisher's reporting
 * chain (portal_backend/review_routing.py) and stamps two task fields:
 *   - review_routing  {routed_via: reports_to | owner | fallback | manual, …}
 *   - manager_review  {status: pending | approved | sent_back | commented |
 *                      superseded | overridden, manager_alias, reasons, …}
 * These helpers turn them into the ONE line every surface shows (verification
 * gate, Needs you row, org chart), and predict — from the snapshot's
 * reporting lines — whose reviews a person holds on the org chart.
 * An AI manager's call is a recommendation; a human always verifies.
 */
import type { Agent, ManagerReview, Snapshot, Task } from "../types";

/** "via probe's manager" / "project owner" / … — why this reviewer. Null = no route. */
export function reviewVia(t: Pick<Task, "review_routing" | "assignee">): string | null {
  const r = t.review_routing;
  if (!r) return null;
  const who = r.assignee_alias || t.assignee || "the assignee";
  switch (r.routed_via) {
    case "reports_to":
      return "via " + who + "’s " + ((r.manager_depth ?? 1) > 1 ? "manager chain" : "manager");
    case "owner":
      return "project owner";
    case "fallback":
      return "no manager in " + who + "’s chain can verify — anyone may";
    case "manual":
      return r.set_by_alias ? "set by " + r.set_by_alias : "set by a person";
    default:
      return null;
  }
}

/** "Reviewer: maya · via Forge's manager" (null when there is nothing routed to say). */
export function reviewRouteLine(t: Pick<Task, "review_routing" | "assignee" | "reviewer">): string | null {
  const via = reviewVia(t);
  if (!via) return null;
  const rv = t.reviewer;
  const name = rv == null ? "" : typeof rv === "string" ? rv : rv.alias || rv.github_login || "";
  if (t.review_routing?.routed_via === "fallback" || !name) return "Reviewer: anyone · " + via;
  return "Reviewer: " + name + " · " + via;
}

export type ManagerReviewTone = "pending" | "ok" | "bad" | "muted";

/** The AI manager pre-review, as one line + tone. Null when there is none. */
export function managerReviewLine(mr: ManagerReview | null | undefined): { text: string; tone: ManagerReviewTone } | null {
  if (!mr || !mr.status) return null;
  const who = (mr.manager_alias || "The manager") + " (manager)";
  const why = mr.reasons ? ": " + mr.reasons : "";
  switch (mr.status) {
    case "pending":
      return { text: who + " is pre-reviewing — you can still decide now", tone: "pending" };
    case "approved":
      return { text: who + " recommends approval" + why, tone: "ok" };
    case "sent_back":
      return { text: who + " sent it back" + why, tone: "bad" };
    case "commented":
      return { text: who + " commented" + why, tone: "muted" };
    case "superseded":
      return { text: (mr.manager_alias || "The manager") + "’s pre-review was skipped — a person decided first", tone: "muted" };
    case "overridden":
      return { text: who + " sent it back — accepted anyway by a person", tone: "muted" };
    default:
      return null;
  }
}

/** Short Needs-you row bit: "Atlas recommends approval" / "via probe's manager". */
export function reviewBrief(t: Pick<Task, "review_routing" | "manager_review" | "assignee">): string {
  const mr = t.manager_review;
  if (mr?.status === "approved") return (mr.manager_alias || "manager") + " recommends approval";
  if (mr?.status === "pending") return (mr.manager_alias || "manager") + " pre-reviewing";
  if (mr?.status === "commented") return (mr.manager_alias || "manager") + " commented";
  const via = reviewVia(t);
  return via && t.review_routing?.routed_via === "reports_to" ? via : "";
}

/* ---- org chart: whose reviews a person holds ------------------------------------------ */

function canVerify(a: Agent): boolean {
  return a.kind === "human" && a.member_role !== "viewer";
}

/** Where a finisher's work goes under the project's setting, from the snapshot's
 *  reporting lines (the same walk the backend does). */
export function predictRoute(snap: Pick<Snapshot, "agents" | "container"> | null, finisherId: string): { human: Agent | null; preReviewer: Agent | null } {
  const agents = snap?.agents || [];
  const byId = new Map(agents.map((a) => [String(a.id), a]));
  const route = snap?.container?.review_route ?? "manager_chain";
  if (route !== "manager_chain") return { human: null, preReviewer: null };
  const pre = snap?.container?.ai_manager_prereview !== false;
  const seen = new Set<string>([finisherId]);
  let cur = byId.get(finisherId)?.reports_to ?? null;
  let preReviewer: Agent | null = null;
  while (cur && !seen.has(String(cur))) {
    seen.add(String(cur));
    const m = byId.get(String(cur));
    if (!m) break; // retired / unknown manager: the backend passes through; the snapshot can't
    if (m.kind !== "human") {
      if (pre && !preReviewer) preReviewer = m;
    } else if (canVerify(m)) {
      return { human: m, preReviewer };
    }
    cur = m.reports_to ?? null;
  }
  return { human: null, preReviewer };
}

export interface ReviewLoad {
  /** AI agents whose finished work routes to this person (as the human reviewer or the AI pre-reviewer) */
  covers: Agent[];
  /** tasks waiting on this person's review right now */
  pending: Task[];
}

export function reviewLoad(snap: Snapshot | null, agentId: string): ReviewLoad {
  const id = String(agentId);
  const covers: Agent[] = [];
  for (const a of snap?.agents || []) {
    if (a.kind === "human" || String(a.id) === id) continue;
    const r = predictRoute(snap, String(a.id));
    if ((r.human && String(r.human.id) === id) || (r.preReviewer && String(r.preReviewer.id) === id)) covers.push(a);
  }
  const pending = (snap?.tasks || []).filter((t) => {
    if (t.status === "needs_verification" && t.reviewer_agent_id != null && String(t.reviewer_agent_id) === id) return true;
    const mr = t.manager_review;
    return t.status === "needs_verification" && mr?.status === "pending" && String(mr.manager_agent_id) === id;
  });
  return { covers, pending };
}

/** Tooltip for the org card's review fact: "Reviews finished work for 3 · 1 waiting". */
export function reviewsTitle(rv: ReviewLoad): string {
  return "Reviews finished work for " + rv.covers.length + (rv.covers.length === 1 ? " agent" : " agents") +
    (rv.pending.length ? " · " + rv.pending.length + " waiting now" : "");
}
