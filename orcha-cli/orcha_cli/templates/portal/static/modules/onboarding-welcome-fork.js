/* Onboarding flow module: operator welcome and path selection. */
/* ---- 1 · WELCOME → register the operator (human) --------------------- */
function stepWelcome(main) {
  main.innerHTML = `<div class="ob welcome">
    <div class="bigmark">${O.orcaSVG()}</div>
    <div class="eyebrow">Orcha · orchestration portal</div>
    <h1>Run a team of agents,<br>with you in command.</h1>
    <p class="lede">Orcha is a human-authoritative, multi-agent workspace. Agents do the work and stream it to you live — but nothing ships on their say-so. You approve plans, verify results, and unblock. Let's set up your workspace.</p>

    <div class="whatis">
      <div class="w"><div class="ic">${OnbIcon("person", "")}</div><h4>You hold authority</h4><p>Agents stop at <i>needs&nbsp;verification</i>. You approve, verify, and decide — always.</p></div>
      <div class="w"><div class="ic">${OnbIcon("live", "")}</div><h4>Episodic agents</h4><p>Each agent wakes as a fresh worker, rehydrates from memory, and streams its work.</p></div>
      <div class="w"><div class="ic">${OnbIcon("shield", "")}</div><h4>Async gates</h4><p>No frantic allow-prompts. Govern through deliberate approve / verify decisions.</p></div>
    </div>

    <div class="namecard">
      <div class="nh"><span class="badge">${OnbIcon("person", "")}</span><h3>Claim the human authority</h3></div>
      <p class="sub">What should we call you? This registers you as the operator — the standing human authority for everything that happens in this workspace.</p>
      <div class="nrow">
        <input class="ipt lg" id="opName" placeholder="Your name — e.g. Dario" autocomplete="off" spellcheck="false" maxlength="40">
        <button class="btn" id="opGo" style="padding:0 18px">${OnbIcon("arrow", "")}Enter</button>
      </div>
      <div class="auth-note">${OnbIcon("shield", "")}<span>You can hand specific tasks to AI agents later — authority stays with you.</span></div>
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
      <h1>Welcome${op ? `, <span class="nm">${OnbEsc(op.alias)}</span>` : ""}. Your workspace is empty — let's change that.</h1>
      <p>Two ways in. Both lead to the same place: a workspace with <b>agents</b> doing <b>tasks</b> under your authority. Pick whichever matches how you think.</p>
    </div>
    <div class="ob wide">
      <div class="gpath">
        <div class="gp-icon">${OnbIcon("spark", "")}</div>
        <div class="gp-body">
          <div class="step">Path G · Recommended</div>
          <h3>Help me set this up</h3>
          <p>Describe your project in a sentence. An AI proposes a starting roster — agents with system prompts and their first tasks — that you review, edit, and create. You stay in command; nothing exists until you approve it.</p>
        </div>
        <button class="btn" data-go="propose-goal">${OnbIcon("spark", "")}Propose my roster ${OnbIcon("arrow", "")}</button>
      </div>
      <div class="forkmanual"><span></span>or set it up by hand<span></span></div>
      <div class="fork">
        <div class="onramp agent">
          <div class="top"><span class="oic">${OnbIcon("agents", "")}</span><div><div class="step">Path A</div><h3>Create your first agent</h3></div></div>
          <p>Stand up an AI teammate — give it a role, a model, and a system prompt. Best first move: create a <b>concierge</b> agent and brainstorm the whole plan with it.</p>
          <span class="recommend">${OnbIcon("spark", "")}Recommended for a blank slate</span>
          <button class="btn" data-go="create-agent">${OnbIcon("plus", "")}Create an agent</button>
        </div>
        <div class="onramp task">
          <div class="top"><span class="oic">${OnbIcon("tasks", "")}</span><div><div class="step">Path B</div><h3>Add tasks first</h3></div></div>
          <p>Already know the work? Capture it as tasks — each with a clear definition of done — then create the agents to carry them out.</p>
          <span class="recommend" style="color:var(--violet);background:var(--violet-soft);border-color:var(--violet-line)">${OnbIcon("tasks", "")}Good if the plan is clear</span>
          <button class="btn subtle" data-go="create-tasks">${OnbIcon("plus", "")}Add tasks</button>
        </div>
      </div>
      <div class="merge">${OnbIcon("convert", "")}<span>Either way you'll end up with <b>agents&nbsp;+&nbsp;tasks</b>. Once an agent exists you give it work from its page.</span></div>
    </div>`;
  wireGo(main);
}
