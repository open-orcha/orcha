/* ============================================================================
   Orcha — O1+O2+O3 first-run onboarding (served at /onboarding).
   A guided state machine on the dashboard shell:
     welcome → fork → create-agent | create-tasks → agent-created
   O1: operator (human) shell — register the human via POST .../agents kind:human.
   O2: create-agent form — POST .../agents kind:ai + prompt (+ optional initial_task),
       model from GET /api/models.
   O3: concierge template for the FIRST agent (CONCIERGE_TEMPLATE, editable).
   O4 is HELD — the assign/wake step is a "coming soon" stub (needs the B5 assign endpoint).

   Unlike the localStorage MOCKUP this was lifted from, this WIRES TO THE REAL API:
   the container id is resolved once on boot (OrchaData.resolveCid), the operator and
   agents are POSTed to the live FastAPI, and the snapshot decides what already exists
   (skip welcome if a human is registered; "first agent" = zero AI agents in the snapshot).
   Local state (the wizard step + in-progress task drafts) persists in localStorage so a
   refresh resumes; the SOURCE OF TRUTH for agents/humans/tasks is the server snapshot.
   ========================================================================== */
(function () {
  const O = window.Orcha;
  const icon = O.icon, esc = O.esc, avatar = O.avatar;

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

  /* ====================================================================== */
  /*  HTTP                                                                    */
  /* ====================================================================== */
  async function postJSON(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, body: j };
  }

  /* ====================================================================== */
  /*  SHELL                                                                  */
  /* ====================================================================== */
  function renderShell() {
    // Reuse the canonical D0 shell so the sidebar/topbar match every other page.
    O.mountShell("home", { title: "Set up your workspace", ctx: "First-run onboarding" });
  }

  function guideRail() {
    const curKey = railKeyFor(S.step);
    const idx = RAIL.findIndex((r) => r.key === curKey);
    return `<div class="guide-rail">
      <div class="steps">
        ${RAIL.map((r, i) => `${i ? '<span class="sep"></span>' : ""}
          <span class="st ${i < idx ? "done" : i === idx ? "cur" : ""}">
            <span class="n">${i < idx ? icon("check", "") : r.n}</span>${esc(r.label)}</span>`).join("")}
      </div>
      <a class="skip" href="/">Skip to dashboard ${icon("arrow", "")}</a>
    </div>`;
  }

  /* ====================================================================== */
  /*  RENDER                                                                 */
  /* ====================================================================== */
  function render() {
    renderShell();
    const c = document.getElementById("content");
    if (!c) return;
    const showRail = S.step !== "welcome";
    c.innerHTML = (showRail ? guideRail() : "") + `<div id="obMain"></div>`;
    const main = document.getElementById("obMain");
    ({
      "welcome": stepWelcome, "fork": stepFork, "create-agent": stepCreateAgent,
      "agent-created": stepAgentCreated, "create-tasks": stepCreateTasks,
      "propose-goal": stepProposeGoal, "propose-stream": stepProposeStream,
      "propose-roster": stepProposeRoster,
    }[S.step] || stepWelcome)(main);
  }
  // scroll-to-top belongs to an explicit STEP CHANGE, not to render() itself — so a
  // refresh/re-render of the current step never jumps the page (covers all screens; bug 3).
  // Any live propose SSE stream is aborted on navigation so it never leaks past its step.
  function go(step) { if (_proposeAbort) { try { _proposeAbort(); } catch (e) {} _proposeAbort = null; } S.step = step; save(); render(); window.scrollTo({ top: 0 }); }
  // After a WRITE, pull a fresh snapshot BEFORE rendering the next snapshot-derived step —
  // we no longer rebuild every 3s, so a just-created human/agent/task must be refreshed in
  // explicitly or it won't appear until the user navigates away/back (review P2).
  async function refreshAnd(step) {
    try { await window.OrchaData.refresh(); } catch (e) {}
    go(step);
  }

  /* ---- 1 · WELCOME → register the operator (human) --------------------- */
  function stepWelcome(main) {
    main.innerHTML = `<div class="ob welcome">
      <div class="bigmark">${O.orcaSVG()}</div>
      <div class="eyebrow">Orcha · orchestration portal</div>
      <h1>Run a team of agents,<br>with you in command.</h1>
      <p class="lede">Orcha is a human-authoritative, multi-agent workspace. Agents do the work and stream it to you live — but nothing ships on their say-so. You approve plans, verify results, and unblock. Let's set up your workspace.</p>

      <div class="whatis">
        <div class="w"><div class="ic">${icon("person", "")}</div><h4>You hold authority</h4><p>Agents stop at <i>needs&nbsp;verification</i>. You approve, verify, and decide — always.</p></div>
        <div class="w"><div class="ic">${icon("live", "")}</div><h4>Episodic agents</h4><p>Each agent wakes as a fresh worker, rehydrates from memory, and streams its work.</p></div>
        <div class="w"><div class="ic">${icon("shield", "")}</div><h4>Async gates</h4><p>No frantic allow-prompts. Govern through deliberate approve / verify decisions.</p></div>
      </div>

      <div class="namecard">
        <div class="nh"><span class="badge">${icon("person", "")}</span><h3>Claim the human authority</h3></div>
        <p class="sub">What should we call you? This registers you as the operator — the standing human authority for everything that happens in this workspace.</p>
        <div class="nrow">
          <input class="ipt lg" id="opName" placeholder="Your name — e.g. Dario" autocomplete="off" spellcheck="false" maxlength="40">
          <button class="btn" id="opGo" style="padding:0 18px">${icon("arrow", "")}Enter</button>
        </div>
        <div class="auth-note">${icon("shield", "")}<span>You can hand specific tasks to AI agents later — authority stays with you.</span></div>
      </div>
    </div>`;

    const inp = document.getElementById("opName");
    const btn = document.getElementById("opGo");
    const submit = async () => {
      const v = (inp.value || "").trim();
      if (!v) { inp.focus(); inp.style.borderColor = "var(--danger-line)"; return; }
      if (!CID) { O.toast("No workspace found yet — try again in a moment.", "danger"); return; }
      // O1: don't double-register — if an operator already exists, skip straight to the fork.
      if (operator()) { O.toast("Operator already registered.", "ok"); go("fork"); return; }
      btn.disabled = true;
      const res = await postJSON("/api/containers/" + encodeURIComponent(CID) + "/agents",
        { alias: v, role: "Operator", kind: "human" });
      btn.disabled = false;
      if (!res.ok) { O.toast("Couldn't register you (" + res.status + ")", "danger"); return; }
      // adopt as the acting human so the rest of the portal knows who you are
      try { if (res.body && res.body.agent_id) O.setActingHuman(res.body.agent_id); } catch (e) {}
      O.toast("Welcome, " + v + " — you're the operator", "ok");
      await refreshAnd("fork");   // snapshot now has the operator (fork/resume reads it)
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    inp.addEventListener("input", () => { inp.style.borderColor = ""; });
    btn.addEventListener("click", submit);
    setTimeout(() => inp && inp.focus(), 60);
  }

  /* ---- 2 · THE FORK ---------------------------------------------------- */
  function stepFork(main) {
    const op = operator();
    main.innerHTML = `
      <div class="ob wide greet">
        <h1>Welcome${op ? `, <span class="nm">${esc(op.alias)}</span>` : ""}. Your workspace is empty — let's change that.</h1>
        <p>Two ways in. Both lead to the same place: a workspace with <b>agents</b> doing <b>tasks</b> under your authority. Pick whichever matches how you think.</p>
      </div>
      <div class="ob wide">
        <div class="gpath">
          <div class="gp-icon">${icon("spark", "")}</div>
          <div class="gp-body">
            <div class="step">Path G · Recommended</div>
            <h3>Help me set this up</h3>
            <p>Describe your project in a sentence. An AI proposes a starting roster — agents with system prompts and their first tasks — that you review, edit, and create. You stay in command; nothing exists until you approve it.</p>
          </div>
          <button class="btn" data-go="propose-goal">${icon("spark", "")}Propose my roster ${icon("arrow", "")}</button>
        </div>
        <div class="forkmanual"><span></span>or set it up by hand<span></span></div>
        <div class="fork">
          <div class="onramp agent">
            <div class="top"><span class="oic">${icon("agents", "")}</span><div><div class="step">Path A</div><h3>Create your first agent</h3></div></div>
            <p>Stand up an AI teammate — give it a role, a model, and a system prompt. Best first move: create a <b>concierge</b> agent and brainstorm the whole plan with it.</p>
            <span class="recommend">${icon("spark", "")}Recommended for a blank slate</span>
            <button class="btn" data-go="create-agent">${icon("plus", "")}Create an agent</button>
          </div>
          <div class="onramp task">
            <div class="top"><span class="oic">${icon("tasks", "")}</span><div><div class="step">Path B</div><h3>Add tasks first</h3></div></div>
            <p>Already know the work? Capture it as tasks — each with a clear definition of done — then create the agents to carry them out.</p>
            <span class="recommend" style="color:var(--violet);background:var(--violet-soft);border-color:var(--violet-line)">${icon("tasks", "")}Good if the plan is clear</span>
            <button class="btn subtle" data-go="create-tasks">${icon("plus", "")}Add tasks</button>
          </div>
        </div>
        <div class="merge">${icon("convert", "")}<span>Either way you'll end up with <b>agents&nbsp;+&nbsp;tasks</b>. Once an agent exists you give it work from its page.</span></div>
      </div>`;
    wireGo(main);
  }

  /* ---- 3a · CREATE AGENT ----------------------------------------------- */
  function stepCreateAgent(main) {
    const first = isFirstAgent();
    // restore an in-progress draft, else seed (concierge template for the first agent)
    const draft = S._agentDraft || {
      alias: first ? "Atlas" : "",
      role: first ? "Concierge · planning & orchestration" : "",
      prompt: first ? CONCIERGE_TEMPLATE : "",
      model: DEFAULT_MODEL,
      _firstMode: readyTasks().length ? "pick" : "none",
      _pickId: null, _desc: "",
    };
    if (draft.model == null) draft.model = DEFAULT_MODEL;
    S._agentDraft = draft; save();

    // During an AI-roster walk (Path G), the form is pre-seeded per proposed agent.
    const walk = S._walk;
    const walkBar = walk ? `<div class="walkbar">${icon("spark", "")}<span>Agent <b>${walk.idx + 1}</b> of <b>${walk.agents.length}</b> from your proposed roster — edit anything, then create.</span></div>` : "";

    main.innerHTML = `<div class="ob">${walkBar}
      <div class="form-h">
        <span class="fic">${icon("agents", "")}</span>
        <div><h2>${walk ? "Review &amp; create " + esc(draft.alias || "this agent") : (first ? "Create your first agent" : "Create an agent")}</h2>
        <p>${walk ? "Pre-filled from your proposed roster. Edit anything before you create — nothing is committed until you click Create." : (first ? "We've pre-filled a concierge agent — an AI teammate you can brainstorm the workspace plan with. Edit anything; it's yours." : "Define the teammate: who they are, how they think, and what they'll pick up first.")}</p></div>
      </div>
      <div class="card pad">
        <div class="field2">
          <div class="lab">Agent name <span class="req">*</span></div>
          <input class="ipt" id="agName" value="${esc(draft.alias)}" placeholder="e.g. Atlas, Forge, Vault" autocomplete="off" spellcheck="false">
          <div class="hint">A short, memorable alias. This is how the agent appears everywhere in the portal.</div>
        </div>
        <div class="field2">
          <div class="lab">Role <span class="req">*</span></div>
          <input class="ipt" id="agRole" value="${esc(draft.role)}" placeholder="e.g. Concierge · planning & orchestration" autocomplete="off">
        </div>
        <div class="field2">
          <div class="lab"><span>System prompt</span><span class="req">*</span><span class="grow"></span>
            ${first ? `<span class="refine" id="agTemplate">${icon("spark", "")}Use the concierge template</span>` : ""}</div>
          <textarea class="txa mono" id="agPrompt" rows="9" placeholder="Describe the agent's persona, how it should behave, and its boundaries…">${esc(draft.prompt)}</textarea>
          <div class="hint">This is the agent's standing persona — rehydrated on every wake. You can keep refining it later from the agent's page.</div>
        </div>
        <div class="field2">
          <div class="lab">Model <span class="req">*</span></div>
          <div class="models" id="agModels">${modelCards(draft.model)}</div>
        </div>
        <div class="field2" style="margin-bottom:6px">
          <div class="lab"><span>First task</span><span class="opt">optional</span></div>
          <div class="hint" style="margin-top:0;margin-bottom:9px">Give the agent something to pick up — choose an existing ready task or describe one. You can also leave this empty and just brainstorm.</div>
          <div class="firsttask">
            <div class="ftmode" id="ftMode">
              <button data-mode="pick" class="${draft._firstMode === "pick" ? "on" : ""}">${icon("tasks", "")}Pick existing task</button>
              <button data-mode="describe" class="${draft._firstMode === "describe" ? "on" : ""}">${icon("plus", "")}Describe a task</button>
              <button data-mode="none" class="${draft._firstMode === "none" ? "on" : ""}">${icon("clock", "")}Not yet</button>
            </div>
            <div class="ftbody" id="ftBody"></div>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn ghost" data-go="fork">Back</button>
        <span class="grow"></span>
        <span class="note">You're the authority — creating an agent doesn't wake it.</span>
        <button class="btn" id="agCreate">${icon("check", "")}Create ${first ? "agent" : ""}</button>
      </div>
    </div>`;

    const $ = (id) => document.getElementById(id);
    $("agName").addEventListener("input", (e) => { draft.alias = e.target.value; save(); });
    $("agRole").addEventListener("input", (e) => { draft.role = e.target.value; save(); });
    $("agPrompt").addEventListener("input", (e) => { draft.prompt = e.target.value; save(); });
    $("agModels").addEventListener("click", (e) => {
      const b = e.target.closest("[data-model]"); if (!b) return;
      $("agModels").querySelectorAll(".m").forEach((x) => x.classList.remove("on"));
      b.classList.add("on"); draft.model = b.dataset.model; save();
    });
    const tmpl = $("agTemplate");
    if (tmpl) tmpl.addEventListener("click", () => {
      draft.prompt = CONCIERGE_TEMPLATE; save();
      const ta = $("agPrompt"); if (ta) ta.value = CONCIERGE_TEMPLATE;
      O.toast("Concierge template applied — edit freely", "ok");
    });

    function renderFt() {
      const body = $("ftBody");
      if (draft._firstMode === "pick") {
        // recompute the ready list LIVE (reflects tasks created earlier in this flow) and
        // select by task ID, not a positional index into a stale snapshot (review #4).
        const rtsLive = readyTasks();
        body.innerHTML = rtsLive.length
          ? `<div class="picklist">${rtsLive.map((t) => `<div class="pl ${draft._pickId === t.id ? "on" : ""}" data-pickid="${esc(t.id)}">
              <span class="rad"></span><div class="grow"><div class="t1">${esc(t.title)}</div><div class="t2">${esc(O.trunc(t.definition_of_done || "", 70))}</div></div></div>`).join("")}</div>`
          : `<div class="none" style="padding:16px">No ready unassigned tasks. Switch to <b>Describe a task</b>, or leave it for now.</div>`;
        body.querySelectorAll("[data-pickid]").forEach((el) => el.addEventListener("click", () => {
          draft._pickId = el.dataset.pickid; save(); renderFt();
        }));
      } else if (draft._firstMode === "describe") {
        body.innerHTML = `<textarea class="txa" id="ftDesc" rows="3" placeholder="Describe the first task in plain language — e.g. &quot;Stand up the schema_migrations runner so we can ship migrations without wiping the volume.&quot;">${esc(draft._desc)}</textarea>
          <div class="hint">Becomes an initial_task with a title + a definition of done assigned to this agent on creation.</div>`;
        $("ftDesc").addEventListener("input", (e) => { draft._desc = e.target.value; save(); });
      } else {
        body.innerHTML = `<div class="none" style="padding:16px">No first task — you'll brainstorm with this agent and create tasks together.</div>`;
      }
    }
    renderFt();
    $("ftMode").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mode]"); if (!b) return;
      $("ftMode").querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
      draft._firstMode = b.dataset.mode; save(); renderFt();
    });

    $("agCreate").addEventListener("click", () => submitAgent(draft));
    wireGo(main);
  }

  function modelCards(selected) {
    if (!MODELS.length) return `<div class="none" style="padding:14px">Loading models…</div>`;
    return MODELS.map((m) => `<button type="button" class="m ${m.id === selected ? "on" : ""}" data-model="${esc(m.id)}">
      ${icon("check", "tick")}
      <div class="mn">${esc(m.name || m.id)}</div></button>`).join("");
  }

  async function submitAgent(draft) {
    if (!CID) { O.toast("No workspace found yet.", "danger"); return; }
    const alias = (draft.alias || "").trim();
    const role = (draft.role || "").trim();
    const prompt = (draft.prompt || "").trim();
    if (!alias || !role || !prompt) { O.toast("Name, role, and system prompt are required", "bad"); return; }

    // O2: optional initial_task — either an existing ready task picked, or a described one.
    let initial_task = null;
    const rts = readyTasks();
    const picked = (draft._firstMode === "pick" && draft._pickId) ? rts.find((x) => x.id === draft._pickId) : null;
    if (picked) {
      initial_task = { title: picked.title, definition_of_done: picked.definition_of_done || ("Complete: " + picked.title) };
    } else if (draft._firstMode === "describe" && (draft._desc || "").trim()) {
      const d = draft._desc.trim();
      // honor a proposal-supplied title (walk) so a roster kickoff keeps its name;
      // manual describe leaves _taskTitle unset → falls back to the truncated dod.
      initial_task = { title: (draft._taskTitle || "").trim() || O.trunc(d, 60), definition_of_done: d };
    }

    const body = { alias, role, kind: "ai", prompt, model: draft.model || undefined };
    if (initial_task) body.initial_task = initial_task;

    const btn = document.getElementById("agCreate");
    if (btn) btn.disabled = true;
    const res = await postJSON("/api/containers/" + encodeURIComponent(CID) + "/agents", body);
    if (btn) btn.disabled = false;
    if (!res.ok) { O.toast("Create failed (" + res.status + ")", "danger"); return; }

    S.lastAgentAlias = alias;
    S._agentDraft = null;
    if (S._walk) { S._walk.idx += 1; }   // advance the roster walk past the agent just created
    save();
    O.toast(alias + " created", "ok");
    await refreshAnd("agent-created");   // snapshot now has the new agent (isFirstAgent / create-another)
  }

  /* ---- 3a · AGENT CREATED ---------------------------------------------- */
  function stepAgentCreated(main) {
    const alias = S.lastAgentAlias;
    const a = alias ? snapAgents().find((x) => x.alias === alias) : null;
    if (!alias) { go("fork"); return; }
    // Defensive ghost guard (#140): if the celebrated agent vanished from server truth
    // after boot (e.g. retired in another tab), don't render a dead success card — drop
    // the stale reference and fall back to the fork instead of a phantom "is ready".
    if (!a) { S.lastAgentAlias = null; save(); go("fork"); return; }
    const role = a ? a.role : "AI agent";
    const model = a ? (a.model || "—") : "—";

    // Path G roster walk: after each agent, drive the operator to the NEXT proposed
    // agent (re-using this same success → create-agent loop), then to the queued tasks.
    const walk = S._walk;
    const nextAgent = walk && walk.idx < walk.agents.length ? walk.agents[walk.idx] : null;
    const standaloneLeft = walk && walk.standalone ? walk.standalone.length : 0;
    let walkBlock = "";
    if (walk && nextAgent) {
      walkBlock = `<div class="walknext">
        <div class="wn-prog">${icon("spark", "")}<span>${esc(String(walk.idx))} of ${esc(String(walk.agents.length))} agents created — keep going through your roster.</span></div>
        <button class="btn" id="wnNext">${icon("agents", "")}Next: create ${esc(nextAgent.name)} ${icon("arrow", "")}</button>
      </div>`;
    } else if (walk && standaloneLeft) {
      walkBlock = `<div class="walknext">
        <div class="wn-prog">${icon("check", "")}<span>All ${esc(String(walk.agents.length))} proposed agents created. ${esc(String(standaloneLeft))} proposed task${standaloneLeft === 1 ? "" : "s"} left to add.</span></div>
        <button class="btn" id="wnTasks">${icon("tasks", "")}Add your ${esc(String(standaloneLeft))} proposed task${standaloneLeft === 1 ? "" : "s"} ${icon("arrow", "")}</button>
      </div>`;
    } else if (walk) {
      walkBlock = `<div class="walknext done">
        <div class="wn-prog">${icon("check", "")}<span>Your proposed roster is live — agents created and tasks queued. You're set up.</span></div>
        <a class="btn" href="/">${icon("home", "")}Go to dashboard ${icon("arrow", "")}</a>
      </div>`;
    }

    main.innerHTML = `<div class="ob created">
      <div class="seal">${icon("check", "")}</div>
      <div class="eyebrow">Agent created</div>
      <h1>${esc(alias)} is ready.</h1>
      <p class="lede">Your teammate is standing by — idle until you give it work. The best first move is to think out loud with it.</p>

      <div class="agentcard">
        ${avatar(alias, "ai", "lg")}
        <div class="ac-meta">
          <h3>${esc(alias)} ${O.kindBadge("ai")}</h3>
          <div class="role">${esc(role)}</div>
          <div class="chips">${O.pill(a ? a.status : "idle")}<span class="tag model">${esc(model)}</span></div>
        </div>
      </div>

      <div class="brainstorm">
        <div class="bh"><span class="bic">${icon("requests", "")}</span><h3>Brainstorm the plan with ${esc(alias)}</h3></div>
        <div class="bb">
          <p>Open a conversation and think through what you're building. ${esc(alias)} will help you break it into tasks and <b>propose the rest of the team</b> for your approval. You stay in command the whole way.</p>
          <a class="btn" href="/agents?agent=${encodeURIComponent(alias)}">${icon("requests", "")}Open conversation with ${esc(alias)} ${icon("arrow", "")}</a>
        </div>
      </div>

      <div class="held">${icon("clock", "")}<span>Assigning tasks to agents is coming soon (needs the B5 assign endpoint). For now, ${esc(alias)} picks up any initial task you gave it.</span></div>

      ${walkBlock}

      <div class="secondary">
        <a data-go="create-agent">${icon("plus", "")}Create another agent</a>
        <a data-go="create-tasks">${icon("tasks", "")}Add tasks</a>
        <a href="/">${icon("home", "")}Go to dashboard</a>
      </div>
    </div>`;
    // walk: seed the NEXT proposed agent into the existing create-agent form.
    const wnNext = document.getElementById("wnNext");
    if (wnNext) wnNext.addEventListener("click", () => {
      S._agentDraft = walkAgentToDraft(nextAgent, DEFAULT_MODEL); save();
      go("create-agent");
    });
    // walk: push the proposed standalone tasks into the queue, hand off to the existing
    // create-tasks POST loop, and end the walk (the queue commits through the unchanged path).
    const wnTasks = document.getElementById("wnTasks");
    if (wnTasks) wnTasks.addEventListener("click", () => {
      const have = new Set(S.tasks.map((t) => t.title + "\n" + t.dod));
      walk.standalone.forEach((t) => { const k = t.title + "\n" + t.dod; if (!have.has(k)) { S.tasks.push({ title: t.title, dod: t.dod }); have.add(k); } });
      S._walk = null; save();
      go("create-tasks");
    });
    wireGo(main);
  }

  /* ---- 3b · CREATE TASKS (queue locally, then POST each as a standalone ready task) -- */
  function stepCreateTasks(main) {
    main.innerHTML = `<div class="ob">
      <div class="form-h">
        <span class="fic" style="background:var(--violet-soft);border-color:var(--violet-line);color:var(--violet)">${icon("tasks", "")}</span>
        <div><h2>Add your first tasks</h2><p>Capture the work as tasks — each with a clear definition of done. Next, create an agent and these become its first task.</p></div>
      </div>

      <div id="tqWrap"></div>

      <div class="taskform">
        <div class="tf-h">${icon("plus", "")}New task</div>
        <div class="field2">
          <div class="lab">Title <span class="req">*</span></div>
          <input class="ipt" id="tkTitle" placeholder="e.g. Persist + expose worker output" autocomplete="off">
        </div>
        <div class="field2" style="margin-bottom:8px">
          <div class="lab">Definition of done <span class="req">*</span></div>
          <textarea class="txa" id="tkDod" rows="2" placeholder="The unambiguous finish line — how you'll know it's done."></textarea>
        </div>
        <div style="display:flex;justify-content:flex-end"><button class="btn subtle" id="tkAdd">${icon("plus", "")}Add task</button></div>
      </div>

      <div class="form-actions">
        <button class="btn ghost" data-go="fork">Back</button>
        <span class="grow"></span>
        <span class="note" id="tkCount"></span>
        <button class="btn" id="tkContinue">${icon("agents", "")}Continue — create an agent ${icon("arrow", "")}</button>
      </div>
    </div>`;

    const renderQueue = () => {
      const wrap = document.getElementById("tqWrap");
      wrap.innerHTML = S.tasks.length
        ? `<div class="taskqueue">${S.tasks.map((t, i) => `<div class="tq">
            <span class="num">${i + 1}</span>
            <div class="grow"><div class="tt">${esc(t.title)}</div><div class="dod">${esc(t.dod)}</div></div>
            <button class="del" data-del="${i}" title="Remove">${icon("x", "")}</button></div>`).join("")}</div>`
        : `<div class="none" style="margin-bottom:18px;padding:22px">No tasks yet — add your first one below.</div>`;
      wrap.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { S.tasks.splice(+b.dataset.del, 1); save(); renderQueue(); updateCount(); }));
    };
    const updateCount = () => {
      document.getElementById("tkCount").textContent = S.tasks.length ? S.tasks.length + " task" + (S.tasks.length === 1 ? "" : "s") + " queued" : "Add at least one task";
    };
    renderQueue(); updateCount();

    const addTask = () => {
      const title = (document.getElementById("tkTitle").value || "").trim();
      const dod = (document.getElementById("tkDod").value || "").trim();
      if (!title || !dod) { O.toast("Title and definition of done are required", "bad"); return; }
      S.tasks.push({ title, dod }); save();
      document.getElementById("tkTitle").value = ""; document.getElementById("tkDod").value = "";
      document.getElementById("tkTitle").focus();
      renderQueue(); updateCount();
      O.toast("Task added", "ok");
    };
    document.getElementById("tkAdd").addEventListener("click", addTask);
    document.getElementById("tkDod").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") addTask(); });

    document.getElementById("tkContinue").addEventListener("click", async () => {
      // Path B: persist EVERY queued task as a real standalone (ready/unassigned) task so an
      // agent can pick it up via the work loop — never silently drop the queue (review P2).
      // The create-agent step can then optionally pick one of them as the agent's initial_task.
      if (S.tasks.length) {
        const btn = document.getElementById("tkContinue"); btn.disabled = true;
        const h = O.actingHuman();
        const remaining = [];
        for (const t of S.tasks) {
          const res = await postJSON("/api/containers/" + encodeURIComponent(CID) + "/tasks",
            { title: t.title, definition_of_done: t.dod, created_by_agent_id: h ? h.id : undefined });
          if (!res.ok) remaining.push(t);
        }
        const created = S.tasks.length - remaining.length;
        S.tasks = remaining; save();
        O.toast(remaining.length ? (created + " created, " + remaining.length + " failed — retry the rest")
                                 : (created + " task" + (created === 1 ? "" : "s") + " created"),
                remaining.length ? "bad" : "ok");
        btn.disabled = false;
        if (remaining.length) { render(); return; }   // stay on the step so they can retry
        S._agentDraft = null;      // fresh create-agent draft (tasks are now standalone)
        await refreshAnd("create-agent");   // snapshot now has the new tasks -> pickable in the picker
        return;
      }
      S._agentDraft = null;
      go("create-agent");
    });
    wireGo(main);
  }

  /* ====================================================================== */
  /*  PATH G — AI roster proposal (goal → stream → editable roster → walk)    */
  /* ====================================================================== */

  /* ---- G1 · describe the goal ------------------------------------------ */
  function stepProposeGoal(main) {
    const pr = S._propose || (S._propose = { goal: "", dialogue: [] });
    main.innerHTML = `<div class="ob">
      <div class="form-h">
        <span class="fic">${icon("spark", "")}</span>
        <div><h2>Tell me what you're building</h2>
        <p>One or two sentences is plenty. I'll propose a starting team — agents with system prompts and their first tasks — for you to review and edit. Nothing is created until you approve it.</p></div>
      </div>
      <div class="card pad">
        <div class="field2" style="margin-bottom:6px">
          <div class="lab">Your project goal <span class="req">*</span></div>
          <textarea class="txa" id="gGoal" rows="4" placeholder="e.g. Improve my app's onboarding — I want fewer drop-offs on first run and a clearer first-task experience.">${esc(pr.goal)}</textarea>
          <div class="hint">Vague is fine — I may ask 1–3 quick questions to narrow it before proposing.</div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn ghost" data-go="fork">Back</button>
        <span class="grow"></span>
        <span class="note">I propose; you decide. You can edit everything next.</span>
        <button class="btn" id="gGo">${icon("spark", "")}Propose my roster</button>
      </div>
    </div>`;
    const ta = document.getElementById("gGoal");
    ta.addEventListener("input", (e) => { pr.goal = e.target.value; ta.style.borderColor = ""; save(); });
    document.getElementById("gGo").addEventListener("click", () => {
      const g = (ta.value || "").trim();
      if (!g) { ta.focus(); ta.style.borderColor = "var(--danger-line)"; return; }
      pr.goal = g; pr.dialogue = []; save();
      go("propose-stream");
    });
    wireGo(main);
    setTimeout(() => ta && ta.focus(), 60);
  }

  /* ---- G2 · stream the proposal (thinking → clarify | roster | error) --- */
  function stepProposeStream(main) {
    const pr = S._propose || (S._propose = { goal: "", dialogue: [] });
    if (!pr.goal) { go("propose-goal"); return; }

    main.innerHTML = `<div class="ob propose">
      <div class="form-h">
        <span class="fic">${icon("spark", "")}</span>
        <div><h2>Designing your roster…</h2>
        <p class="gp-goal">“${esc(O.trunc(pr.goal, 160))}”</p></div>
      </div>
      <div class="card pad">
        <div class="thinking" id="pThink">
          <div class="th-h">${icon("live", "")}<span>Thinking</span><span class="dots"><i></i><i></i><i></i></span></div>
          <pre class="th-body" id="pThinkBody"></pre>
        </div>
        <div id="pTurn"></div>
      </div>
      <div class="form-actions">
        <button class="btn ghost" id="pStop">${icon("stop", "")}Stop</button>
        <span class="grow"></span>
        <span class="note">Streaming from the onboarding model</span>
      </div>
    </div>`;

    const thinkBody = document.getElementById("pThinkBody");
    const turn = document.getElementById("pTurn");
    let acc = "";
    const finishThinking = () => { const t = document.getElementById("pThink"); if (t) t.classList.add("done"); };

    document.getElementById("pStop").addEventListener("click", () => { go("propose-goal"); });

    _proposeAbort = startPropose({ cid: CID, goal: pr.goal, dialogue: pr.dialogue || [] }, {
      onThinking: (d) => { acc += d; if (thinkBody) { thinkBody.textContent = acc; thinkBody.scrollTop = thinkBody.scrollHeight; } },
      onClarify: (questions) => { finishThinking(); renderClarify(turn, pr, questions); },
      onRoster: (payload) => { S._roster = normalizeRoster(payload, DEFAULT_MODEL); save(); go("propose-roster"); },
      onError: (err) => { finishThinking(); renderError(turn, err); },
    });
  }

  const ERR_COPY = {
    no_api_key: "No model API key is configured for this workspace yet. Add one in Settings, or set the team up by hand.",
    model_error: "The model couldn't be reached just now. Retry, or set the team up by hand.",
    invalid_goal: "I couldn't work with that goal — try describing the project a little more concretely.",
    rate_limited: "The model is rate-limited right now. Give it a moment and retry, or set up by hand.",
    roster_truncated: "The roster was too large to finish. Narrow the first team in your goal, then try again, or set it up by hand.",
  };
  function renderClarify(turn, pr, questions) {
    const qs = (questions || []).slice(0, 3);
    turn.innerHTML = `<div class="clarify">
      <div class="cl-h">${icon("requests", "")}<span>A couple of quick questions</span></div>
      ${qs.map((q) => `<div class="field2" style="margin-bottom:13px">
        <div class="lab">${esc(q.prompt)}</div>
        <input class="ipt" data-qid="${esc(q.id || "")}" data-qprompt="${esc(q.prompt || "")}" placeholder="Your answer — or leave blank" autocomplete="off"></div>`).join("")}
      <div class="cl-actions">
        <button class="btn subtle" id="clSkip">Skip — just propose</button>
        <button class="btn" id="clGo">${icon("arrow", "")}Continue</button>
      </div>
    </div>`;
    const collect = () => {
      turn.querySelectorAll("[data-qid]").forEach((el) => {
        const a = (el.value || "").trim();
        pr.dialogue.push({ role: "assistant", content: el.dataset.qprompt });
        pr.dialogue.push({ role: "user", content: a || "(no preference)" });
      });
      save();
    };
    document.getElementById("clGo").addEventListener("click", () => { collect(); go("propose-stream"); });
    document.getElementById("clSkip").addEventListener("click", () => {
      pr.dialogue.push({ role: "user", content: "(skip clarifying — propose your best roster now)" }); save();
      go("propose-stream");
    });
  }
  function renderError(turn, err) {
    const code = (err && err.code) || "model_error";
    const msg = (err && err.message) || ERR_COPY[code] || ERR_COPY.model_error;
    const retryable = code !== "roster_truncated";
    turn.innerHTML = `<div class="perror">
      <div class="pe-h">${icon("shield", "")}<span>Couldn't propose a roster</span></div>
      <p>${esc(msg)}</p>
      <div class="pe-actions">
        ${retryable ? `<button class="btn subtle" id="peRetry">${icon("refresh", "")}Retry</button>` : ""}
        <a class="btn ghost" data-go="propose-goal">Edit goal</a>
        <a class="btn ghost" data-go="fork">Set up by hand instead</a>
      </div>
    </div>`;
    const retry = document.getElementById("peRetry");
    if (retry) retry.addEventListener("click", () => retryPropose(S._propose, err));
    wireGo(turn);
  }

  function retryPropose(pr, err) {
    if (pr && err && err.code === "invalid_goal" && err.message) {
      pr.dialogue = pr.dialogue || [];
      pr.dialogue.push({ role: "user", content: "(Previous roster proposal failed validation on the server: " + err.message + ". Please revise the roster and avoid that issue.)" });
      save();
    }
    go("propose-stream");
  }

  // Open the SSE stream (fetch + ReadableStream — EventSource is GET-only, the contract is
  // POST+SSE). Fails OPEN: any transport/HTTP failure (incl. a 404 because #292 isn't
  // deployed) surfaces as an honest `error` turn that keeps the manual lanes usable.
  // Returns an abort() the step calls on navigation. ?demo=1 swaps in a client-side stub.
  function startPropose(body, h) {
    if (S._propose && S._propose.demo) return demoPropose(body, h);
    const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    let stopped = false;
    (async function pump() {
      let resp;
      try {
        resp = await fetch(PROPOSE_URL, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
      } catch (e) {
        if (!stopped) h.onError({ code: "model_error", message: "Couldn't reach the server. Check the workspace is running, then retry." });
        return;
      }
      if (!resp.ok || !resp.body || !resp.body.getReader) {
        if (!stopped) h.onError({ code: "model_error",
          message: "The AI propose endpoint isn't available (" + resp.status + "). The #292 backend may not be deployed yet — you can set up by hand." });
        return;
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!stopped) {
        let r;
        try { r = await reader.read(); } catch (e) { break; }
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        const parsed = parseSSE(buf); buf = parsed.rest;
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
    return function abort() { stopped = true; if (ctrl) try { ctrl.abort(); } catch (e) {} };
  }

  // DEV-ONLY (?demo=1): synthesize a stream so the whole lane is exercisable before the
  // #292 backend lands. Never the default path — gated on S._propose.demo.
  function demoPropose(body, h) {
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
        rationale: "A concierge to plan and delegate, plus one builder to execute the first slice — the smallest team that can move “" + O.trunc(goal, 60) + "” forward.",
        agents: [
          { name: "Atlas", role: "Concierge · planning & orchestration", charter: CONCIERGE_TEMPLATE, model_hint: DEFAULT_MODEL },
          { name: "Forge", role: "Builder · implementation", charter: "You are a builder agent. Take a task with a clear definition of done, implement it, and stop at needs_verification for the operator to verify. Cooperate with teammates via /orcha-ask; never self-certify.", model_hint: DEFAULT_MODEL },
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

  /* ---- G3 · review + edit the proposed roster, then commit (the walk) --- */
  function stepProposeRoster(main) {
    const r = S._roster;
    if (!r || !r.agents || !r.agents.length) { go("propose-goal"); return; }

    const agentNames = () => r.agents.map((a) => a.name).filter(Boolean);
    const agentCard = (a, i) => `<div class="rcard" data-aidx="${i}">
      <div class="rc-h">${avatar(a.name || "?", "ai", "sm")}
        <div class="grow"><input class="ipt rc-name" data-aidx="${i}" value="${esc(a.name)}" placeholder="Agent name" autocomplete="off" spellcheck="false">
        <input class="ipt rc-role" data-aidx="${i}" value="${esc(a.role)}" placeholder="Role — e.g. Builder · implementation" autocomplete="off"></div>
        <button class="rdel" data-adel="${i}" title="Remove agent">${icon("x", "")}</button></div>
      <textarea class="txa mono rc-charter" data-aidx="${i}" rows="5" placeholder="System prompt / charter">${esc(a.charter)}</textarea>
      <div class="rc-models" data-aidx="${i}">${modelCards(a.model)}</div>
    </div>`;

    const taskRow = (t, i) => {
      const opts = [`<option value=""${t.assignee ? "" : " selected"}>Unassigned (standalone)</option>`]
        .concat(agentNames().map((n) => `<option value="${esc(n)}"${t.assignee === n ? " selected" : ""}>${esc(n)}</option>`)).join("");
      const deps = (t.depends_on || []).length ? `<span class="rt-dep">${icon("link", "")}after: ${esc(t.depends_on.join(", "))}</span>` : "";
      const proto = t.protocol ? `<span class="rt-proto">${icon("flag", "")}protocol</span>` : "";
      return `<div class="rtask" data-tidx="${i}">
        <div class="rt-top">
          <input class="ipt rt-title" data-tidx="${i}" value="${esc(t.title)}" placeholder="Task title" autocomplete="off">
          <button class="rdel" data-tdel="${i}" title="Remove task">${icon("x", "")}</button>
        </div>
        <textarea class="txa rt-dod" data-tidx="${i}" rows="2" placeholder="Definition of done">${esc(t.definition_of_done)}</textarea>
        <div class="rt-meta">
          <label class="rt-assign">Assignee <select class="sel rt-assignee" data-tidx="${i}">${opts}</select></label>
          <label class="rt-kick"><input type="checkbox" class="rt-kickoff" data-tidx="${i}" ${t.is_kickoff ? "checked" : ""} ${t.assignee ? "" : "disabled"}> First task (kickoff)</label>
          ${deps}${proto}
        </div>
      </div>`;
    };

    main.innerHTML = `<div class="ob wide">
      <div class="form-h">
        <span class="fic">${icon("spark", "")}</span>
        <div><h2>Your proposed roster</h2>
        <p>Review and edit anything — names, prompts, models, tasks, who owns what. Nothing is created until you choose to. You'll confirm each agent in the create form before it's committed.</p></div>
      </div>
      ${r.rationale ? `<div class="rationale">${icon("spark", "")}<span>${esc(r.rationale)}</span></div>` : ""}

      <div class="rsec-h">${icon("agents", "")}<span>Agents</span><span class="grow"></span><button class="addrow" id="rAddAgent">${icon("plus", "")}Add agent</button></div>
      <div class="rgrid" id="rAgents">${r.agents.map(agentCard).join("")}</div>

      <div class="rsec-h" style="margin-top:24px">${icon("tasks", "")}<span>Tasks</span><span class="grow"></span><button class="addrow" id="rAddTask">${icon("plus", "")}Add task</button></div>
      <div class="rtasks" id="rTasks">${r.tasks.length ? r.tasks.map(taskRow).join("") : `<div class="none" style="padding:18px">No tasks proposed — add one, or create agents and add work later.</div>`}</div>

      <div class="form-actions">
        <button class="btn ghost" data-go="propose-goal">${icon("arrow", "")}Back</button>
        <span class="grow"></span>
        <span class="note">Kickoff tasks become each agent's first task; the rest become ready tasks.</span>
        <button class="btn" id="rCommit">${icon("check", "")}Looks good — create the team</button>
      </div>
    </div>`;

    const reRenderTasks = () => {
      const box = document.getElementById("rTasks");
      box.innerHTML = r.tasks.length ? r.tasks.map(taskRow).join("") : `<div class="none" style="padding:18px">No tasks proposed — add one, or create agents and add work later.</div>`;
      wireTasks();
    };
    const reRenderAgents = () => {
      const box = document.getElementById("rAgents");
      box.innerHTML = r.agents.map(agentCard).join("");
      wireAgents();
      reRenderTasks();   // assignee <select> options depend on agent names
    };

    function wireAgents() {
      const box = document.getElementById("rAgents");
      box.querySelectorAll(".rc-name").forEach((el) => el.addEventListener("input", (e) => { r.agents[+el.dataset.aidx].name = e.target.value; save(); }));
      box.querySelectorAll(".rc-role").forEach((el) => el.addEventListener("input", (e) => { r.agents[+el.dataset.aidx].role = e.target.value; save(); }));
      box.querySelectorAll(".rc-charter").forEach((el) => el.addEventListener("input", (e) => { r.agents[+el.dataset.aidx].charter = e.target.value; save(); }));
      box.querySelectorAll(".rc-models").forEach((mc) => mc.addEventListener("click", (e) => {
        const b = e.target.closest("[data-model]"); if (!b) return;
        mc.querySelectorAll(".m").forEach((x) => x.classList.remove("on")); b.classList.add("on");
        r.agents[+mc.dataset.aidx].model = b.dataset.model; save();
      }));
      box.querySelectorAll("[data-adel]").forEach((b) => b.addEventListener("click", () => {
        const gone = r.agents.splice(+b.dataset.adel, 1)[0];
        // drop now-dangling assignees + kickoffs that pointed at the removed agent
        if (gone) r.tasks.forEach((t) => { if (t.assignee === gone.name) { t.assignee = null; t.is_kickoff = false; } });
        save(); reRenderAgents();
      }));
    }
    function wireTasks() {
      const box = document.getElementById("rTasks");
      box.querySelectorAll(".rt-title").forEach((el) => el.addEventListener("input", (e) => { r.tasks[+el.dataset.tidx].title = e.target.value; save(); }));
      box.querySelectorAll(".rt-dod").forEach((el) => el.addEventListener("input", (e) => { r.tasks[+el.dataset.tidx].definition_of_done = e.target.value; save(); }));
      box.querySelectorAll(".rt-assignee").forEach((el) => el.addEventListener("change", (e) => {
        const t = r.tasks[+el.dataset.tidx]; t.assignee = e.target.value || null;
        if (!t.assignee) t.is_kickoff = false;     // standalone tasks can't be a kickoff
        save(); reRenderTasks();
      }));
      box.querySelectorAll(".rt-kickoff").forEach((el) => el.addEventListener("change", (e) => {
        const t = r.tasks[+el.dataset.tidx];
        if (e.target.checked && t.assignee) {       // one kickoff per assignee — clear the others
          r.tasks.forEach((o, j) => { if (j !== +el.dataset.tidx && o.assignee === t.assignee) o.is_kickoff = false; });
          t.is_kickoff = true;
        } else t.is_kickoff = false;
        save(); reRenderTasks();
      }));
      box.querySelectorAll("[data-tdel]").forEach((b) => b.addEventListener("click", () => { r.tasks.splice(+b.dataset.tdel, 1); save(); reRenderTasks(); }));
    }

    wireAgents(); wireTasks();
    document.getElementById("rAddAgent").addEventListener("click", () => { r.agents.push({ name: "", role: "", charter: "", model: DEFAULT_MODEL }); save(); reRenderAgents(); });
    document.getElementById("rAddTask").addEventListener("click", () => { r.tasks.push({ title: "", definition_of_done: "", assignee: null, depends_on: [], protocol: null, is_kickoff: false }); save(); reRenderTasks(); });

    document.getElementById("rCommit").addEventListener("click", () => {
      // normalize the edited roster once more (drop empties / fix refs), then start the walk.
      const clean = normalizeRoster({ rationale: r.rationale, agents: r.agents.map((a) => ({ name: a.name, role: a.role, charter: a.charter, model_hint: a.model })), tasks: r.tasks }, DEFAULT_MODEL);
      if (!clean.agents.length) { O.toast("Add at least one agent (name, role, prompt) before creating", "bad"); return; }
      S._walk = rosterToWalk(clean);
      S._agentDraft = walkAgentToDraft(S._walk.agents[0], DEFAULT_MODEL);
      save();
      go("create-agent");
    });
    wireGo(main);
  }

  /* ---- shared: wire any [data-go] inside a container ------------------- */
  function wireGo(scope) {
    (scope || document).querySelectorAll("[data-go]").forEach((el) => {
      if (el._wired) return; el._wired = true;
      el.addEventListener("click", (e) => { e.preventDefault(); go(el.dataset.go); });
    });
  }

  /* ---- boot: resolve cid once, load models, then live-render on snapshot - */
  function boot() {
    // "+ New agent" deep-link (?new=1 or ?step=create-agent): once an operator exists, jump
    // straight to the create form so adding ANOTHER agent doesn't replay welcome/fork.
    const q = new URLSearchParams(location.search);
    // Reconcile against server truth FIRST: if the persisted flow celebrates an agent the
    // live snapshot no longer has (workspace reset / retirement), drop the ghost (#140) so
    // the steps below resume from a real step, not a vanished agent.
    const rec = reconcileGhost(S, snapAgents().map((a) => a.alias));
    S.step = rec.step; S.lastAgentAlias = rec.lastAgentAlias;
    // DEV-ONLY: ?demo=1 makes the propose lane synthesize a roster client-side (no #292 backend).
    // Reconciled from the live URL every boot (never sticky): set while ?demo=1 is present,
    // cleared otherwise so a prior demo session can't hijack the real propose path. save() below
    // persists the cleared state.
    reconcileDemoFlag(S, q.get("demo") === "1");
    if ((q.get("new") === "1" || q.get("step") === "create-agent") && operator()) S.step = "create-agent";
    else S.step = resumeStep(S.step, !!operator());   // skip welcome if a human exists
    save();
    render();
  }

  // resolve cid + models once on boot (independent of the 3s snapshot cadence)
  (async function init() {
    try { CID = await window.OrchaData.resolveCid(); } catch (e) {}
    fetch("/api/models").then((r) => r.ok ? r.json() : null).then((d) => {
      if (d && Array.isArray(d.models)) {
        MODELS = d.models; DEFAULT_MODEL = d.default || (d.models[0] && d.models[0].id) || null;
        if (S._agentDraft && S._agentDraft.model == null) S._agentDraft.model = DEFAULT_MODEL;
        // populate the model picker IN PLACE — a full render() here would rebuild the form
        // mid-entry + jump (bug 3). The #agModels click listener is delegated so it survives.
        const mc = document.getElementById("agModels");
        if (mc && S._agentDraft) mc.innerHTML = modelCards(S._agentDraft.model);
      }
    }).catch(() => {});
  })();

  // Boot ONCE on the first snapshot. We deliberately do NOT re-render on every 3s tick: the
  // wizard is a form flow, so rebuilding it every 3s jumps the scroll + clobbers inputs
  // (O-series bug). OrchaData keeps window.ORCHA fresh, so each step reads current data when
  // it's navigated; user actions (go/buttons) drive the renders.
  let booted = false;
  window.OrchaData.start(() => { if (!booted) { booted = true; boot(); } }, 3000);

  // expose the pure step-machine helpers for node tests
  window.OrchaOnboarding = { railKeyFor, resumeStep, reconcileGhost, reconcileDemoFlag, CONCIERGE_TEMPLATE, RAIL,
    parseSSE, normalizeRoster, rosterToWalk, walkAgentToDraft };
})();
