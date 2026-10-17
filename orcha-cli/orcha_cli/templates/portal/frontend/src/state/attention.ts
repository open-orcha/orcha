/**
 * "Needs you" — the ONE attention definition (docs/orcha-v2-architecture.md §3).
 *
 * An attention item is one ENTITY awaiting a human decision the backend lets a
 * human make:
 *   plan    — task in_progress, no plan_decision, agent plan message present,
 *             and the plan author's (else assignee's) EFFECTIVE autonomy is
 *             "plan" (per-agent override aware — planAwaitsHuman);
 *   verify  — task needs_verification, container autonomy level is not "full";
 *   request — request open to a human (target null or a human) OR escalated.
 * One entity counts once. The badge number counts items NOT assigned to someone
 * else (a reviewer / target human who is not the acting human). Notifications,
 * run failures and blocked tasks are never attention.
 *
 * Counts come from the snapshot LISTS only — never task_open_total /
 * request_open_total (those are open-work counts, GAP-01). When the lists are
 * truncated (task_total > tasks.length …) the result is `partial`, and before
 * the first snapshot the count is `null` (unknown ≠ zero).
 */
import { useMemo, useSyncExternalStore } from "react";
import type { Agent, OrchaRequest, Snapshot, Task } from "../types";
import { reviewFor } from "../lib/reviewer";
import { payloadTitle as sharedPayloadTitle } from "../components/primitives/Payload";
import { registerTestReset } from "../lib/testResets";
import {
  actingAuthority,
  agentById,
  agentByAlias,
  autLevel,
  isToHuman,
  planAwaitsHuman,
  planMessageOf,
  useSnapshot,
} from "./SnapshotProvider";

export type AttentionKind = "plan" | "verify" | "request";

export interface AttentionItem {
  kind: AttentionKind;
  key: string; // `${kind}:${id}` — stable React key and /needs?item= value
  id: string;
  title: string;
  projectCid: string | null;
  agentAlias: string | null;
  since: string | null;
  href: string;
  assignedToOther: boolean;
  task?: Task;
  request?: OrchaRequest;
}

export interface Attention {
  items: AttentionItem[];
  count: number | null;
  partial: boolean;
  followUps: OrchaRequest[];
  /** the viewer may not decide anything here (viewer role / non-member):
   *  items are listed for context, every one is `assignedToOther`, count 0. */
  readOnly?: boolean;
}

export interface AttentionOpts {
  /** viewer role or trusted non-member — nothing is theirs to decide */
  readOnly?: boolean;
  /** identity still resolving — the count is unknown, never a guess */
  pending?: boolean;
}

const KIND_ORDER: Record<AttentionKind, number> = { plan: 0, verify: 1, request: 2 };

function ts(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY; // unknown age sorts last within its kind
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

// Human one-line title for a request (D4: never raw JSON / "{...}"): the shared
// Payload primitive's summary/question/title picker, else a humanised type.
function requestTitle(r: OrchaRequest): string {
  const type = r.type ? r.type.charAt(0).toUpperCase() + r.type.slice(1).replace(/_/g, " ") : "Request";
  // a display title (code-thread questions, lib/requestText.ts) wins over the payload's first line
  return (r.title || "").trim() || sharedPayloadTitle(r.payload, type + " request");
}

/** Is the request's target a human who is NOT the acting human? */
function requestForOtherHuman(snap: Snapshot, r: OrchaRequest, actingId: string | null): boolean {
  let target: Agent | null = null;
  if (r.target_id) target = agentById(snap, r.target_id);
  else if (r.target_id === undefined && r.to && r.to !== "human") target = agentByAlias(snap, r.to);
  if (!target || target.kind !== "human") return false;
  return actingId == null || String(target.id) !== String(actingId);
}

export function selectAttention(snap: Snapshot | null, actingHumanId: string | null, opts: AttentionOpts = {}): Attention {
  if (!snap) return { items: [], count: null, partial: false, followUps: [] };
  const cid = snap.container?.id != null ? String(snap.container.id) : null;
  const level = autLevel(snap);
  const acting = actingHumanId != null ? agentById(snap, actingHumanId) : null;
  const items: AttentionItem[] = [];

  for (const t of snap.tasks ?? []) {
    let kind: AttentionKind | null = null;
    let since: string | null = null;
    let agentAlias: string | null = t.assignee ?? null;
    if (planAwaitsHuman(snap, t)) {
      kind = "plan";
      const pm = planMessageOf(t);
      since = (pm && pm.at) || t.started_at || null;
      agentAlias = (pm && pm.from) || agentAlias;
    } else if (level !== "full" && t.status === "needs_verification") {
      kind = "verify";
      since = t.completed_at || t.started_at || t.created_at || null;
    }
    if (!kind) continue;
    // reviewer rule exactly as lib/reviewer.ts renders it today: someone
    // else's assigned review (and you are not an owner) is listed, not counted.
    const other = t.reviewer_agent_id != null || t.reviewer != null
      ? (acting ? reviewFor(t, acting) != null : t.reviewer_agent_id != null)
      : false;
    items.push({
      kind, key: `${kind}:${t.id}`, id: String(t.id), title: t.title || String(t.id),
      projectCid: cid, agentAlias, since,
      href: "/tasks?task=" + encodeURIComponent(String(t.id)),
      assignedToOther: other, task: t,
    });
  }

  const followUps: OrchaRequest[] = [];
  for (const r of snap.requests ?? []) {
    const toHuman = r.status === "open" && isToHuman(snap, r);
    if (toHuman || r.status === "escalated") {
      items.push({
        kind: "request", key: `request:${r.id}`, id: String(r.id), title: requestTitle(r),
        projectCid: cid, agentAlias: r.from && r.from !== "human" ? r.from : null,
        since: r.created_at || null,
        href: "/requests?req=" + encodeURIComponent(String(r.id)),
        assignedToOther: requestForOtherHuman(snap, r, actingHumanId), request: r,
      });
    } else if (r.status === "answered" && actingHumanId != null && String(r.requester_id) === String(actingHumanId)) {
      followUps.push(r);
    }
  }

  items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || ts(a.since) - ts(b.since));
  const partial =
    (snap.task_total != null && snap.task_total > (snap.tasks ?? []).length) ||
    (snap.request_total != null && snap.request_total > (snap.requests ?? []).length);
  if (opts.pending) {
    // identity unresolved: never count decisions for a guessed human
    return { items: items.map((i) => ({ ...i, assignedToOther: true })), count: null, partial, followUps: [] };
  }
  if (opts.readOnly) {
    // arch §3.1: attention = decisions the backend lets THIS human make — none.
    return { items: items.map((i) => ({ ...i, assignedToOther: true })), count: 0, partial: false, followUps: [], readOnly: true };
  }
  return { items, count: items.filter((i) => !i.assignedToOther).length, partial, followUps };
}

/* ---- optimistic decisions, shared app-wide --------------------------------
 * A decision made anywhere (Needs you, the task inspector, a request) hides
 * its item from EVERY attention surface at once — sidebar, header bell, tab
 * counts, the Needs-you list — instead of only the page that made it
 * (screen review: after a decision the group header said 7 while the tab,
 * header and sidebar still said 8). A mark lasts until the snapshot confirms
 * it (the key leaves attention), or DECIDED_TTL_MS as a safety net so a
 * decision the server never applied cannot hide an item forever.        */
export const DECIDED_TTL_MS = 60_000;
const decided = new Map<string, number>(); // attention key -> marked at (ms)
const listeners = new Set<() => void>();
let decidedVersion = 0;
function emit() { decidedVersion++; listeners.forEach((l) => l()); }
function subscribeDecided(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
const getDecidedVersion = () => decidedVersion;

/** Hide `key` (e.g. "plan:t1", "request:r4") everywhere until the next
 *  snapshot confirms the decision. Returns an undo for a failed request. */
export function markAttentionDecided(key: string): () => void {
  decided.set(key, Date.now());
  emit();
  return () => unmarkAttentionDecided(key);
}
export function unmarkAttentionDecided(key: string): void {
  if (decided.delete(key)) emit();
}
/** Test hook. */
export function _resetAttentionDecided(): void {
  if (!decided.size) return;
  decided.clear();
  emit();
}
registerTestReset(_resetAttentionDecided);

/** Pure: drop optimistically-decided items and recount. Prunes marks the
 *  snapshot has confirmed (key gone) or that outlived DECIDED_TTL_MS. */
export function applyDecided(a: Attention, now: number = Date.now()): Attention {
  if (!decided.size) return a;
  const live = new Set(a.items.map((i) => i.key));
  for (const [k, at] of decided) if (!live.has(k) || now - at > DECIDED_TTL_MS) decided.delete(k);
  if (!decided.size) return a;
  const items = a.items.filter((i) => !decided.has(i.key));
  if (items.length === a.items.length) return a;
  return { ...a, items, count: a.count == null ? null : a.readOnly ? 0 : items.filter((i) => !i.assignedToOther).length };
}

/** Shell/page hook: memoized on snapshot bump + acting authority + decisions. */
export function useAttention(): Attention {
  const { snap, identity, identityPending, identityTrusted, identityUnverified, bump } = useSnapshot();
  const auth = actingAuthority(snap, identity, { pending: identityPending, trusted: identityTrusted, unverified: identityUnverified });
  const actingId = auth.human?.id ?? null;
  const { readOnly } = auth;
  // an UNVERIFIED identity is unknown, not zero: the count reads "–" like pending
  const pending = auth.pending || !!auth.unverified;
  const dv = useSyncExternalStore(subscribeDecided, getDecidedVersion, getDecidedVersion);
  const base = useMemo(
    () => selectAttention(snap, actingId, { readOnly: readOnly && !pending, pending }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap, bump, actingId, readOnly, pending],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => applyDecided(base), [base, dv]);
}

/** Count label: "" for unknown, "N" or "N+" when counted from a truncated list. */
export function attentionLabel(a: Pick<Attention, "count" | "partial">): string {
  if (a.count == null) return "";
  return String(a.count) + (a.partial ? "+" : "");
}

/**
 * Open-work counts for the Tasks / Requests nav (NOT attention). Authoritative
 * server totals win; old backends fall back to counting the (possibly
 * truncated) lists: non-terminal tasks (not completed/cancelled — the backend's
 * own open definition) and open requests. The project's ROOT task is never
 * counted as open work (parity r2: a brand-new project read "1 open task"
 * while its checklist and the hub said 0 — same rule as onboarding forkCounts).
 */
export function openWorkCounts(snap: Snapshot | null): { tasks: number | null; requests: number | null } {
  if (!snap) return { tasks: null, requests: null };
  return {
    tasks: snap.task_open_total ?? (snap.tasks ?? []).filter((t) => !t.is_root && t.status !== "completed" && t.status !== "cancelled").length,
    requests: snap.request_open_total ?? (snap.requests ?? []).filter((r) => r.status === "open").length,
  };
}
