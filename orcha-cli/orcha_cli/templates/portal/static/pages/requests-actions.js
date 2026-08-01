/* Requests page controller: detail rendering, request actions, selection, and refresh loop. */
function renderDetail(force) {
  const r = reqs().find((x) => x.id === sel);
  if (!r) { ReqO.patch(Req$("detailMain"), '<div class="card pad"><div class="none">Request not found.</div></div>', force); return; }
  const escd = isToHuman(r) && r.status === "open";
  const fa = ReqO.agentByAlias(r.from), ta = ReqO.agentByAlias(r.to);

  let html = `<div class="card pad" style="margin-bottom:18px">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div class="flowbig">
        <a class="node" href="/agents?agent=${encodeURIComponent(r.from)}" style="color:inherit">${ReqO.avatar(r.from, fa ? fa.kind : "ai", "sm")}${ReqO.esc(r.from)}</a>
        <span class="arrow">${ReqO.icon("arrow", "")}</span>
        <a class="node" href="${r.to === "human" ? "#" : "/agents?agent=" + encodeURIComponent(r.to)}" style="color:inherit">${ReqO.avatar(r.to, r.to === "human" ? "human" : (ta ? ta.kind : "ai"), "sm")}${ReqO.esc(partyLabel(r.to))}</a>
      </div>
      ${ReqO.pill(escd ? "escalated" : r.status, "lg")}
    </div>
    <div class="row" style="gap:10px;margin-top:14px;flex-wrap:wrap">
      <span class="tag">${ReqO.esc(r.type)} request</span>
      <span class="prio ${r.priority<=20?'p-hi':r.priority<=40?'p-md':''}">Priority ${ReqO.esc(r.priority)}</span>
      <span class="muted" style="font-size:12.5px">· opened ${r.created_at ? ReqO.relTime(r.created_at) : "—"}</span>
      ${r.task_link && r.task_link.task_id ? `<span class="muted" style="font-size:12.5px">· in service of</span> ${ReqO.taskLink(r.task_link.task_id)}` : ""}
      ${escd ? `<span class="tag" style="color:var(--danger);margin-left:auto">${ReqO.icon("flag", "")}escalated to you</span>` : ""}
    </div>
  </div>`;

  html += chainView(r);

  html += `<div class="card pad" style="margin-bottom:18px">
    <div class="field" style="margin-bottom:18px"><div class="lbl">${ReqO.icon("dot", "")}Payload</div><div class="payload md">${ReqO.mdText(r.payload)}</div></div>
    ${r.response ? `<div class="field" style="margin-bottom:18px"><div class="lbl" style="color:var(--ok)">${ReqO.icon("check", "")}Answer · from ${ReqO.esc(partyLabel(r.to))}</div><div class="answer md">${ReqO.mdText(r.response)}</div></div>` : ""}
    ${r.rejection_reason ? `<div class="field" style="margin-bottom:18px"><div class="lbl" style="color:var(--danger)">${ReqO.icon("x", "")}Rejected — reason</div><div class="answer rej md">${ReqO.mdText(r.rejection_reason)}</div></div>` : ""}
    <div class="field"><div class="lbl">${ReqO.icon("shield", "")}Your move</div>${actionsFor(r)}</div>
  </div>`;

  // only (re)wire when patch actually replaced the DOM (see tasks.html note).
  if (ReqO.patch(Req$("detailMain"), html, force)) wire(r);
}

/* ---------- wiring + real POSTs ---------- */
function postJSON(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function wire(r) {
  Req$("detailMain").querySelectorAll(".chain .clink[data-id]").forEach((c) => c.addEventListener("click", () => select(c.dataset.id)));
  // ISS-79: the inline answer prompt's "Send answer"/"Cancel" buttons render as siblings
  // OUTSIDE #reqacts, so a box-scoped query left them unwired — clicking Send was a no-op
  // (no submit, no /respond call). Wire every data-act control in the detail pane instead.
  const acts = Req$("detailMain").querySelectorAll("[data-act]");
  if (!acts.length) return;
  acts.forEach((b) => b.addEventListener("click", () => onAction(b.dataset.act, r)));
  const ai = Req$("ansIn"); if (ai) ai.focus();
}
function onAction(act, r) {
  const h = ReqO.actingHuman();
  if (!h) { ReqO.toast("Pick an acting human (top-right) first.", "danger"); return; }
  if (act === "answer") { answering = true; renderDetail(); return; }
  if (act === "cancel-answer") {
    // clear+blur the box so the ISS-53 dirty-input guard doesn't block the cancel repaint
    const ai = Req$("ansIn"); if (ai) { ai.value = ""; ai.blur(); }
    answering = false; renderDetail(); return;
  }
  if (act === "send-answer") {
    const v = (Req$("ansIn").value || "").trim(); if (!v) return;
    const ai = Req$("ansIn");
    postJSON("/api/requests/" + encodeURIComponent(r.id) + "/respond", { responder_agent_id: h.id, response: v })
      .then((res) => { ReqO.toast(res.ok ? "Answer sent to " + r.from : "Failed (" + res.status + ")", res.ok ? "ok" : "danger");
        // clear+blur the answer box so the dirty-input guard doesn't block the repaint
        if (res.ok) { if (ai) { ai.value = ""; ai.blur(); } answering = false; renderList(); renderDetail(); } });
    return;
  }
  if (act === "escalate") {
    ReqO.modal({ title: "Escalate to a human?", desc: "Re-targets this request to the human authority. Only the requester can escalate.",
      primary: "Escalate", onPrimary: () => { ReqO.closeModal();
        postJSON("/api/requests/" + encodeURIComponent(r.id) + "/escalate", { requester_agent_id: h.id })
          .then((res) => { ReqO.toast(res.ok ? "Escalated to human" : "Failed (" + res.status + ")", res.ok ? "ok" : "danger"); if (res.ok) { renderList(); renderDetail(); } }); } });
    return;
  }
  if (act === "convert") {
    ReqO.modal({ title: "Convert to a task", desc: "Spawn a tracked task from this answered request — assigned, with a definition of done.",
      body: `<div class="field" style="margin-bottom:12px"><div class="lbl">Title</div><input id="ctT" class="ans-in" style="min-height:0" value="${ReqO.esc("From request: " + ReqO.trunc(r.payload, 48))}"></div>
        <div class="field" style="margin-bottom:12px"><div class="lbl">Definition of done</div><textarea id="ctDod" class="ans-in" style="min-height:60px" placeholder="When is this task done?"></textarea></div>
        <div class="field"><div class="lbl">Assign to</div><select id="ctA" class="ans-in" style="min-height:0">${(ReqD().agents || []).filter((a) => a.kind === "ai").map((a) => `<option>${ReqO.esc(a.alias)}</option>`).join("")}</select></div>`,
      primary: "Create task", approve: true,
      onPrimary: () => { const title = (Req$("ctT").value || "").trim(), dod = (Req$("ctDod").value || "").trim(), assignee = Req$("ctA").value;
        if (!title || !dod) { ReqO.toast("Title and definition of done are required.", "danger"); return; }
        ReqO.closeModal();
        postJSON("/api/requests/" + encodeURIComponent(r.id) + "/convert-to-task", { requester_agent_id: h.id, title, definition_of_done: dod, assignee_alias: assignee })
          .then((res) => { ReqO.toast(res.ok ? "Task created from request" : "Failed (" + res.status + ")", res.ok ? "ok" : "danger"); if (res.ok) { renderList(); renderDetail(); } }); } });
    return;
  }
  if (act === "nudge") {
    // #60: standalone nudge — wakes whoever owns the next action. Never changes state.
    const whom = r.status === "answered" ? r.from + " (they must act on the answer or close it)" : (r.to || "the agent handling it") + " (they still owe an answer)";
    ReqO.modal({ title: "Nudge this request?", desc: "Wakes " + whom + ". This does NOT change the request — it just prompts them to act.",
      body: `<textarea id="ndN" class="ans-in" style="min-height:64px" placeholder="Optional note to include in the nudge…"></textarea>`,
      primary: "Send nudge", onPrimary: () => { const note = (Req$("ndN").value || "").trim(); ReqO.closeModal();
        postJSON("/api/requests/" + encodeURIComponent(r.id) + "/nudge", { actor_agent_id: h.id, note: note || undefined })
          .then((res) => res.json().then((j) => ({ ok: res.ok, status: res.status, j })).catch(() => ({ ok: res.ok, status: res.status, j: {} })))
          .then((res) => { ReqO.toast(!res.ok ? "Failed (" + res.status + ")" : (res.j.nudged ? "Nudged the " + (res.j.nudged_role || "agent") : "No agent to wake — a human owns the next action"), res.ok ? "ok" : "danger"); }); } });
    return;
  }
  if (act === "close") {
    ReqO.modal({ title: "Close this request?", desc: "Marks it resolved. " + r.from + " sees it closed on the next sync. A reason is required if it isn't yours.",
      body: `<textarea id="clR" class="ans-in" style="min-height:64px" placeholder="Reason (required when closing someone else's request)…"></textarea>`,
      primary: "Close request", danger: true,
      onPrimary: () => { const reason = (Req$("clR").value || "").trim(); ReqO.closeModal();
        postJSON("/api/requests/" + encodeURIComponent(r.id) + "/close", { requester_agent_id: h.id, reason: reason || undefined })
          .then((res) => { ReqO.toast(res.ok ? "Request closed" : (res.status === 422 ? "A reason is required to close another agent's request." : "Failed (" + res.status + ")"), res.ok ? "ok" : "danger"); if (res.ok) { renderList(); renderDetail(); } }); } });
    return;
  }
}

/* ---------- selection ---------- */
function select(id) {
  if (id === sel) return;
  sel = id; answering = false; pendingScroll = true;   // ISS-38: keep the picked row anchored in view
  const u = new URL(location.href); u.searchParams.set("req", id); history.replaceState(null, "", u);
  renderList(); renderDetail(true); window.scrollTo({ top: 0 });   // ISS-57: force the detail swap past the selection/input guard
}
Req$("rlist").addEventListener("click", (ev) => {
  if (ev.target.closest(".sortctl")) return;   // ISS-331: handled by wireSortControl below
  if (ev.target.closest("[data-loadmore]")) { reqsShown += REQS_PAGE; renderList(); return; }
  const f = ev.target.closest("[data-f]"); if (f) { filter = f.dataset.f; reqsShown = REQS_PAGE; renderList(); return; }
  const b = ev.target.closest("[data-id]"); if (b) select(b.dataset.id);
});
// ISS-331: re-sort on control change (single delegated binding on the stable list container)
ReqO.wireSortControl(Req$("rlist"), () => renderList());

/* ---------- boot ---------- */
function render() {
  if (!ReqD() || !ReqD().container) return;
  if (!sel || !reqs().some((r) => r.id === sel)) sel = firstSel();
  ReqO.mountShell("requests", { title: "Requests", ctx: reqs().length + " requests · " + ReqD().container.name });
  renderList(); renderDetail();
}
window.OrchaData.start(render, 3000);
