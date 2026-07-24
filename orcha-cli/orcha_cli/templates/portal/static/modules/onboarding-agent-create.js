/* Onboarding flow module: create-agent form and submission. */
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
  const walkBar = walk ? `<div class="walkbar">${OnbIcon("spark", "")}<span>Agent <b>${walk.idx + 1}</b> of <b>${walk.agents.length}</b> from your proposed roster — edit anything, then create.</span></div>` : "";

  main.innerHTML = `<div class="ob">${walkBar}
    <div class="form-h">
      <span class="fic">${OnbIcon("agents", "")}</span>
      <div><h2>${walk ? "Review &amp; create " + OnbEsc(draft.alias || "this agent") : (first ? "Create your first agent" : "Create an agent")}</h2>
      <p>${walk ? "Pre-filled from your proposed roster. Edit anything before you create — nothing is committed until you click Create." : (first ? "We've pre-filled a concierge agent — an AI teammate you can brainstorm the workspace plan with. Edit anything; it's yours." : "Define the teammate: who they are, how they think, and what they'll pick up first.")}</p></div>
    </div>
    <div class="card pad">
      <div class="field2">
        <div class="lab">Agent name <span class="req">*</span></div>
        <input class="ipt" id="agName" value="${OnbEsc(draft.alias)}" placeholder="e.g. Atlas, Forge, Vault" autocomplete="off" spellcheck="false">
        <div class="hint">A short, memorable alias. This is how the agent appears everywhere in the portal.</div>
      </div>
      <div class="field2">
        <div class="lab">Role <span class="req">*</span></div>
        <input class="ipt" id="agRole" value="${OnbEsc(draft.role)}" placeholder="e.g. Concierge · planning & orchestration" autocomplete="off">
      </div>
      <div class="field2">
        <div class="lab"><span>System prompt</span><span class="req">*</span><span class="grow"></span>
          ${first ? `<span class="refine" id="agTemplate">${OnbIcon("spark", "")}Use the concierge template</span>` : ""}</div>
        <textarea class="txa mono" id="agPrompt" rows="9" placeholder="Describe the agent's persona, how it should behave, and its boundaries…">${OnbEsc(draft.prompt)}</textarea>
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
            <button data-mode="pick" class="${draft._firstMode === "pick" ? "on" : ""}">${OnbIcon("tasks", "")}Pick existing task</button>
            <button data-mode="describe" class="${draft._firstMode === "describe" ? "on" : ""}">${OnbIcon("plus", "")}Describe a task</button>
            <button data-mode="none" class="${draft._firstMode === "none" ? "on" : ""}">${OnbIcon("clock", "")}Not yet</button>
          </div>
          <div class="ftbody" id="ftBody"></div>
        </div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn ghost" data-go="fork">Back</button>
      <span class="grow"></span>
      <span class="note">You're the authority — creating an agent doesn't wake it.</span>
      <button class="btn" id="agCreate">${OnbIcon("check", "")}Create ${first ? "agent" : ""}</button>
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
        ? `<div class="picklist">${rtsLive.map((t) => `<div class="pl ${draft._pickId === t.id ? "on" : ""}" data-pickid="${OnbEsc(t.id)}">
            <span class="rad"></span><div class="grow"><div class="t1">${OnbEsc(t.title)}</div><div class="t2">${OnbEsc(O.trunc(t.definition_of_done || "", 70))}</div></div></div>`).join("")}</div>`
        : `<div class="none" style="padding:16px">No ready unassigned tasks. Switch to <b>Describe a task</b>, or leave it for now.</div>`;
      body.querySelectorAll("[data-pickid]").forEach((el) => el.addEventListener("click", () => {
        draft._pickId = el.dataset.pickid; save(); renderFt();
      }));
    } else if (draft._firstMode === "describe") {
      body.innerHTML = `<textarea class="txa" id="ftDesc" rows="3" placeholder="Describe the first task in plain language — e.g. &quot;Stand up the schema_migrations runner so we can ship migrations without wiping the volume.&quot;">${OnbEsc(draft._desc)}</textarea>
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
  return MODELS.map((m) => `<button type="button" class="m ${m.id === selected ? "on" : ""}" data-model="${OnbEsc(m.id)}">
    ${OnbIcon("check", "tick")}
    <div class="mn">${OnbEsc(m.name || m.id)}</div></button>`).join("");
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
