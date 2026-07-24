/* Agents page controller: agent controls and worker-run rendering. */
function fmtInterval(secs) {
  if (secs == null) return "Off";
  if (secs % 3600 === 0) return (secs / 3600) + "h";
  if (secs % 60 === 0) return (secs / 60) + "m";
  return secs + "s";
}
// presets for the current value: the fixed set, plus a dynamic chip if the live cadence
// isn't one of them (so an API-set 10m never renders as a silently-unselected "Off").
function awakePresets(current) {
  if (current == null || AWAKE_PRESETS.some((p) => p.secs === current)) return AWAKE_PRESETS;
  return AWAKE_PRESETS.concat([{ secs: current, label: fmtInterval(current) }]);
}
function onAwakeClick(ev) {
  const b = ev.target.closest("[data-awake]"); if (!b || b.disabled) return;
  const seg = b.closest("#awakeSeg"); const aid = seg && seg.dataset.agent;
  const h = AgeO.actingHuman();
  if (!aid || !h) { AgeO.toast("Pick an acting human first.", "danger"); return; }
  const interval = b.dataset.awake === "null" ? null : parseInt(b.dataset.awake, 10);
  const a = AgeO.agentById(aid); if (!a) return;
  const prev = a.auto_wake_interval_secs != null ? a.auto_wake_interval_secs : null;
  if (interval === prev) return;                 // no-op (re-click of the active chip)
  a.auto_wake_interval_secs = interval;          // optimistic; reconciled by the next snapshot
  renderDetailMain(true);
  fetch("/api/agents/" + encodeURIComponent(aid) + "/auto-wake", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor_agent_id: h.id, interval_secs: interval }),
  }).then((r) => {
    if (!r.ok) { a.auto_wake_interval_secs = prev; renderDetailMain(true);   // revert on failure
      AgeO.toast("Auto-wake change failed (" + r.status + ")", "danger"); return; }
    AgeO.toast(interval == null ? "Auto-wake off" : ("Auto-wake every " + fmtInterval(interval)), "ok");
  }).catch((e) => { a.auto_wake_interval_secs = prev; renderDetailMain(true);
    AgeO.toast("Auto-wake change failed: " + e.message, "danger"); });
}

/* ---------- model control (POST /api/agents/{id}/model) ---------- */
function onModelRuntimeClick(ev) {
  const b = ev.target.closest("[data-runtime]"); if (!b || b.disabled) return;
  const seg = b.closest("#modelRuntimeSeg"); const aid = seg && seg.dataset.agent;
  const h = AgeO.actingHuman();
  if (!aid || !h) { AgeO.toast("Pick an acting human first.", "danger"); return; }
  const runtime = b.dataset.runtime === "codex" ? "codex" : "claude";
  modelRuntimeFilters[aid] = runtime;
  renderDetailMain(true);
}

function onModelClick(ev) {
  const b = ev.target.closest("[data-model]"); if (!b || b.disabled) return;
  const seg = b.closest("#modelSeg"); const aid = seg && seg.dataset.agent;
  const h = AgeO.actingHuman();
  if (!aid || !h) { AgeO.toast("Pick an acting human first.", "danger"); return; }
  const model = b.dataset.model;   // the curated id (POST /model only accepts ids)
  const name = (MODELS.find((m) => m.id === model) || {}).name || model;
  modelRuntimeFilters[aid] = modelRuntimeOf(model);
  seg.querySelectorAll("[data-model]").forEach((x) => {
    x.classList.remove("on");
    x.setAttribute("aria-pressed", "false");
  });
  b.classList.add("on");
  b.setAttribute("aria-pressed", "true");
  fetch("/api/agents/" + encodeURIComponent(aid) + "/model", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  }).then((r) => AgeO.toast(r.ok ? ("Model → " + name) : ("Failed (" + r.status + ")"), r.ok ? "ok" : "danger"))
    .catch((e) => AgeO.toast("Failed: " + e.message, "danger"));
}

function onEffortClick(ev) {
  const b = ev.target.closest("[data-effort]"); if (!b || b.disabled) return;
  const seg = b.closest("#effortSeg"); const aid = seg && seg.dataset.agent;
  const h = AgeO.actingHuman();
  if (!aid || !h) { AgeO.toast("Pick an acting human first.", "danger"); return; }
  const effort = b.dataset.effort === "null" ? null : b.dataset.effort;
  const a = AgeO.agentById(aid); if (!a) return;
  const prev = a.reasoning_effort != null ? a.reasoning_effort : null;
  if (effort === prev) return;
  a.reasoning_effort = effort;          // optimistic; reconciled by the next snapshot
  renderDetailMain(true);
  fetch("/api/agents/" + encodeURIComponent(aid) + "/reasoning-effort", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reasoning_effort: effort }),
  }).then((r) => {
    if (!r.ok) {
      a.reasoning_effort = prev;
      renderDetailMain(true);
      AgeO.toast("Reasoning effort change failed (" + r.status + ")", "danger");
      return;
    }
    const label = (REASONING_EFFORTS.find((x) => x.id === effort) || {}).name || effort || "Default";
    AgeO.toast("Reasoning effort -> " + label, "ok");
  }).catch((e) => {
    a.reasoning_effort = prev;
    renderDetailMain(true);
    AgeO.toast("Reasoning effort change failed: " + e.message, "danger");
  });
}

/* ---------- worker runs (live feed) — built on agent change / run-set change ---------- */
function renderRuns(force) {
  const a = AgeO.agentByAlias(sel);
  if (!a) { Age$("runsWrap").innerHTML = ""; return; }
  const myToken = ++runsToken;
  fetch("/api/agents/" + encodeURIComponent(a.id) + "/runs")
    .then((r) => r.ok ? r.json() : Promise.reject(r.status))
    .then((d) => {
      if (myToken !== runsToken || sel !== a.alias) return;   // a newer select superseded us
      const runs = Array.isArray(d) ? d : (d.runs || []);
      const sig = runs.map((x) => (x.run_id || x.id) + ":" + x.status).join("|");
      if (!force && a.alias === runsAgent && sig === runsSig) return;   // nothing changed; keep live streams
      runsAgent = a.alias; runsSig = sig;
      if (stopRuns) { stopRuns(); stopRuns = null; }
      const live = runs.some((x) => x.status === "running");
      Age$("runsWrap").innerHTML = `<div class="card">
        <div class="card-h"><h3>Worker runs</h3><span class="grow"></span>
          ${live ? '<span class="live accent"><span class="d"></span>live stream</span>' : '<span class="muted" style="font-size:11.5px">'+runs.length+' run'+(runs.length===1?"":"s")+'</span>'}</div>
        <div class="card-b" style="padding:13px 14px">
          <p class="muted" style="font-size:12.5px;margin:0 0 12px">Each wake is a fresh headless worker — classified into 9 event types, collapsible by section. ${AgeO.esc(a.alias)} is one continuous agent across all of them.</p>
          ${runs.length ? runs.map((r) => AgeO.runCard(r)).join("") : '<div class="none">No worker runs yet.</div>'}
        </div></div>`;
      stopRuns = AgeO.activateRuns(runs);
    })
    .catch(() => {
      if (myToken !== runsToken) return;
      if (a.alias !== runsAgent) { runsAgent = a.alias; runsSig = ""; Age$("runsWrap").innerHTML =
        '<div class="card"><div class="card-h"><h3>Worker runs</h3></div><div class="card-b" style="padding:14px"><div class="none">Run feed unavailable.</div></div></div>'; }
    });
}

/* ---------- conversation panel (S1) — mounted in #convWrap, remounted on agent change ---------- */
let convAgent = null;
function mountConv(a) {
  if (!window.OrchaConvo) return;
  if (!a || a.kind === "human") { if (convAgent !== null) { OrchaConvo.teardown(); convAgent = null; } return; }
  if (a.id === convAgent) return;   // already mounted for this agent (don't remount each tick)
  convAgent = a.id;
  OrchaConvo.mount(Age$("convWrap"), a.id);
}
