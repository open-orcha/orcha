/* Onboarding flow module: editable proposed agents/tasks and shared navigation wiring. */
/* ---- G3 · review + edit the proposed roster, then commit (the walk) --- */
function stepProposeRoster(main) {
  const r = S._roster;
  if (!r || !r.agents || !r.agents.length) { go("propose-goal"); return; }

  const agentNames = () => r.agents.map((a) => a.name).filter(Boolean);
  const agentCard = (a, i) => `<div class="rcard" data-aidx="${i}">
    <div class="rc-h">${OnbAvatar(a.name || "?", "ai", "sm")}
      <div class="grow"><input class="ipt rc-name" data-aidx="${i}" value="${OnbEsc(a.name)}" placeholder="Agent name" autocomplete="off" spellcheck="false">
      <input class="ipt rc-role" data-aidx="${i}" value="${OnbEsc(a.role)}" placeholder="Role — e.g. Builder · implementation" autocomplete="off"></div>
      <button class="rdel" data-adel="${i}" title="Remove agent">${OnbIcon("x", "")}</button></div>
    <textarea class="txa mono rc-charter" data-aidx="${i}" rows="5" placeholder="System prompt / charter">${OnbEsc(a.charter)}</textarea>
    <div class="rc-models" data-aidx="${i}">${modelCards(a.model)}</div>
  </div>`;

  const taskRow = (t, i) => {
    const opts = [`<option value=""${t.assignee ? "" : " selected"}>Unassigned (standalone)</option>`]
      .concat(agentNames().map((n) => `<option value="${OnbEsc(n)}"${t.assignee === n ? " selected" : ""}>${OnbEsc(n)}</option>`)).join("");
    const deps = (t.depends_on || []).length ? `<span class="rt-dep">${OnbIcon("link", "")}after: ${OnbEsc(t.depends_on.join(", "))}</span>` : "";
    const proto = t.protocol ? `<span class="rt-proto">${OnbIcon("flag", "")}protocol</span>` : "";
    return `<div class="rtask" data-tidx="${i}">
      <div class="rt-top">
        <input class="ipt rt-title" data-tidx="${i}" value="${OnbEsc(t.title)}" placeholder="Task title" autocomplete="off">
        <button class="rdel" data-tdel="${i}" title="Remove task">${OnbIcon("x", "")}</button>
      </div>
      <textarea class="txa rt-dod" data-tidx="${i}" rows="2" placeholder="Definition of done">${OnbEsc(t.definition_of_done)}</textarea>
      <div class="rt-meta">
        <label class="rt-assign">Assignee <select class="sel rt-assignee" data-tidx="${i}">${opts}</select></label>
        <label class="rt-kick"><input type="checkbox" class="rt-kickoff" data-tidx="${i}" ${t.is_kickoff ? "checked" : ""} ${t.assignee ? "" : "disabled"}> First task (kickoff)</label>
        ${deps}${proto}
      </div>
    </div>`;
  };

  main.innerHTML = `<div class="ob wide">
    <div class="form-h">
      <span class="fic">${OnbIcon("spark", "")}</span>
      <div><h2>Your proposed roster</h2>
      <p>Review and edit anything — names, prompts, models, tasks, who owns what. Nothing is created until you choose to. You'll confirm each agent in the create form before it's committed.</p></div>
    </div>
    ${r.rationale ? `<div class="rationale">${OnbIcon("spark", "")}<span>${OnbEsc(r.rationale)}</span></div>` : ""}

    <div class="rsec-h">${OnbIcon("agents", "")}<span>Agents</span><span class="grow"></span><button class="addrow" id="rAddAgent">${OnbIcon("plus", "")}Add agent</button></div>
    <div class="rgrid" id="rAgents">${r.agents.map(agentCard).join("")}</div>

    <div class="rsec-h" style="margin-top:24px">${OnbIcon("tasks", "")}<span>Tasks</span><span class="grow"></span><button class="addrow" id="rAddTask">${OnbIcon("plus", "")}Add task</button></div>
    <div class="rtasks" id="rTasks">${r.tasks.length ? r.tasks.map(taskRow).join("") : `<div class="none" style="padding:18px">No tasks proposed — add one, or create agents and add work later.</div>`}</div>

    <div class="form-actions">
      <button class="btn ghost" data-go="propose-goal">${OnbIcon("arrow", "")}Back</button>
      <span class="grow"></span>
      <span class="note">Kickoff tasks become each agent's first task; the rest become ready tasks.</span>
      <button class="btn" id="rCommit">${OnbIcon("check", "")}Looks good — create the team</button>
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
