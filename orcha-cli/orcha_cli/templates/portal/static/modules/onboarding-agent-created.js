/* Onboarding flow module: post-create state and kickoff options. */
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
      <div class="wn-prog">${OnbIcon("spark", "")}<span>${OnbEsc(String(walk.idx))} of ${OnbEsc(String(walk.agents.length))} agents created — keep going through your roster.</span></div>
      <button class="btn" id="wnNext">${OnbIcon("agents", "")}Next: create ${OnbEsc(nextAgent.name)} ${OnbIcon("arrow", "")}</button>
    </div>`;
  } else if (walk && standaloneLeft) {
    walkBlock = `<div class="walknext">
      <div class="wn-prog">${OnbIcon("check", "")}<span>All ${OnbEsc(String(walk.agents.length))} proposed agents created. ${OnbEsc(String(standaloneLeft))} proposed task${standaloneLeft === 1 ? "" : "s"} left to add.</span></div>
      <button class="btn" id="wnTasks">${OnbIcon("tasks", "")}Add your ${OnbEsc(String(standaloneLeft))} proposed task${standaloneLeft === 1 ? "" : "s"} ${OnbIcon("arrow", "")}</button>
    </div>`;
  } else if (walk) {
    walkBlock = `<div class="walknext done">
      <div class="wn-prog">${OnbIcon("check", "")}<span>Your proposed roster is live — agents created and tasks queued. You're set up.</span></div>
      <a class="btn" href="/">${OnbIcon("home", "")}Go to dashboard ${OnbIcon("arrow", "")}</a>
    </div>`;
  }

  main.innerHTML = `<div class="ob created">
    <div class="seal">${OnbIcon("check", "")}</div>
    <div class="eyebrow">Agent created</div>
    <h1>${OnbEsc(alias)} is ready.</h1>
    <p class="lede">Your teammate is standing by — idle until you give it work. The best first move is to think out loud with it.</p>

    <div class="agentcard">
      ${OnbAvatar(alias, "ai", "lg")}
      <div class="ac-meta">
        <h3>${OnbEsc(alias)} ${O.kindBadge("ai")}</h3>
        <div class="role">${OnbEsc(role)}</div>
        <div class="chips">${O.pill(a ? a.status : "idle")}<span class="tag model">${OnbEsc(model)}</span></div>
      </div>
    </div>

    <div class="brainstorm">
      <div class="bh"><span class="bic">${OnbIcon("requests", "")}</span><h3>Brainstorm the plan with ${OnbEsc(alias)}</h3></div>
      <div class="bb">
        <p>Open a conversation and think through what you're building. ${OnbEsc(alias)} will help you break it into tasks and <b>propose the rest of the team</b> for your approval. You stay in command the whole way.</p>
        <a class="btn" href="/agents?agent=${encodeURIComponent(alias)}">${OnbIcon("requests", "")}Open conversation with ${OnbEsc(alias)} ${OnbIcon("arrow", "")}</a>
      </div>
    </div>

    <div class="held">${OnbIcon("clock", "")}<span>Assigning tasks to agents is coming soon (needs the B5 assign endpoint). For now, ${OnbEsc(alias)} picks up any initial task you gave it.</span></div>

    ${walkBlock}

    <div class="secondary">
      <a data-go="create-agent">${OnbIcon("plus", "")}Create another agent</a>
      <a data-go="create-tasks">${OnbIcon("tasks", "")}Add tasks</a>
      <a href="/">${OnbIcon("home", "")}Go to dashboard</a>
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
