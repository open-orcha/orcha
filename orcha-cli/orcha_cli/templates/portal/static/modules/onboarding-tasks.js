/* Onboarding flow module: local task queue and standalone task posting. */
/* ---- 3b · CREATE TASKS (queue locally, then POST each as a standalone ready task) -- */
function stepCreateTasks(main) {
  main.innerHTML = `<div class="ob">
    <div class="form-h">
      <span class="fic" style="background:var(--violet-soft);border-color:var(--violet-line);color:var(--violet)">${OnbIcon("tasks", "")}</span>
      <div><h2>Add your first tasks</h2><p>Capture the work as tasks — each with a clear definition of done. Next, create an agent and these become its first task.</p></div>
    </div>

    <div id="tqWrap"></div>

    <div class="taskform">
      <div class="tf-h">${OnbIcon("plus", "")}New task</div>
      <div class="field2">
        <div class="lab">Title <span class="req">*</span></div>
        <input class="ipt" id="tkTitle" placeholder="e.g. Persist + expose worker output" autocomplete="off">
      </div>
      <div class="field2" style="margin-bottom:8px">
        <div class="lab">Definition of done <span class="req">*</span></div>
        <textarea class="txa" id="tkDod" rows="2" placeholder="The unambiguous finish line — how you'll know it's done."></textarea>
      </div>
      <div style="display:flex;justify-content:flex-end"><button class="btn subtle" id="tkAdd">${OnbIcon("plus", "")}Add task</button></div>
    </div>

    <div class="form-actions">
      <button class="btn ghost" data-go="fork">Back</button>
      <span class="grow"></span>
      <span class="note" id="tkCount"></span>
      <button class="btn" id="tkContinue">${OnbIcon("agents", "")}Continue — create an agent ${OnbIcon("arrow", "")}</button>
    </div>
  </div>`;

  const renderQueue = () => {
    const wrap = document.getElementById("tqWrap");
    wrap.innerHTML = S.tasks.length
      ? `<div class="taskqueue">${S.tasks.map((t, i) => `<div class="tq">
          <span class="num">${i + 1}</span>
          <div class="grow"><div class="tt">${OnbEsc(t.title)}</div><div class="dod">${OnbEsc(t.dod)}</div></div>
          <button class="del" data-del="${i}" title="Remove">${OnbIcon("x", "")}</button></div>`).join("")}</div>`
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
