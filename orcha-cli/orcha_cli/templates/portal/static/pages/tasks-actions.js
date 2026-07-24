/* Tasks page controller: actor helpers, assignment, new-task modal, and task posting. */
function actor() { return TasO.actingHuman(); }
function actorName() { const h = actor(); return h ? h.alias : ""; }
function humanAvatar() { const h = actor(); return h ? TasO.avatar(h.alias, "human", "sm") : ""; }
function actorOrWarn() { const h = actor(); if (!h) TasO.toast("Pick an acting human (top-right) first.", "danger"); return h; }

/* ---------- wiring + real POSTs ---------- */
function postJSON(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function patchJSON(url, body) {
  return fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
// O4: confirm + POST the assignment. Copy matches Forge's B5 reassign policy — a plain
// assign when free, a release-and-reassign confirm when someone else is already on it.
function doAssign(t) {
  const h = actorOrWarn(); if (!h) return;
  const sel = Tas$("assignSel"); if (!sel || !sel.value) return;
  const agentId = sel.value;
  const ai = (TasD().agents || []).find((x) => x.id === agentId);
  const alias = ai ? ai.alias : "the agent";
  // The /assign endpoint is the AUTHORITY on assignment state — B5 handles the
  // same-assignee case idempotently, races, AND multiple prior active assignees. We do
  // NOT pre-decide from the snapshot's single display alias (t.assignee = assignees[0],
  // possibly stale): just confirm intent, POST reassign=false, and let a 409 drive the
  // reassign flow (review P2). Never short-circuit the request client-side.
  TasO.modal({
    title: "Assign task?",
    desc: "Assign to " + alias + "? This wakes them to start the task.",
    primary: "Assign & wake", approve: true,
    onPrimary: () => { TasO.closeModal(); postAssign(t, h.id, agentId, alias, false); },
  });
}
function postAssign(t, actorId, agentId, alias, reassign) {
  postJSON("/api/tasks/" + encodeURIComponent(t.id) + "/assign", { actor_agent_id: actorId, agent_id: agentId, reassign: reassign })
    .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, d })).catch(() => ({ ok: r.ok, status: r.status, d: {} })))
    .then(({ ok, status, d }) => {
      if (ok) {
        const nm = d.alias || alias;
        let msg = d.woke ? "Woke " + nm + " to start the task"
                : d.status === "pending" ? "Assigned to " + nm + " — starts when dependencies clear"
                : "Assigned to " + nm;
        if (d.released_prior && d.released_prior.length) msg += " · previous assignee released";
        TasO.toast(msg, "ok");
        renderList(); renderDetail();
        return;
      }
      // race: client thought it was free but B5 sees a different active assignee -> offer reassign
      if (status === 409 && !reassign && /different active assignee/i.test(d.detail || "")) {
        TasO.modal({ title: "Reassign task?", desc: "This task already has a different active assignee. Reassign to " + alias + "? They'll be released.",
          primary: "Reassign & wake", approve: true, onPrimary: () => { TasO.closeModal(); postAssign(t, actorId, agentId, alias, true); } });
        return;
      }
      TasO.toast("Assign failed (" + status + ")" + (d.detail ? ": " + d.detail : ""), "danger");
    });
}

/* ---------- create-task (human authority) — POST /api/containers/{cid}/tasks ----------
   The enabler so a human can create+assign from the portal (then test assign->wake).
   created_by resolves the acting human server-side via created_by_agent_id. */
function openNewTaskModal() {
  const h = actorOrWarn(); if (!h) return;
  const cid = TasD().container && TasD().container.id;
  if (!cid) { TasO.toast("No container loaded.", "danger"); return; }
  const ais = (TasD().agents || []).filter((x) => x.kind === "ai");
  const aOpts = `<option value="">— Unassigned —</option>`
    + ais.map((x) => `<option value="${TasO.esc(x.alias)}">${TasO.esc(x.alias)}</option>`).join("");
  // depends_on: optional multi-select of NON-terminal tasks (a finished task as a blocker is
  // meaningless; the server validates UUIDs but we keep the list scoped + readable).
  const TERMINAL = ["completed", "cancelled"];
  const deps = (TasD().tasks || []).filter((t) => TERMINAL.indexOf(t.status) < 0);
  const dOpts = deps.map((t) => `<option value="${TasO.esc(t.id)}">${TasO.esc(TasO.trunc(t.title, 70))}</option>`).join("");
  const body = `
    <div class="field"><div class="lbl">${TasO.icon("dot", "")}Title <span style="color:var(--danger)">*</span></div>
      <input id="nt_title" class="reply-in" style="width:100%" placeholder="Short, action-oriented title" maxlength="200"></div>
    <div class="field" style="margin-top:12px"><div class="lbl">Description</div>
      <textarea id="nt_desc" class="reply-in" style="width:100%;min-height:64px;resize:vertical" placeholder="Optional — context, links, scope"></textarea></div>
    <div class="field" style="margin-top:12px"><div class="lbl">${TasO.icon("check", "")}Definition of done <span style="color:var(--danger)">*</span></div>
      <textarea id="nt_dod" class="reply-in" style="width:100%;min-height:64px;resize:vertical" placeholder="What must be true for this task to be considered complete"></textarea></div>
    <div class="row" style="gap:12px;margin-top:12px;flex-wrap:wrap">
      <div class="field" style="flex:0 0 120px"><div class="lbl">Priority</div>
        <input id="nt_pri" class="reply-in" type="number" value="100" min="1" style="width:100%" title="Lower = higher priority"></div>
      <div class="field" style="flex:1;min-width:180px"><div class="lbl">Assignee</div>
        <select id="nt_assignee" class="reply-in" style="width:100%">${aOpts}</select></div>
    </div>
    ${dOpts ? `<div class="field" style="margin-top:12px"><div class="lbl">Depends on <span class="muted" style="font-weight:450;text-transform:none;letter-spacing:0">— optional; ⌘/Ctrl-click to multi-select</span></div>
      <select id="nt_deps" class="reply-in" multiple size="4" style="width:100%">${dOpts}</select></div>` : ""}
    <details class="field" style="margin-top:12px">
      <summary style="cursor:pointer;font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:650;color:var(--faint)">Protocol <span class="muted" style="font-weight:450;text-transform:none;letter-spacing:0">— optional; the multi-agent loop rules the assignee reads on its first wake</span></summary>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
        <div class="field"><div class="lbl">Review chain</div>
          <textarea id="nt_p_chain" class="reply-in" style="width:100%;min-height:48px;resize:vertical" placeholder="e.g. Builder → Reviewer → loop until clean → human"></textarea></div>
        <div class="field"><div class="lbl">Hand-off to</div>
          <textarea id="nt_p_handoff" class="reply-in" style="width:100%;min-height:48px;resize:vertical" placeholder="Who the assignee returns to first when done"></textarea></div>
        <div class="field"><div class="lbl">Autonomy</div>
          <textarea id="nt_p_autonomy" class="reply-in" style="width:100%;min-height:48px;resize:vertical" placeholder="Free-text — how far the assignee may go before checking in"></textarea></div>
        <div class="field"><div class="lbl">Notes</div>
          <textarea id="nt_p_notes" class="reply-in" style="width:100%;min-height:48px;resize:vertical" placeholder="Any other standing rules for this task"></textarea></div>
      </div>
    </details>
    <div class="hint" id="nt_err" style="display:none;color:var(--danger);font-size:12px;margin-top:10px"></div>`;
  TasO.modal({
    title: "New task",
    desc: "Created by " + h.alias + " (you) and logged to the audit trail.",
    body,
    primary: "Create task", approve: true,
    onOpen: (ov) => { const ti = ov.querySelector("#nt_title"); if (ti) ti.focus(); },
    onPrimary: (ov) => submitNewTask(ov, cid, h.id),
  });
}

function submitNewTask(ov, cid, humanId) {
  const val = (id) => { const el = ov.querySelector(id); return el ? el.value.trim() : ""; };
  const title = val("#nt_title"), dod = val("#nt_dod");
  const err = ov.querySelector("#nt_err");
  const fail = (m) => { if (err) { err.textContent = m; err.style.display = "block"; } };
  if (!title) return fail("Title is required.");
  if (!dod) return fail("Definition of done is required.");
  let priority = parseInt(val("#nt_pri"), 10); if (!Number.isFinite(priority)) priority = 100;
  const assignee_alias = (ov.querySelector("#nt_assignee") || {}).value || null;
  const depsEl = ov.querySelector("#nt_deps");
  const depends_on = depsEl ? Array.from(depsEl.selectedOptions).map((o) => o.value) : [];
  // #55: optional create-time protocol — send only the fields the user actually filled in, and
  // only attach `protocol` when at least one is set (so an untouched section persists as NULL).
  const proto = {};
  const pmap = { review_chain: "#nt_p_chain", handoff_to: "#nt_p_handoff", autonomy: "#nt_p_autonomy", notes: "#nt_p_notes" };
  Object.keys(pmap).forEach((k) => { const v = val(pmap[k]); if (v) proto[k] = v; });
  const btn = ov.querySelector("#__mp"); if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }
  postJSON("/api/containers/" + encodeURIComponent(cid) + "/tasks", {
    title, description: val("#nt_desc") || null, definition_of_done: dod,
    priority, created_by_agent_id: humanId,
    assignee_alias: assignee_alias || undefined, depends_on,
    protocol: Object.keys(proto).length ? proto : undefined,
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, d })).catch(() => ({ ok: r.ok, status: r.status, d: {} })))
    .then(({ ok, status, d }) => {
      if (ok) {
        TasO.closeModal();
        const where = d.status === "pending" ? " — starts when dependencies clear"
          : d.assignee_alias ? " · assigned to " + d.assignee_alias : "";
        TasO.toast("Task created" + where, "ok");
        // Don't repaint now — the new task isn't in the local snapshot yet, so renderDetail()
        // would flash "Task not found". Set sel; the 3s poll's render() picks it up (the task
        // now exists server-side, so render()'s validity check preserves this selection).
        if (d.task_id) sel = d.task_id;
        return;
      }
      if (btn) { btn.disabled = false; btn.textContent = "Create task"; }
      fail("Create failed (" + status + ")" + (d.detail ? ": " + (typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail)) : ""));
    })
    .catch(() => { if (btn) { btn.disabled = false; btn.textContent = "Create task"; } fail("Create failed — network error."); });
}

/* ---------- #301: attachment staging tray ---------- */
