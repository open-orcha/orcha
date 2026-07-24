/* Onboarding flow module: operator/agent snapshot access and pure step-machine helpers. */
const O = window.Orcha;
const OnbIcon = O.icon, OnbEsc = O.esc, OnbAvatar = O.avatar;

/* ---- O3: concierge first-agent system prompt ------------------------- *
 * v1 SEED. The canonical concierge wording is Tim/docs-owned; this is a
 * reasonable starting draft and stays fully editable in the textarea.    */
const CONCIERGE_TEMPLATE =
`You are the concierge agent — the first agent in a brand-new, empty Orcha workspace.

Your job is to help the operator (the human authority) figure out what this workspace
needs, then help them staff it. Concretely:

1. Brainstorm with the operator about what they're building and the work it implies.
 Ask sharp, clarifying questions. Surface trade-offs. Keep it concise.
2. Break the goal into tasks with clear, verifiable definitions of done.
3. When the workspace needs more agents, SUGGEST them via the /orcha-suggest-agent
 skill — propose the role, model, and a draft system prompt — and let the operator
 decide. You propose teammates; you do NOT create them yourself.
4. Cooperate with other agents through Orcha requests (/orcha-ask) rather than acting
 on their behalf.

You are human-authoritative. Never self-certify: your work stops at needs_verification
and waits for the operator to verify. Propose plans and wait for approval before acting.`;

/* ---- curated model fallback (GET /api/models is the source of truth) -- */
let MODELS = [];
let DEFAULT_MODEL = null;

/* ---- resolved-once container id -------------------------------------- */
let CID = null;

/* ---- persisted LOCAL flow state (wizard step + in-progress drafts).
   The server snapshot is the source of truth for operator/agents/tasks. -- */
const KEY = "orcha:onboarding";
let S;
try { S = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { S = {}; }
S = Object.assign({ step: "welcome", tasks: [], lastAgentAlias: null, _agentDraft: null }, S);
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

/* ---- live snapshot accessors (server = source of truth) -------------- */
function snapAgents() { return (O.agents && O.agents()) || []; }
function operator() { return snapAgents().find((a) => a.kind === "human") || null; }
function aiAgents() { return snapAgents().filter((a) => a.kind !== "human"); }
function isFirstAgent() { return aiAgents().length === 0; }   // "first agent" = zero AI agents
function readyTasks() {
  return ((O.tasks && O.tasks()) || []).filter((t) => t.status === "ready" && !(t.assignees || []).length);
}

/* ---- PURE step-machine transition logic (exported for node tests) ----- *
 * Keeping these pure + DOM-free makes the wizard's branching unit-testable. */
function railKeyFor(step) {
  if (step === "welcome") return "welcome";
  if (step === "fork") return "fork";
  // the AI propose lane (Path G) and the manual create steps all live under "Create" (step 3).
  if (step === "propose-goal" || step === "propose-stream" || step === "propose-roster") return "build";
  if (step === "create-agent" || step === "create-tasks" || step === "agent-created") return "build";
  return "build";
}
// Where the flow resumes given who already exists. If a human is registered we
// never re-show welcome (don't double-register) — jump straight to the fork.
function resumeStep(persistedStep, hasOperator) {
  if (persistedStep === "welcome" && hasOperator) return "fork";
  if (!hasOperator && persistedStep !== "welcome") return "welcome";
  // a live SSE stream can't survive a reload — resume the goal step so it re-asks
  // (the proposal isn't persisted until the editable roster lands in propose-roster).
  if (persistedStep === "propose-stream") return "propose-goal";
  return persistedStep || "welcome";
}
// GHOST RECONCILE (#140 frontend half). Persisted local flow state can reference an
// agent that the live server snapshot no longer has — a workspace reset
// (`orcha down -v && orcha init --force`, or `orcha init --force --reset-data`) or an
// agent retirement wipes the DB while localStorage still holds the old "agent-created"
// screen + lastAgentAlias. The no-store infra half (#195/PR) stopped the HTML/HTTP cache;
// this stops the SPA from re-rendering the dead agent as a "ghost" on a soft refresh.
// Pure + DOM-free so it's unit-testable: returns the reconciled {step,lastAgentAlias}.
function reconcileGhost(persisted, liveAgentAliases) {
  const next = Object.assign({}, persisted);
  const alias = next.lastAgentAlias;
  if (alias && (liveAgentAliases || []).indexOf(alias) === -1) {
    // the agent the success screen celebrates is gone from server truth → drop it
    next.lastAgentAlias = null;
    if (next.step === "agent-created") next.step = "fork";
  }
  return next;
}
// Keep the DEV-ONLY demo flag in lockstep with the CURRENT url, reconciled every boot.
// Without the else-clear, a single `?demo=1` visit persists `demo:true` into localStorage
// and every later plain `/onboarding` would route startPropose through the synthetic stub
// instead of the real `/api/onboarding/propose` — i.e. demo would become sticky/default.
function reconcileDemoFlag(state, hasDemo) {
  if (hasDemo) state._propose = Object.assign({ goal: "", dialogue: [] }, state._propose, { demo: true });
  else if (state._propose && state._propose.demo) delete state._propose.demo;
  return state._propose;
}
const RAIL = [
  { key: "welcome", n: "1", label: "Name yourself" },
  { key: "fork",    n: "2", label: "Choose a path" },
  { key: "build",   n: "3", label: "Create" },
];
