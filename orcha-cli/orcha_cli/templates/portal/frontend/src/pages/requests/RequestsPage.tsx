/**
 * Requests page (V2, owner D) — Linear Inbox layout over the UNCHANGED backend.
 *
 * Layout (D5/D10/D12): filter pills + circular toolbar buttons in the Shell's
 * fixed toolbar slot; a narrow list of two-line inbox items (round requester
 * avatar, bold headline, muted "who → who · status" line, status glyph + age)
 * on the left; the open request on the right like a Linear issue — a 44px bar
 * (short id, "1 / N" pager, close), a Display title, the readable payload, a
 * compact decision card ("Your move" / roster suggestion), the request chain
 * and the activity as timelines, and properties in a rail (right when the
 * pane is wide, below otherwise).
 *
 * - URL: `?req=<id>` selects (history-replace, ISS-38); `?filter=all|open|
 *   answered|escalated|task`, `?dir=in|out|agents` and `?q=` persist the list
 *   query. Below 900 px a selection pushes, so Back returns to the list.
 * - ISS-68 PR-3 render cap: top-N + "Load more"; the selected/deeplinked row is
 *   appended past the window so it stays reachable. Resets on filter switch.
 * - ISS-331 sort (Time/Priority + direction, persisted per-surface in
 *   orcha:sort:requests) — status rank (open→answered→other) stays the outer
 *   key. Rendered as one circular menu button (same persisted state as SortCtl).
 * - Exact status is always shown as text; a request routed to the acting human
 *   is flagged by the recipient reading "you" (never relabelled).
 * - Payloads/responses are rendered human-readable (requestPayload.tsx) —
 *   never raw JSON or "[object Object]" (D4).
 * - Every action keeps its original authorization gate (isTarget/isRequester)
 *   and wire body. A failed action keeps the typed answer / modal fields and
 *   shows the server's reason inline (ISS-46/53 drafts live in useState).
 * - RequestDetail is exported for the Needs-you queue (same actions, same
 *   semantics; `onResolved` lets the queue advance after a successful action).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AgentCapNotice, agentCapOf, agentLimitFacts, type AgentCap } from "../../lib/agentCap";
import { sendJSON } from "../../api/client";
import { clockTime, relTime, shortId, trunc } from "../../lib/format";
import { statusMeta } from "../../lib/status";
import { Icon, Linkified, useToast } from "../../components/ui";
import { Tooltip } from "../../components/primitives";
import {
  Avatar, Button, ButtonLink, Chip, Dialog, actorKey, rosterPaletteSlots, EmptyState, IconButton, List, Menu, PriorityIcon, Row, SplitPane, StatusGlyph, StatusIcon,
  isEditingTarget, type MenuItemSpec,
} from "../../components/primitives";
import { Timeline, TimelineComment, TimelineEvent } from "../../components/primitives";
import { Property, PropertyRail, PropertySection } from "../../components/primitives";
import { Composer } from "../../components/primitives";
import { markAttentionDecided, unmarkAttentionDecided } from "../../state/attention";
import { RESOLVE_UNDO_MS, scheduleResolve, undoResolve, useResolving } from "./resolveUndo";
import { Shell } from "../../shell/Shell";
import { CircleIconButton, FilterPills, PageHeader, Pager, scrollMainTo } from "../../shell/PageChrome";
import { useInboxKeys } from "../needs/useInboxKeys";
import {
  actingHuman,
  agentByAlias,
  isToHuman,
  taskById,
  useActingAuthority,
  useSnapshot,
} from "../../state/SnapshotProvider";
import type { Agent, OrchaRequest, Snapshot } from "../../types";
import { sortComparator, sortState, type SortState } from "../../lib/sort";
import { workCss } from "../tasks/workCss";
import { SnapshotPending } from "../../components/SnapshotPending";
import { grantDenied } from "../agents/agentModel";
import { PayloadView, payloadAfterTitle, payloadSearchText, payloadText, reqDetailTitle, reqTitle } from "./requestPayload";
import { detailCss, listCss } from "./requestsCss";

export { payloadText, payloadTitle, requestTitle } from "./requestPayload";

const REQS_PAGE = 30; // ISS-68 PR-3 render-cap page size (dense V2 rows)
const NO_HUMAN_REQ = "Pick an acting human to arbitrate this request — actions are recorded under a human identity, and none is acting on this project.";
/** Why the acting human can't arbitrate: the viewer / non-member / offline reason when that is
 *  the cause (a viewer IS a human — "pick an acting human" would mislead), else NO_HUMAN_REQ. */
export function noHumanReqReason(a: { readOnly: boolean; pending: boolean; reason: string | null }): string {
  return (a.readOnly || a.pending) && a.reason ? a.reason : NO_HUMAN_REQ;
}
function useNoHumanReq(): string {
  return noHumanReqReason(useActingAuthority());
}
/** Backend default priority (schemas/requests.py `priority: int = 100`) — not shown on rows. */
export const DEFAULT_PRIORITY = 100;

/* REQ-013 parity: the old "Escalations" tab listed every request routed to a human
 * (plus the legacy escalated status). The snapshot carries no escalation flag for
 * an escalated-then-open request (the backend keeps status "open" and re-targets a
 * human), so an "escalated only" pill silently dropped every real escalation. The
 * pill is honestly named for what the data can tell: requests to a human — which
 * includes every escalation. `?filter=escalated` (old links) maps to it. */
export const REQ_FILTERS = [
  { k: "all", label: "All" },
  { k: "open", label: "Open" },
  { k: "answered", label: "Answered" },
  { k: "human", label: "To a human" },
  { k: "task", label: "Tasks" },
] as const;
type FilterKey = (typeof REQ_FILTERS)[number]["k"];
/** URL filter value → key (the old "escalated" key is an alias of "human"). */
export function filterKeyOf(raw: string | null): FilterKey {
  if (raw === "escalated") return "human";
  return REQ_FILTERS.some((f) => f.k === raw) ? (raw as FilterKey) : "all";
}

/** Direction relative to the acting human (the brief's incoming / outgoing split). */
export const DIR_FILTERS = [
  { k: "any", label: "All directions", short: "Direction" },
  { k: "in", label: "To you", short: "To you" },
  { k: "out", label: "From you", short: "From you" },
  { k: "agents", label: "Between agents", short: "Agents" },
] as const;
export type DirKey = (typeof DIR_FILTERS)[number]["k"];

/** "info" → "Info request" (fallback title for payloads with no readable headline). */
const typeLabel = (t: string | null | undefined) => { const s = (t || "request").trim(); return s[0].toUpperCase() + s.slice(1) + (s === "request" ? "" : " request"); };
const prioNum = (p: OrchaRequest["priority"]) => (p == null || p === "" ? DEFAULT_PRIORITY : Number(p));

/** "you" for the generic human and for the acting human's own alias. */
function partyLabel(snap: Snapshot | null, name: string): string {
  if (name === "human") return "you";
  const h = actingHuman(snap);
  return h && h.alias === name ? "you" : name;
}

/* ---- ISS-331 sort (shared lib/sort — same orcha:sort:requests key) -------- */
// ISS-83: requests carry no frontend sort — they arrive in backend order. The comparator
// mirrors the server _sort_clause: status rank (open→answered→other) stays the OUTER key.
const REQ_STATUS_RANK: Record<string, number> = { open: 0, answered: 1 };
const reqRank = (r: OrchaRequest) => REQ_STATUS_RANK[r.status] ?? 2;
const reqTime = (r: OrchaRequest) => Date.parse(r.created_at || "") || 0;

/* ---- escalations made in this session ------------------------------------
 * POST /escalate re-targets the request at a human and keeps status "open"; the
 * snapshot has no flag for it (cross-file request: expose `escalated` from the
 * events table). A successful escalate from this tab is a known fact, so it is
 * remembered (in memory + sessionStorage) and shown as escalated until reload of
 * the session — never inferred for requests we did not escalate. */
const ESC_KEY = "orcha:v2:escalatedReqs";
let escLocal: Set<string> | null = null;
function escSet(): Set<string> {
  if (escLocal) return escLocal;
  escLocal = new Set();
  try {
    const v = JSON.parse(window.sessionStorage.getItem(ESC_KEY) || "[]");
    if (Array.isArray(v)) v.forEach((x) => typeof x === "string" && escLocal!.add(x));
  } catch { /* unavailable */ }
  return escLocal;
}
/** Remember that request `id` was escalated from this session (after a 2xx). */
export function markEscalatedLocally(id: string): void {
  const s = escSet();
  s.add(id);
  try { window.sessionStorage.setItem(ESC_KEY, JSON.stringify([...s].slice(-200))); } catch { /* private mode */ }
}
/** test hook */
export function _resetLocalEscalations(): void {
  escLocal = null;
  try { window.sessionStorage.removeItem(ESC_KEY); } catch { /* unavailable */ }
}

/** Was this request escalated to a human? (backend flag, the legacy status word, or escalated from this session) */
export function isEscalated(r: OrchaRequest): boolean {
  return !!r.escalated || r.status === "escalated" || (r.status === "open" && escSet().has(r.id));
}

/** Incoming / outgoing relative to the acting human (null = between agents). */
export function requestDirection(snap: Snapshot | null, r: OrchaRequest): "incoming" | "outgoing" | null {
  const h = actingHuman(snap);
  if (!h) return null;
  if (String(r.requester_id) === String(h.id)) return "outgoing";
  if (String(r.target_id) === String(h.id) || (r.target_id == null && r.to === "human")) return "incoming";
  return null;
}

/** Pure: does a request match the list filter + direction + search? (exported for tests / Needs) */
export function requestMatches(snap: Snapshot | null, r: OrchaRequest, filter: string, q: string, dir: string = "any"): boolean {
  const toHuman = isToHuman(snap, r);
  // REQ-013: every request routed to a human (the old "Escalations" set) — escalations included
  if ((filter === "human" || filter === "escalated") && !(toHuman || r.to === "human" || isEscalated(r))) return false;
  if (filter === "task" && r.type !== "task") return false;
  if (filter === "answered" && r.status !== "answered") return false;
  if (filter === "open" && r.status !== "open") return false;
  if (dir !== "any") {
    const d = requestDirection(snap, r);
    if (dir === "in" && d !== "incoming") return false;
    if (dir === "out" && d !== "outgoing") return false;
    if (dir === "agents" && (d !== null || toHuman || r.to === "human" || r.from === "human")) return false;
  }
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const hay = [r.id, r.type, r.status, r.from, r.to, r.title || "", payloadSearchText(r.payload), payloadSearchText(r.response)].join("\n").toLowerCase();
  return s.split(/\s+/).every((tok) => (tok.startsWith("#") && tok.length > 1 ? String(r.id).toLowerCase().startsWith(tok.slice(1)) : hay.includes(tok)));
}

/** Relative time that understands the future ("in 30m") — expiry is usually ahead. */
export function relWhen(iso: string | null | undefined, now = Date.now()): { text: string; past: boolean } {
  if (!iso) return { text: "—", past: false };
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return { text: "—", past: false };
  const diff = (t - now) / 1000;
  if (diff <= 0) return { text: relTime(iso), past: true };
  const f = diff < 60 ? Math.max(1, Math.floor(diff)) + "s" : diff < 3600 ? Math.floor(diff / 60) + "m" : diff < 86400 ? Math.floor(diff / 3600) + "h" : Math.floor(diff / 86400) + "d";
  return { text: "in " + f, past: false };
}

/* ---- small render helpers ------------------------------------------------ */
/** Status glyph + exact label (D8: the one StatusIcon set — open = neutral ring with dot). */
export function ReqStatus({ status, showLabel = true }: { status: string; showLabel?: boolean }) {
  return <StatusIcon status={status} showLabel={showLabel} className="rq-status" />;
}

/** "Info request" → "an info request" (activity sentences). */
function aType(t: string | null | undefined): string {
  const s = typeLabel(t).toLowerCase();
  return (/^[aeiou]/.test(s) ? "an " : "a ") + s;
}

function TaskLink({ snap, id, label, status }: { snap: Snapshot | null; id: string; label?: string; status?: string | null }) {
  const t = taskById(snap, id);
  const title = label || t?.title || "";
  const st = status ?? t?.status ?? null;
  // Linear "Duplicate ENG-1998 …" pattern: glyph + muted short id + regular-weight title
  return (
    <a className="rq-tasklink" href={"/tasks?task=" + encodeURIComponent(id)} title={title || shortId(id)}>
      {st ? <StatusGlyph status={st} size={14} /> : null}
      <span className="rq-tasklink-id">{shortId(id)}</span>
      {title ? <span className="rq-tasklink-t">{title}</span> : null}
    </a>
  );
}

/** Round avatar for a request party ("human" → the acting human). D7: AI sparkle + presence dot, humans neither. */
function PartyAvatar({ snap, alias, size = 20, decorative }: { snap: Snapshot | null; alias: string; size?: 16 | 20 | 24 | 32; decorative?: boolean }) {
  const h = actingHuman(snap);
  const shown = alias === "human" && h ? h.alias : alias;
  const a = agentByAlias(snap, shown);
  const isHuman = alias === "human" || (!!h && h.alias === alias) || (!!a && a.kind === "human");
  const slot = rosterPaletteSlots(snap?.agents)?.get(actorKey(shown));
  return (
    <Avatar
      alias={shown} kind={isHuman ? "human" : "ai"} size={size} decorative={decorative}
      status={!isHuman && a ? a.status : undefined} palette={slot} ghLogin={a?.github_login ?? undefined}
    />
  );
}

function AgentNode({ snap, alias }: { snap: Snapshot | null; alias: string }) {
  const h = actingHuman(snap);
  const isHuman = alias === "human" || (!!h && h.alias === alias);
  const a = agentByAlias(snap, alias);
  const label = partyLabel(snap, alias);
  const inner = (
    <>
      <PartyAvatar snap={snap} alias={alias} size={20} decorative />
      {label}
    </>
  );
  const title = label === "you" ? (h ? h.alias + " (you)" : "a human") : alias;
  // a human node has no destination page — plain text, not a dead link
  return isHuman || (a && a.kind === "human") ? (
    <span className="node" title={title}>{inner}</span>
  ) : (
    <a className="node dlink" title={title} href={"/agents?agent=" + encodeURIComponent(alias)}>{inner}</a>
  );
}

/** Clock time, prefixed with the date unless it is today (a bare "05:35 PM" on a
 *  3-day-old request is ambiguous); relative time + full stamp in the tooltip. */
export function stampText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return clockTime(iso);
  if (d.toDateString() === now.toDateString()) return clockTime(iso);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts) + ", " + clockTime(iso);
}
function stamp(iso: string): ReactNode {
  return <span title={relTime(iso) + " · " + iso}>{stampText(iso)}</span>;
}

function expiryStamp(iso: string, open: boolean): ReactNode {
  const w = relWhen(iso);
  const soon = !w.past && new Date(iso).getTime() - Date.now() < 3600_000;
  return (
    <span title={iso} className={open && w.past ? "rq-expired" : open && soon ? "rq-soon" : undefined}>
      {stampText(iso)} <span className="wk-lbl" style={{ color: "inherit", opacity: 0.85 }}>· {w.past ? (open ? "overdue, expired " : "expired ") + w.text : w.text}</span>
    </span>
  );
}

/** The request's short ID shown ONCE (detail header): ID text + a copy icon on hover / focus —
 *  the same affordance as the Needs-you header. */
function CopyId({ id }: { id: string }) {
  const toast = useToast();
  const failed = () => toast("Couldn't copy — select the id instead", "warn");
  return (
    <Tooltip label="Copy ID">
      <button
        type="button"
        className="v2-t-id rq-id"
        aria-label={"Copy request id " + shortId(id)}
        onClick={() => {
          try {
            const p = navigator.clipboard?.writeText(id);
            if (p) void p.then(() => toast("Request id copied", "ok"), failed);
            else failed();
          } catch { failed(); }
        }}
      >
        <span className="wk-id" title={id}>{shortId(id)}</span>
        <Icon name="copy" cls="v2-ico rq-id-copy" />
      </button>
    </Tooltip>
  );
}

/* ---- answers sent but not yet in the snapshot ------------------------------
 * After "Answer sent" the snapshot that shows it answered can be a poll or
 * two away (a refresh racing the write can still say "open"). Until the
 * snapshot moves the request off "open", the detail reads "Answered ·
 * syncing…" and offers no second Answer (no double answers — the badge has
 * already dropped it). Entries clear once the status changes, or after a
 * minute as a safety net (then the snapshot is the truth again). */
const PENDING_TTL = 60_000;
const pendingAnswers = new Map<string, { text: string; at: number }>();
/** Remember an answer just sent for request `id`. */
export function markAnswerPending(id: string, text: string, now = Date.now()): void { pendingAnswers.set(id, { text, at: now }); }
/** The locally-sent answer for a request the snapshot still calls "open" — kept across
 *  snapshots until the status changes (or PENDING_TTL passes). Exported for tests. */
export function pendingAnswer(r: OrchaRequest, now = Date.now()): { text: string; at: number } | null {
  const p = pendingAnswers.get(r.id);
  if (!p) return null;
  if (r.status !== "open" || now - p.at > PENDING_TTL) { pendingAnswers.delete(r.id); return null; }
  return p;
}
/** test hook */
export function _resetPendingAnswers(): void { pendingAnswers.clear(); }

/* ---- modal state --------------------------------------------------------- */
type ModalSt =
  | { kind: "escalate"; req: OrchaRequest }
  | { kind: "convert"; req: OrchaRequest; title: string; dod: string; assignee: string }
  | { kind: "close"; req: OrchaRequest; reason: string };

type Resolution = "answered" | "escalated" | "converted" | "closed" | "suggestion";

/* ============================================================================
   Agent-suggestion decision (PI-10) — POST /api/agent-suggestions/{rid}/decide
   {kind: create|reassign|refuse, target_alias?, reason?, actor_agent_id}.
   Rendered ONLY when the snapshot carries the request's `detail.proposed_alias`
   (the backend's own suggestion marker) and the request is still open. A human
   decides; the agent never creates another agent on its own.
   ========================================================================== */
interface SuggestionDetail { proposed_alias?: string; proposed_role?: string; proposed_prompt?: string; rationale?: string; suggestion_decided?: unknown }
export function suggestionOf(r: OrchaRequest): SuggestionDetail | null {
  const d = (r as OrchaRequest & { detail?: unknown }).detail;
  if (!d || typeof d !== "object") return null;
  const s = d as SuggestionDetail;
  // UO-11b: once decided (create / reassign stamp detail.suggestion_decided)
  // the request never offers "Create agent…" again
  if (s.suggestion_decided) return null;
  return typeof s.proposed_alias === "string" && s.proposed_alias ? s : null;
}

/** UO-11a: a failed suggestion decision in plain words — the server's reason,
 *  never the raw "/api/agent-suggestions/<id>/decide → 409" error text (D4). */
export function suggestionFailMsg(e: unknown, mode: "create" | "reassign" | "refuse"): string {
  const err = e as { status?: number; detail?: string; message?: string };
  const detail = err.detail || (err.message || "").split(": ").slice(1).join(": ");
  const what = mode === "create" ? "Couldn't create the agent" : mode === "reassign" ? "Couldn't reassign" : "Couldn't refuse the suggestion";
  if (err.status == null) return what + " — the portal could not be reached.";
  return what + " (" + err.status + ")" + (detail ? ": " + detail : ".");
}

/** A task request's proposed task (backend `requests.detail` {title, definition_of_done}),
 *  or null when the request carries none. Never invented: both fields come from the row. */
export function proposedTaskOf(r: OrchaRequest): { title: string; dod: string | null } | null {
  if ((r.type || "").toLowerCase() !== "task") return null;
  const d = r.detail;
  if (!d || typeof d !== "object") return null;
  const title = typeof d.title === "string" ? d.title.trim() : "";
  if (!title) return null;
  const dod = typeof d.definition_of_done === "string" && d.definition_of_done.trim() ? d.definition_of_done.trim() : null;
  return { title, dod };
}

/** Who wrote the request's response. After an escalation the row's target is the human it was
 *  re-routed to; an answer given BEFORE the escalation came from the original target. */
export function responderAlias(r: OrchaRequest): string {
  const from = r.escalated_from;
  if (isEscalated(r) && from && r.responded_at) {
    const at = Date.parse(r.responded_at);
    const esc = r.escalated_at ? Date.parse(r.escalated_at) : NaN;
    if (!r.escalated_at || (Number.isFinite(at) && Number.isFinite(esc) && at < esc)) return from;
  }
  return r.to;
}

/** Closing someone else's request needs a reason (backend request_close_routes: a human
 *  closing a request it does not own → 422 reason_required). */
export function closeNeedsReason(req: OrchaRequest, h: Agent | null): boolean {
  return !h || String(req.requester_id) !== String(h.id);
}

function SuggestionDecision({ r, onDone, overflow = [] }: { r: OrchaRequest; onDone: (k: Resolution) => void; overflow?: MenuItemSpec[] }) {
  const { snap, refresh, identity } = useSnapshot();
  const noHuman = useNoHumanReq();
  const toast = useToast();
  const s = suggestionOf(r)!;
  // parity e2e-permissions-29: creating the agent is owner-or-manage_agents — the same gate
  // as Agents › New agent (agent_registration_routes). Reassign / Refuse stay member-level.
  // PS-29: the connection-aware actor — offline / read-only → every decision disables
  const h = useActingAuthority().human;
  const createDenied = grantDenied(snap, identity, "manage_agents", noHuman) ?? (h ? null : noHuman);
  const ais = (snap?.agents ?? []).filter((a) => a.kind === "ai");
  const [mode, setMode] = useState<null | "create" | "reassign" | "refuse">(null);
  const [target, setTarget] = useState(ais[0]?.alias ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the project's agent limit refused "Create agent" — shown as the cap notice, not the raw error
  const [cap, setCap] = useState<AgentCap | null>(null);
  useRefocusDialogOnError(!!mode && !busy && !!error);

  const decide = async () => {
    if (!h || !mode) return;
    setBusy(true);
    setError(null);
    try {
      await sendJSON("POST", "/api/agent-suggestions/" + encodeURIComponent(r.id) + "/decide", {
        kind: mode,
        target_alias: mode === "reassign" ? target : undefined,
        reason: mode === "refuse" ? reason.trim() || undefined : undefined,
        actor_agent_id: h.id,
      });
      toast(mode === "create" ? "Agent " + s.proposed_alias + " created" : mode === "reassign" ? "Reassigned to " + target : "Suggestion refused", "ok");
      setMode(null);
      onDone("suggestion");
      void refresh();
    } catch (e) {
      setCap(mode === "create" ? agentCapOf(e, agentLimitFacts(snap)) : null);
      setError(suggestionFailMsg(e, mode));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rq-card" aria-label="Agent suggestion">
      <header className="rq-card-h">
        <Icon name="spark" cls="v2-ico rq-card-ico" />
        <span className="rq-card-t">Roster suggestion</span>
        <HelpDot text="A human decides — agents never create agents on their own." />
      </header>
      <dl className="rq-card-kv">
        <dt>Proposed agent</dt>
        <dd><Chip size="sm" icon={<Avatar alias={s.proposed_alias} kind="ai" size={16} decorative />}>{s.proposed_alias}</Chip></dd>
        {s.proposed_role ? (<><dt>Role</dt><dd>{s.proposed_role}</dd></>) : null}
        {s.rationale ? (<><dt>Rationale</dt><dd><Linkified text={s.rationale} tasks={snap?.tasks} /></dd></>) : null}
      </dl>
      {s.proposed_prompt ? (
        <details className="rq-raw">
          <summary>Proposed instructions</summary>
          <div className="rq-payload" style={{ whiteSpace: "pre-wrap" }}>{s.proposed_prompt}</div>
        </details>
      ) : null}
      {/* wave-4 (390px): Refuse lives in ⋯ beside the two real choices, all right-aligned on one line */}
      <div className="rq-actions rq-sugg-acts">
        <MoreMenu
          label="More suggestion actions"
          items={[
            { label: "Refuse suggestion…", icon: "x", danger: true, disabled: !h, disabledReason: h ? undefined : noHuman, onSelect: () => { setError(null); setMode("refuse"); } },
            ...overflow,
          ]}
        />
        <Button variant="secondary" disabled={!h || !ais.length} title={!ais.length ? "No existing AI agent to reassign to" : h ? undefined : noHuman} aria-label="Reassign to existing…" onClick={() => { setError(null); setMode("reassign"); }}>Reassign<span className="rq-wide-only"> to existing</span>…</Button>
        <Button variant="primary" icon="plus" disabled={!!createDenied} title={createDenied ?? undefined} data-denied={createDenied ?? undefined} onClick={() => { if (createDenied) return; setError(null); setMode("create"); }}>Create agent…</Button>
      </div>
      {mode ? (
        <Dialog
          title={mode === "create" ? `Create agent “${s.proposed_alias}”?` : mode === "reassign" ? "Reassign to an existing agent?" : "Refuse this suggestion?"}
          description={
            mode === "create"
              ? "Creates the proposed agent with the role and instructions above, then routes this request to it. The project's agent cap still applies."
              : mode === "reassign"
                ? "Re-targets the request at an existing agent; that agent still has to accept the task."
                : "Closes the request; the requester sees it refused."
          }
          onClose={() => { if (!busy) setMode(null); }}
          size="sm"
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
              <Button variant={mode === "refuse" ? "danger" : "primary"} busy={busy} onClick={() => void decide()}>
                {error && cap ? "Retry" : mode === "create" ? "Create agent" : mode === "reassign" ? "Reassign" : "Refuse"}
              </Button>
            </>
          }
        >
          {mode === "reassign" ? (
            <label className="wk-form">
              <span className="wk-lbl">Agent</span>
              <select className="wk-select" value={target} onChange={(e) => setTarget(e.target.value)}>
                {ais.map((a) => <option key={a.id} value={a.alias}>{a.alias}</option>)}
              </select>
            </label>
          ) : mode === "refuse" ? (
            <textarea className="ans-in" aria-label="Reason (optional)" placeholder="Reason (optional)…" value={reason} onChange={(e) => setReason(e.target.value)} />
          ) : null}
          {error && cap ? <AgentCapNotice cap={cap} canRaise={!createDenied} /> : error ? <div className="wk-err" role="alert"><b>Not decided.</b> {error}</div> : null}
        </Dialog>
      ) : null}
    </section>
  );
}

/**
 * After a failed submit the busy button re-enables but focus has already dropped
 * to <body> (the disabled button lost it), so the dialog's own Escape handler
 * never fires. Pull focus back into the open dialog (its first field, else the
 * dialog itself) once the error shows. */
export function useRefocusDialogOnError(failed: boolean): void {
  useEffect(() => {
    if (!failed) return;
    const dlg = document.querySelector<HTMLElement>('.v2-dialog[role="dialog"]');
    if (!dlg || dlg.contains(document.activeElement)) return;
    (dlg.querySelector<HTMLElement>("textarea, input, select") ?? dlg).focus();
  }, [failed]);
}

/** Small help glyph whose explanation lives in its tooltip (D12: boilerplate out of the layout). */
function HelpDot({ text }: { text: string }) {
  return (
    <span className="rq-help" role="img" aria-label={text} title={text} tabIndex={0}>
      <Icon name="info" cls="v2-ico" />
    </span>
  );
}

/** Overflow ("More actions") menu button for secondary request actions. */
function MoreMenu({ items, label = "More request actions" }: { items: MenuItemSpec[]; label?: string }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <>
      <IconButton ref={ref} icon="more" label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} items={items} label={label} placement="bottom-end" />
    </>
  );
}

/** What the acting human can do with this request — every gate unchanged from the vanilla page. */
export function requestActions(snap: Snapshot | null, req: OrchaRequest, h: Agent | null) {
  const none = { answer: false, convert: false, escalate: false, nudge: false, close: false, nudgeWho: "" };
  if (!h || req.status === "closed" || req.status === "converted_to_task") return none;
  const isTarget = String(req.target_id) === String(h.id) || req.to === "human";
  const isRequester = String(req.requester_id) === String(h.id);
  const live = req.status === "open" || req.status === "answered";
  // Nudge wakes whoever owns the NEXT action (backend request_nudge_routes: open → target,
  // answered → requester). Offer it only when that owner is an AI agent other than you —
  // a human owner (you, or an escalation) is a guaranteed no-op.
  const ownerAlias = req.status === "open" ? req.to : req.status === "answered" ? req.from : "";
  const owner = ownerAlias && ownerAlias !== "human" ? agentByAlias(snap, ownerAlias) : null;
  const ownerIsAi = !!ownerAlias && ownerAlias !== "human" && ownerAlias !== h.alias && (owner ? owner.kind !== "human" : true);
  return {
    answer: isTarget && req.status === "open",
    convert: isRequester && req.status === "answered",
    escalate: isRequester && live,
    nudge: live && ownerIsAi,
    nudgeWho: ownerIsAi ? ownerAlias : "",
    close: true,
  };
}

/**
 * Your own question came back answered (owner request): the card shows the answer and one-click
 * Resolve is primary; "Turn into a task" / "Ask a follow-up" are secondary. Only a request that
 * asks for WORK (type task) keeps "Convert to task" as the primary action.
 */
export function isAnsweredQuestion(req: OrchaRequest, h: Agent | null): boolean {
  return !!h && req.status === "answered" && String(req.requester_id) === String(h.id) && (req.type || "").toLowerCase() !== "task";
}

/** Line label for a code-thread anchor ("L3" / "L3–9"). */
const lineLabel = (s: number, e: number) => (s === e ? "L" + s : "L" + s + "–" + e);

/** The decision an open request routed to you asks for (Linear's triage card names it). */
function askTitle(req: OrchaRequest, from: string): string {
  const t = (req.type || "").toLowerCase();
  if (t === "review") return "Review requested from you";
  if (t === "handoff") return "Handoff to you";
  if (t === "task") return from + " asks you to take a task";
  return from + " asks you";
}

/**
 * Who owns the NEXT action on a request, as the decision card's title — the
 * card names the decision ("lead asks you", "Review requested from you") only
 * when the acting human owns it (backend routing:
 * open → target, answered → requester; see request_nudge_routes). Everything
 * else is titled by its owner ("Waiting on maria"), never "Nothing needed" on
 * an item that is counted as waiting on you.
 */
export function requestNextStep(snap: Snapshot | null, req: OrchaRequest, h: Agent | null): { mine: boolean; owner: string | null; title: string } {
  const isTarget = !!h && (String(req.target_id) === String(h.id) || req.to === "human");
  const isRequester = !!h && String(req.requester_id) === String(h.id);
  const name = (a: string) => partyLabel(snap, a);
  const esc = isEscalated(req);
  if (req.status === "open") {
    if (isTarget) return { mine: true, owner: h!.alias, title: esc ? "Escalated to you" : askTitle(req, name(req.from)) };
    return { mine: false, owner: req.to, title: (esc ? "Escalated · waiting on " : "Waiting on ") + name(req.to) };
  }
  if (req.status === "answered") {
    // your own question came back: say who answered and what is left to do
    if (isRequester) {
      // a question: read the answer and resolve it; a work request: convert it (see isAnsweredQuestion)
      if ((req.type || "").toLowerCase() !== "task") return { mine: true, owner: h!.alias, title: name(responderAlias(req)) + " answered" };
      return { mine: true, owner: h!.alias, title: name(req.to) + " answered — convert or close" };
    }
    return { mine: false, owner: req.from, title: "Answered · waiting on " + name(req.from) };
  }
  if (req.status === "escalated") {
    // legacy status word: the Needs-you queue counts it as yours (state/attention), so the
    // card must say so too — never "waiting on X" for an item the badge counts. The backend
    // answers only open requests, so closing (with a reason) is what is left.
    if (h) return { mine: true, owner: h.alias, title: "Escalated to you" };
    return { mine: false, owner: req.to, title: "Escalated · waiting on " + name(req.to) };
  }
  return { mine: false, owner: null, title: statusMeta(req.status).l };
}

/* ============================================================================
   Request detail — flow, exact status, request/answer content, the role-gated
   actions (answer / convert / escalate / nudge / close), chain and properties.
   ========================================================================== */
export function RequestDetail({
  r,
  onSelect,
  onResolved,
  titleShown,
  idShown,
  statusShown,
  typeShown,
}: {
  r: OrchaRequest;
  onSelect: (id: string) => void;
  onResolved?: (r: OrchaRequest, how: Resolution) => void;
  /** The headline the host already renders as its title — not repeated in the body. */
  titleShown?: string;
  /** The host already shows the request id (with copy) in its own header. */
  idShown?: boolean;
  /** The host header already shows the status glyph: the flowline drops its status and the rail states it once. */
  statusShown?: boolean;
  /** The host header already names the request type ("Question request"). */
  typeShown?: boolean;
}) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const authority = useActingAuthority();
  const noHuman = noHumanReqReason(authority);
  const [answering, setAnswering] = useState(false); // inline answer box open (ISS-53)
  const [ansDraft, setAnsDraft] = useState("");
  const [ansErr, setAnsErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [modal, setModal] = useState<ModalSt | null>(null);
  const [modalErr, setModalErr] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [followUp, setFollowUp] = useState(false); // inline follow-up box open
  const [fuDraft, setFuDraft] = useState("");
  const [fuErr, setFuErr] = useState<string | null>(null);
  const [fuBusy, setFuBusy] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false); // answered-card excerpt expanded
  const resolving = useResolving(r.id);
  useRefocusDialogOnError(!!modal && !modalBusy && !!modalErr);
  const reqs = snap?.requests ?? [];
  const done = (how: Resolution) => {
    // resolved (not escalated — that still waits on a human): hide it on every
    // attention surface at once; the next snapshot confirms
    if (how !== "escalated") markAttentionDecided("request:" + r.id);
    onResolved?.(r, how);
  };
  const who = (alias: string) => partyLabel(snap, alias);

  /* ---- actions (real POSTs; acting-human gated like the vanilla page) ---- */
  const requireHuman = (): Agent | null => {
    const h = authority.human;
    if (!h) toast(noHuman, "danger");
    return h;
  };
  const failMsg = (e: unknown) => {
    const st = (e as { status?: number }).status;
    const detail = ((e as Error).message || "").split(": ").slice(1).join(": ");
    return "Failed (" + (st ?? "?") + ")" + (detail ? ": " + detail : "");
  };

  const sendAnswer = async (req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    const v = ansDraft.trim();
    if (!v) return;
    setSending(true);
    setAnsErr(null);
    try {
      await sendJSON("POST", "/api/requests/" + encodeURIComponent(req.id) + "/respond", {
        responder_agent_id: h.id,
        response: v,
      });
      toast("Answer sent to " + req.from, "ok");
      markAnswerPending(req.id, v);
      setAnsDraft("");
      setAnswering(false);
      done("answered");
      void refresh();
    } catch (e) {
      // the typed answer stays in the box
      setAnsErr(failMsg(e));
      toast(failMsg(e), "danger");
    } finally {
      setSending(false);
    }
  };

  const runModal = async (fn: () => Promise<void>, ok: string, how: Resolution, errMap?: (e: unknown) => string | null) => {
    setModalBusy(true);
    setModalErr(null);
    try {
      await fn();
      toast(ok, "ok");
      setModal(null);
      done(how);
      void refresh();
    } catch (e) {
      // keep the modal (and every typed field) open with the reason
      const m = (errMap && errMap(e)) || failMsg(e);
      setModalErr(m);
      toast(m, "danger");
    } finally {
      setModalBusy(false);
    }
  };

  const doEscalate = async (req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    await runModal(
      () => sendJSON("POST", "/api/requests/" + encodeURIComponent(req.id) + "/escalate", {
        requester_agent_id: h.id,
      }).then(() => { markEscalatedLocally(req.id); }),
      "Escalated to human",
      "escalated",
      // parity r2: the backend never escalates back to the requester — when nobody
      // else can act it answers 409 with the reason; show that reason, not a code.
      (e) => {
        if ((e as { status?: number }).status !== 409) return null;
        const detail = ((e as Error).message || "").split(": ").slice(1).join(": ");
        return detail ? "Not escalated — " + detail : null;
      },
    );
  };

  const doConvert = async (m: Extract<ModalSt, { kind: "convert" }>) => {
    const h = requireHuman();
    if (!h) return;
    const title = m.title.trim();
    const dod = m.dod.trim();
    if (!title || !dod) {
      setModalErr("Title and definition of done are required.");
      return; // keep the modal open, like the vanilla validation
    }
    await runModal(
      () => sendJSON("POST", "/api/requests/" + encodeURIComponent(m.req.id) + "/convert-to-task", {
        requester_agent_id: h.id,
        title,
        definition_of_done: dod,
        assignee_alias: m.assignee,
      }).then(() => undefined),
      "Task created from request",
      "converted",
    );
  };

  /* One click, no dialog: the close is deferred for RESOLVE_UNDO_MS so Undo is real (resolveUndo.ts). */
  const doResolve = (req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    const key = "request:" + req.id;
    const undo = () => {
      if (!undoResolve(req.id)) return;
      unmarkAttentionDecided(key);
      toast("Kept open", "");
    };
    scheduleResolve(req.id, h.id, {
      onDone: () => void refresh(),
      onFail: (msg) => {
        unmarkAttentionDecided(key);
        toast("Couldn't resolve " + shortId(req.id) + " " + msg, "danger", { sticky: true });
        void refresh();
      },
    });
    done("closed");
    toast("Resolved", "ok", { action: { label: "Undo", onClick: undo }, durationMs: RESOLVE_UNDO_MS });
  };
  const doUndoResolve = (req: OrchaRequest) => {
    if (!undoResolve(req.id)) return;
    unmarkAttentionDecided("request:" + req.id);
    toast("Kept open", "");
  };

  /* A follow-up is a new question to whoever answered, chained to this one (parent_request_id);
     this one is then resolved — the conversation continues on the follow-up. */
  const sendFollowUp = async (req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    const text = fuDraft.trim();
    const cid = snap?.container?.id;
    if (!text || !cid) return;
    const to = responderAlias(req);
    const target = agentByAlias(snap, to)?.id ?? req.target_id;
    setFuBusy(true);
    setFuErr(null);
    try {
      await sendJSON("POST", "/api/containers/" + encodeURIComponent(cid) + "/requests", {
        requester_agent_id: h.id,
        target_agent_id: target,
        payload: text,
        parent_request_id: req.id,
      });
      let resolved = true;
      try {
        await sendJSON("POST", "/api/requests/" + encodeURIComponent(req.id) + "/close", { requester_agent_id: h.id });
      } catch { resolved = false; }
      toast("Follow-up sent to " + who(to) + (resolved ? " · this question is resolved" : ""), "ok");
      setFuDraft("");
      setFollowUp(false);
      if (resolved) done("closed");
      void refresh();
    } catch (e) {
      setFuErr(failMsg(e));
      toast(failMsg(e), "danger");
    } finally {
      setFuBusy(false);
    }
  };

  const doNudge = async (req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    try {
      const res = await sendJSON<{ nudged: boolean }>("POST", "/api/requests/" + encodeURIComponent(req.id) + "/nudge", {
        actor_agent_id: h.id,
      });
      // never changes request state — nudged:false is a clean no-op (no agent to wake).
      toast(res.nudged ? "Nudge sent" : "Nothing to wake — no agent owns the next action", res.nudged ? "ok" : "warn");
    } catch (e) {
      // 409 = not actionable in this state; sendJSON's Error.message already carries the
      // server's ": <detail>" suffix, so surface it verbatim instead of a generic failMsg.
      const st = (e as { status?: number }).status;
      if (st === 409) {
        const detail = (e as Error).message.split(": ").slice(1).join(": ");
        toast("Can't nudge — " + (detail || "not actionable in this state"), "danger");
      } else {
        toast(failMsg(e), "danger");
      }
    }
  };

  const doClose = async (m: Extract<ModalSt, { kind: "close" }>) => {
    const h = requireHuman();
    if (!h) return;
    const reason = m.reason.trim();
    await runModal(
      () => sendJSON("POST", "/api/requests/" + encodeURIComponent(m.req.id) + "/close", {
        requester_agent_id: h.id,
        reason: reason || undefined, // JSON.stringify drops undefined — same wire body as vanilla
      }).then(() => undefined),
      "Request closed",
      "closed",
      (e) => ((e as { status?: number }).status === 422 ? "A reason is required to close another agent's request." : null),
    );
  };

  const aiAgents = (snap?.agents ?? []).filter((a) => a.kind === "ai");
  const openAction = (act: string, req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    setModalErr(null);
    if (act === "answer") { setAnswering(true); return; }
    if (act === "cancel-answer") { setAnsDraft(""); setAnswering(false); setAnsErr(null); return; }
    if (act === "escalate") { setModal({ kind: "escalate", req }); return; }
    if (act === "convert") {
      // default the assignee to the agent that answered (the request's target), else the first AI agent
      const responder = aiAgents.find((a) => a.alias === req.to);
      setModal({
        kind: "convert",
        req,
        title: trunc(reqTitle(req, typeLabel(req.type)), 80),
        dod: "",
        assignee: responder?.alias ?? aiAgents[0]?.alias ?? "",
      });
      return;
    }
    if (act === "close") { setModal({ kind: "close", req, reason: "" }); return; }
  };

  /* ---- request chain ----------------------------------------------------- */
  const chainSeq = (cur: OrchaRequest): OrchaRequest[] => {
    const seq: OrchaRequest[] = [];
    const seen = new Set<string>([cur.id]);
    let node: OrchaRequest | undefined = cur;
    while (node && node.in_service_of) {
      const p = reqs.find((x) => x.id === node!.in_service_of);
      if (!p || seen.has(p.id)) break;
      seen.add(p.id);
      seq.unshift(p);
      node = p;
    }
    seq.push(cur);
    reqs.filter((x) => x.in_service_of === cur.id).forEach((c) => seq.push(c));
    return seq;
  };

  // PS-29: the connection-aware actor (null while offline / read-only), so the
  // decision card shows the reason instead of live buttons nobody can use
  const h = authority.human;
  const pending = pendingAnswer(r);
  const sugg = r.status === "open" && !pending ? suggestionOf(r) : null;
  const acts0 = requestActions(snap, r, h);
  // answered locally, snapshot not caught up: nothing to answer again
  const acts = pending ? { ...acts0, answer: false, nudge: false, escalate: false, convert: false } : acts0;
  const showAnswer = acts.answer && !sugg; // a roster suggestion is decided, not answered (answer stays in ⋯)
  const answeredQ = !pending && isAnsweredQuestion(r, h);
  const threadLink = r.code_thread?.link || null;

  /* ---- actions block (vanilla actionsFor) -------------------------------- */
  const actionsBlock = (req: OrchaRequest): ReactNode => {
    if (req.status === "closed" || req.status === "converted_to_task") return null; // stated in the activity
    if (!h) return <div className="rq-idle">{noHuman}</div>;
    if (answering && acts.answer) {
      return (
        <div className="rq-answer">
          <Composer
            id="ansIn"
            label={"Your answer to " + req.from}
            placeholder={`Type your answer — ${req.from} sees it verbatim on the next wake.`}
            value={ansDraft}
            onChange={setAnsDraft}
            onSubmit={() => void sendAnswer(req)}
            busy={sending}
            submitLabel="Send answer"
            minRows={3}
            autoFocus
            keyHint
            leading={<Button variant="ghost" size="sm" onClick={() => openAction("cancel-answer", req)}>Cancel</Button>}
          />
          {ansErr ? (
            <div className="wk-err" role="alert">
              <b>Answer not sent.</b> {ansErr}. Your answer is kept.
            </div>
          ) : null}
        </div>
      );
    }
    if (sugg) return null; // the suggestion card carries the actions (answer/close live in its ⋯)
    if (answeredQ) {
      if (resolving) {
        return (
          <div className="rq-actions" id="reqacts" data-req={req.id}>
            <Button variant="secondary" icon="refresh" onClick={() => doUndoResolve(req)}>Undo</Button>
          </div>
        );
      }
      if (followUp) {
        return (
          <div className="rq-answer">
            <Composer
              id="fuIn"
              label={"Follow-up to " + who(responderAlias(req))}
              placeholder={"Ask " + who(responderAlias(req)) + " a follow-up — it's sent as a new question linked to this one."}
              value={fuDraft}
              onChange={setFuDraft}
              onSubmit={() => void sendFollowUp(req)}
              busy={fuBusy}
              submitLabel="Send follow-up"
              minRows={2}
              autoFocus
              keyHint
              leading={<Button variant="ghost" size="sm" onClick={() => { setFollowUp(false); setFuErr(null); }}>Cancel</Button>}
            />
            {fuErr ? (
              <div className="wk-err" role="alert">
                <b>Follow-up not sent.</b> {fuErr}. Your text is kept.
              </div>
            ) : null}
          </div>
        );
      }
      const moreQ: MenuItemSpec[] = acts.escalate
        ? [{ label: "Escalate to human…", icon: "flag", onSelect: () => openAction("escalate", req) }]
        : [];
      return (
        <div className="rq-actions" id="reqacts" data-req={req.id}>
          <MoreMenu items={moreQ} />
          {threadLink ? (
            // a code-thread question's conversation lives in its thread: follow up there
            <ButtonLink variant="ghost" icon="pencil" href={threadLink}>Ask a follow-up</ButtonLink>
          ) : (
            <Button variant="ghost" icon="pencil" onClick={() => { setFuErr(null); setFollowUp(true); }}>Ask a follow-up</Button>
          )}
          <Button variant="secondary" icon="convert" onClick={() => openAction("convert", req)}>Turn into a task</Button>
          <Button variant="primary" icon="check" onClick={() => doResolve(req)}>Resolve</Button>
        </div>
      );
    }
    const primaryIsAnswer = showAnswer;
    const primaryIsConvert = !primaryIsAnswer && acts.convert;
    // Escalate is requester-only, i.e. always YOUR own request: re-routing it to "a human"
    // is rarely the next step, so it lives in ⋯ instead of the inline card (never dropped).
    const more: MenuItemSpec[] = acts.escalate
      ? [{ label: "Escalate to human…", icon: "flag", onSelect: () => openAction("escalate", req) }]
      : [];
    const moreBtn = more.length ? <MoreMenu items={more} /> : null;
    const any = showAnswer || acts.convert || acts.nudge;
    const closeBtn = acts.close ? (
      <Button variant={any ? "ghost" : "secondary"} icon="x" onClick={() => openAction("close", req)}>Close…</Button>
    ) : null;
    if (!any) return closeBtn || moreBtn ? <div className="rq-actions" id="reqacts" data-req={req.id}>{moreBtn}{closeBtn}</div> : null;
    // Linear order: quiet actions first, the one primary action last (right-aligned)
    return (
      <div className="rq-actions" id="reqacts" data-req={req.id}>
        {moreBtn}
        {closeBtn}
        {acts.nudge && (
          <Button variant="secondary" icon="bell" title={"Wake " + acts.nudgeWho + " — " + (req.status === "open" ? "it owes an answer" : "to pick up the answer")} onClick={() => void doNudge(req)}>
            Nudge {acts.nudgeWho}
          </Button>
        )}
        {acts.convert && (
          <Button variant={primaryIsConvert ? "primary" : "secondary"} icon="convert" onClick={() => openAction("convert", req)}>
            Convert to task
          </Button>
        )}
        {showAnswer && (
          <Button variant="primary" icon="pencil" onClick={() => openAction("answer", req)}>
            Answer
          </Button>
        )}
      </div>
    );
  };

  const seq = chainSeq(r);
  const hasChain = seq.length >= 2;
  // the host already shows the title: the description carries only the rest (never the title twice, D12)
  const after = titleShown ? payloadAfterTitle(r.payload, titleShown) : null;
  const payloadRedundant = after ? after.empty : r.payload == null && !!titleShown;
  const hasResponse = r.response != null && r.response !== "";
  const tl = r.task_link && r.task_link.task_id;
  const actions = actionsBlock(r);
  const suggOverflow: MenuItemSpec[] = sugg
    ? [
        ...(acts.answer ? [{ label: "Answer with text…", icon: "pencil", onSelect: () => openAction("answer", r) }] : []),
        ...(acts.nudge ? [{ label: "Nudge " + acts.nudgeWho, icon: "bell", onSelect: () => void doNudge(r) }] : []),
        ...(acts.close ? [{ label: "Close request…", icon: "x", onSelect: () => openAction("close", r) }] : []),
      ]
    : [];
  const prio = prioNum(r.priority);
  const escalated = isEscalated(r);
  // the flowline's addressee: after an escalation, the agent it was first sent to (never "you → you")
  const origTo = escalated && r.escalated_from && r.escalated_from !== r.to ? r.escalated_from : null;
  const answeredBy = responderAlias(r);
  const task = proposedTaskOf(r);
  const escAfterExpiry = escalated && !!r.expires_at && Date.parse(r.expires_at) <= Date.now();
  const moveHelp = h ? "Acting as " + h.alias + " · every action is logged to the audit trail." : noHuman;
  const next0 = requestNextStep(snap, r, h);
  const next = pending ? { mine: false, owner: null, title: "Answered · syncing…" } : next0;
  // the decision card already says "Escalated…" / "Answered · syncing…": no Status row repeating it (D12)
  const cardStatesStatus = !!(actions || pending) && !(answering && actions) && (!!pending || next.title.startsWith("Escalated"));
  const cardHelp = pending
    ? "Your answer was sent; the list catches up on the next sync."
    : r.status === "escalated" && next.mine
      ? "Escalated before routing to a person — it can't be answered in this state. Close it with a reason to resolve it. " + moveHelp
      : next.mine || !next.owner
        ? moveHelp
        : (r.status === "answered" ? next.owner + " picks up the answer" : "Only " + next.owner + " can answer") +
          (acts.nudge ? " — nudge to wake it" : "") + ". " + moveHelp;

  return (
    <div className="wk-detail rq-detail" data-req={r.id}>
      <style>{detailCss}</style>
      <div className="rq-grid">
      <div className="rq-main">
        <div className="rq-flowline">
          <AgentNode snap={snap} alias={r.from} />
          <span className="wk-arrow" aria-label="to"><Icon name="arrow" cls="v2-ico" /></span>
          {origTo ? (
            // escalated: the original addressee stays on the flow; the re-target is a quiet suffix
            <>
              <AgentNode snap={snap} alias={origTo} />
              <span className="rq-sep" aria-hidden="true">·</span>
              <span className="rq-esc-to"><Icon name="flag" cls="v2-ico" />escalated to {r.to === "human" ? "a human" : who(r.to)}</span>
            </>
          ) : <AgentNode snap={snap} alias={r.to} />}
          {statusShown ? null : (
            <>
              <span className="rq-sep" aria-hidden="true">·</span>
              {pending ? <span className="rq-syncing"><ReqStatus status="answered" /><span className="rq-muted">· syncing…</span></span> : <ReqStatus status={r.status} />}
            </>
          )}
        </div>

        {!payloadRedundant ? (
          <section className="rq-desc" aria-label="Request">
            <PayloadView value={after ? after.value : r.payload} tasks={snap?.tasks} testClass="payload" />
          </section>
        ) : null}

        {r.code_thread ? (
          // mig 065: the conversation lives in the code thread — one chip, never the raw /code?… path
          <div className="rq-src">
            {threadLink ? (
              <a className="v2-chip v2-chip-sm is-interactive rq-thread-chip" href={threadLink}>
                <Icon name="code" cls="v2-ico" /><span className="v2-chip-text">Open thread in Code</span>
              </a>
            ) : null}
            <span className="rq-src-path" title={r.code_thread.path}>{r.code_thread.path} {lineLabel(r.code_thread.start_line, r.code_thread.end_line)}</span>
          </div>
        ) : null}

        {task ? (
          <section className="rq-proposed" aria-label="Proposed task">
            <h2 className="rq-h2">Proposed task</h2>
            <dl className="rq-card-kv">
              <dt>Title</dt>
              <dd className="rq-proposed-t"><StatusGlyph status="pending" size={14} /><span>{task.title}</span></dd>
              {task.dod ? (<><dt>Done when</dt><dd><Linkified text={task.dod} tasks={snap?.tasks} /></dd></>) : null}
            </dl>
          </section>
        ) : null}

        {sugg ? <SuggestionDecision r={r} onDone={(k) => done(k)} overflow={suggOverflow} /> : null}

        {answeredQ && actions ? (
          // "Atlas answered · 2m ⓘ", the answer (clamped, expandable / Open thread), then
          // [⋯] [Ask a follow-up] [Turn into a task] [Resolve] — Resolve is one click with Undo
          <section className={"rq-card rq-qa is-mine" + (resolving ? " is-resolving" : "")} aria-label={resolving ? "Resolved" : who(answeredBy) + " answered"}>
            <header className="rq-card-h">
              {resolving ? <Icon name="check" cls="v2-ico rq-card-ico" /> : <PartyAvatar snap={snap} alias={answeredBy} size={16} decorative />}
              <span className="rq-card-t">{resolving ? "Resolved" : who(answeredBy) + " answered"}</span>
              {!resolving && r.responded_at ? <span className="rq-card-when" title={stampText(r.responded_at)}>{relTime(r.responded_at)}</span> : null}
              <HelpDot text={resolving ? "Leaves every queue now; the close is sent in a few seconds unless you undo." : "Resolve closes your question — " + who(answeredBy) + " isn't woken again. " + moveHelp} />
            </header>
            {!resolving && hasResponse ? (
              <div className="rq-qa-body">
                <div className={"rq-qa-answer" + (answerOpen ? " is-open" : "")}>
                  <PayloadView value={r.response} tasks={snap?.tasks} testClass="answer" />
                </div>
                <div className="rq-qa-more">
                  {threadLink ? (
                    <a className="lnk rq-qa-link" href={threadLink}>Open thread<Icon name="arrow" cls="v2-ico" /></a>
                  ) : (
                    <button type="button" className="rq-qa-link" aria-expanded={answerOpen} onClick={() => setAnswerOpen((o) => !o)}>
                      {answerOpen ? "Show less" : "Show full answer"}
                    </button>
                  )}
                </div>
              </div>
            ) : null}
            {actions}
          </section>
        ) : actions || pending ? (
          answering && actions ? (
            <section className="rq-card is-answering" aria-label="Your answer">
              <header className="rq-card-h">
                <Icon name="pencil" cls="v2-ico rq-card-ico" />
                <span className="rq-card-t">Your answer</span>
                <HelpDot text={moveHelp} />
              </header>
              {actions}
            </section>
          ) : (
            // one compact row: "⚑ lead asks you ⓘ ……… [Close…] [Nudge x] [Answer]" — titled by who owns the next action
            <section className={"rq-card is-inline" + (next.mine ? " is-mine" : "")} aria-label={next.title}>
              <span className="rq-card-h">
                {pending
                  ? <Icon name="check" cls="v2-ico rq-card-ico" />
                  : next.mine || !next.owner
                  ? <Icon name="flag" cls="v2-ico rq-card-ico" />
                  : <PartyAvatar snap={snap} alias={next.owner} size={16} decorative />}
                <span className="rq-card-t">{next.title}</span>
                <HelpDot text={cardHelp} />
              </span>
              {actions}
            </section>
          )
        ) : null}

        {hasChain && (
          <section className="rq-sec" aria-label="Request chain">
            <h2 className="rq-h2">Request chain <span className="rq-h2-count">{seq.length}</span></h2>
            <Timeline label="Request chain" className="rq-chain">
              {seq.map((x) => {
                const cur = x.id === r.id;
                return (
                  <TimelineEvent key={x.id} glyph={<StatusGlyph status={x.status} size={14} />} className={cur ? "is-cur" : undefined}>
                    <button type="button" className={"rq-cnode" + (cur ? " cur" : "")} aria-current={cur ? "true" : undefined} onClick={() => onSelect(x.id)}>
                      <span className="ttl">{reqTitle(x, typeLabel(x.type))}</span>
                      <span className="sub">
                        {who(x.from)} → {who(x.to)} · {statusMeta(x.status).l}
                      </span>
                    </button>
                  </TimelineEvent>
                );
              })}
            </Timeline>
          </section>
        )}

        <section className="rq-sec" aria-label="Activity">
          <h2 className="rq-h2">Activity</h2>
          <Timeline label="Request activity">
            <TimelineEvent glyph={<PartyAvatar snap={snap} alias={r.from} size={16} decorative />} actor={who(r.from)} at={r.created_at || null}>
              sent {aType(r.type)} to <b>{who(escalated && r.escalated_from ? r.escalated_from : r.to)}</b>
            </TimelineEvent>
            {escalated && r.escalated_at ? (
              // backend escalation fact (event row): its own time, the original target named
              <TimelineEvent icon="flag" at={r.escalated_at}>
                escalated to <b>{r.to === "human" ? "a human" : who(r.to)}</b>{r.escalated_from ? <> (from {who(r.escalated_from)})</> : null}
              </TimelineEvent>
            ) : escalated ? (
              escAfterExpiry ? (
                // the backend escalates an unanswered request once it expires: the expiry is the event time
                <TimelineEvent icon="flag" at={r.expires_at}>Expired unanswered — escalated to <b>a human</b></TimelineEvent>
              ) : (
                // no escalation timestamp in the snapshot: the actor only, never an invented time
                <TimelineEvent icon="flag" actor={who(r.from)}>escalated to <b>a human</b></TimelineEvent>
              )
            ) : null}
            {pending && !hasResponse ? (
              <TimelineComment author={who(r.to)} avatar={<PartyAvatar snap={snap} alias={r.to} size={16} decorative />} meta={<><span className="rq-ok"><Icon name="check" cls="v2-ico" /></span>answered · syncing…</>} at={new Date(pending.at).toISOString()}>
                <PayloadView value={pending.text} tasks={snap?.tasks} testClass="answer" />
              </TimelineComment>
            ) : null}
            {hasResponse && answeredQ && !resolving ? (
              // the card above shows the answer: the activity logs the event once (D12)
              <TimelineEvent glyph={<PartyAvatar snap={snap} alias={answeredBy} size={16} decorative />} actor={who(answeredBy)} at={r.responded_at || null}>
                answered
              </TimelineEvent>
            ) : hasResponse ? (
              <TimelineComment author={who(answeredBy)} avatar={<PartyAvatar snap={snap} alias={answeredBy} size={16} decorative />} meta={<><span className="rq-ok"><Icon name="check" cls="v2-ico" /></span>{r.status === "accepted" ? "accepted the task" : "answered"}</>} at={r.responded_at || null}>
                <PayloadView value={r.response} tasks={snap?.tasks} testClass="answer" />
              </TimelineComment>
            ) : null}
            {r.rejection_reason ? (
              <TimelineComment author={who(r.to)} avatar={<PartyAvatar snap={snap} alias={r.to} size={16} decorative />} meta={<><span className="rq-bad"><Icon name="x" cls="v2-ico" /></span>rejected</>} at={hasResponse ? null : r.responded_at || null}>
                <PayloadView value={r.rejection_reason} tasks={snap?.tasks} testClass="answer rej" />
              </TimelineComment>
            ) : null}
            {/* accepted: the note (if any) already says "accepted the task" — the event line only
                adds what the note doesn't (the spawned task), never the same fact twice (D12) */}
            {r.status === "accepted" && (!hasResponse || tl) ? (
              hasResponse ? (
                <TimelineEvent icon="convert" at={null}>
                  Spawned task <TaskLink snap={snap} id={tl!} label={r.task_link?.title} status={r.task_link?.status} />
                </TimelineEvent>
              ) : (
                <TimelineEvent glyph={<PartyAvatar snap={snap} alias={r.to} size={16} decorative />} actor={who(r.to)} at={r.responded_at || null}>
                  accepted the task{tl ? <> <TaskLink snap={snap} id={tl} label={r.task_link?.title} status={r.task_link?.status} /></> : null}
                </TimelineEvent>
              )
            ) : null}
            {r.status === "converted_to_task" ? (
              // only the requester may convert (request_conversion_routes: 403 otherwise)
              <TimelineEvent glyph={<PartyAvatar snap={snap} alias={r.from} size={16} decorative />} actor={who(r.from)} at={r.responded_at || null}>
                converted it to a task{tl ? <> <TaskLink snap={snap} id={tl} label={r.task_link?.title} /></> : null}
              </TimelineEvent>
            ) : null}
            {r.status === "closed" ? (
              typeof r.detail?.auto_resolved === "string" ? (
                // backend auto-resolve (code_space_routes._settle_thread_request): the thread IS the conversation
                <TimelineEvent icon="check" at={r.closed_at || r.responded_at || null}>
                  Resolved automatically — {r.detail.auto_resolved === "thread_resolved" ? "the code thread was resolved" : "answered in the code thread"}
                  {threadLink ? <> · <a className="lnk" href={threadLink}>Open thread</a></> : null}
                </TimelineEvent>
              ) : r.closed_by ? (
                // parity r2: name who closed it and, for a force-close, why
                <TimelineEvent glyph={<PartyAvatar snap={snap} alias={r.closed_by} size={16} decorative />} actor={who(r.closed_by)} at={r.closed_at || null}>
                  closed it{r.close_reason ? <> — <span className="rq-close-reason">{r.close_reason}</span></> : null}
                </TimelineEvent>
              ) : (
                <TimelineEvent icon="check" at={r.closed_at || null}>
                  Closed{r.close_reason ? <> — <span className="rq-close-reason">{r.close_reason}</span></> : " — no further action"}
                </TimelineEvent>
              )
            ) : null}
          </Timeline>
        </section>
      </div>

      <PropertyRail label="Request details" className="rq-rail">
        <PropertySection title="Details">
          {statusShown && !cardStatesStatus ? (
            <Property label="Status">
              {pending ? <span className="rq-syncing"><ReqStatus status="answered" /><span className="rq-muted">· syncing…</span></span> : <ReqStatus status={r.status} />}
            </Property>
          ) : null}
          {typeShown ? null : <Property label="Type">{r.type} request</Property>}
          <Property label="Priority" hint={"Priority " + prio + (prio === DEFAULT_PRIORITY ? " (default)" : "") + " · lower = more urgent"}>
            {/* brief §3: the exact numeric priority stays visible, not only in a tooltip */}
            <span className="rq-prio" title={"Priority " + prio}><PriorityIcon priority={prio} showLabel /><span className="rq-muted rq-num"> · P{prio}</span></span>
          </Property>
          {r.created_at ? <Property label="Opened">{stamp(r.created_at)}</Property> : null}
          {r.responded_at ? <Property label="Responded">{stamp(r.responded_at)}</Property> : null}
          {r.expires_at ? <Property label="Expires">{expiryStamp(r.expires_at, r.status === "open")}</Property> : null}
          {r.chain_depth ? <Property label="Chain depth"><span className="rq-num">{r.chain_depth}</span></Property> : null}
          {tl ? (
            // task_link is always the request's spawned task (snapshot: requests.spawned_task_id)
            <Property label="Spawned task">
              <TaskLink snap={snap} id={tl} label={r.task_link?.title} status={r.task_link?.status} />
            </Property>
          ) : null}
          {idShown ? null : <Property label="ID"><CopyId id={r.id} /></Property>}
        </PropertySection>
      </PropertyRail>
      </div>

      {modal?.kind === "escalate" && (
        <Dialog
          title="Escalate to a human?"
          description="Re-targets this request to the human authority. Only the requester can escalate."
          size="sm"
          onClose={() => { if (!modalBusy) setModal(null); }}
          footer={
            <>
              <Button variant="ghost" disabled={modalBusy} onClick={() => setModal(null)}>Cancel</Button>
              <Button variant="primary" busy={modalBusy} onClick={() => void doEscalate(modal.req)}>Escalate</Button>
            </>
          }
        >
          {modalErr ? <div className="wk-err" role="alert"><b>Not escalated.</b> {modalErr}</div> : null}
        </Dialog>
      )}
      {modal?.kind === "convert" && (
        <Dialog
          title="Convert to a task"
          description="Spawn a tracked task from this answered request — assigned, with a definition of done."
          onClose={() => { if (!modalBusy) setModal(null); }}
          footer={
            <>
              <Button variant="ghost" disabled={modalBusy} onClick={() => setModal(null)}>Cancel</Button>
              <Button variant="primary" busy={modalBusy} onClick={() => void doConvert(modal)}>Create task</Button>
            </>
          }
        >
          <div className="wk-form">
            <label>
              Title
              <input className="wk-input" value={modal.title} onChange={(e) => setModal({ ...modal, title: e.target.value })} />
            </label>
            <label>
              Definition of done
              <textarea className="ans-in" style={{ minHeight: 60 }} placeholder="When is this task done?" value={modal.dod} onChange={(e) => setModal({ ...modal, dod: e.target.value })} />
            </label>
            <label>
              Assign to
              <select className="wk-select" value={modal.assignee} onChange={(e) => setModal({ ...modal, assignee: e.target.value })}>
                {aiAgents.map((a) => (
                  <option key={a.id}>{a.alias}</option>
                ))}
              </select>
            </label>
            {modalErr ? <div className="wk-err" role="alert"><b>Not converted.</b> {modalErr} Your fields are kept.</div> : null}
          </div>
        </Dialog>
      )}
      {modal?.kind === "close" && (
        <Dialog
          title="Close this request?"
          description={
            h && String(modal.req.requester_id) === String(h.id)
              ? "Marks your request resolved; it leaves every queue on the next sync."
              : "Marks it resolved; " + who(modal.req.from) + " sees it closed on the next sync. A reason is required because it isn't your request."
          }
          size="sm"
          onClose={() => { if (!modalBusy) setModal(null); }}
          footer={
            <>
              <Button variant="ghost" disabled={modalBusy} onClick={() => setModal(null)}>Cancel</Button>
              <Button
                variant="danger" busy={modalBusy}
                disabled={closeNeedsReason(modal.req, h) && !modal.reason.trim()}
                title={closeNeedsReason(modal.req, h) && !modal.reason.trim() ? "Add a reason — it isn't your request" : undefined}
                onClick={() => void doClose(modal)}
              >Close request</Button>
            </>
          }
        >
          <textarea
            className="ans-in"
            style={{ minHeight: 64 }}
            aria-label="Reason"
            placeholder={h && String(modal.req.requester_id) === String(h.id) ? "Reason (optional)…" : "Reason…"}
            value={modal.reason}
            onChange={(e) => setModal({ ...modal, reason: e.target.value })}
          />
          {modalErr ? <div className="wk-err" role="alert"><b>Not closed.</b> {modalErr} Your reason is kept.</div> : null}
        </Dialog>
      )}
    </div>
  );
}

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

/* ---- toolbar menus -------------------------------------------------------- */
const SORT_OPTS: { st: SortState; label: string; short: string }[] = [
  { st: { key: "time", dir: "desc" }, label: "Newest first", short: "Newest" },
  { st: { key: "time", dir: "asc" }, label: "Oldest first", short: "Oldest" },
  { st: { key: "priority", dir: "asc" }, label: "Highest priority first", short: "Priority" },
  { st: { key: "priority", dir: "desc" }, label: "Lowest priority first", short: "Priority ↑" },
];

/** ISS-331 sort as one circular menu button — writes the same orcha:sort:<name> state as SortCtl. */
function SortMenu({ name, onChange }: { name: string; onChange: () => void }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const st = sortState(name);
  const cur = SORT_OPTS.find((o) => o.st.key === st.key && o.st.dir === st.dir) ?? SORT_OPTS[0];
  const pick = (s: SortState) => {
    try { localStorage.setItem("orcha:sort:" + name, JSON.stringify(s)); } catch { /* private mode */ }
    onChange();
  };
  return (
    <>
      <IconButton
        ref={ref} icon="sort" variant="outline" label={"Sort: " + cur.label}
        pressed={cur !== SORT_OPTS[0] ? true : undefined}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
      />
      <Menu
        anchor={ref}
        open={open}
        onClose={() => setOpen(false)}
        label="Sort requests"
        placement="bottom-end"
        items={SORT_OPTS.map((o) => ({ label: o.label, checked: o === cur, onSelect: () => pick(o.st) }))}
      />
    </>
  );
}

/** Direction filter: a circular button while unfiltered, a labelled pill once a direction is picked.
 *  Also carries the "Task requests only" type filter (wave-4: a fifth pill overflowed the list head). */
function DirMenu({ value, onPick, taskOnly, onTaskOnly }: { value: DirKey; onPick: (k: DirKey) => void; taskOnly?: boolean | null; onTaskOnly?: (on: boolean) => void }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const cur = DIR_FILTERS.find((d) => d.k === value) ?? DIR_FILTERS[0];
  const toggle = () => setOpen((o) => !o);
  return (
    <>
      {value === "any" ? (
        <IconButton ref={ref} icon="filter" variant="outline" label={"Direction: " + cur.label} aria-haspopup="menu" aria-expanded={open} onClick={toggle} />
      ) : (
        <Button ref={ref} variant="secondary" size="sm" pill icon="filter" iconRight="chev" aria-haspopup="menu" aria-expanded={open} aria-label={"Direction: " + cur.label} onClick={toggle}>
          {cur.short}
        </Button>
      )}
      <Menu
        anchor={ref}
        open={open}
        onClose={() => setOpen(false)}
        label="Filter requests by direction or type"
        placement="bottom-end"
        items={[
          ...DIR_FILTERS.map((d) => ({ label: d.label, checked: d.k === value, onSelect: () => onPick(d.k) })),
          ...(taskOnly != null && onTaskOnly ? [{ label: "Task requests only", icon: taskOnly ? "check" : undefined, onSelect: () => onTaskOnly(!taskOnly) }] : []),
        ]}
      />
    </>
  );
}

/** Pre-drag detail width: the list keeps ~Linear's inbox width (≈470px at 1440) and the detail takes the rest. */
const detailDefault = () => (typeof window === "undefined" ? 760 : Math.max(420, Math.min(1400, window.innerWidth - 740)));

/** "question" → "Question request" (detail header kind label; also the Needs-you header). */
export const requestKindLabel = (t: string | null | undefined) => typeLabel(t);
const kindLabel = requestKindLabel;

/* ========================================================================== */
export function RequestsPage() {
  const { snap } = useSnapshot();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();

  const params = new URLSearchParams(location.search);
  const dlReq = params.get("req");
  const filterRaw = params.get("filter");
  const filter: FilterKey = filterKeyOf(filterRaw);
  const dirRaw = params.get("dir");
  const dir: DirKey = DIR_FILTERS.some((d) => d.k === dirRaw) ? (dirRaw as DirKey) : "any";
  const qUrl = params.get("q") || "";
  const [sel, setSel] = useState<string | null>(dlReq);
  const [closed, setClosed] = useState(false);
  const [qDraft, setQDraft] = useState(qUrl);
  const [reqsShown, setReqsShown] = useState(REQS_PAGE);
  const [searchOpen, setSearchOpen] = useState(false); // the search field opens from a circular button
  const [, sortTick] = useState(0); // repaint when the sort menu changes state
  // ISS-38: one-shot scroll anchor for a deeplinked/picked row — cleared after
  // the next list paint so the 3s poll never yanks scroll.
  const pendingScroll = useRef(!!dlReq);
  const listRef = useRef<HTMLDivElement | null>(null);
  // after Esc / ✕ closes the detail, focus returns to the row that was open (not the panel)
  const refocusRow = useRef<string | null>(null);

  const setParams = (patch: Record<string, string | null>, push = false, state?: unknown) => {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || (k === "filter" && v === "all") || (k === "dir" && v === "any")) p.delete(k);
      else p.set(k, v);
    }
    const s = p.toString();
    navigate({ pathname: "/requests", search: s ? "?" + s : "" }, { replace: !push, state });
  };

  // external ?req= changes (notification links, chain links from elsewhere)
  useEffect(() => {
    if (dlReq && dlReq !== sel) {
      setSel(dlReq);
      setClosed(false);
      pendingScroll.current = true;
    } else if (!dlReq && narrow && sel) {
      // REQ-107: browser Back / swipe-back removed ?req= on a phone — return to the list
      setSel(null);
      setClosed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlReq]);
  useEffect(() => {
    setQDraft(qUrl);
  }, [qUrl]);
  useEffect(() => {
    if (qDraft === qUrl) return;
    const h = setTimeout(() => {
      setParams({ q: qDraft.trim() ? qDraft : null });
      setReqsShown(REQS_PAGE);
    }, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft, qUrl]);

  const reqs = useMemo(() => snap?.requests ?? [], [snap]);

  // wave-4: the picked request keeps its place while it stays picked — answering it
  // (open → answered changes its status bucket) must not re-sort it out from under the
  // cursor, Linear-style. Its bucket is frozen at the moment it was picked.
  const freeze = useRef<{ id: string; rank: number } | null>(null);
  const pickedId = sel ?? null;
  if (!pickedId) freeze.current = null;
  else if (freeze.current?.id !== pickedId) {
    const pr = reqs.find((x) => x.id === pickedId);
    freeze.current = pr ? { id: pickedId, rank: reqRank(pr) } : null;
  }
  const fz = freeze.current;
  const bucket = (x: OrchaRequest) => (fz && x.id === fz.id ? fz.rank : reqRank(x));
  const list = reqs.filter((r) => requestMatches(snap, r, filter, qUrl, dir)).sort(sortComparator("requests", { bucket, time: reqTime, prio: (r) => prioNum(r.priority) }));
  // vanilla firstSel() (first open request in backend order, else the first) — limited to the
  // VISIBLE list, so a filter that hides everything never leaves an unrelated request open
  const visible = new Set(list.map((x) => x.id));
  const firstSel = (reqs.find((x) => x.status === "open" && visible.has(x.id)) || list[0])?.id ?? null;
  const selValid = !!sel && reqs.some((r) => r.id === sel);
  const selEff = selValid ? sel : dlReq && sel === dlReq ? null : closed || narrow ? null : firstSel;
  const missing = !!(snap && dlReq && sel === dlReq && !selValid);

  const head = list.slice(0, reqsShown);
  // ISS-38: the render cap is a UI window, not a filter — a deeplinked/selected
  // request beyond the window is appended past it so it stays reachable.
  const selBeyond = selEff && list.some((r) => r.id === selEff) && !head.some((r) => r.id === selEff)
    ? list.find((r) => r.id === selEff)
    : undefined;
  const shown = selBeyond ? head.concat(selBeyond) : head;
  const r = reqs.find((x) => x.id === selEff) || null;
  const truncated = snap?.request_total != null && snap.request_total > reqs.length;
  const filtered = filter !== "all" || dir !== "any" || !!qUrl.trim();

  // ISS-38: anchor the deeplinked/selected row after the list paints (one-shot)
  useEffect(() => {
    if (!snap || !pendingScroll.current) return;
    pendingScroll.current = false;
    const row = listRef.current?.querySelector(".qrow.is-selected");
    if (row && typeof (row as HTMLElement).scrollIntoView === "function") {
      (row as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  });
  // focus return after closing the detail (one-shot)
  useEffect(() => {
    const id = refocusRow.current;
    if (!id) return;
    refocusRow.current = null;
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-v2-row]") ?? []).find((el) => el.dataset.id === id);
    row?.focus({ preventScroll: true });
  });

  const select = (id: string, opts?: { page?: boolean }) => {
    setClosed(false);
    // an auto-selected (first open) request is pinned once picked, so answering it never
    // swaps the detail to the next open request when the list re-sorts
    if (id === selEff && !narrow) { if (sel !== id) setSel(id); return; }
    setSel(id);
    pendingScroll.current = true; // ISS-38: keep the picked row anchored in view
    if (narrow) {
      // paging inside the open detail replaces (Back still returns to the list)
      if (opts?.page) setParams({ req: id }, false, location.state);
      else setParams({ req: id }, true, { wkFromList: true });
      scrollMainTo(0);
    } else {
      setParams({ req: id });
    }
  };
  const fromList = !!(location.state as { wkFromList?: boolean } | null)?.wkFromList;
  const closeDetail = () => {
    refocusRow.current = selEff;
    // REQ-107: clear the selection on BOTH branches — popping the history entry alone left
    // `sel` set, so the narrow layout stayed stuck on the detail with the list hidden
    setClosed(true);
    setSel(null);
    if (fromList) { navigate(-1); return; }
    setParams({ req: null });
  };

  const detailOpen = !!r || missing;
  // Linear Inbox keys (shared with Needs you): j/k (and ↑/↓ in the list) move the
  // selection; Escape closes the detail — never while typing or with an overlay open.
  useInboxKeys({
    enabled: true,
    keys: shown.map((x) => x.id),
    selected: selEff,
    select: (id) => select(id),
    listSelector: "#rlist .v2-list",
    navDisabled: narrow,
    onEscape: (e) => {
      if (!detailOpen || e.defaultPrevented || isEditingTarget(document.activeElement)) return false;
      closeDetail();
      return true;
    },
  });

  // a newly opened request starts at its top (the detail pane scrolls on its own)
  useEffect(() => {
    const pane = listRef.current?.closest(".v2-split")?.querySelector(".v2-split-inspector");
    if (pane) pane.scrollTop = 0;
  }, [selEff]);

  const clearFilters = () => { setQDraft(""); setSearchOpen(false); setParams({ filter: null, dir: null, q: null }); setReqsShown(REQS_PAGE); };

  /* ---- render ------------------------------------------------------------ */
  const rowFor = (x: OrchaRequest) => {
    const title = reqTitle(x, typeLabel(x.type));
    // D10/D12 inbox item: bold headline + ONE fully muted line ("lead → you · question");
    // the glyph carries the status (exact label in its tooltip + screen-reader text).
    const trail = [isEscalated(x) && x.status !== "escalated" ? "escalated" : "", x.chain_depth ? "in a chain" : "", x.type].filter(Boolean).join(" · ");
    return (
      <Row key={x.id} id={x.id} className="wk-row qrow rq-row" selected={x.id === selEff} onActivate={() => select(x.id)} title={payloadText(x.payload)}>
        <span className="rq-av"><PartyAvatar snap={snap} alias={x.from} size={32} decorative /></span>
        <span className="wk-main">
          <span className="rq-l1">
            <span className="rq-title">{title}</span>
          </span>
          <span className="rq-meta">
            <span className="rq-party">{partyLabel(snap, x.from)} → {partyLabel(snap, x.to)}</span>
            {trail ? <span className="rq-trail">· {trail}</span> : null}
          </span>
        </span>
        <span className="rq-side">
          <StatusIcon status={x.status} className="rq-rowst" />
          <span className="rq-age" title={x.created_at}>{x.created_at ? shortAge(x.created_at) : ""}</span>
        </span>
      </Row>
    );
  };

  const pillItems = REQ_FILTERS.map((f) => ({
    key: f.k,
    label: f.label,
    count: snap ? reqs.filter((x) => requestMatches(snap, x, f.k, qUrl, dir)).length : null,
  })).filter((it) => it.key !== "task" || it.key === filter); // "Tasks" is a pill only while selected (it lives in the filter menu)
  const hasTaskReqs = !!snap && reqs.some((x) => x.type === "task");
  const searchShown = searchOpen || !!qDraft;
  // the pills already carry the per-filter counts: the "N of M match" footer is only for the
  // filters the pills can't show (search text, direction)
  const refined = dir !== "any" || !!qUrl.trim();

  // Linear Inbox: the list column owns its own head (pills + circular tools), so the
  // detail header sits level with it at the top of the panel (image 12).
  const listHead = (
    <div className="rq-listhead-wrap">
      <div className="rq-listhead" role="toolbar" aria-label="Request filters">
        <FilterPills
          label="Filter requests"
          size="sm"
          value={filter}
          items={pillItems}
          onChange={(k) => { setParams({ filter: k }); setReqsShown(REQS_PAGE); }}
        />
        <span className="v2-grow" />
        <CircleIconButton
          icon="search" label="Search requests"
          pressed={searchShown ? true : undefined}
          onClick={() => {
            if (searchShown && !qDraft) { setSearchOpen(false); return; }
            setSearchOpen(true);
          }}
        />
        <DirMenu
          value={dir}
          onPick={(k) => { setParams({ dir: k }); setReqsShown(REQS_PAGE); }}
          taskOnly={hasTaskReqs || filter === "task" ? filter === "task" : null}
          onTaskOnly={(on) => { setParams({ filter: on ? "task" : null }); setReqsShown(REQS_PAGE); }}
        />
        <SortMenu name="requests" onChange={() => sortTick((n) => n + 1)} />
      </div>
      {searchShown ? (
        <div className="rq-searchrow">
          <span className="rq-search">
            <Icon name="search" cls="v2-ico" />
            <label className="v2-sr" htmlFor="reqQ">Search requests</label>
            <input
              id="reqQ"
              type="search"
              placeholder="Search requests…"
              value={qDraft}
              autoFocus={searchOpen && !qUrl}
              onChange={(e) => setQDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && !qDraft) { e.preventDefault(); setSearchOpen(false); } }}
              onBlur={() => { if (!qDraft) setSearchOpen(false); }}
            />
          </span>
        </div>
      ) : null}
    </div>
  );

  // a project with no requests at all: no pills / tools acting on nothing, just the empty state
  const noRequests = !!snap && !reqs.length;
  const listPane = (
    <div id="rlist" className="rq-list" ref={listRef}>
      {noRequests ? null : listHead}
      {truncated ? (
        <div className="wk-note" role="note">
          Showing the first <b>{reqs.length}</b> of <b>{snap?.request_total}</b> requests (snapshot limit) — filters apply to the loaded requests only.
        </div>
      ) : null}
      <div className="rq-listbody">
        {!snap ? (
          <SnapshotPending lines={6} label="Loading requests" what="requests" />
        ) : shown.length ? (
          <>
            <List label="Requests" vimKeys>
              {shown.map(rowFor)}
            </List>
            {list.length > head.length && ( // count the window (head), not the appended deeplink row
              <Button variant="ghost" className="wk-more" onClick={() => setReqsShown((n) => n + REQS_PAGE)}>
                Load more · {head.length} of {list.length}
              </Button>
            )}
            {refined && list.length < reqs.length ? (
              <div className="rq-listfoot">
                <span>{list.length} of {reqs.length} requests match</span>
                <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>
              </div>
            ) : null}
          </>
        ) : reqs.length ? (
          <div className="rq-empty"><EmptyState
            title="No requests match"
            body={dir === "in" ? "Nothing is addressed to you with these filters." : dir === "out" ? "You haven't sent a request that matches." : "Try another filter or clear the search."}
            action={filtered ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
          /></div>
        ) : (
          <div className="rq-empty is-none"><EmptyState title="No requests yet" body="Agents ask each other — and you — for answers, reviews and tasks. They appear here with their chain and status." /></div>
        )}
      </div>
    </div>
  );

  // detail title: the whole first sentence of prose (fits the Display title), else the headline field
  const rTitle = r ? reqDetailTitle(r, typeLabel(r.type)) : "";
  const idx = r ? list.findIndex((x) => x.id === r.id) : -1;
  const rPending = r ? pendingAnswer(r) : null;
  const inspector = detailOpen ? (
    <section id="detailMain" className="rq-pane" aria-label={r ? "Request " + shortId(r.id) : "Request"}>
      <PageHeader
        className="rq-bar"
        titleAs="div"
        glyph={
          narrow ? (
            <CircleIconButton icon="arrow-left" label="Back to requests" size="sm" className="rq-backbtn" onClick={closeDetail} />
          ) : r ? (
            <StatusIcon status={rPending ? "answered" : r.status} size={14} />
          ) : undefined
        }
        id={r ? <CopyId id={r.id} /> : undefined}
        title={<span className="rq-dkind">{r ? kindLabel(r.type) : "Request"}</span>}
        actions={narrow ? undefined : <CircleIconButton icon="x" label="Close details" size="sm" onClick={closeDetail} />}
        pager={
          r && idx >= 0 && list.length > 1 ? (
            <Pager
              index={idx}
              total={list.length}
              noun="request"
              onPrev={() => select(list[idx - 1].id, { page: true })}
              onNext={() => select(list[idx + 1].id, { page: true })}
            />
          ) : undefined
        }
      />
      <div className="rq-scroll">
        {r ? (
          <>
            <h1 className="wk-dtitle rq-dtitle" title={payloadText(r.payload)}>{rTitle}</h1>
            <RequestDetail
              key={r.id} r={r} onSelect={select} titleShown={rTitle} idShown statusShown typeShown
              // keep the request just acted on open ("Answered · syncing…"), even when it was the auto-selection
              onResolved={(x) => { if (sel !== x.id) setSel(x.id); }}
            />
          </>
        ) : (
          <EmptyState
            title="Request not found"
            body={truncated ? `Request ${shortId(dlReq)} isn't among the ${reqs.length} loaded requests — it may be beyond the snapshot limit.` : `Request ${shortId(dlReq)} isn't in this project.`}
            action={<Button variant="secondary" onClick={closeDetail}>Back to requests</Button>}
          />
        )}
      </div>
    </section>
  ) : null;

  return (
    <Shell
      page="requests"
      title="Requests"
      // D12: the header stays "Project / Requests" — no "N open ·" fragment (the pills carry the counts)
      // and the request title lives in the detail pane only; the pills live in the list column head
      flush
    >
      <style>{workCss}</style>
      <style>{listCss}</style>
      <div className={"rq-page" + (detailOpen ? " has-detail" : "") + (snap && !reqs.length ? " is-empty" : "")}>
        <SplitPane list={listPane} inspector={inspector} storageKey="orcha:v2:requestsDetailW" defaultSize={detailDefault()} min={420} max={1400} label="Resize request detail" />
      </div>
    </Shell>
  );
}

/** Inbox-style compact age: "8m", "2h", "3d" (full relative time stays in the tooltip). */
function shortAge(iso: string): string {
  const t = relTime(iso);
  if (t === "just now") return "now";
  const m = t.match(/^(\d+)\s*([smhdwy])/);
  return m ? m[1] + m[2] : t.replace(/ ago$/, "");
}
