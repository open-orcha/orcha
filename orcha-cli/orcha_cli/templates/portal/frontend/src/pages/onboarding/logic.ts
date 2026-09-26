/**
 * Pure, DOM-free onboarding logic — a faithful port of static/onboarding.js:
 * the persisted local flow state (SAME localStorage key, so a draft started in
 * the classic page resumes in the React page and vice versa), the step-machine
 * transitions (resume / #140 ghost reconcile / dev demo flag), the #293 SSE
 * propose lane (SPEC-292 frame parsing + roster normalization), and the
 * roster→commit walk mapping. The backend is UNCHANGED — every endpoint,
 * method, and body here is copied from onboarding.js.
 */
import { sendJSON } from "../../api/client";
import { trunc } from "../../lib/format";

/* ---- O3: concierge first-agent system prompt (v1 SEED, verbatim) --------- */
export const CONCIERGE_TEMPLATE = `You are the concierge agent — the first agent in a brand-new, empty Orcha workspace.

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

/* ---- persisted LOCAL flow state (wizard step + in-progress drafts) ------- */
export interface QueuedTask { title: string; dod: string }
export interface AgentDraft {
  alias: string;
  role: string;
  prompt: string;
  model: string | null;
  _firstMode: "pick" | "describe" | "none";
  _pickId: string | null;
  _desc: string;
  _taskTitle?: string | null;
}
export interface DialogueTurn { role: string; content: string }
export interface ProposeState { goal: string; dialogue: DialogueTurn[]; demo?: boolean }
export interface RosterAgent { name: string; role: string; charter: string; model: string | null }
export interface RosterTask {
  title: string;
  definition_of_done: string;
  assignee: string | null;
  depends_on: string[];
  protocol: unknown | null;
  is_kickoff: boolean;
}
export interface Roster { rationale: string; agents: RosterAgent[]; tasks: RosterTask[] }
export interface WalkAgent {
  name: string;
  role: string;
  charter: string;
  model: string | null;
  kickoff: { title: string; dod: string } | null;
}
export interface Walk { idx: number; rationale: string; agents: WalkAgent[]; standalone: QueuedTask[] }
export interface OnbState {
  step: string;
  tasks: QueuedTask[];
  lastAgentAlias: string | null;
  _agentDraft: AgentDraft | null;
  _propose?: ProposeState;
  _roster?: Roster | null;
  _walk?: Walk | null;
}

export const KEY = "orcha:onboarding";

export function loadState(): OnbState {
  let s: Partial<OnbState>;
  try { s = (JSON.parse(localStorage.getItem(KEY) || "null") as Partial<OnbState>) || {}; } catch { s = {}; }
  return Object.assign({ step: "welcome", tasks: [], lastAgentAlias: null, _agentDraft: null }, s) as OnbState;
}
export function saveState(s: OnbState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

/* ---- PURE step-machine transition logic ---------------------------------- */
export function railKeyFor(step: string): string {
  if (step === "welcome") return "welcome";
  if (step === "fork") return "fork";
  // the AI propose lane (Path G) and the manual create steps all live under "Create" (step 3).
  if (step === "propose-goal" || step === "propose-stream" || step === "propose-roster") return "build";
  if (step === "create-agent" || step === "create-tasks" || step === "agent-created") return "build";
  return "build";
}

// Where the flow resumes given who already exists. If a human is registered we
// never re-show welcome (don't double-register) — jump straight to the fork.
export function resumeStep(persistedStep: string | null | undefined, hasOperator: boolean): string {
  if (persistedStep === "welcome" && hasOperator) return "fork";
  if (!hasOperator && persistedStep !== "welcome") return "welcome";
  // a live SSE stream can't survive a reload — resume the goal step so it re-asks
  // (the proposal isn't persisted until the editable roster lands in propose-roster).
  if (persistedStep === "propose-stream") return "propose-goal";
  return persistedStep || "welcome";
}

// GHOST RECONCILE (#140 frontend half). Persisted local flow state can reference an
// agent that the live server snapshot no longer has (workspace reset / retirement);
// the no-store infra half (#195) stopped the HTML/HTTP cache — this stops the SPA
// from re-rendering the dead agent as a "ghost" on a soft refresh.
export function reconcileGhost(
  persisted: { step: string; lastAgentAlias: string | null },
  liveAgentAliases: string[],
): { step: string; lastAgentAlias: string | null } {
  const next = { step: persisted.step, lastAgentAlias: persisted.lastAgentAlias };
  const alias = next.lastAgentAlias;
  if (alias && (liveAgentAliases || []).indexOf(alias) === -1) {
    // the agent the success screen celebrates is gone from server truth → drop it
    next.lastAgentAlias = null;
    if (next.step === "agent-created") next.step = "fork";
  }
  return next;
}

// Keep the DEV-ONLY demo flag in lockstep with the CURRENT url, reconciled every boot.
// Without the else-clear, a single `?demo=1` visit would persist `demo:true` and every
// later plain /onboarding would route startPropose through the synthetic stub.
export function reconcileDemoFlag(state: OnbState, hasDemo: boolean): ProposeState | undefined {
  if (hasDemo) state._propose = Object.assign({ goal: "", dialogue: [] }, state._propose, { demo: true });
  else if (state._propose && state._propose.demo) delete state._propose.demo;
  return state._propose;
}

export const RAIL = [
  { key: "welcome", n: "1", label: "Name yourself" },
  { key: "fork", n: "2", label: "Choose a path" },
  { key: "build", n: "3", label: "Create" },
] as const;

/* ====================================================================== */
/*  #293 — AI roster-proposal lane (Path G): SSE parse + binding helpers.   */
/*  Consumes the FROZEN SPEC-292 contract (POST /api/onboarding/propose):   */
/*  `data:<json>` SSE frames; event ∈ thinking|clarify|roster|error|done.   */
/* ====================================================================== */
export const PROPOSE_URL = "/api/onboarding/propose";

export interface ClarifyQuestion { id?: string; prompt?: string }
export interface ProposeError { code?: string; message?: string }
export interface SSEFrame {
  event?: string;
  delta?: string;
  questions?: ClarifyQuestion[];
  code?: string;
  message?: string;
  rationale?: string;
  agents?: unknown;
  tasks?: unknown;
}
export interface ProposeHandlers {
  onThinking: (delta: string) => void;
  onClarify: (questions: ClarifyQuestion[]) => void;
  onRoster: (payload: SSEFrame) => void;
  onError: (err: ProposeError) => void;
}

// Incrementally parse a growing SSE text buffer into complete data frames.
// Frames separated by a blank line; ':' lines are comment/heartbeat keepalives
// (ignored); 'data:' lines carry the JSON payload. A malformed frame is skipped
// (never kills the live stream). Returns {frames, rest}.
export function parseSSE(bufferIn: string): { frames: SSEFrame[]; rest: string } {
  let buffer = bufferIn;
  const frames: SSEFrame[] = [];
  let nl: number;
  while ((nl = buffer.indexOf("\n\n")) !== -1) {
    const block = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 2);
    const data: string[] = [];
    block.split("\n").forEach((line) => {
      if (!line || line.charAt(0) === ":") return; // blank or heartbeat comment
      const m = /^data:\s?(.*)$/.exec(line);
      if (m) data.push(m[1]);
    });
    if (!data.length) continue;
    try { frames.push(JSON.parse(data.join("\n")) as SSEFrame); } catch { /* skip malformed */ }
  }
  return { frames, rest: buffer };
}

// Normalize a propose_roster payload (SPEC-292 §3) into a TOTAL, UI-safe shape.
// Fail-open: drop invalid references instead of throwing. Enforces the §3 binding
// constraints the UI relies on:
//   · dangling assignee (not a roster name) → unassigned
//   · depends_on keeps only EARLIER titles (no forward refs / cycles)
//   · at most ONE kickoff per assignee
export function normalizeRoster(payload: unknown, defaultModel: string | null): Roster {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const r = (payload || {}) as any;
  const agents: RosterAgent[] = (Array.isArray(r.agents) ? r.agents : []).map((a: any) => ({
    name: String((a && a.name) || "").trim(),
    role: String((a && a.role) || "").trim(),
    charter: String((a && a.charter) || "").trim(),
    model: (a && a.model_hint) || defaultModel || null,
  })).filter((a: RosterAgent) => a.name);
  const names: Record<string, boolean> = {};
  agents.forEach((a) => { names[a.name] = true; });
  const seenTitles: string[] = [];
  const haveKickoff: Record<string, boolean> = {};
  const tasks: RosterTask[] = (Array.isArray(r.tasks) ? r.tasks : []).map((t: any) => {
    const title = String((t && t.title) || "").trim();
    let assignee: string | null = (t && t.assignee) || null;
    if (assignee && !names[assignee]) assignee = null; // drop dangling ref
    const deps: string[] = (Array.isArray(t && t.depends_on) ? t.depends_on : [])
      .filter((d: string) => seenTitles.indexOf(d) !== -1); // earlier titles only
    let kickoff = !!(t && t.is_kickoff);
    if (kickoff && assignee) { // a kickoff is an agent's FIRST task → needs an assignee
      if (haveKickoff[assignee]) kickoff = false; else haveKickoff[assignee] = true;
    } else kickoff = false; // unassigned (or dangling) → never a kickoff
    seenTitles.push(title);
    return {
      title,
      definition_of_done: String((t && t.definition_of_done) || "").trim(),
      assignee, depends_on: deps,
      protocol: (t && t.protocol) || null, is_kickoff: kickoff,
    };
  }).filter((t: RosterTask) => t.title);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { rationale: String(r.rationale || "").trim(), agents, tasks };
}

// Turn the (operator-edited) roster into a COMMIT WALK: one create-agent pass per
// agent, the agent's kickoff task → its initial_task; every non-kickoff task →
// a standalone ready task committed through the EXISTING POST loop (SPEC-292 §4
// reuse mandate — zero new commit route).
export function rosterToWalk(roster: Roster): Walk {
  const agents: WalkAgent[] = (roster.agents || []).map((a) => {
    const kt = (roster.tasks || []).find((t) => t.is_kickoff && t.assignee === a.name) || null;
    return {
      name: a.name, role: a.role, charter: a.charter, model: a.model,
      kickoff: kt ? { title: kt.title, dod: kt.definition_of_done } : null,
    };
  });
  const standalone: QueuedTask[] = (roster.tasks || [])
    .filter((t) => !(t.is_kickoff && t.assignee)) // kickoffs become initial_task; rest standalone
    .map((t) => ({ title: t.title, dod: t.definition_of_done }));
  return { idx: 0, rationale: roster.rationale || "", agents, standalone };
}

// Map ONE walk agent onto the existing create-agent draft so the proposal commits
// through the UNCHANGED submitAgent POST. Kickoff → describe mode, preserving the
// proposed title (submitAgent honors draft._taskTitle).
export function walkAgentToDraft(agent: WalkAgent, defaultModel: string | null): AgentDraft {
  return {
    alias: agent.name, role: agent.role, prompt: agent.charter,
    model: agent.model || defaultModel || null,
    _firstMode: agent.kickoff ? "describe" : "none",
    _pickId: null,
    _desc: agent.kickoff ? agent.kickoff.dod : "",
    _taskTitle: agent.kickoff ? agent.kickoff.title : null,
  };
}

/* ---- error copy (verbatim) ------------------------------------------------ */
export const ERR_COPY: Record<string, string> = {
  no_api_key: "No model API key is configured for this workspace yet. Add one in Settings, or set the team up by hand.",
  model_error: "The model couldn't be reached just now. Retry, or set the team up by hand.",
  invalid_goal: "I couldn't work with that goal — try describing the project a little more concretely.",
  rate_limited: "The model is rate-limited right now. Give it a moment and retry, or set up by hand.",
  roster_truncated: "The roster was too large to finish. Narrow the first team in your goal, then try again, or set it up by hand.",
};

/* ---- HTTP: vanilla postJSON semantics over the shared sendJSON ------------ */
// onboarding.js postJSON never throws — it returns {ok, status, body} so every
// caller can toast the vanilla copy ("Create failed (404)") verbatim.
export async function postJSON<T = unknown>(url: string, body: unknown): Promise<{ ok: boolean; status: number; body: T | null }> {
  try {
    const res = await sendJSON<T>("POST", url, body);
    return { ok: true, status: 200, body: res };
  } catch (e) {
    return { ok: false, status: (e as { status?: number }).status ?? 0, body: null };
  }
}

/* ---- the propose stream (fetch + ReadableStream; POST+SSE contract) ------- */
// Fails OPEN: any transport/HTTP failure (incl. a 404 because #292 isn't deployed)
// surfaces as an honest `error` turn that keeps the manual lanes usable. Returns
// an abort() the step calls on navigation. demo=true swaps in a client-side stub.
export function startPropose(
  body: { cid: string | null; goal: string; dialogue: DialogueTurn[] },
  h: ProposeHandlers,
  opts?: { demo?: boolean; defaultModel?: string | null },
): () => void {
  if (opts && opts.demo) return demoPropose(body, h, opts.defaultModel ?? null);
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let stopped = false;
  (async function pump() {
    let resp: Response;
    try {
      resp = await fetch(PROPOSE_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined,
      });
    } catch {
      if (!stopped) h.onError({ code: "model_error", message: "Couldn't reach the server. Check the workspace is running, then retry." });
      return;
    }
    if (!resp.ok || !resp.body || !resp.body.getReader) {
      if (!stopped) h.onError({
        code: "model_error",
        message: "The AI propose endpoint isn't available (" + resp.status + "). The #292 backend may not be deployed yet — you can set up by hand.",
      });
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!stopped) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try { r = await reader.read(); } catch { break; }
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const parsed = parseSSE(buf);
      buf = parsed.rest;
      for (let i = 0; i < parsed.frames.length; i++) {
        if (stopped) return;
        const f = parsed.frames[i];
        if (f.event === "thinking") h.onThinking(f.delta || "");
        else if (f.event === "clarify") h.onClarify(f.questions || []);
        else if (f.event === "roster") { h.onRoster(f); return; }
        else if (f.event === "error") { h.onError(f); return; }
        else if (f.event === "done") return;
      }
    }
  })();
  return function abort() { stopped = true; if (ctrl) try { ctrl.abort(); } catch { /* already aborted */ } };
}

// DEV-ONLY (?demo=1): synthesize a stream so the whole lane is exercisable before
// the #292 backend lands. Never the default path — gated on S._propose.demo.
function demoPropose(
  body: { goal: string },
  h: ProposeHandlers,
  defaultModel: string | null,
): () => void {
  let stopped = false;
  const goal = body.goal || "your project";
  const deltas = ["Reading your goal…\n", "Sketching the smallest team that can own it…\n",
    "A concierge to plan + delegate, plus a builder to execute…\n", "Writing first tasks with clear definitions of done…\n"];
  let i = 0;
  const tick = () => {
    if (stopped) return;
    if (i < deltas.length) { h.onThinking(deltas[i++]); setTimeout(tick, 260); return; }
    h.onRoster({
      event: "roster",
      rationale: "A concierge to plan and delegate, plus one builder to execute the first slice — the smallest team that can move “" + trunc(goal, 60) + "” forward.",
      agents: [
        { name: "Atlas", role: "Concierge · planning & orchestration", charter: CONCIERGE_TEMPLATE, model_hint: defaultModel },
        { name: "Forge", role: "Builder · implementation", charter: "You are a builder agent. Take a task with a clear definition of done, implement it, and stop at needs_verification for the operator to verify. Cooperate with teammates via /orcha-ask; never self-certify.", model_hint: defaultModel },
      ],
      tasks: [
        { title: "Map the current onboarding flow", definition_of_done: "A written breakdown of every first-run step and where users drop off, approved by the operator.", assignee: "Atlas", depends_on: [], protocol: null, is_kickoff: true },
        { title: "Ship the highest-impact fix", definition_of_done: "The top drop-off point from the map is fixed and verified in the running app.", assignee: "Forge", depends_on: ["Map the current onboarding flow"], protocol: null, is_kickoff: true },
      ],
    });
  };
  setTimeout(tick, 200);
  return function abort() { stopped = true; };
}
