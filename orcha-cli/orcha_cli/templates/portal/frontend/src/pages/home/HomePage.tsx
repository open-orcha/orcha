/**
 * Project Overview (Orcha V2; parity H-01…H-07, R-01). The project's `/`.
 *
 * D10 "Pulse-like and much simpler" — one centred column:
 *   1. summary: the objective line and ONE muted facts line (AI agents ·
 *      people · open tasks · open requests, plus blocked / failed only when
 *      non-zero — each a link to that filtered list). No per-status stat wall:
 *      the full breakdown lives on Tasks;
 *   2. setup checklist — ONLY for an empty project (then nothing else renders);
 *   3. Needs you (top few) — a D8 band + Inbox-style one-line rows;
 *   4. Active work — a D8 band + My-issues-style one-line rows (status glyph,
 *      title, live pill / assignee avatar, age). A plan waiting on a human is
 *      listed under Needs you only, never again here;
 *   5. Updates — the same band, then a Timeline feed grouped under Today /
 *      Yesterday / date dividers (messages, requests asked/answered, finished).
 * Facts the header already shows (Notifier state + autonomy live in the
 * header's Execution chip) are NOT repeated here (D12 "same fact twice").
 * Every section links to its full view:
 *   Agents        → /agents   (People → /settings#tab=members)
 *   Open tasks    → /tasks?status=pending,ready,in_progress,blocked,needs_verification
 *                   (the backend's task_open_total = everything but completed/cancelled)
 *   Open requests → /requests?filter=open   (request_open_total = status "open")
 *   Needs you     → /needs when that page exists, else this page's queue
 *   Blocked/failed → /tasks?status=<status>
 *   Updates       → /activity
 * (The `status` / `filter` params are the V2 Tasks/Requests URL contract, arch §2.1.)
 *
 * Needs you uses the ONE attention definition (state/attention.ts): plans at
 * autonomy "plan", verifications unless "full", requests open to a human or
 * escalated; someone else's review is listed de-emphasized but not counted.
 * When the dedicated /needs queue exists the Overview shows compact preview
 * rows that open the exact item there (`/needs?item=<kind>:<id>`) — the
 * decision itself (with full context) happens once, on /needs. Without it the
 * Overview keeps the inline gate actions (backend UNCHANGED, bodies verbatim
 * from the pre-V2 dashboard): POST /api/decisions (plan_approval) and
 * POST /api/tasks/{tid}/verify, both carrying the acting human's id;
 * rejection always requires a typed reason.
 */
import { useEffect, useMemo, useState, type AnchorHTMLAttributes } from "react";
import { Link } from "react-router-dom";
import { getJSON, sendJSON } from "../../api/client";
import { relTime, shortId, trunc } from "../../lib/format";
import { reviewFor } from "../../lib/reviewer";
import { actingHuman, agentByAlias, useSnapshot } from "../../state/SnapshotProvider";
import { openWorkCounts, useAttention, type AttentionItem } from "../../state/attention";
import { Icon, Linkified, useToast } from "../../components/ui";
import {
  Avatar, AvatarStack, Button, ButtonLink, Chip, Dialog, EmptyState, LivePill, PriorityIcon, Skeleton, StatusGlyph, StatusIcon, Tooltip,
  payloadTitle, statusLabel,
} from "../../components/primitives";
import { HelpTip, ListGroup } from "../../components/primitives";
import { FilterPills } from "../../components/primitives";
import { RelTime, Timeline, TimelineDivider, TimelineEvent } from "../../components/primitives";
import { HAS_NEEDS_PAGE } from "../../shell/optionalPages";
import { Shell, snapshotErrorKind } from "../../shell/Shell";
import { useProjects } from "../../state/projects";
import { useOpenCompose } from "../../shell/chrome";
import type { ActiveRun, Agent, OrchaRequest, Snapshot, Task } from "../../types";
import { plainPreview } from "../needs/plainPreview";
import { requestAnsweredBy } from "../activity/events";
import { notifierState } from "../../lib/notifier";
import { projectStatusMeta } from "../../cloud/projects/projectStatus";
import "./overview.css";

/** Non-terminal task statuses — the backend's "open" (everything but completed/cancelled). */
export const OPEN_TASK_STATUSES = ["pending", "ready", "in_progress", "blocked", "needs_verification"];
export const OPEN_TASKS_HREF = "/tasks?status=" + OPEN_TASK_STATUSES.join(",");
export const OPEN_REQUESTS_HREF = "/requests?filter=open";
export const MEMBERS_HREF = "/settings#tab=members";
export const DONE_TASKS_HREF = "/tasks?status=completed,cancelled";
export const statusHref = (s: string) => "/tasks?status=" + encodeURIComponent(s);
/** `/needs?item=<kind>:<id>` — the ':' stays readable in the URL. */
export const needsItemHref = (key: string) => "/needs?item=" + encodeURIComponent(key).replace(/%3A/gi, ":");
/** Items shown inline on the Overview when the dedicated /needs queue exists. */
const NEEDS_PREVIEW = 5;
/** Active-work rows shown before "View all". */
const ACTIVE_PREVIEW = 6;
/** Band collapse state persists per section under `${OV_GROUP_KEY}:<id>`. */
export const OV_GROUP_KEY = "orcha:v2:ovGroups";

export { notifierState, type NotifierState } from "../../lib/notifier";

/* ---- in-app link: SPA navigation (the persistent sidebar stays mounted; the
 * shell re-pins ?cid= after every route change). Same href as before. ----- */
function Go({ href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <Link to={href} {...rest} />;
}

/* ---- deeplink helper ------------------------------------------------------ */
function AgentLink({ snap, alias }: { snap: Snapshot | null; alias: string | null | undefined }) {
  const a = agentByAlias(snap, alias);
  if (!a) return <>{alias || "Unknown"}</>;
  return (
    <Go className="dlink" href={agentHref(alias!)}>
      <Avatar alias={alias} kind={a.kind} size={16} decorative />
      <span>{alias}</span>
    </Go>
  );
}

/** `/agents?agent=<alias>` — the agent deep link (only for an agent that exists). */
export const agentHref = (alias: string) => "/agents?agent=" + encodeURIComponent(alias);

/* ---- ISS-68 plan text/author (thread-free via plan_message) -------------- */
function planText(t: Task): string {
  if (t.plan_message) return t.plan_message.body || "";
  const m = (t.thread || []).filter((x) => !x.is_human);
  return m.length ? m[0].body : "";
}
function planAuthor(t: Task): string | null | undefined {
  if (t.plan_message) return t.plan_message.author_alias || (t.assignees || [])[0];
  const m = (t.thread || []).filter((x) => !x.is_human);
  return m.length ? m[0].from || (t.assignees || [])[0] : (t.assignees || [])[0];
}

/* ---- #340 friendly labels for task-less live worker runs ----------------- */
const RUN_LABELS: Record<string, string> = {
  conversation_turn: "In conversation", request_answered: "Handling a reply",
  request_created: "Handling a request", request_closed: "Wrapping up a request",
  task_message: "On a task thread", checkpoint_respawn: "Checking in",
  auto_wake: "Auto-wake check", task_request_accepted: "Picked up a task",
  task_verified: "Verifying a task", live_terminal: "Live terminal",
  task_assigned: "Starting a task", decision_made: "Acting on a decision", prompt: "Working",
};
export function runLabel(ar: ActiveRun): string {
  if (ar.has_conversation) return RUN_LABELS.conversation_turn;
  return RUN_LABELS[ar.wake_event || ""] || (ar.wake_event ? ar.wake_event.replace(/_/g, " ") : "Working");
}
const ts = (iso: string | null | undefined) => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/* ---- updates feed: synthesized from the snapshot (SSE is escalations-only) */
type ActKind = "post" | "decision" | "request" | "answer" | "outcome";
export interface ActEvent {
  who: string | null; human: boolean; kind: ActKind; ctx: string; text: string; at: string; link: string;
  /** exact task status for "outcome" events (completed / cancelled — never merged) */
  status?: string;
}
/** Feed filter pills. */
export type FeedFilter = "all" | "messages" | "requests" | "outcomes";
const FEED_OF: Record<ActKind, FeedFilter> = { post: "messages", decision: "messages", request: "requests", answer: "requests", outcome: "outcomes" };
/** Events considered (per filter) and shown on the Overview; the full history is on /activity. */
export const FEED_LIMIT = 60;
export const FEED_SHOWN = 12;

const isMessage = (e: ActEvent) => e.kind === "post" || e.kind === "decision";
/**
 * The events a feed filter shows (newest first). "All" is a summary, not the
 * full log (that is /activity): messages are the most frequent event, so they
 * may fill at most two thirds of the shown lines while requests, answers and
 * finished tasks exist in the window — otherwise "All" reads as a wall of
 * "X posted on Y" and the other kinds only surface through their pills.
 */
export function pickFeed(evs: ActEvent[], filter: FeedFilter, n = FEED_SHOWN): ActEvent[] {
  if (filter !== "all") return evs.filter((e) => FEED_OF[e.kind] === filter).slice(0, n);
  const msgs = evs.filter(isMessage), others = evs.filter((e) => !isMessage(e));
  const reserve = Math.min(others.length, Math.ceil(n / 3));
  const takeMsgs = Math.min(msgs.length, n - reserve);
  const takeOthers = Math.min(others.length, n - takeMsgs);
  return [...msgs.slice(0, takeMsgs), ...others.slice(0, takeOthers)].sort((a, b) => ts(b.at) - ts(a.at));
}

export function activityEvents(tasks: Task[], requests: OrchaRequest[], limit = FEED_LIMIT): ActEvent[] {
  const out: ActEvent[] = [];
  // ISS-68: no full threads in the snapshot — use message_summary.last per task;
  // fall back to an expanded thread if one is present.
  tasks.forEach((t) => {
    const link = "/tasks?task=" + encodeURIComponent(t.id);
    const thread = t.thread || [];
    if (thread.length) {
      thread.forEach((m) => out.push({
        who: m.from || (m.is_human ? "human" : null), human: !!m.is_human, kind: m.is_human ? "decision" : "post",
        ctx: t.title, text: trunc(plainPreview(m.body || ""), 160), at: m.at || "", link,
      }));
    } else {
      const last = t.message_summary && t.message_summary.last;
      if (last) {
        const lastAt = (last as { created_at?: string; at?: string }).created_at ?? last.at ?? "";
        out.push({
          who: last.author_alias || (last.is_human ? "human" : null), human: !!last.is_human,
          kind: last.is_human ? "decision" : "post",
          ctx: t.title, text: trunc(plainPreview(last.body || ""), 160), at: lastAt, link,
        });
      }
    }
    // a finished task is an update — dated by its real completion stamp only
    if ((t.status === "completed" || t.status === "cancelled") && t.completed_at) {
      out.push({ who: null, human: false, kind: "outcome", status: t.status, ctx: t.title, text: "", at: t.completed_at, link });
    }
  });
  requests.forEach((r) => {
    const link = "/requests?req=" + encodeURIComponent(r.id);
    const title = trunc(r.title || payloadTitle(r.payload, (r.type || "request") + " request"), 90);
    out.push({ who: r.from || null, human: r.from === "human", kind: "request", ctx: title, text: "", at: r.created_at || "", link });
    if (r.responded_at) {
      // parity r2: an answer given before an escalation belongs to the agent it was
      // escalated away from, not the human it now targets (same rule as Activity).
      const by = requestAnsweredBy(r);
      out.push({ who: by, human: by === "human", kind: "answer", ctx: title, text: trunc(payloadTitle(r.response), 160), at: r.responded_at, link });
    }
  });
  return out
    .filter((e) => ts(e.at) > 0)
    .sort((a, b) => ts(b.at) - ts(a.at))
    .slice(0, limit);
}

/** Day divider label for the feed: "Today", "Yesterday", else a short date (local time). */
export function dayLabel(at: string, now: Date = new Date()): string {
  const d = new Date(at);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** Group feed events (already newest-first) under consecutive day labels. */
export function groupByDay(evs: ActEvent[], now: Date = new Date()): { day: string; events: ActEvent[] }[] {
  const out: { day: string; events: ActEvent[] }[] = [];
  evs.forEach((e) => {
    const day = dayLabel(e.at, now);
    const last = out[out.length - 1];
    if (last && last.day === day) last.events.push(e);
    else out.push({ day, events: [e] });
  });
  return out;
}

/* ---- task-status breakdown (exact statuses, never merged) ----------------- */
const STATUS_ORDER = ["needs_verification", "in_progress", "ready", "pending", "blocked", "failed", "completed", "cancelled"];
export function statusBreakdown(tasks: Task[]): { status: string; tasks: Task[] }[] {
  const by = new Map<string, Task[]>();
  // the root/objective task is the project itself, not a unit of work — it is
  // excluded here exactly as it is from "Active work" (one number per fact)
  tasks.forEach((t) => { if (t.is_root) return; const k = t.status || "unknown"; by.set(k, [...(by.get(k) || []), t]); });
  const keys = [...by.keys()].sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a), ib = STATUS_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map((k) => ({ status: k, tasks: by.get(k)! }));
}

/* ---- provider-key status for the empty-project checklist ------------------- */
type KeyCheck = { state: "loading" } | { state: "ok"; source: string } | { state: "missing" } | { state: "unknown"; why: string };
function useProviderKeyCheck(cid: string | null, enabled: boolean): KeyCheck {
  const [chk, setChk] = useState<KeyCheck>({ state: "loading" });
  useEffect(() => {
    if (!enabled || !cid) return;
    let alive = true;
    setChk({ state: "loading" });
    getJSON<{ configured?: boolean; source?: string | null }>("/api/containers/" + encodeURIComponent(cid) + "/settings/llm-key")
      .then((d) => {
        if (!alive) return; // project switched / unmounted: drop the stale answer
        const src = d && (d.source === "db" || d.source === "env") ? d.source : null;
        setChk(src || (d && d.configured) ? { state: "ok", source: src || "configured" } : { state: "missing" });
      })
      .catch((e) => {
        if (!alive) return;
        const m = /→ (\d{3})$/.exec(e instanceof Error ? e.message : "");
        setChk({ state: "unknown", why: m ? "HTTP " + m[1] : "network error" });
      });
    return () => { alive = false; };
  }, [cid, enabled]);
  return chk;
}

/* ---- Needs-you kind presentation (icon chip; no stripes, no coloured slabs) */
function kindOf(it: AttentionItem): { label: string; short: string; icon: string; tone: "warn" | "danger" | "info" } {
  if (it.kind === "plan") return { label: "Plan approval", short: "Plan", icon: "flag", tone: "warn" };
  if (it.kind === "verify") return { label: "Verify task", short: "Verify", icon: "check", tone: "warn" };
  if (it.request && (it.request.status === "escalated" || it.request.escalated)) return { label: "Escalated", short: "Escalated", icon: "alert", tone: "danger" };
  return { label: "Request", short: "Request", icon: "requests", tone: "info" };
}
/** Kind chip: the full label on wide screens, a one-word label on narrow ones
 * (never an icon alone — plan vs verify must stay readable at 390px). */
function KindChip({ it }: { it: AttentionItem }) {
  const k = kindOf(it);
  return (
    <Chip size="sm" className={"aq-type v2-tone-" + k.tone} icon={<Icon name={k.icon} cls="v2-ico aq-type-ico" />}>
      <span className="aq-l-long">{k.label}</span>
      {/* always rendered: at 390 the long label is visually hidden, so a
          one-word kind whose short == long (Escalated) must still show */}
      <span className="aq-l-short" aria-hidden="true">{k.short}</span>
    </Chip>
  );
}
/** A quiet ? that carries the explanation a line of copy used to (D12). */
const Help = ({ text }: { text: string }) => <HelpTip tip={text} />;
const plural = (n: number, one: string, many = one + "s") => (n === 1 ? one : many);
function itemTitle(it: AttentionItem): string {
  if (it.request) return it.request.title || payloadTitle(it.request.payload, it.title);
  return it.title;
}

/* ========================================================================== */

export function HomePage() {
  const { snap, cid, error, refresh } = useSnapshot();
  const toast = useToast();
  const attention = useAttention();
  const openCompose = useOpenCompose();

  // P2: tasks acted on THIS session (plan approved/rejected, or verified) —
  // suppress their rows immediately so the 3s repaint can't re-submit before
  // the snapshot reflects the decision. Pruned the moment the id leaves the
  // actionable set, so a reject→rework cycle reappears (review P2:173).
  const [acted, setActed] = useState<Set<string>>(new Set());
  // local UI drafts survive the 3s poll (controlled inputs in React state)
  const [reasonOpen, setReasonOpen] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [approveFor, setApproveFor] = useState<{ taskId: string; authorId: string; who: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("all");

  const c = snap?.container ?? null;
  const agents = snap?.agents ?? [];
  const tasks = snap?.tasks ?? [];
  const requests = snap?.requests ?? [];

  // prune the acted-suppression set against the live actionable set
  useEffect(() => {
    const actionable = new Set(attention.items.filter((i) => i.kind !== "request").map((i) => i.id));
    setActed((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => { if (actionable.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [attention]);

  /* ---- gate actions (HUMAN-GATED; endpoints/bodies verbatim) -------------- */
  const actorOrWarn = (): Agent | null => {
    const h = actingHuman(snap);
    if (!h) { toast("Choose who you are (account menu) before deciding.", "danger"); return null; }
    return h;
  };
  const markActed = (taskId: string) => {
    setActed((p) => new Set(p).add(taskId));
    setReasonOpen((p) => ({ ...p, [taskId]: false }));
    setDrafts((p) => ({ ...p, [taskId]: "" }));
  };
  // a failed decision keeps the typed reason and the row (the draft is untouched)
  const failToast = (e: unknown) =>
    toast("Failed (" + ((e as { status?: number }).status ?? "network") + ") — nothing was changed; your input is kept.", "danger");

  const sendPlanDecision = async (taskId: string, authorId: string, approve: boolean, reason?: string) => {
    const h = actorOrWarn(); if (!h) return;
    setBusy((p) => ({ ...p, [taskId]: true }));
    try {
      await sendJSON("POST", "/api/decisions", {
        subject_type: "plan_approval", subject_id: taskId, decision: approve ? "approve" : "reject",
        reason: reason || undefined, actor_agent_id: h.id, target_agent_id: authorId || undefined,
      });
      toast(approve ? "Plan approved — routed to the agent." : "Plan rejected — reason sent.", "ok");
      markActed(taskId);
      void refresh();
    } catch (e) { failToast(e); }
    setBusy((p) => ({ ...p, [taskId]: false }));
  };
  const sendVerify = async (taskId: string, approve: boolean, feedback?: string) => {
    const h = actorOrWarn(); if (!h) return;
    setBusy((p) => ({ ...p, [taskId]: true }));
    try {
      await sendJSON("POST", "/api/tasks/" + encodeURIComponent(taskId) + "/verify", {
        approve, actor_agent_id: h.id, feedback: approve ? undefined : feedback || "",
      });
      toast(approve ? "Accepted — task completed." : "Rejected — sent back with feedback.", "ok");
      markActed(taskId);
      void refresh();
    } catch (e) { failToast(e); }
    setBusy((p) => ({ ...p, [taskId]: false }));
  };

  const openReject = (taskId: string) => {
    if (!actorOrWarn()) return;
    setReasonOpen((p) => ({ ...p, [taskId]: true }));
  };
  const cancelReject = (taskId: string) => {
    setReasonOpen((p) => ({ ...p, [taskId]: false }));
    setDrafts((p) => ({ ...p, [taskId]: "" }));
  };
  const submitReject = (taskId: string, isPlan: boolean, authorId: string) => {
    const v = (drafts[taskId] || "").trim();
    if (!v) { toast("A reason is required to reject.", "danger"); return; }
    if (isPlan) void sendPlanDecision(taskId, authorId, false, v);
    else void sendVerify(taskId, false, v);
  };

  const reasonBox = (taskId: string, isPlan: boolean, authorId: string) =>
    reasonOpen[taskId] ? (
      <div className="aq-reason" id={"reason-" + taskId}>
        <label className="v2-sr" htmlFor={"rt-" + taskId}>{isPlan ? "Reason for rejecting the plan" : "What needs fixing"}</label>
        <textarea
          id={"rt-" + taskId}
          className="ov-input"
          placeholder={isPlan ? "Why are you rejecting? (required)" : "What needs fixing? (required)"}
          value={drafts[taskId] || ""}
          onChange={(e) => setDrafts((p) => ({ ...p, [taskId]: e.target.value }))}
        />
        <div className="aq-reason-acts">
          <Button variant="ghost" size="sm" onClick={() => cancelReject(taskId)}>Cancel</Button>
          <Button
            variant="danger" size="sm" id={"cr-" + taskId} busy={!!busy[taskId]}
            disabled={!(drafts[taskId] || "").trim()}
            title="A typed reason is required to reject."
            onClick={() => submitReject(taskId, isPlan, authorId)}
          >
            Submit rejection
          </Button>
        </div>
      </div>
    ) : null;

  /* ---- attention rows ----------------------------------------------------- */
  const shown = attention.items.filter((i) => { const t = i.task; return !t || !acted.has(t.id); });
  // The band count is "mine" (someone else's review is never counted), so the
  // preview lists ONLY mine — oldest first, the item that has waited longest
  // leads — and "N more" is computed from the same set (count == rows + more).
  // Other reviewers' items are named separately, never folded into "more".
  const mine = shown.filter((i) => !i.assignedToOther).sort((a, b) => ts(a.since) - ts(b.since));
  const othersCount = shown.length - mine.length;
  const mineCount = mine.length;
  const preview = mine.slice(0, NEEDS_PREVIEW);
  const moreMine = mineCount - preview.length;
  const badge = attention.count == null ? null : String(mineCount) + (attention.partial ? "+" : "");

  /* compact Inbox-style row → the exact item on /needs (the decision happens there) */
  const previewRow = (it: AttentionItem) => {
    const other = it.task ? reviewFor(it.task, actingHuman(snap)) : it.assignedToOther ? it.request?.to || null : null;
    const title = itemTitle(it);
    const a = agentByAlias(snap, it.agentAlias);
    return (
      <li key={it.key} className={"nq" + (it.assignedToOther ? " other-review" : "")}>
        {/* the actor links to their agent page (AgentLink parity, AA-118) — a
            sibling of the row link, never nested inside it */}
        {it.agentAlias && a ? (
          <Go className="nq-av" href={agentHref(it.agentAlias)} title={"Open " + it.agentAlias} aria-label={"Open agent " + it.agentAlias}>
            <Avatar alias={it.agentAlias} kind={a.kind ?? "ai"} status={a.status} size={20} decorative />
          </Go>
        ) : (
          <span className="nq-av">
            {it.agentAlias ? (
              <Avatar alias={it.agentAlias} kind="ai" size={20} />
            ) : (
              <span className="ov-av-none" aria-hidden="true"><Icon name="inbox" cls="v2-ico" /></span>
            )}
          </span>
        )}
        <Go className="nq-row ov-row" href={needsItemHref(it.key)} title={title}>
          <span className="nq-t ov-row-t">{title}</span>
          {other ? <Chip size="sm" className="review-for" title={"Assigned reviewer: " + other}>review: {other}</Chip> : null}
          <KindChip it={it} />
          <span className="ov-age">{it.since ? <RelTime at={it.since} /> : null}</span>
        </Go>
      </li>
    );
  };

  /* compact inline gate cards — only when the dedicated /needs page is absent */
  const cardHead = (it: AttentionItem, title: string, href: string, review: string | null, alias: string | null | undefined, extra?: string | null) => (
    <div className="aq-top">
      <Go className="aq-title" href={href}>{title}</Go>
      {review ? <span className="tag review-for">review: {review}</span> : null}
      <KindChip it={it} />
      <span className="aq-who">
        {alias ? <AgentLink snap={snap} alias={alias} /> : <span className="ov-meta">Unassigned</span>}
        {extra ? <span className="ov-meta" title="Model">{extra}</span> : null}
        <span className="ov-meta">{relTime(it.since)}</span>
      </span>
    </div>
  );

  const planCard = (t: Task, it: AttentionItem) => {
    const who = planAuthor(t);
    const a = agentByAlias(snap, who);
    const authorId = a?.id || "";
    const href = "/tasks?task=" + encodeURIComponent(t.id);
    return (
      <div className={"aq plan" + (it.assignedToOther ? " other-review" : "")} key={"p-" + t.id}>
        {cardHead(it, t.title, href, null, who, a?.model)}
        {/* P1: FULL plan body in a bounded scroll box — review the whole proposal */}
        <div className="aq-ctx aq-plan" tabIndex={0} aria-label={"Proposed plan for " + t.title}>
          <span className="lbl">Proposed plan</span>
          <Linkified text={planText(t)} tasks={tasks} />
        </div>
        <div className="aq-acts" data-kind="plan" data-task={t.id} data-author={authorId}>
          <ButtonLink variant="ghost" size="sm" to={href}>Open task</ButtonLink>
          <span className="grow" />
          <Button variant="secondary" size="sm" onClick={() => openReject(t.id)}>Reject…</Button>
          <Button
            variant="secondary" size="sm" icon="check" busy={!!busy[t.id]}
            onClick={() => { if (actorOrWarn()) { setAnswer(""); setApproveFor({ taskId: t.id, authorId, who: who || "The agent" }); } }}
          >
            Approve plan
          </Button>
        </div>
        {reasonBox(t.id, true, authorId)}
      </div>
    );
  };

  const verifyCard = (t: Task, it: AttentionItem) => {
    const who = (t.assignees || [])[0];
    // Collab v1: a task with an owner-assigned reviewer is SOMEONE's review.
    // The assigned reviewer (or any owner — permissive when member_role is
    // absent, i.e. open backends) sees it normally; everyone else gets it
    // de-emphasized + labeled. The backend verify gate decides who may act.
    const revLabel = reviewFor(t, actingHuman(snap));
    const href = "/tasks?task=" + encodeURIComponent(t.id);
    return (
      <div className={"aq verify" + (revLabel ? " other-review" : "")} key={"v-" + t.id}>
        {cardHead(it, t.title, href, revLabel, who)}
        <dl className="aq-lines">
          {t.result ? (<><dt>Result</dt><dd title={t.result}>{t.result}</dd></>) : null}
          <dt>Done when</dt><dd>{t.definition_of_done || <span className="ov-muted">No definition of done written</span>}</dd>
        </dl>
        <div className="aq-acts" data-kind="verify" data-task={t.id}>
          <ButtonLink variant="ghost" size="sm" to={href}>Open task · evidence</ButtonLink>
          <span className="grow" />
          <Button variant="secondary" size="sm" onClick={() => openReject(t.id)}>Reject…</Button>
          <Button variant="secondary" size="sm" icon="check" busy={!!busy[t.id]} onClick={() => void sendVerify(t.id, true)}>Accept</Button>
        </div>
        {reasonBox(t.id, false, "")}
      </div>
    );
  };

  const escCard = (r: OrchaRequest, it: AttentionItem) => {
    const href = "/requests?req=" + encodeURIComponent(r.id);
    return (
      <div className={"aq esc" + (it.assignedToOther ? " other-review" : "")} key={"e-" + r.id}>
        {cardHead(it, trunc(itemTitle(it), 96), href, it.assignedToOther ? r.to || null : null, r.from)}
        {r.task_link ? (
          <dl className="aq-lines"><dt>Blocks</dt><dd>{r.task_link.title || "Untitled task"}</dd></dl>
        ) : null}
        <div className="aq-acts">
          <span className="grow" />
          <ButtonLink variant="secondary" size="sm" iconRight="arrow" to={href}>Open request</ButtonLink>
        </div>
      </div>
    );
  };

  const renderCard = (it: AttentionItem) => {
    if (it.kind === "plan" && it.task) return planCard(it.task, it);
    if (it.kind === "verify" && it.task) return verifyCard(it.task, it);
    if (it.kind === "request" && it.request) return escCard(it.request, it);
    return null;
  };

  /* ---- derived page data -------------------------------------------------- */
  const notifier = notifierState(c);
  const aiAgents = agents.filter((a) => a.kind !== "human");
  const noAi = aiAgents.length === 0;
  const empty = !!snap && (noAi || tasks.length === 0);
  // the root/objective task is the project itself — never "your first task"
  const workTasks = tasks.filter((t) => !t.is_root);
  const keyCheck = useProviderKeyCheck(cid, empty);
  const open = openWorkCounts(snap);
  // A plan waiting on a human is listed under Needs you (mine or another
  // reviewer's) — not again as ordinary in-progress work (D12: one fact once).
  const planWaiting = useMemo(
    () => new Set(attention.items.filter((i) => i.kind === "plan").map((i) => i.id)),
    [attention],
  );
  const planHeld = tasks.filter((t) => t.status === "in_progress" && !t.is_root && planWaiting.has(String(t.id))).length;
  const inProgress = useMemo(
    () => tasks
      .filter((t) => t.status === "in_progress" && !t.is_root && !planWaiting.has(String(t.id)))
      .sort((a, b) => ts(b.started_at) - ts(a.started_at)),
    [tasks, planWaiting],
  );
  // the agent working on a task — the SAME "working" rule as the sidebar's
  // live agents (shell/liveAgents: a live run, or a working status on its
  // current task), so every row the sidebar calls working gets the pill here
  const liveOn = useMemo(() => liveWorkByTask(agents), [agents]);
  const allEvs = useMemo(() => activityEvents(tasks, requests), [tasks, requests]);
  const evs = pickFeed(allEvs, feedFilter);
  const days = groupByDay(evs);
  const breakdown = statusBreakdown(tasks);
  const humans = agents.length - aiAgents.length;
  // D10: no per-status stat wall — only the states that need attention (blocked /
  // failed), and only when non-zero, as muted glyph + number links on the facts line
  const troubled = breakdown.filter((g) => g.status === "blocked" || g.status === "failed");
  const partialTasks = snap?.task_total != null && snap.task_total > tasks.length;
  const rootTask = c?.root_task_id ? tasks.find((t) => String(t.id) === String(c.root_task_id)) ?? null : null;
  const aiFirst = useMemo(
    () => [...agents].sort((a, b) => Number(b.kind !== "human") - Number(a.kind !== "human") || Number(!!b.active_run) - Number(!!a.active_run)),
    [agents],
  );

  // "New task" stays in the header on every project so the header keeps one
  // shape. On an empty project the checklist's next step is the ONE primary,
  // so the header button is quiet (secondary) there.
  const primary = snap
    ? <Button variant={empty ? "secondary" : "primary"} size="sm" icon="plus" aria-keyshortcuts="c" title="Create a new task (C)" onClick={() => openCompose()}>New task</Button>
    : undefined;
  // checklist: the first unfinished step gets the primary button
  const nextStep = keyCheck.state !== "ok" && keyCheck.state !== "loading" ? 1 : noAi ? 2 : !workTasks.length ? 3 : 0;
  const stepVariant = (n: number) => (n === nextStep ? "primary" : "secondary") as "primary" | "secondary";

  const summary = (
    <section className="ov-sum" id="ctxbar" aria-label="Project summary">
      {c?.description ? (
        <p className="ov-obj">{c.description}</p>
      ) : rootTask ? (
        <p className="ov-obj">Objective: <Go href={"/tasks?task=" + encodeURIComponent(rootTask.id)}>{rootTask.title}</Go></p>
      ) : (
        <p className="ov-obj ov-muted">No objective written for this project yet.</p>
      )}
      <div className="ov-facts">
        {/* every live project is "active" — the status is a fact only when it is not */}
        {c?.status && c.status !== "active" ? (
          <span className="ov-fi ov-fi-status">
            {/* the ONE project-status map (label + tone) the All-projects table,
                Settings and Needs-you use — "paused" reads the same everywhere */}
            <Chip size="sm" dot={projectStatusMeta(c.status).tone} className="ov-pstatus">
              {"Project " + projectStatusMeta(c.status).label.toLowerCase()}
            </Chip>
          </span>
        ) : null}
        {/* AI agents and people are counted apart: an empty project with only
            its owner has 0 agents, matching the checklist's "No AI agents yet".
            "+ New agent" sits right after the agents fact it adds to. */}
        <span className="ov-fi">
          <Go className="stat ov-fact" href="/agents" title="AI agents in this project">
            {aiAgents.length ? (
              <AvatarStack actors={aiFirst.filter((a) => a.kind !== "human").map((a) => ({ alias: a.alias, kind: a.kind, ghLogin: a.github_login }))} size={16} max={4} label="Agents" />
            ) : null}
            <span className="n tnum">{aiAgents.length}</span> <span className="l">{plural(aiAgents.length, "agent")}</span>
          </Go>
          <Tooltip label="New agent" placement="bottom">
            <Link className="ov-newagent" to="/onboarding?new=1" aria-label="New agent">
              <Icon name="plus" cls="v2-ico" />
            </Link>
          </Tooltip>
        </span>
        {humans ? (
          <span className="ov-fi">
            <Go className="stat ov-fact" href={MEMBERS_HREF} title="People (human members) of this project — manage in Settings › Members">
              <span className="n tnum">{humans}</span> <span className="l">{plural(humans, "person", "people")}</span>
            </Go>
          </span>
        ) : null}
        <span className="ov-fi">
          <Go className="stat ov-fact" href={OPEN_TASKS_HREF} title="Open tasks: every status except completed and cancelled">
            <span className="n tnum">{open.tasks ?? "–"}</span> <span className="l">{plural(open.tasks ?? 2, "open task")}</span>
          </Go>
        </span>
        <span className="ov-fi">
          <Go className="stat ov-fact" href={OPEN_REQUESTS_HREF} title="Requests with status open">
            <span className="n tnum">{open.requests ?? "–"}</span> <span className="l">{plural(open.requests ?? 2, "open request")}</span>
          </Go>
        </span>
        {!empty && troubled.map((g) => (
          <span className="ov-fi" key={g.status}>
            <Go
              className="stat ov-fact ov-fact-st" href={statusHref(g.status)}
              title={`${statusLabel(g.status)}: ${g.tasks.length} ${plural(g.tasks.length, "task")}${partialTasks ? ` (of the first ${tasks.length} loaded)` : ""} — open this list in Tasks`}
            >
              <StatusGlyph status={g.status} size={13} />
              <span className="n tnum">{g.tasks.length}{partialTasks ? "+" : ""}</span> <span className="l">{statusLabel(g.status).toLowerCase()}</span>
            </Go>
          </span>
        ))}
      </div>
    </section>
  );

  return (
    <Shell page="home" title="Overview" ctx={c?.name} primaryAction={primary}>
      {!snap ? (
        error ? (
          <LoadError error={error} cid={cid} />
        ) : (
          <Skeleton lines={8} label="Loading project overview" />
        )
      ) : (
        <div className="ov">
          <h1 className="v2-sr">Overview{c?.name ? " — " + c.name : ""}</h1>
          {summary}

          {/* ---- empty project: the next useful actions, in order (nothing else) ---- */}
          {empty && (
            <div id="onbCta">
              <section className="ov-setup" aria-labelledby="ovSetupH">
                <h2 id="ovSetupH" className="ov-h">Get this project working</h2>
                <ol className="ov-steps">
                  <li className={keyCheck.state === "ok" ? "done" : ""}>
                    <span className="ov-step-n" aria-hidden="true">{keyCheck.state === "ok" ? <Icon name="check" cls="ov-step-ico" /> : "1"}</span>
                    <div className="ov-step-b">
                      <div className="ov-step-t">Model provider</div>
                      <div className="ov-step-d">
                        {keyCheck.state === "loading" ? "Checking the provider key…"
                          : keyCheck.state === "ok" ? `Anthropic API key configured (${keyCheck.source === "env" ? "from the environment" : "stored here"}).`
                          : keyCheck.state === "missing" ? <>No Anthropic API key yet. <Help text="AI-assisted setup and Embodent's model-powered helpers need one." /></>
                          : `Couldn't check the provider key (${keyCheck.why}).`}
                      </div>
                    </div>
                    {keyCheck.state !== "ok" && <ButtonLink variant={stepVariant(1)} size="sm" to="/settings#tab=provider-keys">Provider keys</ButtonLink>}
                  </li>
                  <li className={noAi ? "" : "done"}>
                    <span className="ov-step-n" aria-hidden="true">{noAi ? "2" : <Icon name="check" cls="ov-step-ico" />}</span>
                    <div className="ov-step-b">
                      <div className="ov-step-t">Agents</div>
                      <div className="ov-step-d">
                        {noAi ? <>No AI agents yet. <Help text="Describe the project and review a proposed roster, or create agents by hand." /></>
                          : `${aiAgents.length} AI ${plural(aiAgents.length, "agent")} ready.`}
                      </div>
                    </div>
                    {noAi && <ButtonLink variant={stepVariant(2)} size="sm" href="/onboarding">Set up agents</ButtonLink>}
                  </li>
                  <li className={workTasks.length ? "done" : ""} data-step="first-task">
                    <span className="ov-step-n" aria-hidden="true">{workTasks.length ? <Icon name="check" cls="ov-step-ico" /> : "3"}</span>
                    <div className="ov-step-b">
                      <div className="ov-step-t">First task with a definition of done</div>
                      <div className="ov-step-d">
                        {workTasks.length ? `${workTasks.length} ${plural(workTasks.length, "task")} created.`
                          : "Say what “done” means so the result can be verified."}
                      </div>
                    </div>
                    {!workTasks.length && <Button variant={stepVariant(3)} size="sm" icon="plus" onClick={() => openCompose()}>Create a task</Button>}
                  </li>
                  <li className={notifier === "running" ? "done" : ""} data-notifier={notifier}>
                    <span className="ov-step-n" aria-hidden="true">{notifier === "running" ? <Icon name="check" cls="ov-step-ico" /> : "4"}</span>
                    <div className="ov-step-b">
                      <div className="ov-step-t">Let the work start</div>
                      <div className="ov-step-d">
                        {notifier === "paused" ? "Wakes are paused — assigned agents won't wake."
                          : notifier === "running" ? `Running — the wake service checked this project ${relTime(c?.last_wake_scan_at)}.`
                          : notifier === "stale" ? `Wake service last seen ${relTime(c?.last_wake_scan_at)} — agents are not being woken right now.`
                          : notifier === "on" ? "Wakes are enabled."
                          : "No wake service is serving this project yet."}
                        {" "}<Help
                          text={(notifier === "none" || notifier === "stale" ? "Run `orcha up` on a machine bound to this project. " : "")
                            + "Assigned agents wake while the notifier is running; plans to approve and results to verify then appear under Needs you."}
                        />
                      </div>
                    </div>
                  </li>
                </ol>
              </section>
            </div>
          )}

          {/* ---- Needs you (an empty project shows it only when something waits) ---- */}
          {!empty || shown.length ? (
            <section id="needs" className="ov-sec" aria-label="Needs you">
              <ListGroup
                id="needs" level={2} storageKey={OV_GROUP_KEY}
                title="Needs you"
                glyph={<Icon name="inbox" cls="v2-ico ov-band-ico" />}
                count={badge}
                actions={HAS_NEEDS_PAGE && shown.length > 0 ? <Go className="ov-link" href="/needs">Open queue</Go> : undefined}
              >
                {attention.partial ? (
                  <p className="ov-note">Counted from the first {tasks.length} tasks and {requests.length} requests loaded; the project has more.</p>
                ) : null}
                {HAS_NEEDS_PAGE && shown.length ? (
                  <ul className="ov-rows" id="aqGrid" aria-label="Decisions waiting">
                    {preview.length ? preview.map(previewRow) : (
                      <li className="ov-empty"><Icon name="check" cls="v2-ico ov-empty-ico" />Nothing needs you right now.</li>
                    )}
                    {moreMine > 0 || othersCount > 0 ? (
                      <li className="ov-more">
                        {moreMine > 0 ? <Go className="ov-link" href="/needs">{moreMine} more in the queue</Go> : null}
                        {othersCount > 0 ? (
                          <Go
                            className="ov-link ov-link-other" href="/needs"
                            title={attention.readOnly
                              ? "View-only: nothing here is yours to decide — listed on the queue for context"
                              : "Reviews and requests assigned to someone else — listed on the queue, not counted as yours"}
                          >
                            {attention.readOnly ? `${othersCount} waiting (view-only)` : `${othersCount} assigned to someone else`}
                          </Go>
                        ) : null}
                      </li>
                    ) : null}
                  </ul>
                ) : !shown.length ? (
                  <div className="ov-empty" id="aqGrid"><Icon name="check" cls="v2-ico ov-empty-ico" />Nothing needs you right now.</div>
                ) : (
                  <div className="aq-list" id="aqGrid">{shown.map(renderCard)}</div>
                )}
              </ListGroup>
            </section>
          ) : null}

          {/* ---- active work ---- */}
          {!empty && (
            <section className="ov-sec" aria-label="Active work" id="activeWork">
              <ListGroup
                id="active" level={2} storageKey={OV_GROUP_KEY}
                title="Active work"
                glyph={<StatusGlyph status="in_progress" size={14} />}
                count={String(inProgress.length) + (partialTasks ? "+" : "")}
                actions={inProgress.length ? <Go className="ov-link" href={statusHref("in_progress")}>View all</Go> : undefined}
              >
                {inProgress.length ? (
                  <ul className="ov-rows" aria-label="Tasks in progress">
                    {inProgress.slice(0, ACTIVE_PREVIEW).map((t) => {
                      const who = t.assignee || (t.assignees || [])[0];
                      const a = agentByAlias(snap, who);
                      const live = liveOn.get(String(t.id));
                      const last = t.message_summary?.last?.at || t.started_at;
                      return (
                        <li key={t.id}>
                          <Go className="ov-row" href={"/tasks?task=" + encodeURIComponent(t.id)} title={t.title}>
                            <PriorityIcon priority={t.priority} className="ov-prio" />
                            <span className="ov-id" aria-hidden="true">{shortId(t.id)}</span>
                            <StatusIcon status={t.status} />
                            <span className="ov-row-t">{t.title}</span>
                            {live ? (
                              <LivePill state="working" actors={[{ alias: live.alias, kind: live.kind, ghLogin: live.github_login }]} />
                            ) : who ? (
                              <Avatar alias={who} kind={a?.kind} ghLogin={a?.github_login} size={20} label={"Assignee: " + who} />
                            ) : (
                              <span className="ov-meta">Unassigned</span>
                            )}
                            <span className="ov-age"><RelTime at={last} /></span>
                          </Go>
                        </li>
                      );
                    })}
                    {inProgress.length > ACTIVE_PREVIEW ? (
                      <li className="ov-more"><Go className="ov-link" href={statusHref("in_progress")}>{inProgress.length - ACTIVE_PREVIEW} more in progress</Go></li>
                    ) : null}
                  </ul>
                ) : (
                  <p className="ov-empty">
                    {planHeld
                      ? <>Nothing else in progress — {planHeld} {plural(planHeld, "task")} waiting on a plan decision (under Needs you).</>
                      : "No task is in progress."}
                  </p>
                )}
              </ListGroup>
            </section>
          )}

          {/* ---- updates feed (Pulse): the same D8 band as the two above, with
              its filter pills inside; Today / Yesterday dividers under it ---- */}
          {!empty && (
            <section className="ov-sec ov-feed" aria-label="Updates" id="updates">
              <ListGroup
                id="updates" level={2} storageKey={OV_GROUP_KEY}
                title="Updates"
                glyph={<Icon name="live" cls="v2-ico ov-band-ico" />}
                actions={
                  <>
                    <FilterPills
                      label="Show updates" size="sm" className="ov-pills" value={feedFilter}
                      onChange={(k) => setFeedFilter(k as FeedFilter)}
                      items={[
                        { key: "all", label: "All" },
                        { key: "messages", label: "Messages" },
                        { key: "requests", label: "Requests" },
                        { key: "outcomes", label: "Finished" },
                      ]}
                    />
                    <Go className="ov-link" href="/activity">Open activity</Go>
                  </>
                }
              >
                <div id="actList">
                  {evs.length ? (
                    <Timeline label="Project updates" className="ov-tl">
                      {days.map((g) => [
                        <TimelineDivider key={"d-" + g.day}>{g.day}</TimelineDivider>,
                        ...g.events.map((e, i) => <FeedEvent key={g.day + i} e={e} snap={snap} />),
                      ])}
                    </Timeline>
                  ) : (
                    <p className="ov-empty">{feedFilter === "all" ? "No updates yet." : "Nothing of this kind yet."}</p>
                  )}
                  {feedFilter === "outcomes" ? <Go className="ov-link ov-feed-more" href={DONE_TASKS_HREF}>All finished tasks</Go> : null}
                </div>
              </ListGroup>
            </section>
          )}
        </div>
      )}

      {/* ISS-59: approving may carry an OPTIONAL answer/guidance for the agent.
          Same title/copy as the Tasks / Needs-you GateSurface dialog. */}
      {approveFor && (
        <Dialog
          title="Approve this plan?"
          description={approveFor.who + " will be cleared to execute. Optionally answer/guide below — it's sent with the approval."}
          onClose={() => setApproveFor(null)}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setApproveFor(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const p = approveFor;
                  setApproveFor(null);
                  void sendPlanDecision(p.taskId, p.authorId, true, answer);
                }}
              >
                Approve plan
              </Button>
            </>
          }
        >
          <textarea
            id="ans" className="ta ov-input" placeholder="Answer / additional info for the agent (optional)"
            aria-label="Answer / additional info for the agent (optional)"
            value={answer} onChange={(e) => setAnswer(e.target.value)}
            style={{ width: "100%", minHeight: 76, resize: "vertical" }}
          />
        </Dialog>
      )}
    </Shell>
  );
}

/* ---- one feed line: "actor verb **object** · time" (+ one muted body line).
 * Rendered as TimelineEvent children so the first line can stay ONE line (the
 * object ellipsizes) and the body sits under it (max 2 lines per item). */
function FeedEvent({ e, snap }: { e: ActEvent; snap: Snapshot | null }) {
  const obj = <Go className="ov-tl-obj" href={e.link} title={e.ctx}><b>{e.ctx}</b></Go>;
  const when = (
    <>
      {" "}<span className="v2-tl-sep" aria-hidden="true">·</span>{" "}
      <RelTime at={e.at} className="v2-tl-time" />
    </>
  );
  if (e.kind === "outcome") {
    return (
      <TimelineEvent className="ov-ev" glyph={<StatusGlyph status={e.status} size={14} />}>
        <span className="ov-ev-main"><span className="ov-ev-verb">{statusLabel(e.status)}</span>{" "}{obj}{when}</span>
      </TimelineEvent>
    );
  }
  const a = agentByAlias(snap, e.who);
  const system = !e.who;
  const verb = e.kind === "request" ? "asked" : e.kind === "answer" ? "answered" : e.human ? "commented on" : "posted on";
  return (
    <TimelineEvent
      className="ov-ev"
      glyph={system ? <Icon name="spark" cls="v2-ico" /> : <Avatar alias={e.who} kind={a ? a.kind : e.human ? "human" : "ai"} size={16} decorative />}
    >
      <span className="ov-ev-main">
        {a && e.who ? (
          <Go className="v2-tl-actor ov-ev-actor" href={agentHref(e.who)} title={"Open " + e.who}>{e.who}</Go>
        ) : (
          <span className="v2-tl-actor">{system ? "System" : e.who}</span>
        )}{" "}
        <span className="ov-ev-verb">{verb}</span>{" "}
        {obj}{when}
      </span>
      {e.text ? <span className="ov-ev-body">{" "}{e.text}</span> : null}
    </TimelineEvent>
  );
}

/** Agent id → task it is working on, by the sidebar's "working" rule (shell/liveAgents). */
export function liveWorkByTask(agents: Agent[]): Map<string, Agent> {
  const m = new Map<string, Agent>();
  agents.forEach((a) => {
    if (a.kind === "human" || a.status === "terminated") return;
    const working = a.active_run != null || a.status === "working" || a.status === "in_progress";
    if (!working) return;
    const id = a.active_run?.task_id ?? a.current_task?.task_id;
    if (id && !m.has(String(id))) m.set(String(id), a);
  });
  // a live run outranks a status-only claim on the same task
  agents.forEach((a) => { const id = a.active_run?.task_id; if (id) m.set(String(id), a); });
  return m;
}

/**
 * The Overview's page state when the project data did not load. It says what
 * the failure MEANS (Shell.snapshotErrorKind: an answer from the backend is not
 * an outage — brief §3), never the raw endpoint / container id / status (the
 * Shell's banner keeps those under its collapsed Details). The ONE action —
 * All projects for no-access / not-found, Retry otherwise — lives on that
 * banner (Shell.staleBanner), so it is not repeated here (D12 one fact once).
 */
export function LoadError({ error, cid }: { error: string; cid: string | null }) {
  const kind = snapshotErrorKind(error);
  const { list, error: listErr } = useProjects();
  const listed = !listErr && cid ? (list || []).find((p) => p.id === cid)?.name ?? null : null;
  if (kind === "forbidden") {
    return <EmptyState title="You don't have access to this project" body="Only its members can open it." />;
  }
  if (kind === "not_found") {
    return <EmptyState title="Project not found" body="Open one of your projects instead." />;
  }
  return (
    <EmptyState
      tone="danger"
      title={listed ? `${listed} is unreachable` : "Couldn't load this project"}
      body="Nothing is shown rather than out-of-date numbers."
    />
  );
}
