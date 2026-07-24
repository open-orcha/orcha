/* Tasks page controller: run rendering, selection, refresh loop, and boot wiring. */
function renderRuns(force) {
  const t = (TasD().tasks || []).find((x) => x.id === sel);
  if (!t) { Tas$("runsWrap").innerHTML = ""; return; }
  const myToken = ++runsToken;
  fetch("/api/tasks/" + encodeURIComponent(t.id) + "/runs").then((r) => r.ok ? r.json() : Promise.reject(r.status))
    .then((d) => {
      if (myToken !== runsToken || sel !== t.id) return;
      const runs = Array.isArray(d) ? d : (d.runs || []);
      const sig = runs.map((x) => (x.run_id || x.id) + ":" + x.status).join("|");
      if (!force && t.id === runsTask && sig === runsSig) return;
      runsTask = t.id; runsSig = sig;
      if (stopRuns) { stopRuns(); stopRuns = null; }
      const live = runs.some((x) => x.status === "running");
      Tas$("runsWrap").innerHTML = `<div class="card">
        <div class="card-h"><h3>Runs &amp; diffs</h3><span class="grow"></span>
          ${live ? '<span class="live accent"><span class="d"></span>live</span>' : '<span class="muted" style="font-size:11.5px">'+runs.length+' run'+(runs.length===1?"":"s")+'</span>'}</div>
        <div class="card-b" style="padding:13px 14px">
          ${runs.length ? runs.map((r) => TasO.runCard(r)).join("") : '<div class="none">No runs yet — appears when a worker wakes for this task.</div>'}
        </div></div>`;
      stopRuns = TasO.activateRuns(runs);
    })
    .catch(() => { if (myToken === runsToken && t.id !== runsTask) { runsTask = t.id; runsSig = "";
      Tas$("runsWrap").innerHTML = '<div class="card"><div class="card-h"><h3>Runs &amp; diffs</h3></div><div class="card-b" style="padding:14px"><div class="none">Run feed unavailable.</div></div></div>'; } });
}

/* ---------- selection ---------- */
function select(id) {
  if (id === sel) return;
  sel = id;
  const u = new URL(location.href); u.searchParams.set("task", id); history.replaceState(null, "", u);
  if (stopRuns) { stopRuns(); stopRuns = null; }
  runsTask = null; runsSig = "";
  renderList(); renderDetail(true); renderRuns(true);   // ISS-57: force the detail swap past the selection/input guard
  window.scrollTo({ top: 0 });
}
Tas$("tlist").addEventListener("click", (ev) => {
  if (ev.target.closest(".sortctl")) return;   // ISS-331: handled by wireSortControl below
  if (ev.target.closest("[data-newtask]")) { openNewTaskModal(); return; }
  if (ev.target.closest("[data-loadmore]")) { tasksShown += TASKS_PAGE; renderList(); return; }
  const b = ev.target.closest("[data-id]"); if (b) select(b.dataset.id);
});
// ISS-331: re-sort on control change (single delegated binding on the stable list container)
TasO.wireSortControl(Tas$("tlist"), () => renderList());

/* #301: image lightbox — delegated click (bound once). An in-thread image thumbnail opens a
   full-size overlay; click anywhere (or Esc) closes it. */
document.addEventListener("click", (ev) => {
  const img = ev.target.closest("[data-lightbox]"); if (!img) return;
  const url = img.getAttribute("data-lightbox"); if (!url) return;
  const box = document.createElement("div"); box.className = "att-lightbox";
  box.innerHTML = `<img src="${TasO.esc(url)}" alt="">`;
  const close = () => box.remove();
  box.addEventListener("click", close);
  document.addEventListener("keydown", function onKey(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } });
  document.body.appendChild(box);
});

/* ---------- boot ---------- */
function render() {
  if (!TasD() || !TasD().container) return;
  if (!sel || !(TasD().tasks || []).some((t) => t.id === sel)) sel = firstSel();
  TasO.mountShell("tasks", { title: "Tasks", ctx: (TasD().tasks || []).length + " tasks · " + TasD().container.name });
  renderList(); renderDetail();
  if (sel) renderRuns(false);
}
window.OrchaData.start(render, 3000);
