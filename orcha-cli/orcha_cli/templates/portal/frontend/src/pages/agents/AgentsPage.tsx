/**
 * Agents page — React + TS port of static/agents.html (roster, deep-linkable
 * detail, gate callout, persona expand, human-only controls, memory digest,
 * requests in/out, worker-run feed, and the S1 conversation panel). All fetch
 * endpoints/methods/bodies are copied EXACTLY from the vanilla page; local UI
 * state (selection, ISS-68 PR-3 section caps, persona expand, drafts) lives in
 * useState so the 3s poll never clobbers it.
 *
 * The live terminal (terminal.js/xterm) is ported: the conversation panel's
 * "Pair in terminal" is the real S3 §3b pairing (see Conversation.tsx +
 * components/terminal/TerminalPane).
 *
 * V2 (Agent E, brief §5): a compact roster (AI agents / Humans, filterable,
 * real status + current activity) and ONE selected-agent workspace whose
 * sections are tabs — Conversation · Runs · Tasks · Requests · Memory ·
 * Configuration — mirrored in ?tab= (default: conversation for AI agents,
 * tasks for humans). The plan/verify gate stays above the tabs. Tabs replace
 * the old ISS-63 collapse toggles. Below 900 px the roster and the workspace
 * are separate full views (opening an agent pushes history).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { getJSON, sendJSON } from "../../api/client";
import { Icon, useToast } from "../../components/ui";
import {
  Avatar, Button, Chip, EmptyState, IconButton, Menu, MenuButton, PriorityIcon, StatusIcon, TabPanel, Tabs,
  type MenuItemSpec, type TabSpec,
} from "../../components/primitives";
import { ListGroup } from "../../components/primitives";
import { useMediaQuery, useNarrow } from "../../hooks/useMediaQuery";
import { payloadText } from "../requests/requestPayload";
import { runOutcome, type WorkerRun } from "../activity/runModel";
import { clockTime, relTime, shortId, trunc } from "../../lib/format";
import { Shell } from "../../shell/Shell";
import { CircleIconButton, FilterPills, PageToolbar, Pager, scrollMainTo } from "../../shell/PageChrome";
import { actingHuman, agentAutonomy, agentByAlias, planAwaitsHuman, planMessageOf, useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import type { Identity } from "../../extensions";
import type { Agent, OrchaRequest, Snapshot, Task } from "../../types";
import { Conversation } from "./Conversation";
import { RunsFeed, runReasonText, useAgentRuns } from "./runlog";
import { modelLabel } from "../../lib/models";
import { agentPresence, humanizeModelId, type ConvPresence } from "./presence";
import { SortCtl, sortComparator, type SortAcc } from "../../lib/sort";
import { SnapshotPending } from "../../components/SnapshotPending";
import { activityOf, BOARD_FILTERS, columnTasks, canGrant, errDetail, grantDenied, GRANT_REASON, NO_ACTING_HUMAN, type BoardFilter } from "./agentModel";
import { AgentsBoard, filterCounts } from "./AgentsBoard";
import { AgentsRoster, RosterSearch } from "./AgentsRoster";
import { changesTarget, useRunChanges } from "./liveChanges";
import { LiveChangesContext } from "./liveChangesContext";
import { LiveChangesButton, LiveChangesPanel } from "./LiveChangesPanel";
import { AgentBudgetSection, BudgetPausedChip } from "./budget/AgentBudgetSection";
import { AgentPerformanceCard } from "./performance/AgentPerformanceCard";
import { autonomyLabelFor, useProjectMode } from "../../lib/projectMode";
import { pausedById, useContainerBudgets } from "./budget/budgetModel";
import { AgentConfigHistory } from "./history/AgentConfigHistory";
import { BrandLogo } from "../../components/primitives/BrandLogo";
import { ModelPicker, type ManagedRuntime } from "./ModelPicker";
import "./agents.css";

/* ---------- constants (verbatim from agents.html) ------------------------- */
// ISS-68 PR-3: agent-detail section caps — tasks 10, incoming/outgoing requests
// 5 each, digest 6 — with a per-section "Load more".
const TASKS_CAP = 10,
  REQ_CAP = 5,
  DIGEST_CAP = 6;

const TASK_RANK: Record<string, number> = { needs_verification: 0, in_progress: 1, ready: 2, pending: 4, blocked: 3, failed: 3, completed: 5, cancelled: 6 };
const REQ_RANK: Record<string, number> = { open: 0, answered: 1 };

interface ModelInfo {
  id: string;
  name: string;
  runtime?: string;
  reasoning_efforts?: string[];
}
// Seeded with the backend's curated list so the control renders correctly
// pre-fetch; GET /api/models is the source of truth (picks up new ids).
const SEED_MODELS: ModelInfo[] = [
  { id: "claude-fable-5-1", name: "Fable 5.1", runtime: "claude", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-5-5", name: "Opus 5.5", runtime: "claude", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", runtime: "claude", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-fable-5", name: "Fable 5", runtime: "claude", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-5", name: "Opus 5", runtime: "claude", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-5", name: "Sonnet 5", runtime: "claude", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", runtime: "claude", reasoning_efforts: [] },
  { id: "gpt-6-astra", name: "GPT-6 Astra", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.5", name: "GPT-5.5", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", name: "GPT-5.4", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", runtime: "codex", reasoning_efforts: ["low", "medium", "high", "xhigh"] },
];
const MODEL_RUNTIMES = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
] as const;
function modelRuntimeName(runtime: string): string {
  return runtime === "codex" ? "Codex" : "Claude";
}

/* ---------- reasoning-effort control (GH #51) ------------------------------
   Labels come from GET /api/reasoning-efforts and are filtered through the
   selected /api/models row's reasoning_efforts. id null is the runtime default. */
interface ReasoningEffortInfo {
  id: string | null;
  name: string;
}
const SEED_REASONING_EFFORTS: ReasoningEffortInfo[] = [
  { id: null, name: "Default" },
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra-high" },
  { id: "max", name: "Maximum" },
  { id: "ultra", name: "Ultra" },
];

/* ---------- auto-wake control (#300) --------------------------------------- */
const AWAKE_PRESETS: { secs: number | null; label: string }[] = [
  { secs: null, label: "Off" },
  { secs: 300, label: "5m" },
  { secs: 900, label: "15m" },
  { secs: 3600, label: "1h" },
];
function fmtInterval(secs: number | null): string {
  if (secs == null) return "Off";
  if (secs % 3600 === 0) return secs / 3600 + "h";
  if (secs % 60 === 0) return secs / 60 + "m";
  return secs + "s";
}
// presets for the current value: the fixed set, plus a dynamic chip if the live
// cadence isn't one of them (an API-set 10m never renders as unselected "Off").
function awakePresets(current: number | null): { secs: number | null; label: string }[] {
  if (current == null || AWAKE_PRESETS.some((p) => p.secs === current)) return AWAKE_PRESETS;
  // sorted by cadence ("Off" first) so an API-set 10m sits between 5m and 15m
  return AWAKE_PRESETS.concat([{ secs: current, label: fmtInterval(current) }]).sort((x, y) => (x.secs ?? -1) - (y.secs ?? -1));
}

/* ---------- per-agent autonomy override (mig 043: PATCH /api/agents/{id}) ----
   Inherit (null) = the container level governs; a level chip grants THIS agent
   a different engine level WITHOUT moving the container slider. HUMAN-AUTHORITY
   gated (same PATCH lane as role + persona edits). While the container ENFORCES
   its level (autonomy_enforced), every override is ignored server-side — the
   chips render disabled with an honest "enforced" note so the live state is
   never misread. The desc always names the EFFECTIVE level (the snapshot's
   server-computed effective_autonomy — the one shared rule the completion gate
   uses), so what the human reads here is exactly what the engine will do.
   Graceful absence: an open backend that omits the mig-043 exposure fields
   (autonomy_override / effective_autonomy) renders NO override control. */
const AUT_OVERRIDES: { id: string | null; name: string }[] = [
  { id: null, name: "Inherit" },
  { id: "plan", name: "Plan-only" },
  { id: "pr", name: "Build to PR" },
  { id: "full", name: "Full" },
];
function autLevelName(level: string | null | undefined): string {
  return (AUT_OVERRIDES.find((o) => o.id === level) || { name: undefined }).name || level || "Plan-only";
}
function containerEnforced(snap: Snapshot | null): boolean {
  return !!snap?.container?.autonomy_enforced;
}
// Cloud access model (mig 039): the selector is enabled only for owners /
// manage_autonomy holders — the SAME grant the container slider requires (the
// server enforces regardless; this only gates the AFFORDANCE). Viewers
// (role-viewer members AND trusted non-members) stay read-only: they still SEE
// the current override + effective level, chips disabled. An enforced container
// parks the control for everyone (the override is ignored server-side).
// Trust off (no identity registered — the open default) falls back to the
// permissive owner convention: the acting human whose member_role is 'owner'
// or absent may act; the server stays the enforcer either way.
export const OVR_ENFORCED_REASON = "The project enforces its autonomy level — per-agent overrides are ignored";
function canEditAutOvr(snap: Snapshot | null, identity: Identity | null): boolean {
  const h = actingHuman(snap); // null for a trusted non-member (viewerOnly)
  if (!h || containerEnforced(snap)) return false;
  if (identity) {
    if (identity.member_role === "viewer") return false; // mig 039: read-only role
    if (identity.member_role === "owner") return true; // owners implicitly hold every grant
    return (identity.grants || []).indexOf("manage_autonomy") >= 0;
  }
  return h.member_role === "owner" || h.member_role == null;
}
function effectiveAutonomyOf(snap: Snapshot | null, a: Pick<Agent, "autonomy_override" | "effective_autonomy">): string {
  // Prefer the server-computed field (single shared rule); degrade to the same
  // rule computed client-side when the snapshot omits it.
  if (a.effective_autonomy) return a.effective_autonomy;
  const containerLevel = snap?.container?.autonomy_level || "plan";
  return containerEnforced(snap) ? containerLevel : a.autonomy_override || containerLevel;
}
function autOvrDesc(snap: Snapshot | null, a: Pick<Agent, "autonomy_override" | "effective_autonomy">): string {
  const eff = "Effective: " + autLevelName(effectiveAutonomyOf(snap, a));
  if (containerEnforced(snap)) return eff + " — 🔒 container enforces its level for all agents (override ignored)";
  return eff + (a.autonomy_override ? " — per-agent override" : " — inherits the container level");
}

/* ISS-69(a) embodiment lease badge + #340 activityOf: ./agentModel (shared with the roster/board). */

/* ---------- small shared bits ---------------------------------------------- */
// ISS-68 PR-3: per-section "Load more" (rendered only when more rows exist).
function MoreBtn({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (total <= shown) return null;
  return (
    <Button variant="ghost" size="sm" icon="chev" className="ag-more" data-more onClick={onMore}>
      Show more · {shown} of {total}
    </Button>
  );
}

// requests mini-row (ISS-38 deeplink to the served route). D4: the payload /
// response are object-or-prose — rendered via payloadText (headline field or
// "Key: value" pairs), never String(obj) ("[object Object]") or raw JSON.
function ReqMini({ r, dir, who, snap }: { r: OrchaRequest; dir: string; who: string; snap: Snapshot | null }) {
  const pl = payloadText(r.payload).replace(/\s+/g, " ").trim();
  const ans = r.response != null && r.response !== "" ? payloadText(r.response).replace(/\s+/g, " ").trim() : "";
  const party = agentByAlias(snap, who);
  return (
    <Link className="rqrow" to={"/requests?req=" + encodeURIComponent(r.id)} title={pl || undefined}>
      <StatusIcon status={r.escalated ? "escalated" : r.status} label={r.escalated || r.status === "escalated" ? "Escalated to a human" : undefined} />
      <span className="rq-main">
        <span className="pl">{pl ? trunc(pl, 140) : <span className="muted">No details</span>}</span>
        {ans ? (
          <span className="ans">
            <Icon name="check" cls="v2-ico" />
            {trunc(ans, 110)}
          </span>
        ) : null}
      </span>
      <span className="rq-meta">
        {r.escalated || r.status === "escalated" ? <Chip size="sm" className="rq-esc" title="Escalated to a human">Escalated</Chip> : null}
        {/* wave-4 (D12): the band already says Incoming / Outgoing, so no "from"/"to" word and no
            "Info" type word — only a task-type request carries a subtle "Task" chip */}
        {r.type === "task" ? <Chip size="sm" className="rq-kind" title="Task request — accepting it creates a task">Task</Chip> : null}
        {r.chain_depth ? <span className="v2-t-meta" title={"Request chain depth " + r.chain_depth}>↳ {r.chain_depth}</span> : null}
        <span className="rq-who" title={(dir === "from" ? "From " : "To ") + who}>
          <span className="v2-sr">{dir} </span>
          <Avatar alias={who} kind={party?.kind === "human" ? "human" : "ai"} size={16} ghLogin={party?.github_login} decorative />
          <b>{who}</b>
        </span>
        <span className="v2-t-meta rq-at">{r.created_at ? relTime(r.created_at) : ""}</span>
      </span>
    </Link>
  );
}

/** A system prompt as one plain line (markdown heading/list markers dropped). A
 *  heading starts a new clause joined with " · " — it never runs into the
 *  sentence before it ("…orcha-web. Responsibilities Break…"). */
export function plainPrompt(md: string): string {
  let out = "";
  for (const raw of md.split("\n")) {
    const heading = /^\s*#{1,6}\s+/.test(raw);
    const l = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").trim();
    if (!l) continue;
    if (heading) out += (out ? " · " : "") + l.replace(/[:.]+$/, "") + ":";
    else out += (out ? " " : "") + l;
  }
  return out.replace(/:$/, "").replace(/\s+/g, " ");
}

/* ---------- ⋯ : a 28px circular icon button opening a Menu (D5) ------------- */
function MoreMenu({ label, items }: { label: string; items: MenuItemSpec[] }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton ref={ref} icon="more" label={label} variant="outline" shape="circle" className="ag-more-menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} items={items} label={label} placement="bottom-end" />
    </>
  );
}

/* ---------- gate callout (ISS-33/36 + ISS-41 plan_decision gating) --------- */
function CalloutCard({ cls, ic, ttl, sub, hint, taskId, cta }: { cls: string; ic: string; ttl: string; sub: string; hint: string; taskId: string; cta: string }) {
  // D12: the task title is the one visible line; the "why am I seeing this" note is the tooltip
  return (
    <div className={"gatecard " + cls} role="status" title={hint}>
      <div className="row">
        <span className="gate-ic">
          <Icon name={ic} cls="" />
        </span>
        <div className="grow">
          <div className="ttl">{ttl}</div>
          <div className="sub">{sub}</div>
        </div>
        {/* secondary + arrow: the page's single primary is "New agent" (D2) */}
        <Link className="v2-btn v2-btn-secondary v2-btn-sm" to={"/tasks?task=" + encodeURIComponent(taskId)}>
          <span className="v2-btn-label">{cta}</span>
          <Icon name="arrow" cls="v2-ico" />
        </Link>
      </div>
    </div>
  );
}
function GateCallout({ a, mine, snap }: { a: Agent; mine: Task[]; snap: Snapshot | null }) {
  // verify gate: any owned task awaiting human verification (status-independent of the agent).
  const verify = mine.find((t) => t.status === "needs_verification");
  const pick = pickGatePlan(snap, mine);
  const planTask = pick.live ?? (verify ? null : pick.decided);
  // e2e-permissions-34: a viewer / non-member can never approve or verify — the
  // callout says what is waiting, not that it waits on them, and the CTA only views
  const authority = useActingAuthority();
  const canAct = !!actingHuman(snap) && !authority.readOnly && !authority.pending;
  if (planTask) {
    if (!planTask.plan_decision) {
      // undecided -> live approval lives on the Tasks gate (one authoritative surface).
      return (
        <CalloutCard
          cls="attn"
          ic="shield"
          ttl={canAct ? "Plan awaiting your approval" : "Plan awaiting approval"}
          sub={planTask.title}
          hint={`Surfaced regardless of ${a.alias}'s status.`}
          taskId={planTask.id}
          cta={canAct ? "Review plan" : "View plan"}
        />
      );
    }
    // decided -> ISS-41: quiet decided-note, never a live re-approve.
    const pd = planTask.plan_decision;
    const verb = pd.decision === "approve" ? "approved" : "rejected";
    const when = pd.at ? relTime(pd.at) : "";
    return (
      <div className="gatecard decided">
        <div className="row">
          <span className={"gate-ic " + (pd.decision === "approve" ? "ok" : "bad")}>
            <Icon name={pd.decision === "approve" ? "check" : "x"} cls="" />
          </span>
          <div className="grow">
            <div className="ttl">Plan {verb}</div>
            <div className="dnote">
              &quot;{trunc(planTask.title, 80)}&quot; — {verb}
              {pd.actor ? <> by <b>{pd.actor}</b></> : null}
              {when ? " · " + when : ""}.{pd.reason ? " " + trunc(pd.reason, 120) : ""}
            </div>
          </div>
          <Link className="v2-btn v2-btn-ghost v2-btn-sm" to={"/tasks?task=" + encodeURIComponent(planTask.id)}>
            <span className="v2-btn-label">Open task</span>
          </Link>
        </div>
      </div>
    );
  }
  if (verify) {
    return (
      <CalloutCard
        cls="attn"
        ic="check"
        ttl="Task awaiting verification"
        sub={verify.title}
        hint={`Surfaced regardless of ${a.alias}'s status.`}
        taskId={verify.id}
        cta={canAct ? "Verify" : "View task"}
      />
    );
  }
  return null;
}

/** parity r2: which plan the header gate callout speaks for. It used to take the FIRST
 *  in-progress plan task in list order, so a stale "Plan approved" (on a task whose
 *  verification was since rejected) hid a newer decision or even a live plan gate.
 *    live    — the newest UNDECIDED plan that awaits a human (planAwaitsHuman — an
 *              undecided plan at pr/full autonomy is a progress note, not a gate);
 *    decided — the most recent decision (plan_decision.at), skipping tasks whose later
 *              verification was rejected afterwards (a "[verification rejected]" thread
 *              marker newer than the decision — the approval is superseded).
 *  The caller shows live > verify gate > decided note (a quiet note never hides a gate). */
function verifyRejectedAfter(t: Task, since: number): boolean {
  return (t.thread || []).some((m) => /^\s*\[verification rejected\]/.test(m.body || "") && (Date.parse(m.at || "") || 0) >= since);
}
export function pickGatePlan(snap: Snapshot | null, mine: Task[]): { live: Task | null; decided: Task | null } {
  const ts = (v?: string | null) => (v ? Date.parse(v) || 0 : 0);
  const plans = mine.filter((t) => t.status === "in_progress" && planMessageOf(t));
  const live = plans
    .filter((t) => !t.plan_decision && planAwaitsHuman(snap, t))
    .sort((x, y) => ts(planMessageOf(y)?.at) - ts(planMessageOf(x)?.at))[0] ?? null;
  const decided = plans
    .filter((t) => !!t.plan_decision && !verifyRejectedAfter(t, ts(t.plan_decision.at)))
    .sort((x, y) => ts(y.plan_decision?.at) - ts(x.plan_decision?.at))[0] ?? null;
  return { live, decided };
}

/* ---------- snapshot-derived helpers --------------------------------------- */
function reqIn(snap: Snapshot | null, alias: string): OrchaRequest[] {
  return (snap?.requests ?? []).filter((r) => r.to === alias);
}
function reqOut(snap: Snapshot | null, alias: string): OrchaRequest[] {
  return (snap?.requests ?? []).filter((r) => r.from === alias);
}
// ISS-331: accessors mirror the Tasks/Requests pages — status rank is the OUTER
// key, the chosen key (time|priority) sorts within it.
const taskAcc: SortAcc<Task> = {
  bucket: (t) => TASK_RANK[t.status] ?? 9,
  time: (t) => Date.parse(t.created_at || "") || 0,
  prio: (t) => Number(t.priority),
};
const reqAcc: SortAcc<OrchaRequest> = {
  bucket: (r) => REQ_RANK[r.status] ?? 2,
  time: (r) => Date.parse(r.created_at || "") || 0,
  prio: (r) => Number(r.priority),
};
function firstAlias(snap: Snapshot | null): string | null {
  const ags = snap?.agents ?? [];
  const ai = ags.find((x) => x.kind !== "human");
  return (ai || ags[0] || ({} as Agent)).alias || null;
}


/** Roster-or-detail breakpoint (kept in sync with agents.css). */
const SPLIT_QUERY = "(max-width: 1099px)";

/* ---------- V2 workspace tabs ---------------------------------------------- */
type TabKey = "conversation" | "runs" | "tasks" | "requests" | "memory" | "config";
const AI_TABS: TabKey[] = ["conversation", "runs", "tasks", "requests", "memory", "config"];
// humans have no conversation panel or worker runs (they are the authority, not workers)
// and no memory digest or wake/model controls — so only Tasks + Requests (their role and
// GitHub login live in the header).
const HUMAN_TABS: TabKey[] = ["tasks", "requests"];
const TAB_LABEL: Record<TabKey, string> = {
  conversation: "Conversation",
  runs: "Runs",
  tasks: "Tasks",
  requests: "Requests",
  memory: "Memory",
  config: "Configuration",
};

interface DigestData {
  current_focus?: string | null;
  decisions?: unknown[];
  learnings?: unknown[];
  open_threads?: unknown[];
}
type DigestEntry = { loading: true } | { loading?: false; digest: DigestData | null };

/* ========================================================================== */
export function AgentsPage() {
  const { snap, cid, identity, connection, stale, lastOkAt } = useSnapshot();
  // General (non-code) projects read "Build to PR" as "Execute"
  const projMode = useProjectMode(cid).mode;
  // KG-6/B25/VD-10: ONE budgets read for the page — roster rows, board columns, the
  // workspace header and the Wake row all say "Budget paused" from the same answer
  // (refreshed on every budget write via BUDGET_CHANGED_EVENT, else every 60 s)
  const budgets = useContainerBudgets(snap?.container?.id ?? cid ?? null);
  const paused = pausedById(budgets.data);
  const toast = useToast();
  // the ONE "why can't I act" copy: viewer / non-member / pending get their own
  // authority reason — never "pick an acting human" for a viewer (who IS a human)
  const authority = useActingAuthority();
  const noHumanReason = authority.reason || NO_ACTING_HUMAN;
  // grant-gated affordances (mig 039): null = allowed, else the reason
  const agentsDenied = grantDenied(snap, identity, "manage_agents", noHumanReason);
  const autonomyDenied = grantDenied(snap, identity, "manage_autonomy", noHumanReason);
  const failMsg = (what: string, e: unknown) => {
    const st = (e as { status?: number }).status;
    const why = errDetail(e);
    return what + " failed" + (st ? " (" + st + ")" : ": " + (e as Error).message) + (why ? " — " + why : "");
  };
  const location = useLocation();
  const navigate = useNavigate();

  // selection (deeplinkable via ?agent=) — ISS-38 pendingScroll anchors the
  // picked roster row (one-shot; cleared after the next paint).
  const dlAgent = new URLSearchParams(location.search).get("agent");
  const [sel, setSel] = useState<string | null>(dlAgent);
  const [pendingScroll, setPendingScroll] = useState(!!dlAgent);

  // ISS-68 PR-3 section caps — reset on agent switch.
  const [tasksShown, setTasksShown] = useState(TASKS_CAP);
  const [riShown, setRiShown] = useState(REQ_CAP);
  const [roShown, setRoShown] = useState(REQ_CAP);
  // per-section digest caps (decisions / learnings / threads each get DIGEST_CAP)
  const [digestShown, setDigestShown] = useState<Record<string, number>>({});
  const resetCaps = () => {
    setTasksShown(TASKS_CAP);
    setRiShown(REQ_CAP);
    setRoShown(REQ_CAP);
    setDigestShown({});
  };

  // per-agent async caches (persona/digest are NOT in the snapshot — fetched
  // lazily on select/expand, keyed by agent id).
  const [personaFull, setPersonaFull] = useState<Record<string, string>>({});
  const [personaOpen, setPersonaOpen] = useState<Record<string, boolean>>({});
  const [digests, setDigests] = useState<Record<string, DigestEntry>>({});

  const [rosterQ, setRosterQ] = useState("");
  // Below 1100px the roster and the workspace are separate full views (a 280px roster
  // beside a ~350px workspace is unusable once the 248px sidebar takes its share).
  const phoneNarrow = useNarrow();
  const splitNarrow = useMediaQuery(SPLIT_QUERY);
  const narrow = phoneNarrow || splitNarrow;


  // The model control sends the curated MODEL ID (POST /model only accepts ids)
  // while displaying the friendly name.
  const [models, setModels] = useState<ModelInfo[]>(SEED_MODELS);
  const [defaultModel, setDefaultModel] = useState("claude-opus-5-5");
  useEffect(() => {
    getJSON<any>("/api/models")
      .then((d) => {
        if (d && Array.isArray(d.models) && d.models.length) setModels(d.models);
        if (d && typeof d.default === "string") setDefaultModel(d.default);
      })
      .catch(() => { /* keep the seed */ });
  }, []);
  // GH #51: fetch once, cache in state — mirrors the /api/models effect above.
  const [reasoningEfforts, setReasoningEfforts] = useState<ReasoningEffortInfo[]>(SEED_REASONING_EFFORTS);
  useEffect(() => {
    getJSON<any>("/api/reasoning-efforts")
      .then((d) => {
        if (d && Array.isArray(d.efforts) && d.efforts.length) setReasoningEfforts([{ id: null, name: "Default" }, ...d.efforts]);
      })
      .catch(() => { /* keep the seed */ });
  }, []);
  // the Provider control opens the model picker on that runtime's group (the runtime follows the model)
  const [pickerOpenOn, setPickerOpenOn] = useState<{ runtime: ManagedRuntime; n: number } | null>(null);
  // optimistic overrides (reconciled by the next snapshot / reverted on failure)
  const [awakeOverride, setAwakeOverride] = useState<{ aid: string; val: number | null } | null>(null);
  const [modelOverride, setModelOverride] = useState<{ aid: string; model: string } | null>(null);
  const [ovrOverride, setOvrOverride] = useState<{ aid: string; val: string | null } | null>(null);
  const [effortOverride, setEffortOverride] = useState<{ aid: string; val: string | null } | null>(null);

  const modelRuntimeOf = (modelId: string | null): "claude" | "codex" => {
    const m = models.find((x) => x.id === modelId);
    if (m && m.runtime) return String(m.runtime).toLowerCase() === "codex" ? "codex" : "claude";
    return String(modelId || "").startsWith("gpt-") ? "codex" : "claude";
  };
  const modelsForRuntime = (runtime: string): ModelInfo[] => {
    const wanted = runtime === "codex" ? "codex" : "claude";
    return models.filter((m) => modelRuntimeOf(m.id) === wanted);
  };
  const reasoningEffortsForModel = (modelId: string | null): ReasoningEffortInfo[] => {
    const model = models.find((m) => m.id === modelId) || models.find((m) => m.id === defaultModel);
    if (!model || !Array.isArray(model.reasoning_efforts)) return reasoningEfforts;
    const supported = new Set(model.reasoning_efforts);
    return reasoningEfforts.filter((effort) => effort.id == null || supported.has(effort.id));
  };
  const modelRuntimeForAgent = (ag: Agent): "claude" | "codex" => {
    const effModel = modelOverride && modelOverride.aid === ag.id ? modelOverride.model : ag.model;
    return modelRuntimeOf(effModel);
  };

  // sort-control re-render tick (ISS-331: the control persists to localStorage;
  // comparators re-read it on each render)
  const [, bumpSort] = useState(0);
  const resort = () => bumpSort((n) => n + 1);

  /* ---------- selection ---------- */
  const agents = snap?.agents ?? [];
  // an unknown ?agent= (typo, deleted agent) says so — it never silently opens another agent
  const selMissing = !!(sel && snap && !agentByAlias(snap, sel));
  const selAlias = selMissing ? null : sel && snap ? sel : firstAlias(snap);
  const a = agentByAlias(snap, selAlias);

  // adopt a deep-link change (e.g. arriving from another page with ?agent=)
  useEffect(() => {
    if (dlAgent && dlAgent !== sel) {
      setSel(dlAgent);
      setPendingScroll(true);
      resetCaps();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlAgent]);

  const select = (alias: string) => {
    if (alias === selAlias) return;
    setSel(alias);
    setPendingScroll(true); // ISS-38: keep the picked roster row anchored in view
    resetCaps(); // ISS-68 PR-3: reset section caps
    setAwakeOverride(null);
    setModelOverride(null);
    setOvrOverride(null);
    setEffortOverride(null);
    const sp = new URLSearchParams(location.search);
    sp.set("agent", alias);
    sp.delete("changes"); // the changes panel speaks for ONE agent's run
    // narrow widths open the workspace as a full view: PUSH so Back returns to the roster
    navigate({ pathname: "/agents", search: "?" + sp.toString() }, narrow ? { state: { fromRoster: true } } : { replace: true });
    scrollMainTo(0); // D5: the content scrolls inside the panel on wide layouts
  };

  // ISS-38: anchor the deeplinked/selected row (one-shot)
  const rosterRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!pendingScroll || !agents.length) return;
    setPendingScroll(false);
    const row = rosterRef.current?.querySelector(".rrow.sel");
    if (row && (row as any).scrollIntoView) (row as any).scrollIntoView({ block: "nearest" });
  }, [pendingScroll, selAlias, agents.length]);

  // D5 prev/next: the roster's visible order (AI agents, then humans — AgentsRoster)
  const rosterOrder = [...agents.filter((x) => x.kind !== "human"), ...agents.filter((x) => x.kind === "human")];
  const selIdx = a ? rosterOrder.findIndex((x) => x.id === a.id) : -1;
  const step = (d: number) => {
    const nx = rosterOrder[selIdx + d];
    if (nx) select(nx.alias);
  };

  /* ---------- memory digest (lazy /digest) ---------- */
  useEffect(() => {
    if (!a || a.kind === "human") return;
    if (digests[a.id] !== undefined) return;
    setDigests((m) => ({ ...m, [a.id]: { loading: true } }));
    getJSON<any>("/api/agents/" + encodeURIComponent(a.id) + "/digest")
      .then((d) => setDigests((m) => ({ ...m, [a.id]: { digest: d.digest || null } })))
      .catch(() => setDigests((m) => ({ ...m, [a.id]: { digest: null } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.id]);

  /* ---------- the agent's runs: ONE /runs read shared by the header + Runs tab ---------- */
  const feed = useAgentRuns(a || null);
  const feedRuns: WorkerRun[] | null = feed && !feed.error ? (feed.runs as WorkerRun[]) : null;
  // failed agent: why? — the NEWEST finished run explains the failed status when it failed;
  // otherwise fall back to the newest FAILED run (r2: an earlier ENOENT reason was hidden
  // behind "No failure reason recorded"). Forward-compat success words are not failures.
  const lastFailure = (() => {
    if (!a || a.kind === "human" || a.status !== "failed" || !feedRuns) return null;
    const isFail = (x: WorkerRun) => x.status !== "running" && runOutcome(x).bucket === "failed" && !/^(completed|succeeded|success|done)$/.test(x.status);
    const newest = feedRuns.find((x) => x.status !== "running");
    const r = newest && isFail(newest) ? newest : feedRuns.find(isFail);
    if (!r) return null;
    const o = runOutcome(r);
    const kr = runReasonText(r) || null;
    return { aid: a.id, rid: String(r.run_id || r.id || ""), label: o.label, reason: kr, at: r.ended_at || r.ended || r.started_at || r.started || null };
  })();
  /* ---------- Live changes: the run the button/panel speak for, ONE poller ----------
     ?changes=<run id> (or "1" = whatever the button would open) keeps the panel on the run
     it was opened for, so a live run that ends flips to "Final changes" in place. */
  const changesParam = new URLSearchParams(location.search).get("changes");
  const pinnedRun = changesParam && changesParam !== "1" && feedRuns ? feedRuns.find((r) => String(r.run_id || r.id || "") === changesParam) || null : null;
  const changesFor = a && a.kind !== "human"
    ? pinnedRun ? { run: pinnedRun, live: pinnedRun.status === "running" } : changesTarget(feedRuns)
    : null;
  const changesRid = changesFor ? String(changesFor.run.run_id || changesFor.run.id || "") : null;
  const changesOpen = !!changesFor && !!changesParam;
  const runChanges = useRunChanges(changesFor && a ? a.id : null, changesRid, { live: !!changesFor?.live, active: changesOpen });
  const setChangesOpen = (open: boolean) => {
    const sp = new URLSearchParams(location.search);
    if (open && changesRid) sp.set("changes", changesRid);
    else sp.delete("changes");
    if (selAlias && !sp.get("agent")) sp.set("agent", selAlias);
    navigate({ pathname: "/agents", search: "?" + sp.toString() }, { replace: true, state: location.state });
  };
  const changesSummary = runChanges.payload && runChanges.payload.available ? runChanges.payload.summary : null;
  // L8: the server says this run recorded no checkout — a button over nothing would lie
  const noCheckout = !!runChanges.payload && !runChanges.payload.available && runChanges.payload.reason === "no_checkout";
  const changesBtn = !!changesFor && !(noCheckout && !changesOpen);
  const changesCtx = changesFor && changesRid && changesBtn
    ? { runId: changesRid, live: changesFor.live, summary: changesSummary, isOpen: changesOpen, open: () => setChangesOpen(true) }
    : null;

  // the conversation's presence, lifted from <Conversation> (kept per agent id)
  const [convPres, setConvPres] = useState<{ aid: string; p: ConvPresence } | null>(null);

  /* ---------- persona expand (lazy /persona) ---------- */
  const loadPersona = (aid: string) => {
    if (personaFull[aid] !== undefined) return;
    fetch("/api/agents/" + encodeURIComponent(aid) + "/persona")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: any) => setPersonaFull((f) => ({ ...f, [aid]: d.system_prompt || "" })))
      .catch(() => setPersonaFull((f) => ({ ...f, [aid]: "" })));
  };
  const togglePersona = (ag: Agent) => {
    const open = !personaOpen[ag.id];
    setPersonaOpen((o) => ({ ...o, [ag.id]: open }));
    if (open) loadPersona(ag.id);
  };

  // Configuration with no prompt_preview: /persona is the truth for "is a persona set?"
  // (review: "No persona set" beside a full prompt behind "Show full prompt").
  const cfgTabOpen = new URLSearchParams(location.search).get("tab") === "config";
  useEffect(() => {
    if (!a || a.kind === "human" || !cfgTabOpen) return;
    if ((a.prompt_preview || "").trim()) return;
    loadPersona(a.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.id, cfgTabOpen]);

  /* ---------- controls (human-gated mutations) ---------- */
  const onRuntimeClick = (runtime: string) => {
    if (agentsDenied) {
      toast(agentsDenied, "danger");
      return;
    }
    // no provider-only write exists: switching provider = picking one of its models
    // (POST /model), so open the picker on that runtime's group
    setPickerOpenOn((cur) => ({ runtime: runtime === "codex" ? "codex" : "claude", n: (cur ? cur.n : 0) + 1 }));
  };

  const onModelClick = (ag: Agent, model: string) => {
    if (agentsDenied) {
      toast(agentsDenied, "danger");
      return;
    }
    const name = (models.find((m) => m.id === model) || { name: model }).name || model;
    setModelOverride({ aid: ag.id, model }); // optimistic; the snapshot reconciles
    sendJSON("POST", "/api/agents/" + encodeURIComponent(ag.id) + "/model", { model })
      .then(() => toast("Model → " + name, "ok"))
      .catch((e) => {
        setModelOverride(null);
        toast(failMsg("Model change", e), "danger");
      });
  };

  // GH #51: mirrors onModelClick — human-gated, optimistic + revert, reconciled
  // by the next snapshot poll. null means "runtime default" (clear the override).
  const onEffortClick = (ag: Agent, effort: string | null) => {
    if (agentsDenied) {
      toast(agentsDenied, "danger");
      return;
    }
    const prev = ag.reasoning_effort != null ? ag.reasoning_effort : null;
    const cur = effortOverride && effortOverride.aid === ag.id ? effortOverride.val : prev;
    if (effort === cur) return; // no-op (re-click of the active chip)
    const name = (reasoningEfforts.find((x) => x.id === effort) || { name: effort || "Default" }).name || effort || "Default";
    setEffortOverride({ aid: ag.id, val: effort }); // optimistic; the snapshot reconciles
    sendJSON("POST", "/api/agents/" + encodeURIComponent(ag.id) + "/reasoning-effort", { reasoning_effort: effort })
      .then(() => toast("Reasoning effort → " + name, "ok"))
      .catch((e) => {
        setEffortOverride(null);
        toast(failMsg("Reasoning effort change", e), "danger");
      });
  };

  const onAwakeClick = (ag: Agent, interval: number | null) => {
    const h = actingHuman(snap);
    // auto-wake is an autonomy write: owner-or-manage_autonomy (agent_wake_policy_routes.py)
    if (!h || autonomyDenied) {
      toast(autonomyDenied || noHumanReason, "danger");
      return;
    }
    const prev = ag.auto_wake_interval_secs != null ? ag.auto_wake_interval_secs : null;
    const cur = awakeOverride && awakeOverride.aid === ag.id ? awakeOverride.val : prev;
    if (interval === cur) return; // no-op (re-click of the active chip)
    setAwakeOverride({ aid: ag.id, val: interval }); // optimistic; reconciled by the next snapshot
    sendJSON("PATCH", "/api/agents/" + encodeURIComponent(ag.id) + "/auto-wake", { actor_agent_id: h.id, interval_secs: interval })
      .then(() => toast(interval == null ? "Auto-wake off" : "Auto-wake every " + fmtInterval(interval), "ok"))
      .catch((e) => {
        setAwakeOverride(null); // revert on failure
        toast(failMsg("Auto-wake change", e), "danger");
      });
  };

  // mig 043: PATCH the per-agent override. Mirrors onAwakeClick — human-gated,
  // optimistic + revert, reconciled by the next snapshot. "Inherit" PATCHes an
  // EXPLICIT null (clear-to-inherit) — the backend distinguishes null-supplied
  // (clear) from omitted (unchanged) via model_fields_set.
  const onAutOvrClick = (ag: Agent, ovr: string | null) => {
    const h = actingHuman(snap);
    if (!h) {
      toast(noHumanReason, "danger");
      return;
    }
    const prev = ag.autonomy_override != null ? ag.autonomy_override : null;
    const cur = ovrOverride && ovrOverride.aid === ag.id ? ovrOverride.val : prev;
    if (ovr === cur) return; // no-op (re-click of the active chip)
    setOvrOverride({ aid: ag.id, val: ovr }); // optimistic; reconciled by the next snapshot
    sendJSON("PATCH", "/api/agents/" + encodeURIComponent(ag.id), { actor_agent_id: h.id, autonomy_override: ovr })
      .then(() => toast(ovr == null ? "Autonomy · inherits the container level" : "Autonomy override → " + autLevelName(ovr), "ok"))
      .catch((e) => {
        setOvrOverride(null); // revert on failure
        toast(failMsg("Autonomy override change", e), "danger");
      });
  };

  /* ---------- digest block ---------- */
  const digestBlock = (ag: Agent) => {
    if (ag.kind === "human") return <div className="none">Humans don&#39;t rehydrate — no digest.</div>;
    const c = digests[ag.id];
    if (c === undefined || c.loading) return <div className="none">Loading digest…</div>;
    const d = c.digest;
    if (!d) return <div className="none">No digest yet — this agent hasn&#39;t snapshotted.</div>;
    const norm = (items?: unknown[]) =>
      (items || []).map((x) => (x && typeof x === "object" ? (x as any).text || payloadText(x) : String(x ?? ""))).filter(Boolean) as string[];
    // ISS-68 PR-3 render cap, per section: each group shows DIGEST_CAP rows with its
    // own "Show more" (a flattened budget used to starve Open threads).
    const groups = [
      { key: "decisions", label: "Recent decisions", arr: norm(d.decisions) },
      { key: "learnings", label: "Learnings", arr: norm(d.learnings) },
      { key: "threads", label: "Open threads", arr: norm(d.open_threads) },
    ];
    const groupEls = groups.map((g) => {
      if (!g.arr.length) return null;
      const cap = digestShown[g.key] ?? DIGEST_CAP;
      return (
        <section key={g.key} className="dgroup" aria-label={g.label}>
          <div className="lbl">
            {g.label} <span className="muted">· {g.arr.length}</span>
          </div>
          <ul>
            {g.arr.slice(0, cap).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <MoreBtn shown={Math.min(cap, g.arr.length)} total={g.arr.length} onMore={() => setDigestShown((m) => ({ ...m, [g.key]: cap + DIGEST_CAP }))} />
        </section>
      );
    });
    const empty = !d.current_focus && groups.every((g) => !g.arr.length);
    return (
      <div className="digest">
        {d.current_focus ? (
          <section className="dgroup focus" aria-label="Current focus">
            <div className="lbl">Current focus</div>
            <p>{d.current_focus}</p>
          </section>
        ) : null}
        {groupEls}
        {empty ? <div className="none">The digest is empty — nothing recorded yet.</div> : null}
      </div>
    );
  };


  /* ---------- V2 workspace tabs (?tab=) ---------- */
  const isHuman = a?.kind === "human";
  const tabKeys: TabKey[] = isHuman ? HUMAN_TABS : AI_TABS;
  const tabParam = new URLSearchParams(location.search).get("tab") as TabKey | null;
  const tab: TabKey = tabParam && tabKeys.indexOf(tabParam) >= 0 ? tabParam : isHuman ? "tasks" : "conversation";
  // r3 (390): an overflowing tab strip CENTRES the active tab (it used to park flush right
  // with a clipped fragment at the start). Runs after the Tabs primitive's own nearest-scroll.
  useLayoutEffect(() => {
    const strip = document.querySelector<HTMLElement>(".agents-detail .ag-tabs");
    if (!strip || strip.scrollWidth <= strip.clientWidth + 1) return;
    const selTab = strip.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!selTab) return;
    const sr = strip.getBoundingClientRect();
    const tr = selTab.getBoundingClientRect();
    const target = strip.scrollLeft + (tr.left - sr.left) - (strip.clientWidth - tr.width) / 2;
    strip.scrollLeft = Math.max(0, Math.min(target, strip.scrollWidth - strip.clientWidth));
    strip.dispatchEvent(new Event("scroll")); // re-sync the edge-fade classes
  }, [tab, a?.id, narrow]);
  const setTab = (k: string) => {
    const sp = new URLSearchParams(location.search);
    sp.set("tab", k);
    if (selAlias && !sp.get("agent")) sp.set("agent", selAlias);
    navigate({ pathname: "/agents", search: "?" + sp.toString() }, { replace: true, state: location.state });
  };
  // narrow widths: the roster and the workspace are separate full views
  const backToRoster = () => {
    if ((location.state as { fromRoster?: boolean } | null)?.fromRoster) {
      navigate(-1);
      return;
    }
    const sp = new URLSearchParams(location.search);
    sp.delete("agent");
    sp.delete("tab");
    const q = sp.toString();
    navigate({ pathname: "/agents", search: q ? "?" + q : "" }, { replace: true });
  };

  /* ---------- render ---------- */
  const canAct = !!actingHuman(snap);
  const me = actingHuman(snap);
  // model / effort / provider: owner-or-manage_agents; auto-wake: owner-or-manage_autonomy
  const canAgents = canGrant(snap, identity, "manage_agents");
  const canAutonomy = canGrant(snap, identity, "manage_autonomy");
  const offline = connection === "offline" || stale;
  // one naming rule app-wide (lib/models modelLabel): the catalog name, else a readable id — never raw
  const modelName = (id: string | null | undefined): string => modelLabel(id, models);
  // a legacy / uncurated id reads as a product name ("Opus 4.1 (legacy)"); the raw id is the tooltip
  // "(legacy)" only when the curated list actually loaded and lacks the id —
  // an unloaded / failed list is not evidence that a model is legacy
  const modelDisplay = (id: string): string => (models.some((m) => m.id === id) ? modelName(id) : humanizeModelId(id) + (models.length ? " (legacy)" : ""));
  const effortName = (id: string | null | undefined): string => (id ? (reasoningEfforts.find((e) => e.id === id) || { name: id }).name : "");

  let detail: React.ReactNode = null;
  if (snap && a) {
    // A7 (D9): a human's workspace lists the same work as their board column — assigned
    // tasks plus the tasks they review (marked "Review"); an AI lists its assigned tasks.
    const colTasks = columnTasks(snap, a);
    const reviewIds = new Set(colTasks.filter((c) => c.role === "review").map((c) => c.task.id));
    const mine = colTasks.map((c) => c.task).sort(sortComparator("agent-tasks", taskAcc));
    // "Needs you" first (a plan awaiting approval, a task to verify, or a task parked on a
    // human), then Active, then the rest — the review found a waiting plan filed under
    // "Other tasks" with an empty-circle glyph.
    // a plan "waits" only when its author runs at plan autonomy (pr/full agents post
    // progress notes) — the same rule Needs you / the Overview / attention counts use
    const planGated = (t: Task) => {
      if (!planMessageOf(t) || t.plan_decision || t.status === "completed" || t.status === "cancelled") return false;
      const pm = planMessageOf(t);
      return agentAutonomy(snap, agentByAlias(snap, pm?.from) || agentByAlias(snap, t.assignee)) === "plan";
    };
    const needsYou = (t: Task) => t.status === "needs_verification" || t.status === "awaiting_human" || planAwaitsHuman(snap, t) || (t.status === "awaiting_request" && planGated(t));
    const waiting = mine.filter(needsYou);
    const current = mine.filter((t) => !needsYou(t) && t.status === "in_progress");
    const rest = mine.filter((t) => waiting.indexOf(t) < 0 && current.indexOf(t) < 0);
    // AA-048: Incoming and Outgoing sort independently (old UI keys agent-req-in / -out)
    const ri = reqIn(snap, a.alias).sort(sortComparator("agent-req-in", reqAcc));
    const ro = reqOut(snap, a.alias).sort(sortComparator("agent-req-out", reqAcc));
    const selectedRuntime = modelRuntimeForAgent(a);
    const modelVal = modelOverride && modelOverride.aid === a.id ? modelOverride.model : a.model;
    // null model = the runtime default: mark (and light) the default model instead of nothing
    const litModel = modelVal || defaultModel;
    const legacyModel = modelVal && models.length > 0 && !models.some((m) => m.id === modelVal) && modelRuntimeOf(modelVal) === selectedRuntime ? modelVal : null;
    const visibleReasoningEfforts = reasoningEffortsForModel(modelVal);
    const awakeVal = awakeOverride && awakeOverride.aid === a.id ? awakeOverride.val : a.auto_wake_interval_secs != null ? a.auto_wake_interval_secs : null;
    const effortVal = effortOverride && effortOverride.aid === a.id ? effortOverride.val : a.reasoning_effort != null ? a.reasoning_effort : null;
    // #64 override segment — graceful absence: an open backend that omits the
    // mig-043 exposure fields renders NO control (nothing to read or write).
    const showAutOvr = a.effective_autonomy != null || a.autonomy_override != null;
    const ovrOptimistic = ovrOverride && ovrOverride.aid === a.id;
    const ovrVal = ovrOptimistic ? ovrOverride.val : a.autonomy_override != null ? a.autonomy_override : null;
    // while optimistic, ignore the (stale) server-computed effective level and
    // apply the same shared rule client-side (vanilla onAutOvrClick parity).
    const ovrDesc = autOvrDesc(snap, ovrOptimistic ? { autonomy_override: ovrVal, effective_autonomy: null } : a);
    const canEditOvr = canEditAutOvr(snap, identity);
    // parity r2: every locked chip names its own reason (like effort / auto-wake), not
    // only the section's "Read-only" badge — enforced container first, else the grant.
    const ovrLock = canEditOvr
      ? ""
      : containerEnforced(snap) && actingHuman(snap)
        ? OVR_ENFORCED_REASON
        : autonomyDenied || (actingHuman(snap) ? GRANT_REASON.manage_autonomy : noHumanReason);
    const full = personaFull[a.id];
    const pOpen = !!personaOpen[a.id];
    const act = activityOf(a);
    const openReqs = ri.filter((r) => r.status === "open" && !r.escalated).length;
    const escReqs = ri.filter((r) => r.status === "escalated" || !!r.escalated).length;
    const tabs: TabSpec[] = tabKeys.map((k) => ({
      key: k,
      label: TAB_LABEL[k],
      count: k === "tasks" ? mine.length : k === "requests" ? ri.length + ro.length : null,
    }));
    const fullP = (personaFull[a.id] || "").trim();
    // the snapshot's prompt_preview is the raw first 160 chars of markdown — flatten it the same way
    const preview = plainPrompt(a.prompt_preview || "") || (fullP ? plainPrompt(fullP).slice(0, 200) : "");
    const personaKnownEmpty = !preview && personaFull[a.id] !== undefined; // /persona answered: nothing set
    const personaLoading = !preview && personaFull[a.id] === undefined;
    const previewTxt = preview.length >= 160 ? preview.replace(/[\s.,;:!?…]+$/, "") + "…" : preview;
    const fail = a.status === "failed" && lastFailure && lastFailure.aid === a.id ? lastFailure : null;
    const aid = a.id;
    const onConvPresence = (p: ConvPresence) => setConvPres((cur) => (cur && cur.aid === aid && cur.p.presence === p.presence && cur.p.reason === p.reason ? cur : { aid, p }));
    const pres = isHuman
      ? null
      : agentPresence(a, {
          snap,
          runs: feedRuns,
          conv: convPres && convPres.aid === a.id ? convPres.p : null,
          failReason: fail ? fail.reason || fail.label : null,
        });
    // the ONE meta line: role · what it is on right now (from the SAME run list as the Runs
    // tab) · last active. No "No active run" filler — the status pill already says idle.
    const liveRun = (feedRuns || []).find((r) => r.status === "running") || null;
    const liveTaskId = (liveRun && liveRun.task_id) || (a.active_run && a.active_run.task_id) || null;
    const liveTask = liveTaskId ? (snap.tasks || []).find((t) => t.id === liveTaskId) : null;
    const nowTxt = liveTask ? trunc(liveTask.title, 56) : act;
    const metaBits: React.ReactNode[] = [];
    if (a.role) metaBits.push(<span className="role-t" title={a.role}>{a.role}</span>);
    if (isHuman && a.member_role && a.member_role.toLowerCase() !== (a.role || "").toLowerCase()) metaBits.push(a.member_role);
    if (isHuman && a.github_login) metaBits.push("@" + a.github_login);
    if (!isHuman && nowTxt) {
      metaBits.push(
        liveTaskId ? (
          <Link to={"/tasks?task=" + encodeURIComponent(liveTaskId)} title={nowTxt}>{nowTxt}</Link>
        ) : (
          <span title={nowTxt}>{nowTxt}</span>
        ),
      );
    }
    metaBits.push(<span title={a.last_active ? new Date(a.last_active).toLocaleString() : undefined}>{a.last_active ? "active " + relTime(a.last_active) : "never active"}</span>);
    if (offline) metaBits.push("as of " + (lastOkAt ? clockTime(new Date(lastOkAt).toISOString()) : "unknown") + " (not live)");
    const copyId = () => {
      try {
        void navigator.clipboard.writeText(a.id).then(() => toast("Agent ID copied", "ok"));
      } catch {
        toast("Couldn't copy", "danger");
      }
    };
    const toTasks = () => navigate("/tasks?assignee=" + encodeURIComponent(a.alias));
    const headerMenu: MenuItemSpec[] = isHuman
      ? [
          { label: "Requests", icon: "requests", onSelect: () => setTab("requests") },
          { label: "Show in Tasks", icon: "tasks", onSelect: toTasks },
          { label: "Copy ID · " + shortId(a.id), icon: "copy", onSelect: copyId },
        ]
      : [
          { label: "Open conversation", icon: "agents", onSelect: () => setTab("conversation") },
          { label: "Runs", icon: "live", onSelect: () => setTab("runs") },
          { label: "Requests", icon: "requests", onSelect: () => setTab("requests") },
          { label: "Memory", icon: "inbox", onSelect: () => setTab("memory") },
          { label: "Configuration", icon: "sliders", onSelect: () => setTab("config") },
          { label: "Show in Tasks", icon: "tasks", onSelect: toTasks },
          { label: "Copy ID · " + shortId(a.id), icon: "copy", onSelect: copyId },
        ];
    const needChip = (t: Task): string | null =>
      t.status === "needs_verification" ? "Verify" : planGated(t) ? "Plan waiting" : null;
    const taskRow = (t: Task) => (
      <Link key={t.id} className="ag-trow" to={"/tasks?task=" + encodeURIComponent(t.id)} title={t.title}>
        <PriorityIcon priority={t.priority} />
        <span className="ag-trow-id v2-t-id">{shortId(t.id)}</span>
        <StatusIcon status={planAwaitsHuman(snap, t) ? "awaiting_human" : t.status} />
        <span className="ag-trow-t">{t.title}</span>
        {needChip(t) ? <Chip size="sm" className="ag-need">{needChip(t)}</Chip> : null}
        {reviewIds.has(t.id) ? <Chip size="sm" className="ag-review" title={a.alias + " reviews this task"}>Review</Chip> : null}
        {t.is_root ? <Chip size="sm" className="ag-root">Root</Chip> : null}
        <span className="ag-trow-at v2-t-meta">{t.created_at ? relTime(t.created_at) : ""}</span>
      </Link>
    );
    // one honest reason per control class: viewer / no human → the authority reason;
    // a member without the grant → which permission it needs (the server 403s otherwise)
    const lockReason = agentsDenied || "";
    const awakeLock = autonomyDenied || "";
    const allLocked = !!agentsDenied && !!autonomyDenied;
    // D9 Configuration: model + reasoning effort are compact dropdowns that always SHOW the
    // current value (a legacy id outside the curated list, or the runtime default when unset).
    // the model picker lists EVERY /api/models row grouped by runtime (ModelPicker.tsx);
    // a legacy id outside the catalog is shown first, current and not pickable
    const modelLabel = legacyModel ? humanizeModelId(legacyModel) + " (legacy)" : modelName(litModel) + (!modelVal ? " · default" : "");
    const effortItems: MenuItemSpec[] = visibleReasoningEfforts.map((e) => ({
      label: e.name,
      checked: (effortVal || null) === e.id,
      disabled: !canAgents,
      disabledReason: lockReason,
      onSelect: () => onEffortClick(a, e.id),
    }));
    const effortLabel = effortVal ? effortName(effortVal) : "Default";

    detail = (
      <>
        {/* header — identity, model and ONE status (review blocker: the status used to be
            told 4-5 ways). The pill's tooltip carries the reason + the lease. Header +
            tabs stay pinned while the tab body scrolls. */}
        <div className="ag-top">
        <header className="ahead">
          <Button variant="ghost" size="sm" icon="arrow-left" className="ag-back" onClick={backToRoster}>
            All agents
          </Button>
          <Avatar alias={a.alias} kind={isHuman ? "human" : "ai"} size={32} ghLogin={a.github_login} />
          <div className="who">
            <div className="who-row">
              <h1 className="v2-t-display">
                <span className="who-nm" title={a.alias}>{a.alias}</span>
              </h1>
              {isHuman ? (
                <Chip size="sm" className="ag-kind" title={me && me.id === a.id ? "This is you — the human authority. Humans have no wake, model or memory controls." : "Human authority — humans have no wake, model or memory controls."}>Human</Chip>
              ) : a.model ? (
                <Chip size="sm" className="ag-model" icon={<BrandLogo brand={modelRuntimeOf(a.model)} size={12} className="mpk-logo" />} title={"Model ID " + a.model + (a.reasoning_effort ? " · reasoning effort " + a.reasoning_effort : "")}>
                  {modelDisplay(a.model)}
                  {a.reasoning_effort ? <span className="ag-model-effort"> · {effortName(a.reasoning_effort)}</span> : null}
                </Chip>
              ) : null}
              {isHuman ? null : <BudgetPausedChip status={paused[a.id]} />}
              {pres ? (
                <span className={"ag-pres p-" + pres.k + " t-" + pres.tone} id="agentPresence" tabIndex={0} title={pres.reason} aria-label={"Status: " + pres.label + ". " + pres.reason}>
                  <span className="d" aria-hidden="true" />
                  {pres.label}
                </span>
              ) : null}
            </div>
            <div className="role">
              {metaBits.map((b, i) => (
                <span key={i} className="role-bit">{b}</span>
              ))}
            </div>
          </div>
          {/* D5: "1 / N ↑ ↓" through the roster + ⋯ (same items as the board column menu) */}
          <div className="ahead-acts">
            {changesFor && changesBtn ? (
              <LiveChangesButton
                live={changesFor.live}
                summary={changesSummary}
                open={changesOpen}
                className="ag-changes-btn"
                onClick={() => setChangesOpen(!changesOpen)}
              />
            ) : null}
            {rosterOrder.length > 1 ? <Pager index={selIdx} total={rosterOrder.length} onPrev={() => step(-1)} onNext={() => step(1)} noun="agent" /> : null}
            <MoreMenu label={a.alias + " actions"} items={headerMenu} />
          </div>
        </header>
        {a.status === "failed" && !isHuman ? (
          // one borderless muted line: "Last failure 3h ago · reason · View run" — the
          // header pill already says Failed, so this line only adds the why + where
          <div className="ag-fail" role="status">
            <Icon name="alert" cls="v2-ico" />
            <span className="grow" title={fail && fail.reason ? fail.reason : undefined}>
              {fail ? (
                <>
                  <span className="muted">Last failure{fail.at ? " " + relTime(fail.at) : ""} · </span>
                  {fail.reason ? fail.reason : fail.label + " — no reason recorded"}
                </>
              ) : (
                <span className="muted">No failure reason recorded</span>
              )}
            </span>
            <Button variant="ghost" size="sm" className="ag-fail-go" onClick={() => setTab("runs")}>
              {fail ? "View run" : "View runs"}
            </Button>
          </div>
        ) : null}
        {/* gate callout — surfaced REGARDLESS of agent status (ISS-36); kept above the tabs */}
        <GateCallout a={a} mine={mine} snap={snap} />

        <Tabs tabs={tabs} value={tab} onChange={setTab} label={a.alias + " workspace"} idPrefix="agtab" className="ag-tabs" />
        </div>

        {/* conversation (S1) stays MOUNTED while other tabs show (hidden, not unmounted) so
            the composer draft, pending send, scroll and a docked terminal survive tab
            switches and the 3s poll never clobbers them */}
        {!isHuman ? (
          <div
            id="agtab-panel-conversation"
            role="tabpanel"
            aria-labelledby="agtab-tab-conversation"
            className="v2-tabpanel ag-panel"
            hidden={tab !== "conversation"}
          >
            <div id="convWrap">
              <LiveChangesContext.Provider value={changesCtx}>
                <Conversation key={a.id} agent={a} onPresence={onConvPresence} runRunning={!!liveRun} liveRun={liveRun} statusShown={pres ? pres.k : null} />
              </LiveChangesContext.Provider>
            </div>
          </div>
        ) : null}

        {changesFor && changesOpen ? (
          <LiveChangesPanel
            agentAlias={a.alias}
            agentId={a.id}
            run={changesFor.run}
            live={changesFor.live}
            state={runChanges}
            onClose={() => setChangesOpen(false)}
          />
        ) : null}

        <div id="detailMain">
          <TabPanel tabKey="runs" idPrefix="agtab" active={tab === "runs" && !isHuman}>
            <div className="ag-panel" id="runsWrap">
              <RunsFeed agent={a} feed={feed} />
            </div>
          </TabPanel>

          <TabPanel tabKey="tasks" idPrefix="agtab" active={tab === "tasks"}>
            <div className="ag-panel">
              {/* the count lives on the tab ("Tasks 2") — the toolbar carries only the sort (D12) */}
              {mine.length > 1 ? (
                <div className="ag-toolbar">
                  <span className="grow" />
                  <SortCtl name="agent-tasks" onChange={resort} />
                </div>
              ) : null}
              {mine.length ? (
                <div className="ag-list">
                  {waiting.length ? (
                    <ListGroup id="needs" title="Needs you" count={waiting.length} glyph={<StatusIcon status="awaiting_human" decorative />}>
                      {waiting.map(taskRow)}
                    </ListGroup>
                  ) : null}
                  {current.length ? (
                    <ListGroup id="active" title="Active" count={current.length} glyph={<StatusIcon status="in_progress" decorative />}>
                      {current.map(taskRow)}
                    </ListGroup>
                  ) : null}
                  {rest.length ? (
                    <ListGroup id="rest" title={current.length || waiting.length ? "Other tasks" : "All tasks"} count={rest.length} glyph={<StatusIcon status="ready" decorative />}>
                      {rest.slice(0, tasksShown).map(taskRow)}
                      <MoreBtn shown={Math.min(tasksShown, rest.length)} total={rest.length} onMore={() => setTasksShown((n) => n + TASKS_CAP)} />
                    </ListGroup>
                  ) : null}
                </div>
              ) : (
                <div className="none">{isHuman ? "No tasks assigned to or reviewed by " + a.alias + "." : "No tasks assigned to " + a.alias + "."}</div>
              )}
            </div>
          </TabPanel>

          <TabPanel tabKey="requests" idPrefix="agtab" active={tab === "requests"}>
            <div className="ag-panel ag-req">
              {ri.length + ro.length ? (
                <div className="ag-toolbar">
                  {/* incoming only: escalated is counted apart from open (review) */}
                  <span className="v2-t-meta">{[openReqs ? openReqs + " open" : "", escReqs ? escReqs + " escalated" : ""].filter(Boolean).join(" · ")}</span>
                  <span className="grow" />
                </div>
              ) : null}
              {ri.length + ro.length ? (
                <div className="ag-list">
                  <ListGroup id="in" title="Incoming" count={ri.length} actions={ri.length > 1 ? <SortCtl name="agent-req-in" onChange={resort} menuLabel="Sort incoming requests" /> : undefined}>
                    {ri.length ? (
                      <>
                        {ri.slice(0, riShown).map((r) => (
                          <ReqMini key={r.id} r={r} dir="from" who={r.from} snap={snap} />
                        ))}
                        <MoreBtn shown={Math.min(riShown, ri.length)} total={ri.length} onMore={() => setRiShown((n) => n + REQ_CAP)} />
                      </>
                    ) : (
                      <div className="ag-list-none">No incoming requests.</div>
                    )}
                  </ListGroup>
                  <ListGroup id="out" title="Outgoing" count={ro.length} actions={ro.length > 1 ? <SortCtl name="agent-req-out" onChange={resort} menuLabel="Sort outgoing requests" /> : undefined}>
                    {ro.length ? (
                      <>
                        {ro.slice(0, roShown).map((r) => (
                          <ReqMini key={r.id} r={r} dir="to" who={r.to} snap={snap} />
                        ))}
                        <MoreBtn shown={Math.min(roShown, ro.length)} total={ro.length} onMore={() => setRoShown((n) => n + REQ_CAP)} />
                      </>
                    ) : (
                      <div className="ag-list-none">No outgoing requests.</div>
                    )}
                  </ListGroup>
                </div>
              ) : (
                <div className="none">No requests to or from {a.alias}.</div>
              )}
            </div>
          </TabPanel>

          {!isHuman ? (
            <TabPanel tabKey="memory" idPrefix="agtab" active={tab === "memory"}>
              <div className="ag-panel">
                <div className="ag-toolbar">
                  <span className="v2-t-meta">Memory digest — where {a.alias} left off</span>
                </div>
                {digestBlock(a)}
              </div>
            </TabPanel>
          ) : null}

          {!isHuman ? (
            <TabPanel tabKey="config" idPrefix="agtab" active={tab === "config"}>
              <div className="ag-panel ag-config">
                <section className="ag-sec">
                  <h3 className="ag-sec-t">Persona</h3>
                  {preview ? (
                    <div className="persona-pre">{previewTxt}</div>
                  ) : personaLoading ? (
                    <div className="none">Loading persona…</div>
                  ) : (
                    <div className="none">No persona set — {a.alias} runs on its role ({a.role || "no role"}) alone.</div>
                  )}
                  {/* never "No persona set" AND a full prompt: the expander shows only when there is one */}
                  {!personaKnownEmpty && !personaLoading ? (
                    <div className="persona-expand">
                      <Button variant="ghost" size="sm" icon={pOpen ? "chev-left" : "chev"} className="ag-linkbtn" id="personaExpandBtn" aria-expanded={pOpen} onClick={() => togglePersona(a)}>
                        {pOpen ? "Hide full prompt" : "Show full prompt"}
                      </Button>
                    </div>
                  ) : null}
                  {pOpen && !personaKnownEmpty && <div className="persona-full">{full === undefined ? "Loading…" : full || "(no system prompt)"}</div>}
                </section>
                <section className="ag-sec">
                  <div className="ag-sec-h">
                    <h3 className="ag-sec-t">Controls</h3>
                    <span className="grow" />
                    <span className="ag-lock" id="agCtrlLock" tabIndex={0} title={!lockReason && !awakeLock ? "Only a human can change these settings." : [lockReason, awakeLock && awakeLock !== lockReason ? "Auto-wake: " + awakeLock : ""].filter(Boolean).join(" · ")}>
                      <Icon name="shield" cls="v2-ico" />
                      {!lockReason && !awakeLock ? "Human-only" : allLocked || !canAct ? "Read-only" : "Partly read-only"}
                    </span>
                  </div>
                  <div className="ag-ctrls">
                    <div className="ctrl">
                      <div className="grow">
                        <div className="lbl">Provider</div>
                        <div className="desc">Claude Code or Codex</div>
                      </div>
                      <div className="seg v2-seg v2-seg-sm" id="modelRuntimeSeg" role="group" aria-label="Model provider">
                        {MODEL_RUNTIMES.map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            className={"v2-seg-item" + (r.id === selectedRuntime ? " on" : "")}
                            aria-pressed={r.id === selectedRuntime}
                            disabled={!(canAgents && modelsForRuntime(r.id).length)}
                            title={lockReason || undefined}
                            onClick={() => onRuntimeClick(r.id)}
                          >
                            <BrandLogo brand={r.id} size={14} className="mpk-logo" />
                            {r.name}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="ctrl model-ctrl">
                      <div className="grow">
                        <div className="lbl">Model</div>
                        <div className="desc">
                          Which {modelRuntimeName(selectedRuntime)} model this agent wakes as
                          {!modelVal ? " · none set, so the default (" + modelName(defaultModel) + ") applies" : ""}
                        </div>
                      </div>
                      <span className="ag-pick" id="modelSeg" data-model={legacyModel || litModel}>
                        {models.length || legacyModel ? (
                          <ModelPicker
                            agentAlias={a.alias}
                            models={models}
                            runtime={selectedRuntime}
                            currentId={legacyModel || litModel}
                            legacyId={legacyModel}
                            legacyLabel={legacyModel ? humanizeModelId(legacyModel) + " (legacy)" : undefined}
                            defaultId={defaultModel}
                            label={modelLabel}
                            title={(legacyModel || litModel) + (lockReason ? " — " + lockReason : "")}
                            lockReason={canAgents ? "" : lockReason || GRANT_REASON.manage_agents}
                            effortName={effortName}
                            openOn={pickerOpenOn}
                            onPick={(id) => {
                              if (id !== modelVal) onModelClick(a, id);
                            }}
                          />
                        ) : (
                          <span className="none">No models</span>
                        )}
                      </span>
                    </div>
                    <div className="ctrl model-ctrl">
                      <div className="grow">
                        <div className="lbl">Reasoning effort</div>
                        <div className="desc">How hard this agent's worker thinks per spawn (Default = the runtime's default)</div>
                      </div>
                      <span className="ag-pick" id="effortSeg" data-effort={effortVal == null ? "null" : effortVal}>
                        <MenuButton
                          menuLabel="Reasoning effort"
                          value={effortLabel}
                          items={effortItems}
                          size="sm"
                          placement="bottom-end"
                          className="ag-pick-btn"
                          title={lockReason || "Reasoning effort"}
                        />
                      </span>
                    </div>
                    <div className="ctrl">
                      <div className="grow">
                        <div className="lbl">Wake</div>
                        <div className="desc">Daemon may wake this agent on pending work (read-only here)</div>
                      </div>
                      {a.wake_enabled && paused[a.id] ? (
                        // VD-10: a budget stop refuses new wakes — never a green "Enabled" beside it
                        <span className="wakebadge paused" title={paused[a.id].reason || "Monthly budget reached — paused for new runs"}>
                          <span className="d" />
                          Paused by budget
                        </span>
                      ) : (
                        <span className={"wakebadge " + (a.wake_enabled ? "on" : "off")}>
                          <span className="d" />
                          {a.wake_enabled ? "Enabled" : "Disabled"}
                        </span>
                      )}
                    </div>
                    <div className="ctrl">
                      <div className="grow">
                        <div className="lbl">Auto-wake</div>
                        <div className="desc">Clock-driven heartbeat — wake on a fixed cadence even with no pending work</div>
                      </div>
                      <div className="seg v2-seg v2-seg-sm" id="awakeSeg" role="group" aria-label="Auto-wake interval">
                        {awakePresets(awakeVal).map((pz) => (
                          <button
                            key={String(pz.secs)}
                            type="button"
                            className={"v2-seg-item" + (pz.secs === awakeVal ? " on" : "")}
                            aria-pressed={pz.secs === awakeVal}
                            disabled={!canAutonomy}
                            title={awakeLock || undefined}
                            onClick={() => onAwakeClick(a, pz.secs)}
                          >
                            {pz.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {showAutOvr && (
                      <div className="ctrl">
                        <div className="grow">
                          <div className="lbl">Autonomy</div>
                          <div className="desc">{ovrDesc}</div>
                        </div>
                        <div className="seg v2-seg v2-seg-sm" id="autOvrSeg" data-agent={a.id} role="group" aria-label="Per-agent autonomy override">
                          {AUT_OVERRIDES.map((o) => (
                            <button
                              key={String(o.id)}
                              type="button"
                              className={"v2-seg-item" + ((ovrVal || null) === o.id ? " on" : "")}
                              data-ovr={o.id == null ? "null" : o.id}
                              aria-pressed={(ovrVal || null) === o.id}
                              disabled={!canEditOvr}
                              title={ovrLock || undefined}
                              onClick={() => onAutOvrClick(a, o.id)}
                            >
                              {o.id ? autonomyLabelFor(o.id, o.name, projMode) : o.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
                <AgentPerformanceCard agent={a} />
                <AgentBudgetSection agent={a} />
                <section className="ag-sec">
                  <h3 className="ag-sec-t">Details</h3>
                  <dl className="ag-kv">
                    <div>
                      <dt>Origin</dt>
                      <dd>Human-created</dd>
                    </div>
                    <div>
                      <dt>Agent ID</dt>
                      <dd className="mono ag-id">
                        <span title={a.id}>{a.id}</span>
                        <IconButton icon="copy" label="Copy agent ID" size="sm" onClick={copyId} />
                      </dd>
                    </div>
                    {a.model ? (
                      <div>
                        <dt>Model ID</dt>
                        <dd className="mono">{a.model}</dd>
                      </div>
                    ) : null}
                  </dl>
                </section>
                <AgentConfigHistory agent={a} />
              </div>
            </TabPanel>
          ) : null}
        </div>
      </>
    );
  }

  const roster = <AgentsRoster agents={agents} selAlias={selAlias} onSelect={select} rosterRef={rosterRef} q={rosterQ} onQ={setRosterQ} search={false} paused={paused} />;

  // creating an agent is owner-or-manage_agents (agent_registration_routes.py): without it the
  // action stays visible but disabled with the reason — never a form bound to a 403
  const newAgent = (label: string) =>
    agentsDenied ? (
      <button
        type="button"
        className="v2-btn v2-btn-primary v2-btn-md ag-new-locked"
        aria-disabled="true"
        title={agentsDenied}
        data-denied={agentsDenied}
        onClick={() => toast(agentsDenied, "warn")}
      >
        <Icon name="plus" cls="v2-ico" />
        <span className="v2-btn-label">{label}</span>
      </button>
    ) : (
      <Link className="v2-btn v2-btn-primary v2-btn-md" to="/onboarding?new=1">
        <Icon name="plus" cls="v2-ico" />
        <span className="v2-btn-label">{label}</span>
      </Link>
    );

  /* ---------- D9 view: board (default) | roster list ---------- */
  const qs = new URLSearchParams(location.search);
  // a deep link to an agent or a workspace tab always opens the list + workspace
  const view: AgentsView = dlAgent || qs.get("tab") ? "list" : qs.get("view") === "list" ? "list" : qs.get("view") === "board" ? "board" : storedView();
  const boardFilter: BoardFilter = (BOARD_FILTERS.find((f) => f.key === qs.get("show")) || BOARD_FILTERS[0]).key;
  const setView = (v: AgentsView) => {
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch { /* private mode */ }
    const sp = new URLSearchParams(location.search);
    sp.delete("agent");
    sp.delete("tab");
    sp.set("view", v);
    navigate({ pathname: "/agents", search: "?" + sp.toString() });
  };
  const setBoardFilter = (k: string) => {
    const sp = new URLSearchParams(location.search);
    if (k === "all") sp.delete("show");
    else sp.set("show", k);
    navigate({ pathname: "/agents", search: sp.toString() ? "?" + sp.toString() : "" }, { replace: true });
  };
  const counts = filterCounts(snap);
  const viewToggle = (
    <div className="ab-viewtoggle" role="group" aria-label="View">
      <CircleIconButton glyph={<BoardGlyph />} label="Board view" pressed={view === "board"} onClick={() => view !== "board" && setView("board")} />
      <CircleIconButton glyph={<ListGlyph />} label="List view" pressed={view === "list"} onClick={() => view !== "list" && setView("list")} />
    </div>
  );
  // narrow agent detail (a full view): no list toolbar — every px goes to the workspace
  // so the conversation composer stays on screen (review: 390px composer below the fold)
  const toolbar =
    snap && agents.length && !(view === "list" && narrow && !!dlAgent) ? (
      <PageToolbar label={view === "board" ? "Agent task filters" : "Agents view"} end={viewToggle}>
        {view === "board" ? (
          <FilterPills
            label="Show"
            value={boardFilter}
            onChange={setBoardFilter}
            items={BOARD_FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key] }))}
          />
        ) : (
          // r2: ONE toolbar row in both views — the roster filter sits where the
          // board's filter pills sit (the band headers already count agents)
          <RosterSearch q={rosterQ} onQ={setRosterQ} />
        )}
      </PageToolbar>
    ) : undefined;

  return (
    <Shell
      page="agents"
      title="Agents"
      ctx={snap ? `${agents.length} agents` : undefined}
      crumbs={view === "list" && a && (dlAgent || !narrow) ? [{ label: a.alias }] : undefined /* board / narrow roster: no selected agent */}
      primaryAction={newAgent("New agent")}
      toolbar={toolbar}
      flush={view === "board" && !!snap && agents.length > 0}
    >
      {!snap ? (
        <SnapshotPending lines={8} label="Loading agents" what="agents" />
      ) : !agents.length ? (
        <EmptyState
          title="No agents yet"
          body="Create your first agents — each gets a role and a model, and a human decides who joins the roster."
          action={newAgent("Create agents")}
        />
      ) : view === "board" ? (
        <AgentsBoard snap={snap} filter={boardFilter} canAct={canAct} paused={paused} />
      ) : (
        <div className="agents-v2" data-has-agent={dlAgent ? "true" : "false"}>
          {roster}
          <div className="agents-detail">
            {a ? (
              detail
            ) : (
              <>
                {/* r3 (390): the roster is hidden in this full view — always offer the way back */}
                <Button variant="ghost" size="sm" icon="arrow-left" className="ag-back ag-back-nf" onClick={backToRoster}>
                  All agents
                </Button>
                <EmptyState title="Agent not found" body={sel ? `No agent named “${sel}” in this project.` : undefined} />
              </>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}

/* ---------- D9 view toggle ---------------------------------------------------- */
type AgentsView = "board" | "list";
const VIEW_KEY = "orcha:v2:agentsView";
function storedView(): AgentsView {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board";
  } catch {
    return "board";
  }
}
function BoardGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true" focusable="false">
      <rect x="2" y="2.5" width="3.4" height="11" rx="1" />
      <rect x="6.3" y="2.5" width="3.4" height="7.5" rx="1" />
      <rect x="10.6" y="2.5" width="3.4" height="9.5" rx="1" />
    </svg>
  );
}
function ListGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      <circle cx="2.6" cy="4" r=".6" fill="currentColor" />
      <circle cx="2.6" cy="8" r=".6" fill="currentColor" />
      <circle cx="2.6" cy="12" r=".6" fill="currentColor" />
    </svg>
  );
}
