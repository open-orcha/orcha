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
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { getJSON, sendJSON } from "../../api/client";
import { Avatar, Icon, KindBadge, Pill, useToast } from "../../components/ui";
import { relTime, shortId, trunc } from "../../lib/format";
import { leaseOf, statusClass } from "../../lib/status";
import { Shell } from "../../shell/Shell";
import { actingHuman, agentByAlias, planMessageOf, useSnapshot } from "../../state/SnapshotProvider";
import type { Identity } from "../../extensions";
import type { Agent, OrchaRequest, Snapshot, Task } from "../../types";
import { Conversation } from "./Conversation";
import { RunsFeed } from "./runlog";
import { SortCtl, sortComparator, type SortAcc } from "../../lib/sort";
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
}
// Seeded with the backend's curated list so the control renders correctly
// pre-fetch; GET /api/models is the source of truth (picks up new ids).
const SEED_MODELS: ModelInfo[] = [
  { id: "claude-opus-5", name: "Opus 5", runtime: "claude" },
  { id: "claude-fable-5", name: "Fable 5", runtime: "claude" },
  { id: "claude-sonnet-5", name: "Sonnet 5", runtime: "claude" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", runtime: "claude" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", runtime: "codex" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", runtime: "codex" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", runtime: "codex" },
  { id: "gpt-5.5", name: "GPT-5.5", runtime: "codex" },
  { id: "gpt-5.4", name: "GPT-5.4", runtime: "codex" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini", runtime: "codex" },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", runtime: "codex" },
];
const MODEL_RUNTIMES = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
] as const;
function modelRuntimeName(runtime: string): string {
  return runtime === "codex" ? "Codex" : "Claude";
}

/* ---------- reasoning-effort control (GH #51) ------------------------------
   Options come from GET /api/reasoning-efforts (canonical list; fetched once,
   cached in state). Mirrors the model control's shape exactly: id null is the
   "default" (runtime default) entry. */
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
  return AWAKE_PRESETS.concat([{ secs: current, label: fmtInterval(current) }]);
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

/* ---------- ISS-69(a): embodiment lease badge ------------------------------ */
const EMBOD_LBL: Record<string, string> = { live: "live", resident: "in convo", ephemeral: "task" };
const EMBOD_TITLE: Record<string, string> = {
  live: "In a live terminal — busy and can't be woken until the terminal closes",
  resident: "In a live conversation — busy until the conversation yields or ends",
  ephemeral: "Running a task — busy until the task completes",
};
function EmbodBadge({ a }: { a: Agent }) {
  const kind = leaseOf(a);
  if (!kind || kind === "idle") return null;
  return (
    <span className={"rlive " + kind} title={EMBOD_TITLE[kind] || ""}>
      <span className="d" />
      {EMBOD_LBL[kind] || kind}
    </span>
  );
}

/* ---------- status glyph (app.js glyph, verbatim markup) ------------------- */
function glyphHtml(cls: string): string {
  const v = (b: string) =>
    `<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`;
  switch (cls) {
    case "s-working":
      return '<svg class="gl" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="1.3"/><circle class="core" cx="6" cy="6" r="2.3" fill="currentColor"/></svg>';
    case "s-ok":
    case "s-done":
      return v('<path d="M2.6 6.4 5 8.7 9.4 3.6"/>');
    case "s-ready":
      return '<svg class="gl" viewBox="0 0 12 12" fill="currentColor"><path d="M3.6 2.6 9.6 6l-6 3.4z"/></svg>';
    case "s-attn":
    case "s-warn":
      return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M6 2 11 10.6H1z"/><path d="M6 5v2.2"/><circle cx="6" cy="9" r=".55" fill="currentColor" stroke="none"/></svg>';
    case "s-bad":
      return v('<path d="M3.3 3.3 8.7 8.7M8.7 3.3 3.3 8.7"/>');
    case "s-acc":
      return v('<path d="M2.6 6h6.8M6.4 3 9.4 6 6.4 9"/>');
    default:
      return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="3.6" stroke-opacity=".55"/><path d="M4.3 6h3.4" stroke-linecap="round"/></svg>';
  }
}
function Glyph({ cls }: { cls: string }) {
  return <span style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: glyphHtml(cls) }} />;
}

/* ---------- small shared bits ---------------------------------------------- */
// ISS-68 PR-3: per-section "Load more" (rendered only when more rows exist).
function MoreBtn({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (total <= shown) return null;
  return (
    <button className="btn sm ghost" style={{ alignSelf: "flex-start", marginTop: 4 }} data-more onClick={onMore}>
      Load more · {shown} of {total}
    </button>
  );
}

// requests mini-row (ISS-38 deeplink to the served route)
function ReqMini({ r, dir, who }: { r: OrchaRequest; dir: string; who: string }) {
  return (
    <Link className="rqrow" to={"/requests?req=" + encodeURIComponent(r.id)}>
      <div className="body">
        <div className="top">
          <Pill status={r.escalated ? "escalated" : r.status} />
          <span className="tag">{r.type}</span>
          <span className="muted" style={{ fontSize: "11.5px" }}>
            {dir} <b style={{ color: "var(--text-2)" }}>{who}</b>
          </span>
          {r.chain_depth ? <span className="tag" style={{ color: "var(--info)" }}>↳ chain {r.chain_depth}</span> : null}
          <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>{r.created_at ? relTime(r.created_at) : ""}</span>
        </div>
        <div className="pl">{trunc(String(r.payload ?? ""), 120)}</div>
        {r.response != null && r.response !== "" ? <div className="ans">{trunc(String(r.response), 110)}</div> : null}
      </div>
    </Link>
  );
}

/* ---------- gate callout (ISS-33/36 + ISS-41 plan_decision gating) --------- */
function CalloutCard({ cls, ic, ttl, sub, taskId, cta }: { cls: string; ic: string; ttl: string; sub: string; taskId: string; cta: string }) {
  return (
    <div className={"gatecard " + cls}>
      <div className="row">
        <span style={{ color: "var(--warn)" }}>
          <Icon name={ic} cls="" />
        </span>
        <div className="grow">
          <div className="ttl">{ttl}</div>
          <div className="sub">{sub}</div>
        </div>
        <Link className="btn sm" to={"/tasks?task=" + encodeURIComponent(taskId)}>
          {cta} <Icon name="arrow" cls="" />
        </Link>
      </div>
    </div>
  );
}
function GateCallout({ a, mine }: { a: Agent; mine: Task[] }) {
  // verify gate: any owned task awaiting human verification (status-independent of the agent).
  const verify = mine.find((t) => t.status === "needs_verification");
  // plan gate: an in-progress task whose agent posted a plan...
  const planTask = mine.find((t) => t.status === "in_progress" && planMessageOf(t));
  if (planTask) {
    if (!planTask.plan_decision) {
      // undecided -> live approval lives on the Tasks gate (one authoritative surface).
      return (
        <CalloutCard
          cls="attn"
          ic="shield"
          ttl="Plan awaiting your approval"
          sub={`${planTask.title} — surfaced regardless of ${a.alias}'s status.`}
          taskId={planTask.id}
          cta="Review plan"
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
          <span style={{ color: pd.decision === "approve" ? "var(--ok)" : "var(--danger)" }}>
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
          <Link className="btn sm ghost" to={"/tasks?task=" + encodeURIComponent(planTask.id)}>
            Open task <Icon name="arrow" cls="" />
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
        sub={`${verify.title} — surfaced regardless of ${a.alias}'s status.`}
        taskId={verify.id}
        cta="Verify"
      />
    );
  }
  return null;
}

/* ---------- snapshot-derived helpers --------------------------------------- */
function agentTasks(snap: Snapshot | null, alias: string): Task[] {
  return (snap?.tasks ?? []).filter((t) => (t.assignees || []).indexOf(alias) >= 0);
}
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

/* ---------- ISS-63 collapse state ------------------------------------------ */
const COLLAPSE_KEY = "orcha:agentWidgetCollapse";
function readCollapsed(): Record<string, boolean> {
  try {
    return (JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}") as Record<string, boolean>) || {};
  } catch {
    return {};
  }
}

interface DigestData {
  current_focus?: string | null;
  decisions?: unknown[];
  learnings?: unknown[];
  open_threads?: unknown[];
}
type DigestEntry = { loading: true } | { loading?: false; digest: DigestData | null };

/* ========================================================================== */
export function AgentsPage() {
  const { snap, identity } = useSnapshot();
  const toast = useToast();
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
  const [digestShown, setDigestShown] = useState(DIGEST_CAP);
  const resetCaps = () => {
    setTasksShown(TASKS_CAP);
    setRiShown(REQ_CAP);
    setRoShown(REQ_CAP);
    setDigestShown(DIGEST_CAP);
  };

  // per-agent async caches (persona/digest are NOT in the snapshot — fetched
  // lazily on select/expand, keyed by agent id).
  const [personaFull, setPersonaFull] = useState<Record<string, string>>({});
  const [personaOpen, setPersonaOpen] = useState<Record<string, boolean>>({});
  const [digests, setDigests] = useState<Record<string, DigestEntry>>({});

  // ISS-63 collapsible widgets (localStorage, shared by all agents).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const isCollapsed = (k: string) => !!collapsed[k];
  const toggleCollapse = (k: string) =>
    setCollapsed((c) => {
      const next = { ...c, [k]: !c[k] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch { /* private mode */ }
      return next;
    });
  const CollapseBtn = ({ k }: { k: string }) => (
    <button className="collapse-btn" data-collapse={k} title={isCollapsed(k) ? "Expand" : "Collapse"} aria-label="toggle" onClick={() => toggleCollapse(k)}>
      <Icon name="chev" cls="" />
    </button>
  );

  // The model control sends the curated MODEL ID (POST /model only accepts ids)
  // while displaying the friendly name.
  const [models, setModels] = useState<ModelInfo[]>(SEED_MODELS);
  useEffect(() => {
    getJSON<any>("/api/models")
      .then((d) => {
        if (d && Array.isArray(d.models) && d.models.length) setModels(d.models);
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
  const [runtimeFilters, setRuntimeFilters] = useState<Record<string, string>>({});
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
  const modelRuntimeForAgent = (ag: Agent): string => {
    const saved = runtimeFilters[ag.id];
    if (saved && modelsForRuntime(saved).length) return saved;
    const effModel = modelOverride && modelOverride.aid === ag.id ? modelOverride.model : ag.model;
    return modelRuntimeOf(effModel);
  };

  // sort-control re-render tick (ISS-331: the control persists to localStorage;
  // comparators re-read it on each render)
  const [, bumpSort] = useState(0);
  const resort = () => bumpSort((n) => n + 1);

  /* ---------- selection ---------- */
  const agents = snap?.agents ?? [];
  const selAlias = sel && snap && agentByAlias(snap, sel) ? sel : firstAlias(snap);
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
    navigate({ pathname: "/agents", search: "?" + sp.toString() }, { replace: true });
    try {
      window.scrollTo({ top: 0 });
    } catch { /* jsdom */ }
  };

  // ISS-38: anchor the deeplinked/selected row (one-shot)
  const rosterRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!pendingScroll || !agents.length) return;
    setPendingScroll(false);
    const row = rosterRef.current?.querySelector(".rrow.sel");
    if (row && (row as any).scrollIntoView) (row as any).scrollIntoView({ block: "nearest" });
  }, [pendingScroll, selAlias, agents.length]);

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

  /* ---------- persona expand (lazy /persona) ---------- */
  const togglePersona = (ag: Agent) => {
    const open = !personaOpen[ag.id];
    setPersonaOpen((o) => ({ ...o, [ag.id]: open }));
    if (open && personaFull[ag.id] === undefined) {
      fetch("/api/agents/" + encodeURIComponent(ag.id) + "/persona")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: any) => setPersonaFull((f) => ({ ...f, [ag.id]: d.system_prompt || "" })))
        .catch(() => setPersonaFull((f) => ({ ...f, [ag.id]: "" })));
    }
  };

  /* ---------- controls (human-gated mutations) ---------- */
  const onRuntimeClick = (ag: Agent, runtime: string) => {
    const h = actingHuman(snap);
    if (!h) {
      toast("Pick an acting human first.", "danger");
      return;
    }
    setRuntimeFilters((f) => ({ ...f, [ag.id]: runtime === "codex" ? "codex" : "claude" }));
  };

  const onModelClick = (ag: Agent, model: string) => {
    const h = actingHuman(snap);
    if (!h) {
      toast("Pick an acting human first.", "danger");
      return;
    }
    const name = (models.find((m) => m.id === model) || { name: model }).name || model;
    setRuntimeFilters((f) => ({ ...f, [ag.id]: modelRuntimeOf(model) }));
    setModelOverride({ aid: ag.id, model }); // optimistic; the snapshot reconciles
    sendJSON("POST", "/api/agents/" + encodeURIComponent(ag.id) + "/model", { model })
      .then(() => toast("Model → " + name, "ok"))
      .catch((e) => {
        setModelOverride(null);
        const st = (e as { status?: number }).status;
        toast(st ? "Failed (" + st + ")" : "Failed: " + (e as Error).message, "danger");
      });
  };

  // GH #51: mirrors onModelClick — human-gated, optimistic + revert, reconciled
  // by the next snapshot poll. null means "runtime default" (clear the override).
  const onEffortClick = (ag: Agent, effort: string | null) => {
    const h = actingHuman(snap);
    if (!h) {
      toast("Pick an acting human first.", "danger");
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
        const st = (e as { status?: number }).status;
        toast(st ? "Reasoning effort change failed (" + st + ")" : "Reasoning effort change failed: " + (e as Error).message, "danger");
      });
  };

  const onAwakeClick = (ag: Agent, interval: number | null) => {
    const h = actingHuman(snap);
    if (!h) {
      toast("Pick an acting human first.", "danger");
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
        const st = (e as { status?: number }).status;
        toast(st ? "Auto-wake change failed (" + st + ")" : "Auto-wake change failed: " + (e as Error).message, "danger");
      });
  };

  // mig 043: PATCH the per-agent override. Mirrors onAwakeClick — human-gated,
  // optimistic + revert, reconciled by the next snapshot. "Inherit" PATCHes an
  // EXPLICIT null (clear-to-inherit) — the backend distinguishes null-supplied
  // (clear) from omitted (unchanged) via model_fields_set.
  const onAutOvrClick = (ag: Agent, ovr: string | null) => {
    const h = actingHuman(snap);
    if (!h) {
      toast("Pick an acting human first.", "danger");
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
        const st = (e as { status?: number }).status;
        toast(st ? "Autonomy override change failed (" + st + ")" : "Autonomy override change failed: " + (e as Error).message, "danger");
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
      (items || []).map((x) => (x && typeof x === "object" ? (x as any).text || JSON.stringify(x) : String(x))).filter(Boolean) as string[];
    // ISS-68 PR-3 render cap: a budget over the FLATTENED decisions→learnings→
    // threads list (Current focus always shows); "Show more" reveals the rest.
    const groups = [
      { label: "Recent decisions", arr: norm(d.decisions), thr: false },
      { label: "Learnings", arr: norm(d.learnings), thr: false },
      { label: "Open threads", arr: norm(d.open_threads), thr: true },
    ];
    const total = groups.reduce((n, g) => n + g.arr.length, 0);
    let remaining = digestShown;
    const groupEls = groups.map((g) => {
      if (!g.arr.length) return null;
      const take = g.arr.slice(0, Math.max(0, remaining));
      remaining -= g.arr.length;
      if (!take.length) return null;
      return (
        <div key={g.label} className={"dgroup " + (g.thr ? "thr" : "")}>
          <div className="lbl">{g.label}</div>
          <ul>
            {take.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      );
    });
    return (
      <div className="digest">
        {d.current_focus ? (
          <div className="focus">
            <div className="lbl">
              <Icon name="dot" cls="" />
              Current focus
            </div>
            {d.current_focus}
          </div>
        ) : null}
        {groupEls}
        <MoreBtn shown={Math.min(digestShown, total)} total={total} onMore={() => setDigestShown((n) => n + DIGEST_CAP)} />
      </div>
    );
  };

  /* ---------- render ---------- */
  const ctx = snap ? `${agents.length} agents · ${snap.container?.name ?? ""}` : undefined;
  const canAct = !!actingHuman(snap);

  let detail: React.ReactNode = null;
  if (snap) {
    if (!a) {
      detail = (
        <div className="card pad">
          <div className="none">Agent not found.</div>
        </div>
      );
    } else {
      const mine = agentTasks(snap, a.alias).sort(sortComparator("agent-tasks", taskAcc));
      const current = mine.filter((t) => t.status === "in_progress" || t.status === "needs_verification");
      const ri = reqIn(snap, a.alias).sort(sortComparator("agent-req-in", reqAcc));
      const ro = reqOut(snap, a.alias).sort(sortComparator("agent-req-out", reqAcc));
      const selectedRuntime = modelRuntimeForAgent(a);
      const visibleModels = modelsForRuntime(selectedRuntime);
      const modelVal = modelOverride && modelOverride.aid === a.id ? modelOverride.model : a.model;
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
      const full = personaFull[a.id];
      const pOpen = !!personaOpen[a.id];

      detail = (
        <>
          {/* header */}
          <div className="card pad" style={{ marginBottom: 18 }}>
            <div className="ahead">
              <Avatar alias={a.alias} kind={a.kind} size="lg" ghLogin={a.github_login} />
              <div className="who grow">
                <h1>
                  {a.alias} <KindBadge kind={a.kind} />
                </h1>
                <div className="role">{a.role}</div>
              </div>
              <Pill status={a.status} size="lg" />
            </div>
            <div className="meta" style={{ marginTop: 16, paddingTop: 15, borderTop: "1px solid var(--border)" }}>
              {a.model ? (
                <div>
                  <span className="k">Model</span>
                  <span className="v">{a.model}</span>
                </div>
              ) : null}
              <div>
                <span className="k">Last active</span>
                <span className="v">{a.last_active ? relTime(a.last_active) : "—"}</span>
              </div>
              <div>
                <span className="k">Origin</span>
                <span className="v">{a.kind === "human" ? "Human authority" : "Human-created"}</span>
              </div>
              <div>
                <span className="k">Agent ID</span>
                <span className="v mono">{shortId(a.id)}</span>
              </div>
            </div>
          </div>

          {/* gate callout — surfaced REGARDLESS of agent status (ISS-36) */}
          <GateCallout a={a} mine={mine} />

          {/* persona + controls */}
          <div className="g2" style={{ marginBottom: 18 }}>
            <div className="card">
              <div className="card-h">
                <h3>{a.kind === "human" ? "Role" : "Persona"}</h3>
              </div>
              <div className="card-b" style={{ padding: "14px 16px" }}>
                <div className="persona-pre">
                  {a.prompt_preview || a.role || "—"}
                  {a.prompt_preview && a.prompt_preview.length >= 160 ? "…" : ""}
                </div>
                {a.kind !== "human" && (
                  <>
                    <div className="persona-expand">
                      <button className="btn sm ghost" id="personaExpandBtn" onClick={() => togglePersona(a)}>
                        {pOpen ? "Hide full prompt" : "Expand full prompt"}
                      </button>
                    </div>
                    {pOpen && <div className="persona-full">{full === undefined ? "Loading…" : full || "(no system prompt)"}</div>}
                  </>
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-h">
                <h3>Controls</h3>
                <span className="grow" />
                <span className="muted" style={{ fontSize: "11.5px" }}>human-only</span>
              </div>
              <div className="card-b" style={{ padding: "13px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                {a.kind === "human" ? (
                  <div className="none" style={{ padding: 16 }}>This is you — the human authority. No wake controls.</div>
                ) : (
                  <>
                    <div className="ctrl">
                      <div className="grow">
                        <div className="lbl">Provider</div>
                        <div className="desc">Claude Code or Codex</div>
                      </div>
                      <div className="seg" id="modelRuntimeSeg" aria-label="Model provider">
                        {MODEL_RUNTIMES.map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            className={r.id === selectedRuntime ? "on" : ""}
                            aria-pressed={r.id === selectedRuntime}
                            disabled={!(canAct && modelsForRuntime(r.id).length)}
                            onClick={() => onRuntimeClick(a, r.id)}
                          >
                            {r.name}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="ctrl model-ctrl">
                      <div className="grow">
                        <div className="lbl">Model</div>
                        <div className="desc">Which {modelRuntimeName(selectedRuntime)} model this agent wakes as</div>
                      </div>
                      <div className="seg" id="modelSeg" aria-label={modelRuntimeName(selectedRuntime) + " model"}>
                        {visibleModels.length ? (
                          visibleModels.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              className={m.id === modelVal ? "on" : ""}
                              aria-pressed={m.id === modelVal}
                              title={m.name}
                              disabled={!canAct}
                              onClick={() => onModelClick(a, m.id)}
                            >
                              {m.name}
                            </button>
                          ))
                        ) : (
                          <span className="none" style={{ padding: "4px 9px" }}>No models</span>
                        )}
                      </div>
                    </div>
                    <div className="ctrl model-ctrl">
                      <div className="grow">
                        <div className="lbl">Reasoning effort</div>
                        <div className="desc">How hard this agent's worker thinks per spawn (default = runtime default)</div>
                      </div>
                      <div className="seg" id="effortSeg" aria-label="Reasoning effort">
                        {reasoningEfforts.map((e) => (
                          <button
                            key={String(e.id)}
                            type="button"
                            className={(effortVal || null) === e.id ? "on" : ""}
                            data-effort={e.id == null ? "null" : e.id}
                            aria-pressed={(effortVal || null) === e.id}
                            disabled={!canAct}
                            onClick={() => onEffortClick(a, e.id)}
                          >
                            {e.name}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="ctrl">
                      <div className="grow">
                        <div className="lbl">Wake</div>
                        <div className="desc">Daemon may wake this agent on pending work</div>
                      </div>
                      <span className={"wakebadge " + (a.wake_enabled ? "on" : "off")}>
                        <span className="d" />
                        {a.wake_enabled ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                    <div className="ctrl">
                      <div className="grow">
                        <div className="lbl">Auto-wake</div>
                        <div className="desc">Clock-driven heartbeat — wake on a fixed cadence even with no pending work</div>
                      </div>
                      <div className="seg" id="awakeSeg" aria-label="Auto-wake interval">
                        {awakePresets(awakeVal).map((pz) => (
                          <button
                            key={String(pz.secs)}
                            type="button"
                            className={pz.secs === awakeVal ? "on" : ""}
                            aria-pressed={pz.secs === awakeVal}
                            disabled={!canAct}
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
                        <div className="seg" id="autOvrSeg" data-agent={a.id} aria-label="Per-agent autonomy override">
                          {AUT_OVERRIDES.map((o) => (
                            <button
                              key={String(o.id)}
                              type="button"
                              className={(ovrVal || null) === o.id ? "on" : ""}
                              data-ovr={o.id == null ? "null" : o.id}
                              aria-pressed={(ovrVal || null) === o.id}
                              disabled={!canEditOvr}
                              onClick={() => onAutOvrClick(a, o.id)}
                            >
                              {o.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* current task + memory digest */}
          <div className="g2" style={{ marginBottom: 18 }}>
            <div className={"card" + (isCollapsed("currentTask") ? " collapsed" : "")}>
              <div className="card-h">
                <h3>Current task</h3>
                <span className="count">{current.length ? "· " + current.length : ""}</span>
                <span className="grow" />
                <SortCtl name="agent-tasks" onChange={resort} />
                <CollapseBtn k="currentTask" />
              </div>
              <div className="card-b" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                {current.length ? (
                  current.map((t) => (
                    <Link key={t.id} className="lrow" style={{ border: "1px solid var(--border)" }} to={"/tasks?task=" + encodeURIComponent(t.id)}>
                      <div className="grow">
                        <div className="t1">
                          {t.is_root ? <span className="tag root" style={{ marginRight: 6 }}>root</span> : null}
                          {t.title}
                        </div>
                        <div className="t2">{trunc(t.definition_of_done, 64)}</div>
                      </div>
                      <Pill status={t.status} />
                    </Link>
                  ))
                ) : (
                  <div className="none">No task in progress.</div>
                )}
                {mine.length > 0 && (
                  <div className="tchips-wrap">
                    <div className="tchips-lbl">All tasks · {mine.length}</div>
                    <div className="tchips">
                      {mine.slice(0, tasksShown).map((t) => (
                        <Link key={t.id} className="tchip" to={"/tasks?task=" + encodeURIComponent(t.id)} title={t.title}>
                          <Glyph cls={statusClass(t.status)} />
                          <span>{trunc(t.title, 30)}</span>
                        </Link>
                      ))}
                    </div>
                    <MoreBtn shown={Math.min(tasksShown, mine.length)} total={mine.length} onMore={() => setTasksShown((n) => n + TASKS_CAP)} />
                  </div>
                )}
              </div>
            </div>
            <div className={"card" + (isCollapsed("memoryDigest") ? " collapsed" : "")}>
              <div className="card-h">
                <h3>Memory digest</h3>
                <span className="grow" />
                <span className="muted" style={{ fontSize: "11.5px" }}>where it left off</span>
                <CollapseBtn k="memoryDigest" />
              </div>
              <div className="card-b" style={{ padding: "13px 14px" }}>{digestBlock(a)}</div>
            </div>
          </div>

          {/* requests in/out (ISS-38) */}
          <div className="g2" style={{ marginBottom: 18 }}>
            <div className={"card" + (isCollapsed("incomingReq") ? " collapsed" : "")}>
              <div className="card-h">
                <h3>Incoming requests</h3>
                <span className="count">({ri.length})</span>
                <span className="grow" />
                <SortCtl name="agent-req-in" onChange={resort} />
                <CollapseBtn k="incomingReq" />
              </div>
              <div className="card-b" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
                {ri.length ? (
                  <>
                    {ri.slice(0, riShown).map((r) => (
                      <ReqMini key={r.id} r={r} dir="from" who={r.from} />
                    ))}
                    <MoreBtn shown={Math.min(riShown, ri.length)} total={ri.length} onMore={() => setRiShown((n) => n + REQ_CAP)} />
                  </>
                ) : (
                  <div className="none">No incoming requests.</div>
                )}
              </div>
            </div>
            <div className={"card" + (isCollapsed("outgoingReq") ? " collapsed" : "")}>
              <div className="card-h">
                <h3>Outgoing requests</h3>
                <span className="count">({ro.length})</span>
                <span className="grow" />
                <SortCtl name="agent-req-out" onChange={resort} />
                <CollapseBtn k="outgoingReq" />
              </div>
              <div className="card-b" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
                {ro.length ? (
                  <>
                    {ro.slice(0, roShown).map((r) => (
                      <ReqMini key={r.id} r={r} dir="to" who={r.to} />
                    ))}
                    <MoreBtn shown={Math.min(roShown, ro.length)} total={ro.length} onMore={() => setRoShown((n) => n + REQ_CAP)} />
                  </>
                ) : (
                  <div className="none">No outgoing requests.</div>
                )}
              </div>
            </div>
          </div>
        </>
      );
    }
  }

  return (
    <Shell page="agents" title="Agents" ctx={ctx}>
      {snap && (
        <div className="split wide">
          <aside className="card roster-card stick" id="roster" ref={rosterRef}>
            <div className="rh">
              <Icon name="agents" cls="" />
              Roster · {agents.length}
              <span style={{ flex: 1 }} />
              <Link to="/onboarding?new=1" style={{ color: "var(--accent)", fontWeight: 650, textTransform: "none", letterSpacing: 0 }}>
                + New
              </Link>
            </div>
            {agents.map((ag) => (
              <button key={ag.id} className={"rrow" + (ag.alias === selAlias ? " sel" : "")} data-alias={ag.alias} onClick={() => select(ag.alias)}>
                <Avatar alias={ag.alias} kind={ag.kind} ghLogin={ag.github_login} />
                <span className="grow">
                  <span className="nm">{ag.alias}</span>
                  <span className="rl">{ag.role}</span>
                </span>
                <EmbodBadge a={ag} />
                <Glyph cls={statusClass(ag.status)} />
              </button>
            ))}
          </aside>
          <main>
            {/* conversation (S1) mounts OUTSIDE the detail so the poll never wipes the composer */}
            <div id="convWrap">{a && a.kind !== "human" ? <Conversation key={a.id} agent={a} /> : null}</div>
            <div id="detailMain">{detail}</div>
            <div id="runsWrap">{a ? <RunsFeed agent={a} /> : null}</div>
          </main>
        </div>
      )}
    </Shell>
  );
}
