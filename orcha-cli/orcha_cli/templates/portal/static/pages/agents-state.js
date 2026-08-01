/* Agents page controller: roster state, model options, request/task helpers, and roster rendering. */
const AgeO = window.Orcha;
const Age$ = (id) => document.getElementById(id);
const AgeD = () => window.ORCHA;

// selection (deeplinkable via ?agent=) + per-agent async caches (persona/digest/runs
// are NOT in the snapshot — fetched lazily on select, keyed by agent id).
const _dlAgent = new URLSearchParams(location.search).get("agent");
let sel = _dlAgent || null;
// ISS-38: a deeplink (?agent=) / explicit select must scroll the roster to the picked
// row, else on a long roster you land on the detail with the selection invisibly
// off-screen. One-shot — cleared after the next roster paint so the 3s tick never yanks scroll.
let pendingScroll = !!_dlAgent;
// ISS-68 PR-3: agent-detail section caps — tasks 10, incoming/outgoing requests 5 each — with a
// per-section "Load more". Client-side reveal over the snapshot-filtered rows; reset on agent switch.
const TASKS_CAP = 10, REQ_CAP = 5, DIGEST_CAP = 6;
let tasksShown = TASKS_CAP, riShown = REQ_CAP, roShown = REQ_CAP;
let digestShown = DIGEST_CAP;   // ISS-68-style render cap over the digest's decisions/learnings/threads
const personaFull = {};   // id -> full system_prompt (lazy, on Expand)
const personaOpen = {};   // id -> bool (expanded?)
const digestCache = {};   // id -> {digest} | {loading}
let stopRuns = null;      // teardown for the live runs streams
let runsAgent = null;     // which agent the runsWrap currently shows
let runsSig = "";         // signature of the rendered run set (rebuild only on change)
let runsToken = 0;        // guards against stale async runs responses across selects

// ISS-63: the Current-task / Incoming / Outgoing widgets push the worker-progress feed far
// down the page. Let the human COLLAPSE them; remember the choice across reloads (localStorage,
// shared by all agents — a layout preference, not per-agent state).
const COLLAPSE_KEY = "orcha:agentWidgetCollapse";
let collapsed = {};
try { collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}") || {}; } catch (e) { collapsed = {}; }
function isCollapsed(k) { return !!collapsed[k]; }
function toggleCollapse(k) {
  collapsed[k] = !collapsed[k];
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch (e) {}
  renderDetailMain();
}
// a chevron toggle for a collapsible card header (delegated click via #detailMain).
function collapseBtn(k) {
  return `<button class="collapse-btn" data-collapse="${AgeO.esc(k)}" title="${isCollapsed(k) ? "Expand" : "Collapse"}" aria-label="toggle">${AgeO.icon("chev", "")}</button>`;
}

// The model control sends the curated MODEL ID (POST /model only accepts ids) while
// displaying the friendly name. Seeded with the backend's curated list so the control
// renders correctly pre-fetch; GET /api/models is the source of truth (picks up new ids).
let MODELS = [
  { id: "claude-opus-5", name: "Opus 5", runtime: "claude" },
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
fetch("/api/models").then((r) => r.ok ? r.json() : null)
  .then((d) => { if (d && Array.isArray(d.models) && d.models.length) { MODELS = d.models; renderDetailMain(); } })
  .catch(() => {});

let REASONING_EFFORTS = [
  { id: null, name: "Default" },
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra-high" },
];
fetch("/api/reasoning-efforts").then((r) => r.ok ? r.json() : null)
  .then((d) => {
    if (d && Array.isArray(d.efforts) && d.efforts.length) {
      REASONING_EFFORTS = [{ id: null, name: "Default" }].concat(d.efforts);
      renderDetailMain();
    }
  }).catch(() => {});

const MODEL_RUNTIMES = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
];
const modelRuntimeFilters = {};
function modelRuntimeOf(modelId) {
  const m = MODELS.find((x) => x.id === modelId);
  if (m && m.runtime) return String(m.runtime).toLowerCase() === "codex" ? "codex" : "claude";
  return String(modelId || "").startsWith("gpt-") ? "codex" : "claude";
}
function modelRuntimeName(runtime) {
  return runtime === "codex" ? "Codex" : "Claude";
}
function modelsForRuntime(runtime) {
  const wanted = runtime === "codex" ? "codex" : "claude";
  return MODELS.filter((m) => modelRuntimeOf(m.id) === wanted);
}
function modelRuntimeForAgent(a) {
  const saved = modelRuntimeFilters[a.id];
  if (saved && modelsForRuntime(saved).length) return saved;
  return modelRuntimeOf(a.model);
}

/* ---------- snapshot-derived helpers ---------- */
function agentTasks(alias) { return AgeO.tasks().filter((t) => (t.assignees || []).indexOf(alias) >= 0); }
function planMsgOf(t) {  // ISS-68: prefer the snapshot's plan_message (thread-free); fall back to an expanded thread
  if (t && t.plan_message) return { body: t.plan_message.body, from: t.plan_message.author_alias || null, at: t.plan_message.at, is_human: false };
  const m = (t.thread || []).filter((x) => !x.is_human); return m.length ? m[0] : null;
}
function reqIn(alias) { return AgeO.requests().filter((r) => r.to === alias); }
function reqOut(alias) { return AgeO.requests().filter((r) => r.from === alias); }
// ISS-331: the shared sort control drives all three agent-detail lists (current tasks, incoming,
// outgoing). Accessors mirror the Tasks/Requests pages: status rank is the OUTER key, the chosen
// key (time|priority) sorts within it. Each list persists its own choice under a distinct name.
const TASK_RANK = { needs_verification: 0, in_progress: 1, ready: 2, pending: 4, blocked: 3, failed: 3, completed: 5, cancelled: 6 };
function taskSortAcc() { return { bucket: (t) => (TASK_RANK[t.status] ?? 9), time: (t) => Date.parse(t.created_at || "") || 0, prio: (t) => t.priority }; }
const REQ_RANK = { open: 0, answered: 1 };
function reqSortAcc() { return { bucket: (r) => (REQ_RANK[r.status] ?? 2), time: (r) => Date.parse(r.created_at || "") || 0, prio: (r) => r.priority }; }
function firstAlias() {
  const ai = AgeO.agents().find((a) => a.kind !== "human");
  return (ai || AgeO.agents()[0] || {}).alias || null;
}
// ISS-68 PR-3: per-section "Load more" affordance (rendered only when more rows exist than shown).
function moreBtn(kind, shown, total) {
  return total > shown ? `<button class="btn sm ghost" style="align-self:flex-start;margin-top:4px" data-more="${kind}">Load more · ${shown} of ${total}</button>` : "";
}

/* ---------- roster ---------- */
function renderRoster() {
  const ags = AgeO.agents();
  // ISS-71 caveat (Forge): an agent with a backgrounded live terminal holds its single-flight
  // lease (can't be woken, no other terminal) until closed — surface it so it isn't invisible.
  const liveSet = (window.OrchaTerm ? OrchaTerm.liveAgentIds() : []);
  AgeO.patch(Age$("roster"), `<div class="rh">${AgeO.icon("agents", "")}Roster · ${ags.length}<span style="flex:1"></span><a href="/onboarding?new=1" style="color:var(--accent);font-weight:650;text-transform:none;letter-spacing:0">+ New</a></div>` +
    ags.map((a) => `<button class="rrow ${a.alias === sel ? "sel" : ""}" data-alias="${AgeO.esc(a.alias)}">
      ${AgeO.avatar(a.alias, a.kind, "")}
      <span class="grow"><span class="nm">${AgeO.esc(a.alias)}</span><span class="rl">${AgeO.esc(a.role)}</span></span>
      ${ovrBadge(a)}
      ${embodBadge(a, liveSet)}
      ${AgeO.glyph(AgeO.statusClass(a.status))}
    </button>`).join(""));
  if (pendingScroll) {   // ISS-38: anchor the deeplinked/selected row (one-shot)
    pendingScroll = false;
    const row = Age$("roster").querySelector(".rrow.sel");
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }
}
// ISS-69(a): surface the agent's single-embodiment lease in the roster. A live terminal held in
// THIS browser is the strongest signal ("live"); otherwise fall back to the read payload's
// `embodiment` so a resident conversation / ephemeral task held anywhere is still legible. idle → none.
const EMBOD_LBL = { live: "live", resident: "in convo", ephemeral: "task" };
const EMBOD_TITLE = {
  live: "In a live terminal — busy and can't be woken until the terminal closes",
  resident: "In a live conversation — busy until the conversation yields or ends",
  ephemeral: "Running a task — busy until the task completes",
};
function embodBadge(a, liveSet) {
  const kind = (liveSet.indexOf(a.id) >= 0) ? "live" : AgeO.leaseOf(a);
  if (!kind || kind === "idle") return "";
  return `<span class="rlive ${kind}" title="${AgeO.esc(EMBOD_TITLE[kind] || "")}"><span class="d"></span>${EMBOD_LBL[kind] || kind}</span>`;
}
// mig 034: surface an active per-agent autonomy override in the roster so a differently-leveled
// agent is never invisible. While the container ENFORCES its level the override is ignored
// server-side — render the badge with a lock glyph (and say so) rather than hiding it, so the
// human still sees the parked override that will resume when enforcement lifts.
function ovrBadge(a) {
  if (a.kind === "human" || !a.autonomy_override) return "";
  const c = (AgeD() && AgeD().container) || {};
  const enforced = !!c.autonomy_enforced;
  const title = enforced
    ? "Override '" + a.autonomy_override + "' is IGNORED — the container enforces '" + (c.autonomy_level || "plan") + "' for all agents"
    : "Per-agent autonomy override: acts at '" + a.autonomy_override + "' (container is '" + (c.autonomy_level || "plan") + "')";
  return `<span class="rovr${enforced ? " enforced" : ""}" title="${AgeO.esc(title)}">${enforced ? "🔒 " : ""}${AgeO.esc(a.autonomy_override)}</span>`;
}
