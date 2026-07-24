/* Onboarding flow module: SSE parsing and roster normalization helpers. */
/* ====================================================================== */
/*  #293 — AI roster-proposal lane (Path G). Pure, DOM-free helpers FIRST   */
/*  so the SSE parse + proposal→form binding stay unit-testable in node.    */
/*  Consumes the FROZEN SPEC-292 contract (POST /api/onboarding/propose):   */
/*  `data:<json>` SSE frames; event ∈ thinking|clarify|roster|error|done.   */
/*  #292 backend isn't built yet → the stream fails OPEN to the manual lane  */
/*  (and ?demo=1 synthesizes a roster client-side for review before then).  */
/* ====================================================================== */
const PROPOSE_URL = "/api/onboarding/propose";
let _proposeAbort = null;   // aborts the live SSE pump on any navigation (see go())

// Incrementally parse a growing SSE text buffer into complete data frames.
// House format (main.py:6146/:6168): frames separated by a blank line; ':' lines are
// comment/heartbeat keepalives (ignored); 'data:' lines carry the JSON payload. A
// malformed frame is skipped (never kills the live stream). Returns {frames, rest}.
function parseSSE(buffer) {
  const frames = [];
  let nl;
  while ((nl = buffer.indexOf("\n\n")) !== -1) {
    const block = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 2);
    const data = [];
    block.split("\n").forEach((line) => {
      if (!line || line.charAt(0) === ":") return;          // blank or heartbeat comment
      const m = /^data:\s?(.*)$/.exec(line);
      if (m) data.push(m[1]);
    });
    if (!data.length) continue;
    try { frames.push(JSON.parse(data.join("\n"))); } catch (e) { /* skip malformed */ }
  }
  return { frames: frames, rest: buffer };
}

// Normalize a propose_roster payload (SPEC-292 §3) into a TOTAL, UI-safe shape.
// Fail-open: drop invalid references instead of throwing — a partial roster still
// beats a dead screen. Enforces the §3 binding constraints the UI relies on:
//   · dangling assignee (not a roster name) → unassigned
//   · depends_on keeps only EARLIER titles (no forward refs / cycles)
//   · at most ONE kickoff per assignee
function normalizeRoster(payload, defaultModel) {
  const r = payload || {};
  const agents = (Array.isArray(r.agents) ? r.agents : []).map((a) => ({
    name: String((a && a.name) || "").trim(),
    role: String((a && a.role) || "").trim(),
    charter: String((a && a.charter) || "").trim(),
    model: (a && a.model_hint) || defaultModel || null,
  })).filter((a) => a.name);
  const names = {}; agents.forEach((a) => { names[a.name] = true; });
  const seenTitles = [];
  const haveKickoff = {};
  const tasks = (Array.isArray(r.tasks) ? r.tasks : []).map((t) => {
    const title = String((t && t.title) || "").trim();
    let assignee = (t && t.assignee) || null;
    if (assignee && !names[assignee]) assignee = null;                  // drop dangling ref
    const deps = (Array.isArray(t && t.depends_on) ? t.depends_on : [])
      .filter((d) => seenTitles.indexOf(d) !== -1);                     // earlier titles only
    let kickoff = !!(t && t.is_kickoff);
    if (kickoff && assignee) {                        // a kickoff is an agent's FIRST task → needs an assignee
      if (haveKickoff[assignee]) kickoff = false; else haveKickoff[assignee] = true;
    } else kickoff = false;                            // unassigned (or dangling) → never a kickoff
    seenTitles.push(title);
    return {
      title: title,
      definition_of_done: String((t && t.definition_of_done) || "").trim(),
      assignee: assignee, depends_on: deps,
      protocol: (t && t.protocol) || null, is_kickoff: kickoff,
    };
  }).filter((t) => t.title);
  return { rationale: String(r.rationale || "").trim(), agents: agents, tasks: tasks };
}

// Turn the (operator-edited) roster into a COMMIT WALK: one create-agent pass per
// agent, the agent's kickoff task → its initial_task; every non-kickoff task →
// a standalone ready task committed through the EXISTING POST loop (SPEC-292 §4 reuse
// mandate — zero new commit route). Pure so the commit ORDER stays unit-testable.
function rosterToWalk(roster) {
  const agents = (roster.agents || []).map((a) => {
    const kt = (roster.tasks || []).find((t) => t.is_kickoff && t.assignee === a.name) || null;
    return { name: a.name, role: a.role, charter: a.charter, model: a.model,
      kickoff: kt ? { title: kt.title, dod: kt.definition_of_done } : null };
  });
  const standalone = (roster.tasks || [])
    .filter((t) => !(t.is_kickoff && t.assignee))     // kickoffs become initial_task; rest standalone
    .map((t) => ({ title: t.title, dod: t.definition_of_done }));
  return { idx: 0, rationale: roster.rationale || "", agents: agents, standalone: standalone };
}

// Map ONE walk agent onto the existing create-agent draft (S._agentDraft) so the
// proposal commits through the UNCHANGED submitAgent POST. Kickoff → describe mode,
// preserving the proposed title (submitAgent honors draft._taskTitle).
function walkAgentToDraft(agent, defaultModel) {
  return {
    alias: agent.name, role: agent.role, prompt: agent.charter,
    model: agent.model || defaultModel || null,
    _firstMode: agent.kickoff ? "describe" : "none",
    _pickId: null,
    _desc: agent.kickoff ? agent.kickoff.dod : "",
    _taskTitle: agent.kickoff ? agent.kickoff.title : null,
  };
}
