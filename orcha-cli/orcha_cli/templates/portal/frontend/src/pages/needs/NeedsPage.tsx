/**
 * Needs you (V2, owner D) — the focused decision queue for the CURRENT project
 * (docs/orcha-v2-architecture.md §3; parity PI-03, H-03, H-04), laid out as a
 * Linear Inbox (directive D10, reference image 12): a compact list on the left
 * (round avatar with presence badge · bold title line · muted "what happened"
 * line · status glyph + age), the selected item on the right (detail header
 * with pager, large title, description, the decision card, an Activity
 * timeline and — for tasks — a "Leave a comment…" composer).
 *
 * - Items come ONLY from the shared selector `useAttention()` (plan approvals
 *   when autonomy is "plan", verifications unless autonomy is "full", requests
 *   open to a human or escalated). Badge = unique entities waiting on YOU;
 *   items assigned to someone else are listed separately, never counted.
 * - Actionable decisions are separated from informational follow-ups
 *   (answered requests you asked) and from history. Read/unread notifications
 *   never resolve anything here.
 * - Selecting a row shows full context with the SAME authorized actions as
 *   the Tasks / Requests pages (GateSurface, RequestDetail). After a
 *   successful decision the queue advances to the next item and the decision
 *   is kept in this session's history; a failed decision keeps its typed input
 *   and stays selected. No bulk approval.
 * - URL: `item=<kind>:<id>`, `scope=project|all`, `view=open|history`.
 *   `scope=all` uses the per-project `needs_you` from GET /api/containers — a
 *   different measure (no plan approvals), labelled as such; missing = "unavailable".
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Shell } from "../../shell/Shell";
import { CircleIconButton, FilterPills, PageHeader, Pager } from "../../shell/PageChrome";
import { Icon, Linkified, useToast } from "../../components/ui";
import {
  Avatar,
  Button,
  ButtonLink,
  Chip,
  EmptyState,
  List,
  Row,
  Skeleton,
  SplitPane,
  StatusGlyph,
  StatusIcon,
  Tooltip,
  actorKey,
  rosterPaletteSlots,
  isEditingTarget,
  payloadText,
  payloadTitle,
} from "../../components/primitives";
import { GroupHeader, ProjectIcon } from "../../components/primitives";
import { Timeline, TimelineEvent } from "../../components/primitives";
import { Composer } from "../../components/primitives";
import { attentionLabel, markAttentionDecided, useAttention, type AttentionItem } from "../../state/attention";
import { useProjectMode } from "../../lib/projectMode";
import { actingHuman, autLevel, planMessageOf, useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { orderProjects, useProjects } from "../../state/projects";
import { switchProject, withCidForced } from "../../lib/scope";
import { clockTime, relTime, shortId, trunc } from "../../lib/format";
import { resultText } from "../../lib/resultText";
import { reviewerLabel, reviewerRef } from "../../lib/reviewer";
import { reviewBrief } from "../../lib/reviewRoute";
import { projectStatusMeta } from "../../cloud/projects/projectStatus";
import { sendJSON } from "../../api/client";
import type { Agent, OrchaRequest, Snapshot, Task } from "../../types";
import { GateSurface, NO_HUMAN, useTaskRuns } from "../tasks/TasksPage";
import { RequestDetail, requestKindLabel } from "../requests/RequestsPage";
import { requestTitle as payloadRequestTitle } from "../requests/requestPayload";
import { plainPreview } from "./plainPreview";
import { useInboxKeys } from "./useInboxKeys";
import "./needs.css";
import { workCss } from "../tasks/workCss";
import { summaryText, useEvidenceSummaries } from "../tasks/evidence";
import { SnapshotPending } from "../../components/SnapshotPending";

/* ---- session decision history (per project; survives in-app navigation) -- */
export interface DecidedEntry {
  key: string;
  kind: AttentionItem["kind"];
  title: string;
  href: string;
  outcome: string;
  /** the acting human who decided (alias), when known */
  who?: string | null;
  at: number;
}
// In memory, mirrored to sessionStorage (per project) so "Decided in this
// session" survives a reload of the tab; storage may be unavailable.
const sessionHistory = new Map<string, DecidedEntry[]>();
const HIST_KEY = "orcha:v2:needsHistory:";
function readStored(k: string): DecidedEntry[] {
  try {
    const raw = window.sessionStorage.getItem(HIST_KEY + k);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? (v.filter((e) => e && typeof e.key === "string" && typeof e.at === "number") as DecidedEntry[]) : [];
  } catch {
    return [];
  }
}
export function historyFor(cid: string | null): DecidedEntry[] {
  const k = cid ?? "";
  let v = sessionHistory.get(k);
  if (!v) {
    v = readStored(k);
    sessionHistory.set(k, v);
  }
  return v;
}
function pushHistory(cid: string | null, e: DecidedEntry) {
  const k = cid ?? "";
  const next = [e, ...historyFor(cid)].slice(0, 100);
  sessionHistory.set(k, next);
  try { window.sessionStorage.setItem(HIST_KEY + k, JSON.stringify(next)); } catch { /* private mode / quota */ }
}
/** test hook */
export function _resetNeedsHistory(): void {
  sessionHistory.clear();
  try {
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(HIST_KEY)) window.sessionStorage.removeItem(key);
    }
  } catch { /* unavailable */ }
}
/** test hook: forget the in-memory copy only (as a page reload would) */
export function _dropNeedsHistoryMemory(): void {
  sessionHistory.clear();
}

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  plan: "Plan approval",
  verify: "Verification",
  request: "Request",
};

function kindLabel(i: AttentionItem): string {
  if (i.kind === "request" && i.request) {
    if (i.request.status === "escalated" || i.request.escalated) return "Escalated request";
    return i.request.type === "task" ? "Task request" : "Request to a human";
  }
  return KIND_LABEL[i.kind];
}

/** Detail header kind: a request is named by its TYPE ("Review request") — the
 *  decision card, timeline and glyph already say "escalated" (D12: once). */
function headerKind(i: AttentionItem): string {
  if (i.kind === "request" && i.request) return requestKindLabel(i.request.type);
  return KIND_LABEL[i.kind];
}

/** One readable subtitle line — markdown flattened, payloads never as JSON (D4). */
function evidencePreview(i: AttentionItem): string {
  if (i.kind === "plan" && i.task) return plainPreview(planMessageOf(i.task)?.body || "", { dropHeadings: true });
  if (i.kind === "verify" && i.task) return plainPreview(resultText(i.task.result)) || "No result text submitted";
  if (i.request) {
    const title = itemTitle(i);
    const text = payloadText(i.request.payload);
    // the row already shows the title: preview what comes after it
    return text.startsWith(title) ? text.slice(title.length).replace(/^[\s·:—-]+/, "") : text;
  }
  return "";
}

/** Item title: a request's payload title (never JSON), else the entity title. */
function itemTitle(i: AttentionItem): string {
  if (i.request) return i.request.title || payloadTitle(i.request.payload, i.title || (i.request.type || "Request") + " request");
  return i.title;
}
const requestTitle = (r: OrchaRequest) => r.title || payloadTitle(r.payload, (r.type || "Request") + " request");

/** Detail titles stay short (D12): at most ~2 lines at display size. A longer
 *  first sentence is cut at a word boundary (full text in the tooltip). */
export const DETAIL_TITLE_MAX = 110;
export function headline(text: string, max = DETAIL_TITLE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{12,}?[.?!])(\s|$)/);
  const first = m ? m[1] : t;
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:·—-]+$/, "") + "…";
}
/**
 * A request's detail title, so the question is never shown twice (D12): the
 * first sentence (≤ DETAIL_TITLE_MAX) via the Requests page's `requestTitle`,
 * and RequestDetail drops that same title from its body (`titleShown`), for
 * string and object payloads alike.
 */
export function requestHead(r: OrchaRequest): { title: string; titleShown: string } {
  // a display title (code-thread questions) is already short and complete — capped, never sentence-cut
  const title = r.title ? (r.title.length <= DETAIL_TITLE_MAX ? r.title : r.title.slice(0, DETAIL_TITLE_MAX - 1).replace(/\s+\S*$/, "") + "…") : payloadRequestTitle(r.payload, (r.type || "Request") + " request", DETAIL_TITLE_MAX);
  return { title, titleShown: title };
}
const requestDetailTitle = (r: OrchaRequest) => requestHead(r).title;

/** The decision outcome as one word-ish label ("Accepted · completed" → "Accepted"). */
export function shortOutcome(o: string): string {
  return o.split(/ · | — /)[0].trim() || o;
}


function otherOwner(i: AttentionItem): string {
  if (!i.assignedToOther) return "";
  if (i.task) return reviewerLabel(reviewerRef(i.task)) || "another reviewer";
  if (i.request) return i.request.to && i.request.to !== "human" ? i.request.to : "another human";
  return "someone else";
}

/** "what happened" verb for the row's muted second line — only facts we hold. */
function happened(i: AttentionItem): string {
  const who = i.agentAlias || "";
  if (i.kind === "plan") return who ? who + " proposed a plan" : "Plan proposed";
  if (i.kind === "verify") return who ? who + " asks for verification" : "Waiting for verification";
  if (i.request?.status === "escalated" || i.request?.escalated) return who ? who + " escalated a request" : "Escalated request";
  return who ? who + " asks" : "Request to a human";
}

const agentBy = (snap: Snapshot | null, alias: string | null | undefined): Agent | undefined =>
  alias ? (snap?.agents ?? []).find((a) => a.alias === alias || a.id === alias) : undefined;

/** D13: the project roster's ONE slot map (rosterPaletteSlots over snap.agents,
 *  shared with the Agents board / roster / Requests / every Avatar). */
export function agentPalette(snap: Snapshot | null): Map<string, number> {
  return rosterPaletteSlots(snap?.agents) ?? new Map();
}
const slotOf = (snap: Snapshot | null, alias: string | null | undefined) => (alias ? agentPalette(snap).get(actorKey(alias)) : undefined);

function useNarrow(): boolean {
  const q = "(max-width: 900px)";
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q).matches : false);
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

/** Inbox-style default: the detail gets the room, the list stays ~400 px. */
function defaultDetailWidth(): number {
  const w = typeof window !== "undefined" ? window.innerWidth : 1440;
  return Math.max(460, Math.min(1100, w - 260 - 16 - 420));
}

/* ---- activity (real timestamps only; nothing inferred) -------------------- */
interface Ev { key: string; icon?: string; glyph?: ReactNode; actor?: string | null; text: ReactNode; at: string | null }

function taskEvents(t: Task, item: AttentionItem | null, snap: Snapshot | null): Ev[] {
  const out: Ev[] = [];
  const creator = agentBy(snap, t.created_by)?.alias || null;
  if (t.created_at) out.push({ key: "created", icon: "plus", actor: creator, text: creator ? "created the task" : "Task created", at: t.created_at });
  if (t.started_at) out.push({ key: "started", glyph: <StatusGlyph status="in_progress" size={12} />, actor: t.assignee, text: t.assignee ? "started work" : "Work started", at: t.started_at });
  // the first agent message is only a PLAN on a plan item (or once a plan decision exists) —
  // on a verification it is ordinary progress ("Export verified locally."), not a plan
  const pm = item?.kind === "plan" || t.plan_decision ? planMessageOf(t) : null;
  if (pm) out.push({ key: "plan", icon: "flag", actor: pm.from || null, text: pm.from ? "proposed a plan" : "Plan proposed", at: pm.at || null });
  if (t.plan_decision) {
    const ok = t.plan_decision.decision === "approve";
    out.push({ key: "plandec", icon: ok ? "check" : "x", actor: t.plan_decision.actor || null, text: (t.plan_decision.actor ? "" : "Plan ") + (ok ? (t.plan_decision.actor ? "approved the plan" : "approved") : (t.plan_decision.actor ? "rejected the plan" : "rejected")), at: t.plan_decision.at || null });
  }
  if (item?.kind === "verify") out.push({ key: "verify", glyph: <StatusGlyph status="needs_verification" size={12} />, actor: t.assignee, text: t.assignee ? "submitted the result for verification" : "Result submitted for verification", at: item.since });
  const last = t.message_summary?.last;
  if (last?.at && last.body) {
    out.push({
      key: "lastmsg",
      icon: "requests",
      actor: last.author_alias || null,
      text: <>{last.author_alias ? "commented " : "Comment "}<span className="nd-quote">“{trunc(plainPreview(last.body), 90)}”</span></>,
      at: last.at,
    });
  }
  return out.filter((e) => e.at).sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
}

function Activity({ events, more }: { events: Ev[]; more?: ReactNode }) {
  if (!events.length && !more) return null;
  return (
    <section className="nd-activity" aria-label="Activity">
      <h2 className="nd-h2">Activity</h2>
      {events.length ? (
        <Timeline label="Activity">
          {events.map((e) => (
            <TimelineEvent key={e.key} icon={e.icon} glyph={e.glyph} actor={e.actor || undefined} at={e.at}>
              {e.text}
            </TimelineEvent>
          ))}
        </Timeline>
      ) : null}
      {more}
    </section>
  );
}

/* ---- comment composer (task items): the task thread, as the acting human -- */
function CommentBox({ t }: { t: Task }) {
  const { refresh } = useSnapshot();
  const authority = useActingAuthority();
  const toast = useToast();
  // PS-29: the connection-aware actor — offline / read-only → disabled with the reason
  const h = authority.human;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const disabledReason = h ? undefined : (authority.reason || NO_HUMAN);
  const submit = async () => {
    const v = text.trim();
    if (!v || busy) return;
    if (!h) { toast(NO_HUMAN, "danger"); return; }
    setBusy(true);
    setText(""); // the draft is restored if the post fails
    try {
      await sendJSON("POST", "/api/tasks/" + encodeURIComponent(t.id) + "/messages", { body: v, author_agent_id: h.id });
      toast("Comment posted", "ok");
      void refresh();
    } catch (e) {
      setText((cur) => (cur.trim() ? cur : v));
      const st = (e as { status?: number }).status;
      toast(st ? "Comment not posted (" + st + ")" : "Couldn't reach the portal — your comment is still in the composer.", "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Composer
      className="nd-composer"
      label={"Comment on " + t.title}
      placeholder={t.assignee ? `Leave a comment for ${t.assignee}…` : "Leave a comment…"}
      value={text}
      onChange={setText}
      onSubmit={() => void submit()}
      busy={busy}
      disabled={!h}
      disabledReason={disabledReason}
      submitLabel="Post comment"
      keyHint
    />
  );
}

/* ---- detail panes --------------------------------------------------------- */
/** The item's short ID, shown ONCE (header): ID text + a copy icon that
 *  appears on hover / focus (the same affordance as the Requests header). */
function CopyId({ id }: { id: string }) {
  const toast = useToast();
  const failed = () => toast("Couldn't copy — select the ID instead", "warn");
  return (
    <Tooltip label="Copy ID">
      <button
        type="button"
        className="v2-t-id nd-id"
        aria-label={"Copy ID " + shortId(id)}
        onClick={() => {
          try {
            const p = navigator.clipboard?.writeText(id);
            if (p) void p.then(() => toast("ID copied", "ok"), failed);
            else failed();
          } catch { failed(); }
        }}
      >
        {shortId(id)}
        <Icon name="copy" cls="v2-ico nd-id-copy" />
      </button>
    </Tooltip>
  );
}

function Description({ text, snap }: { text: string; snap: Snapshot | null }) {
  const [all, setAll] = useState(false);
  const long = text.length > 420 || text.split("\n").length > 6;
  return (
    <div className="nd-desc">
      <div className={"nd-desc-b" + (long && !all ? " is-clamped" : "")}>
        <Linkified text={text} tasks={snap?.tasks} />
      </div>
      {long ? (
        <button type="button" className="nd-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : "Show full description"}
        </button>
      ) : null}
    </div>
  );
}

function TaskDecision({ item, onDecided }: { item: AttentionItem; onDecided: (outcome: string) => void }) {
  const { snap } = useSnapshot();
  const t = item.task!;
  const runs = useTaskRuns(item.kind === "verify" ? t.id : null);
  // GateSurface reports WHICH decision succeeded just before onActed
  const outcomeRef = useRef<string | null>(null);
  const assignee = agentBy(snap, t.assignee);
  const count = t.message_summary?.count ?? 0;
  // the assigned reviewer, when it isn't you (you may still decide as Owner)
  const me = actingHuman(snap)?.alias ?? null;
  const rv = item.kind === "verify" && !item.assignedToOther ? reviewerLabel(reviewerRef(t)) : "";
  const reviewer = rv && deciderLabel(rv, me) !== "you" ? rv : "";
  return (
    <>
      <div className="nd-meta">
        <StatusIcon status={t.status} showLabel size={14} />
        {t.assignee ? (
          <a className="nd-who" href={"/agents?agent=" + encodeURIComponent(t.assignee)}>
            <Avatar alias={t.assignee} kind={assignee?.kind || "ai"} status={assignee?.status} size={20} palette={slotOf(snap, t.assignee)} decorative />
            {t.assignee}
          </a>
        ) : null}
        {/* the age lives in the row, the gate card and the timeline — not here too (D12) */}
        {reviewer ? <span className="nd-dim nd-review">review: {reviewer}</span> : null}
      </div>
      {item.assignedToOther ? (
        <p className="nd-caveat">
          Assigned to {otherOwner(item)} for review. It isn't counted in your queue; you can still decide if you need to.
        </p>
      ) : null}
      {t.description ? <Description text={t.description} snap={snap} /> : null}
      <div className="nd-decision">
        <GateSurface
          key={item.key}
          t={t}
          acted={false}
          runs={item.kind === "verify" ? runs : undefined}
          onDecision={(o) => {
            outcomeRef.current = o;
          }}
          onActed={() => onDecided(outcomeRef.current || "Decision recorded")}
        />
      </div>
      <Activity
        events={taskEvents(t, item, snap)}
        more={count > 1 ? (
          <a className="nd-thread-link" href={"/tasks?task=" + encodeURIComponent(t.id)}>View full thread ({count} messages)</a>
        ) : null}
      />
      <CommentBox t={t} />
    </>
  );
}

/* ---- all-projects scope --------------------------------------------------- */

function AllProjects({ currentCid, liveLabel, onOpenCurrent }: { currentCid: string | null; liveLabel: string; onOpenCurrent: () => void }) {
  const { list, error, fetchedAt, loading, refresh } = useProjects();
  // D13: the sidebar's order and the ONE shared project slot map
  const rows = useMemo(() => (list ? orderProjects(list) : []), [list]);
  if (list == null) {
    return error ? (
      <EmptyState tone="danger" title="Projects unavailable" body={error} action={<Button variant="secondary" onClick={() => void refresh()}>Retry</Button>} />
    ) : (
      <Skeleton lines={4} label="Loading projects" />
    );
  }
  const measure =
    "Other projects: the server's count of verifications and requests waiting on a human — plan approvals are not included." +
    (fetchedAt ? " As of " + clockTime(new Date(fetchedAt).toISOString()) + "." : "");
  return (
    <div className="nd-all">
      <table className="nd-projects">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              <span className="nd-th">
                Needs a human
                <Tooltip placement="bottom" label={measure}>
                  <span className="nd-info nd-info-sm" tabIndex={0} role="img" aria-label={measure}>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 9.2v4.3M10 6.6h.01" /></svg>
                  </span>
                </Tooltip>
              </span>
            </th>
            <th scope="col">
              <span className="nd-th nd-th-end">
                <span className="v2-sr">Open</span>
                <CircleIconButton icon="refresh" label={loading ? "Refreshing project counts…" : "Refresh project counts"} size="sm" busy={loading} onClick={() => void refresh()} />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const current = currentCid != null && String(p.id) === String(currentCid);
            const name = p.name || shortId(p.id);
            const st = projectStatusMeta(p.status);
            // wave-4 (D12): the whole row opens that project's queue — one trailing arrow icon,
            // not an "Open queue →" label repeated on every row
            const open = () => (current ? onOpenCurrent() : switchProject(String(p.id), "/needs"));
            return (
              <tr key={p.id} className="nd-prow" onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) open(); }}>
                <td className="nd-pname" title={p.name || String(p.id)}>
                  {/* D14: the project's own icon (neutral glyph when unset) — never initials */}
                  <ProjectIcon cid={String(p.id)} size={18} className="nd-picon" />
                  <a
                    className="nd-pname-t nd-plink"
                    href={current ? "/needs" : withCidForced("/needs", String(p.id))}
                    aria-label={"Open queue for " + name}
                    onClick={(e) => { e.preventDefault(); open(); }}
                  >
                    {name}
                  </a>
                  {current ? <span className="nd-cur">current</span> : null}
                </td>
                <td>
                  {/* the PROJECT lifecycle map (paused → "Paused"), never the task-status map */}
                  <Chip size="sm" dot={st.tone} className="nd-pstatus">{st.label}</Chip>
                </td>
                <td className="num">
                  {current ? (
                    <span title="Live count for this project — includes plan approvals">{liveLabel || "0"}</span>
                  ) : p.needs_you == null ? (
                    <span className="nd-dim" title="The server did not report a count for this project">unavailable</span>
                  ) : (
                    <span title="Verifications + requests waiting on a human (excl. plan approvals)">{p.needs_you}</span>
                  )}
                </td>
                <td>
                  <Icon name="arrow" cls="v2-ico nd-parrow" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---- history ------------------------------------------------------------- */
interface PastDecision { key: string; title: string; href: string; outcome: string; who: string | null; at: string | null }
function snapshotHistory(snap: Snapshot | null): PastDecision[] {
  if (!snap) return [];
  const out: PastDecision[] = [];
  for (const t of snap.tasks ?? []) {
    if (t.plan_decision) {
      out.push({
        key: "plan:" + t.id,
        title: t.title,
        href: "/tasks?task=" + encodeURIComponent(t.id),
        outcome: t.plan_decision.decision === "approve" ? "Plan approved" : "Plan rejected",
        who: t.plan_decision.actor || null,
        at: t.plan_decision.at || null,
      });
    }
  }
  for (const r of snap.requests ?? []) {
    if (r.responded_at && (r.status === "answered" || r.status === "closed" || r.status === "converted_to_task")) {
      out.push({
        key: "request:" + r.id,
        title: trunc(requestTitle(r), 90),
        href: "/requests?req=" + encodeURIComponent(r.id),
        outcome: r.status === "answered" ? "Answered" : r.status === "closed" ? "Closed" : "Converted to task",
        who: r.to && r.to !== "human" ? r.to : null,
        at: r.responded_at,
      });
    }
  }
  out.sort((a, b) => (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0));
  return out.slice(0, 50);
}

const outcomeStatus = (o: string) => (/reject|closed/i.test(o) ? (/reject/i.test(o) ? "rejected" : "closed") : /escalat/i.test(o) ? "escalated" : /convert/i.test(o) ? "converted_to_task" : "completed");

/** Who decided, as the page names people: the acting human is "you". */
export function deciderLabel(who: string | null | undefined, me: string | null | undefined): string | null {
  if (!who) return null;
  return me && who.replace(/^@/, "") === me.replace(/^@/, "") ? "you" : who;
}

function HistRow({ title, href, outcome, who, at }: { title: string; href: string; outcome: string; who?: string | null; at: string | null }) {
  return (
    <li className="nd-hrow">
      <StatusGlyph status={outcomeStatus(outcome)} size={14} />
      <a className="nd-htitle" href={href} title={title}>{title}</a>
      <span className="nd-hout">{outcome}{who ? <span className="nd-dim"> · by {who}</span> : null}</span>
      <span className="nd-age" title={at ? clockTime(at) : undefined}>{at ? relTime(at) : ""}</span>
    </li>
  );
}

function HistoryView({ cid, snap, me }: { cid: string | null; snap: Snapshot | null; me: string | null }) {
  const mine = historyFor(cid);
  const past = snapshotHistory(snap);
  const [openA, setOpenA] = useState(true);
  const [openB, setOpenB] = useState(true);
  return (
    <div className="nd-history">
      <section aria-label="Decided in this session">
        <GroupHeader title="Decided in this session" count={mine.length} open={openA} onToggle={() => setOpenA((v) => !v)} controls="nd-hist-a" />
        <div id="nd-hist-a" hidden={!openA}>
          {mine.length ? (
            <ul className="nd-hlist">
              {mine.map((e) => (
                <HistRow key={e.key + e.at} title={e.title} href={e.href} outcome={shortOutcome(e.outcome)} who={deciderLabel(e.who, me) || "you"} at={new Date(e.at).toISOString()} />
              ))}
            </ul>
          ) : (
            <div className="nd-emptyline">No decisions made here in this session yet.</div>
          )}
        </div>
      </section>
      <section aria-label="Recent decisions in this project">
        <GroupHeader
          title={<>Recent decisions in this project <Tooltip label="From the loaded snapshot: plan decisions and resolved requests."><span className="nd-dim nd-src">snapshot</span></Tooltip></>}
          count={past.length}
          open={openB}
          onToggle={() => setOpenB((v) => !v)}
          controls="nd-hist-b"
        />
        <div id="nd-hist-b" hidden={!openB}>
          {past.length ? (
            <ul className="nd-hlist">
              {past.map((e) => <HistRow key={e.key} title={e.title} href={e.href} outcome={e.outcome} who={deciderLabel(e.who, me)} at={e.at} />)}
            </ul>
          ) : (
            <div className="nd-emptyline">No recorded decisions in the loaded data.</div>
          )}
        </div>
      </section>
    </div>
  );
}

/** Pager tooltip: "10 items in this view · 8 waiting on you". */
export function pagerHint(total: number, waiting: number): string {
  const all = total + (total === 1 ? " item" : " items") + " in this view";
  return waiting === total ? all : all + " · " + waiting + " waiting on you";
}

/* ---- the page ------------------------------------------------------------ */
export function NeedsPage() {
  const { snap, cid, connection, stale, lastOkAt, retryIdentity } = useSnapshot();
  const projectMode = useProjectMode(cid).mode;
  const authority = useActingAuthority();
  // nobody's identity is known yet: never claim an item is someone else's
  const identityUnknown = authority.pending || !!authority.unverified;
  const attention = useAttention();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const params = new URLSearchParams(location.search);
  const itemParam = params.get("item");
  const scope = params.get("scope") === "all" ? "all" : "project";
  const view = params.get("view") === "history" ? "history" : "open";
  const queueView = scope === "project" && view === "open";
  const [acted, setActed] = useState<Set<string>>(() => new Set());
  const [closed, setClosed] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [, setHistTick] = useState(0);
  const [groupsOpen, setGroupsOpen] = useState<Record<string, boolean>>({});
  const [detailW] = useState(defaultDetailWidth);
  const h = actingHuman(snap);

  const setParams = (patch: Record<string, string | null>, push = false, state?: unknown) => {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || (k === "scope" && v === "project") || (k === "view" && v === "open")) p.delete(k);
      else p.set(k, v);
    }
    const s = p.toString();
    navigate({ pathname: "/needs", search: s ? "?" + s : "" }, { replace: !push, state });
  };

  // A key is suppressed only until the snapshot confirms the decision (the
  // item leaves attention); a re-raised plan/verification with the same key
  // then shows again instead of staying hidden for the page's lifetime (QA).
  useEffect(() => {
    setActed((prev) => {
      if (!prev.size) return prev;
      const live = new Set(attention.items.map((i) => i.key));
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [attention.items]);

  // decided items hide immediately (optimistic) — the next snapshot confirms
  const items = useMemo(() => attention.items.filter((i) => !acted.has(i.key)), [attention.items, acted]);
  const mine = items.filter((i) => !i.assignedToOther);
  const others = items.filter((i) => i.assignedToOther);
  const ordered = useMemo(() => [...mine, ...others], [mine, others]);
  const followUps = attention.followUps;
  const followKey = (r: OrchaRequest) => "followup:" + r.id;
  const navKeys = [...ordered.map((i) => i.key), ...followUps.map(followKey)];

  // selection exists only in the open queue of this project (no stale detail
  // on History / All projects)
  const selValid = !!itemParam && navKeys.includes(itemParam);
  const selKey = !queueView ? null : selValid ? itemParam : itemParam || closed || narrow ? null : ordered[0]?.key ?? null;
  const selItem = ordered.find((i) => i.key === selKey) || null;
  const selFollow = followUps.find((r) => followKey(r) === selKey) || null;
  const resolvedElsewhere = queueView && !!(snap && itemParam && !selValid && !itemParam.startsWith("followup:") && !acted.has(itemParam));

  const fromList = !!(location.state as { wkFromList?: boolean } | null)?.wkFromList;
  const select = (key: string) => {
    setClosed(false);
    if (narrow) setParams({ item: key }, true, { wkFromList: true });
    else setParams({ item: key });
  };
  const closeDetail = () => {
    if (fromList) { navigate(-1); return; }
    setClosed(true);
    setParams({ item: null });
  };

  // after a successful decision: record history, hide the item, advance
  const onDecided = (item: AttentionItem, outcome: string) => {
    pushHistory(cid, { key: item.key, kind: item.kind, title: itemTitle(item), href: item.href, outcome: shortOutcome(outcome), who: h?.alias ?? null, at: Date.now() });
    setHistTick((n) => n + 1);
    const idx = ordered.findIndex((i) => i.key === item.key);
    const rest = ordered.filter((i) => i.key !== item.key);
    const next = rest[Math.min(Math.max(idx, 0), rest.length - 1)] || null;
    setActed((prev) => new Set(prev).add(item.key));
    markAttentionDecided(item.key); // sidebar badge + bell drop it at the same moment
    setAnnounce(outcome + ". " + (next ? "Next: " + kindLabel(next) + " — " + trunc(next.title, 60) : "Nothing else needs you in this project."));
    setParams({ item: next ? next.key : null });
    if (!next) setClosed(true);
  };

  // Keyboard, Linear Inbox style (queue view, wide layout):
  // - j/k and ↑/↓ move the SELECTION (not just focus) through the queue;
  //   ↑/↓ only while focus is in the list (elsewhere they scroll), j/k anywhere
  //   outside a text field.
  // - Escape first closes an EMPTY inline Reject / Request-changes form, then
  //   the detail (never while typing a draft / with a dialog or popover open).
  const detailOpen = !!(selItem || selFollow || resolvedElsewhere);
  useInboxKeys({
    enabled: queueView,
    keys: navKeys,
    selected: selKey,
    select,
    listSelector: ".nd-list",
    navDisabled: narrow,
    onEscape: (e) => {
      const form = document.querySelector<HTMLElement>(".nd-decision .reason.show");
      const ta = form?.querySelector("textarea");
      if (form && ta && !ta.value.trim()) {
        form.querySelector<HTMLElement>('[data-act="cancel-reject"]')?.click();
        return true;
      }
      if (!detailOpen || e.defaultPrevented || isEditingTarget(document.activeElement as HTMLElement | null)) return false;
      closeDetail();
      return false;
    },
  });

  // proof-of-work one-liners for verify rows — refetched when the set of tasks awaiting verification changes
  const evKey = (snap?.tasks || []).filter((t) => t.status === "needs_verification").map((t) => t.id + ":" + (t.result ? 1 : 0)).join(",");
  const evSums = useEvidenceSummaries(cid, evKey);
  const level = autLevel(snap);
  const projectName = snap?.container?.name || "this project";
  // counts come from the POST-optimistic list, so the pill, sidebar and group
  // band agree the moment a decision is made (the snapshot then confirms)
  const countLbl = attention.count == null ? "" : attentionLabel({ count: mine.length, partial: attention.partial });
  const offline = connection === "offline" || stale;

  const rowFor = (i: AttentionItem) => {
    const proof = i.kind === "verify" && i.task ? summaryText(evSums?.[String(i.task.id)], { short: true, general: projectMode === "general" }) : "";
    const ev = proof || evidencePreview(i);
    const who = agentBy(snap, i.agentAlias);
    const status = i.task ? i.task.status : i.request?.status;
    // mig 057: a manager-routed review says why it is yours ("via probe's manager") or
    // what the AI manager recommended, before the evidence preview
    const route = i.kind === "verify" && i.task ? reviewBrief(i.task) : "";
    const sub = [kindLabel(i), i.assignedToOther && !identityUnknown ? "assigned to " + otherOwner(i) : "", route, ev ? ev.replace(/\s+/g, " ") : happened(i)].filter(Boolean).join(" · ");
    return (
      <Row key={i.key} id={i.key} className="nd-row" selected={i.key === selKey} dim={i.assignedToOther} onActivate={() => select(i.key)} title={itemTitle(i)}>
        <span className="nd-av">
          {i.agentAlias ? (
            <Avatar alias={i.agentAlias} kind={who?.kind || "ai"} status={who?.status} size={24} palette={slotOf(snap, i.agentAlias)} />
          ) : (
            <Avatar alias="Embodent" kind="system" size={24} label="Embodent" />
          )}
        </span>
        <span className="nd-main">
          <span className="nd-title">{itemTitle(i)}</span>
          <span className="nd-sub">{trunc(sub, 160)}</span>
        </span>
        <span className="nd-side">
          <StatusIcon status={status} size={14} />
          <span className="nd-age" title={i.since ? clockTime(i.since) : "age unknown"}>{i.since ? relTime(i.since) : ""}</span>
        </span>
      </Row>
    );
  };

  const group = (id: string, title: string, aria: string, count: number, glyph: ReactNode, rows: ReactNode) => {
    const open = groupsOpen[id] ?? true;
    return (
      <div role="group" aria-label={aria + " (" + count + ")"} className="nd-group">
        <GroupHeader
          title={title}
          count={count}
          glyph={glyph}
          open={open}
          onToggle={() => setGroupsOpen((g) => ({ ...g, [id]: !open }))}
          controls={"nd-g-" + id}
          level={2}
        />
        <div id={"nd-g-" + id} hidden={!open}>{rows}</div>
      </div>
    );
  };

  let listPane: ReactNode;
  if (scope === "all") {
    listPane = <AllProjects currentCid={cid} liveLabel={countLbl} onOpenCurrent={() => setParams({ scope: null, view: null, item: null })} />;
  } else if (view === "history") {
    listPane = <HistoryView cid={cid} snap={snap} me={h?.alias ?? null} />;
  } else if (!snap) {
    listPane = <SnapshotPending lines={5} label="Loading decisions" what="decisions" />;
  } else if (!ordered.length && !followUps.length) {
    listPane = (
      <EmptyState
        title={`Nothing needs you in ${trunc(projectName, 40)}`}
        body={
          <>
            No plan approvals{level !== "plan" ? ` (not required at autonomy “${level}”)` : ""}, verifications{level === "full" ? ` (not required at autonomy “full”)` : ""} or requests are waiting on a human.
            {attention.partial ? " Counted from the loaded tasks and requests only." : ""}
          </>
        }
        action={
          <>
            <ButtonLink variant="secondary" to="/tasks">Go to tasks</ButtonLink>
            <Button variant="ghost" onClick={() => setParams({ view: "history" })}>View history</Button>
          </>
        }
      />
    );
  } else {
    listPane = (
      <>
        {attention.partial ? (
          <div className="nd-note" role="note">Counted from the first loaded tasks/requests (snapshot limit) — there may be more waiting.</div>
        ) : null}
        <List label="Decisions waiting" vimKeys className="nd-list">
          {mine.length ? group("mine", "Waiting on you", "Waiting on you", mine.length, <StatusGlyph status="awaiting_human" size={14} />, mine.map(rowFor)) : null}
          {others.length
            ? group("others", "Assigned to someone else", "Assigned to someone else — not counted", others.length, <StatusGlyph status="pending" size={14} />, others.map(rowFor))
            : null}
          {followUps.length
            ? group(
                "follow",
                "Answers to your requests",
                "Follow-ups",
                followUps.length,
                <StatusGlyph status="answered" size={14} />,
                followUps.map((r) => {
                  const who = agentBy(snap, r.to);
                  return (
                    <Row key={followKey(r)} id={followKey(r)} className="nd-row" selected={followKey(r) === selKey} onActivate={() => select(followKey(r))} title={requestTitle(r)}>
                      <span className="nd-av">
                        <Avatar alias={r.to || "human"} kind={who?.kind || "ai"} status={who?.status} size={24} palette={slotOf(snap, r.to)} />
                      </span>
                      <span className="nd-main">
                        <span className="nd-title">{trunc(requestTitle(r), 90)}</span>
                        <span className="nd-sub">{trunc(["Answered", r.to ? "by " + r.to : "", payloadText(r.response)].filter(Boolean).join(" · "), 160)}</span>
                      </span>
                      <span className="nd-side">
                        <StatusIcon status={r.status} size={14} />
                        <span className="nd-age">{r.responded_at ? relTime(r.responded_at) : ""}</span>
                      </span>
                    </Row>
                  );
                }),
              )
            : null}
        </List>
        {!mine.length ? (
          <div className="nd-emptyline">Nothing is waiting on you — the items above are assigned to someone else or informational.</div>
        ) : null}
      </>
    );
  }

  /* ---- detail ---- */
  const idx = selKey ? navKeys.indexOf(selKey) : -1;
  const detailTitle = selItem
    ? selItem.request ? requestDetailTitle(selItem.request) : itemTitle(selItem)
    : selFollow ? requestDetailTitle(selFollow) : "Already decided";
  const fullTitle = selItem ? itemTitle(selItem) : selFollow ? requestTitle(selFollow) : detailTitle;
  const selReq = selItem?.request ?? selFollow ?? null;
  const reqHead = selReq ? requestHead(selReq) : null;
  const selStatus = selItem ? (selItem.task ? selItem.task.status : selItem.request?.status) : selFollow?.status;
  const selId = selItem ? selItem.id : selFollow ? selFollow.id : null;
  const openHref = selItem ? selItem.href : selFollow ? "/requests?req=" + encodeURIComponent(selFollow.id) : null;

  const inspector =
    queueView && detailOpen ? (
      <section id="detailMain" className="nd-detail" aria-label={selItem ? kindLabel(selItem) + ": " + itemTitle(selItem) : "Decision"}>
        <PageHeader
          className="nd-dhead"
          titleAs="div"
          glyph={
            narrow ? (
              <CircleIconButton icon="arrow-left" label="Back to Needs you" size="sm" className="nd-back" onClick={closeDetail} />
            ) : selStatus ? <StatusIcon status={selStatus} size={14} /> : undefined
          }
          id={selId ? <CopyId id={selId} /> : undefined}
          title={<span className="nd-dkind">{selItem ? headerKind(selItem) : selFollow ? "Follow-up" : "Decision"}</span>}
          actions={
            <>

              {openHref ? (
                <Tooltip label={selItem?.task ? "Open task" : "Open request"}>
                  <a className="v2-iconbtn v2-iconbtn-sm v2-iconbtn-circle v2-iconbtn-outline nd-open" href={openHref} aria-label={selItem?.task ? "Open task" : "Open request"}>
                    <svg className="v2-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7" /></svg>
                  </a>
                </Tooltip>
              ) : null}
              {narrow ? null : <CircleIconButton icon="x" label="Close details" size="sm" onClick={closeDetail} />}
            </>
          }
          pager={
            idx >= 0 ? (
              // the pager walks every band (waiting + assigned elsewhere + answers), so its
              // total can exceed the "Waiting on you" badge: say so where the number is
              <span className="nd-pager" title={pagerHint(navKeys.length, mine.length)}>
                <Pager
                  index={idx}
                  total={navKeys.length}
                  noun="item"
                  onPrev={() => idx > 0 && select(navKeys[idx - 1])}
                  onNext={() => idx < navKeys.length - 1 && select(navKeys[idx + 1])}
                />
              </span>
            ) : undefined
          }
        />
        <div className="nd-dbody">
          <h1 className="nd-dtitle v2-t-display" title={detailTitle !== fullTitle ? fullTitle : undefined}>{detailTitle}</h1>
          {selItem && selItem.task ? (
            <TaskDecision key={selItem.key} item={selItem} onDecided={(o) => onDecided(selItem, o)} />
          ) : selItem && selItem.request ? (
            <>
              <div className="nd-decision nd-req">
                <RequestDetail
                  key={selItem.key}
                  r={selItem.request}
                  idShown
                  statusShown
                  typeShown
                  titleShown={reqHead?.titleShown}
                  onSelect={(id) => navigate("/requests?req=" + encodeURIComponent(id))}
                  onResolved={(_r, how) => onDecided(selItem, how === "answered" ? "Answered" : how === "closed" ? "Closed" : how === "escalated" ? "Escalated" : how === "converted" ? "Converted to task" : "Suggestion decided")}
                />
              </div>
            </>
          ) : selFollow ? (
            <>
              <div className="nd-decision nd-req">
                <RequestDetail key={followKey(selFollow)} r={selFollow} idShown statusShown typeShown titleShown={reqHead?.titleShown} onSelect={(id) => navigate("/requests?req=" + encodeURIComponent(id))} />
              </div>
            </>
          ) : (
            <EmptyState
              title="No longer waiting"
              body="This item isn't waiting on a decision any more — it was decided elsewhere or its state changed. See History for recent decisions."
              action={<Button variant="secondary" onClick={() => setParams({ view: "history", item: null })}>View history</Button>}
            />
          )}
        </div>
      </section>
    ) : null;

  const viewKey = scope === "all" ? "all" : view;
  const list = (
    <div id="nlist" className="nd-listcol">
      <div className="nd-listhead">
        <FilterPills
          label="Needs you views"
          size="sm"
          value={viewKey}
          onChange={(k) =>
            setParams(k === "all" ? { scope: "all", view: null, item: null } : k === "history" ? { scope: null, view: "history", item: null } : { scope: null, view: null })
          }
          items={[
            { key: "open", label: "Waiting", count: attention.count != null ? countLbl : null, title: projectName === "this project" ? undefined : "Waiting on you in " + projectName },
            { key: "history", label: "History" },
            { key: "all", label: "All projects" },
          ]}
        />
        <span className="v2-grow" />
        {scope === "project" ? (
          <Tooltip placement="bottom" label="Counts one item per task or request waiting on you; items assigned to someone else are listed, not counted.">
            <span className="nd-info" tabIndex={0} role="img" aria-label="How this queue counts: one item per task or request waiting on you; items assigned to someone else are listed, not counted.">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 9.2v4.3M10 6.6h.01" /></svg>
            </span>
          </Tooltip>
        ) : null}
      </div>
      {offline && scope === "project" ? (
        <div className="nd-note" role="status">
          Not live{lastOkAt ? ` — showing data from ${clockTime(new Date(lastOkAt).toISOString())}` : ""}. Some items may already be decided.
        </div>
      ) : null}
      {authority.unverified && scope === "project" ? (
        <div className="nd-note" role="note">
          <span>{authority.reason}</span>
          <Button size="sm" variant="secondary" onClick={() => retryIdentity()}>Retry</Button>
        </div>
      ) : !h && !authority.pending && scope === "project" && snap ? (
        <div className="nd-note" role="note">
          {/* a viewer / non-member IS signed in: name that reason, not "no acting human" */}
          {authority.readOnly && authority.reason ? authority.reason + " — decisions are disabled." : "No acting human on this project — decisions are disabled until a human identity is acting."}
        </div>
      ) : null}
      {listPane}
    </div>
  );

  return (
    <Shell page="needs" title="Needs you" flush>
      <style>{workCss}</style>
      <div className="v2-sr" id="needsAnnounce" role="status" aria-live="polite">{announce}</div>
      <div className={"nd" + (queueView ? "" : " is-wide")}>
        <SplitPane list={list} inspector={inspector} storageKey="orcha:v2:needsDetailW" defaultSize={detailW} min={420} max={1200} label="Resize decision detail" />
      </div>
    </Shell>
  );
}
