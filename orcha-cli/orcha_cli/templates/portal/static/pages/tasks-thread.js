/* Tasks page controller: attachment tray, uploads, thread wiring, gates, and protocol saving. */
const ACCEPT_EXT = ["png","jpg","jpeg","gif","webp","pdf","txt","md","csv","log","json"];
const IMG_EXT = ["png","jpg","jpeg","gif","webp"];
const extOf = (n) => (String(n||"").split(".").pop() || "").toLowerCase();
function renderTray() {
  const tray = Tas$("attachTray"); if (!tray) return;
  tray.innerHTML = staged.map((s) => {
    const cls = s.status === "uploading" ? " uploading" : s.status === "failed" ? " failed" : "";
    const thumb = (s.status === "done" && s.ref && s.ref.kind === "image")
      ? `<img class="thumb" src="${TasO.esc(s.ref.url)}" alt="">`
      : `<span class="ic">${FILE_ICON}</span>`;
    const sub = s.status === "uploading" ? "uploading…" : s.status === "failed" ? "failed" : fmtSize(s.size);
    return `<span class="att-chip${cls}">${thumb}<span class="meta">
      <span class="nm">${TasO.esc(s.name)}</span><span class="sz">${sub}</span></span>
      <button type="button" class="rm" data-rm="${s.key}" title="Remove">×</button></span>`;
  }).join("");
  tray.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
    staged = staged.filter((s) => String(s.key) !== b.getAttribute("data-rm")); renderTray();
  }));
}
function uploadFiles(tid, files) {
  Array.from(files || []).forEach((f) => {
    if (!ACCEPT_EXT.includes(extOf(f.name))) { TasO.toast("Unsupported file type: " + f.name, "danger"); return; }
    const key = ++stagedSeq;
    const entry = { key, name: f.name, size: f.size, kind: IMG_EXT.includes(extOf(f.name)) ? "image" : "file", status: "uploading" };
    staged.push(entry); renderTray();
    const fd = new FormData(); fd.append("file", f, f.name);
    fetch("/api/tasks/" + encodeURIComponent(tid) + "/attachments", { method: "POST", body: fd })
      .then((r) => r.ok ? r.json() : r.json().then((d) => Promise.reject(d.detail || ("HTTP " + r.status))))
      .then((ref) => { entry.status = "done"; entry.ref = ref; entry.size = ref.size; entry.kind = ref.kind; renderTray(); })
      .catch((err) => { entry.status = "failed"; renderTray(); TasO.toast("Upload failed: " + (err || f.name), "danger"); });
  });
}
function wireAttach(t) {
  const btn = Tas$("attachBtn"), fin = Tas$("attachInput"), wrap = Tas$("replyWrap"), inp = Tas$("reply");
  if (btn && fin) {
    btn.addEventListener("click", () => fin.click());
    fin.addEventListener("change", () => { uploadFiles(t.id, fin.files); fin.value = ""; });
  }
  if (wrap) {
    ["dragenter","dragover"].forEach((e) => wrap.addEventListener(e, (ev) => { ev.preventDefault(); wrap.classList.add("dragover"); }));
    ["dragleave","drop"].forEach((e) => wrap.addEventListener(e, (ev) => { ev.preventDefault(); if (e !== "dragleave" || ev.target === wrap) wrap.classList.remove("dragover"); }));
    wrap.addEventListener("drop", (ev) => { if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) uploadFiles(t.id, ev.dataTransfer.files); });
  }
  if (inp) inp.addEventListener("paste", (ev) => {
    const items = ev.clipboardData && ev.clipboardData.files;
    if (items && items.length) { uploadFiles(t.id, items); }   // pasted image/file → stage (don't block text paste)
  });
  renderTray();
}

function wire(t) {
  // #301: reset the staging tray when the selected task changes (a fresh composer).
  if (stagedTask !== t.id) { staged = []; stagedTask = t.id; }
  wireAttach(t);
  const rb = Tas$("replyBtn");
  if (rb) rb.addEventListener("click", () => {
    const inp = Tas$("reply"), v = (inp.value || "").trim();
    const done = staged.filter((s) => s.status === "done");
    const pending = staged.some((s) => s.status === "uploading");
    if (pending) { TasO.toast("Wait for uploads to finish", "danger"); return; }
    if (!v && !done.length) return;   // #301: allow attachment-only posts
    // #271: ATTRIBUTE the human comment with the acting human's id. The server no longer
    // treats a NULL author as human (that was the spoof hole) — it derives is_human from
    // agents.kind, so an unattributed post now renders as a neutral 'system' message. A human
    // (kind='human') is a container member, so the id passes the membership guard and renders
    // correctly as human. Require an acting human first (parity with the other actions).
    const h = actorOrWarn(); if (!h) return;
    const atts = done.map((s) => ({ id: s.ref.id, name: s.ref.name }));
    postJSON("/api/tasks/" + encodeURIComponent(t.id) + "/messages",
             { body: v, author_agent_id: h.id, attachments: atts.length ? atts : undefined })
      .then((r) => { TasO.toast(r.ok ? "Comment posted" : "Failed (" + r.status + ")", r.ok ? "ok" : "danger");
        if (r.ok) { inp.value = ""; inp.blur(); staged = []; renderTray(); renderDetail(); } });
  });
  // #74: explicit retry for a failed/inconsistent thread fetch — clears the error latch and refetches.
  const tr = Tas$("detailMain").querySelector("[data-thread-retry]");
  if (tr) tr.addEventListener("click", () => { tr.textContent = "Retrying…"; tr.disabled = true; maybeLoadThread(t, true); });
  const gate = Tas$("gate-" + t.id);
  if (gate) wireGate(gate, t);
  wireProtocol(t);
  const aw = Tas$("assignWrap");
  if (aw) aw.querySelector('[data-act="assign"]').addEventListener("click", () => doAssign(t));
  const cw = Tas$("cancelWrap");
  if (cw) cw.querySelector('[data-act="cancel"]').addEventListener("click", () => {
    const h = actorOrWarn(); if (!h) return;
    const reason = (Tas$("cancelReason").value || "").trim();
    TasO.modal({ title: "Close this task?", desc: "Force-closes the task and unblocks anything waiting on it. Logged with your identity.",
      primary: "Close task", approve: false, onPrimary: () => {
        TasO.closeModal();
        postJSON("/api/tasks/" + encodeURIComponent(t.id) + "/cancel", { actor_agent_id: h.id, reason: reason || undefined })
          .then((r) => { TasO.toast(r.ok ? "Task closed" : "Failed (" + r.status + ")", r.ok ? "ok" : "danger");
            if (r.ok) { const cr = Tas$("cancelReason"); if (cr) { cr.value = ""; cr.blur(); } acted.add(t.id); renderList(); renderDetail(); } });
      } });
  });
}
function wireGate(gate, t) {
  const kind = gate.dataset.kind, authorId = gate.dataset.author;
  const ta = Tas$("rt-" + t.id), cr = Tas$("cr-" + t.id), reasonBox = Tas$("reason-" + t.id);
  if (ta) ta.addEventListener("input", () => { cr.disabled = !ta.value.trim(); });
  gate.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
    const act = b.dataset.act;
    if (act === "approve") {
      const h = actorOrWarn(); if (!h) return;
      // ISS-59: a plan approval may carry an OPTIONAL answer/guidance to the agent (decision
      // `reason` → its next wake + the task thread via ISS-48). Verify-complete stays a plain confirm.
      TasO.modal({
        title: kind === "plan" ? "Approve this plan?" : "Accept this task?",
        desc: kind === "plan" ? who(t) + " will be cleared to execute. Optionally answer/guide below — it's sent with the approval." : "Marks the task completed and unblocks anything waiting on it. Logged with your identity.",
        primary: kind === "plan" ? "Approve plan" : "Accept", approve: true,
        body: kind === "plan" ? '<textarea id="ans-' + TasO.esc(t.id) + '" class="ans-in" style="min-height:64px" placeholder="Answer / additional info for the agent (optional)"></textarea>' : undefined,
        onPrimary: () => { const el = kind === "plan" ? document.getElementById("ans-" + t.id) : null; TasO.closeModal(); submit(true, el ? (el.value || "") : ""); },
      });
    } else if (act === "reject") {
      reasonBox.classList.add("show"); if (ta) ta.focus();
    } else if (act === "cancel-reject") {
      reasonBox.classList.remove("show"); if (ta) { ta.value = ""; cr.disabled = true; }
    } else if (act === "confirm-reject") {
      const reason = (ta.value || "").trim(); if (!reason) return;
      submit(false, reason);
    }
  }));
  function submit(approve, reason) {
    const h = actorOrWarn(); if (!h) return;
    const done = (r) => { TasO.toast(r.ok ? (kind === "plan" ? (approve ? "Plan approved" : "Changes requested") : (approve ? "Accepted · completed" : "Rejected — returned"))
                                      : "Failed (" + r.status + ")", r.ok ? "ok" : "danger");
      // clear+blur the reason field so the dirty-input guard doesn't block the repaint
      if (r.ok) { if (ta) { ta.value = ""; ta.blur(); } acted.add(t.id); renderList(); renderDetail(); } };
    if (kind === "plan") {
      postJSON("/api/decisions", { subject_type: "plan_approval", subject_id: t.id, decision: approve ? "approve" : "reject",
        reason: reason || undefined, actor_agent_id: h.id, target_agent_id: authorId || undefined }).then(done);
    } else {
      postJSON("/api/tasks/" + encodeURIComponent(t.id) + "/verify", { approve, actor_agent_id: h.id, feedback: approve ? undefined : reason }).then(done);
    }
  }
}

/* SPEC-4 — wire the protocol panel: collapse on header, edit/set/cancel/save, draft capture. */
function wireProtocol(t) {
  const box = Tas$("proto-" + t.id);
  if (!box) return;
  const st = protoUI[t.id] || (protoUI[t.id] = { collapsed: false, editing: false, draft: null });
  const ph = box.querySelector(".ph");
  if (ph) ph.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;   // buttons handle their own action
    if (st.editing) return;                    // header is inert while editing
    st.collapsed = !st.collapsed; renderDetail(true);
  });
  box.querySelectorAll("[data-pact]").forEach((b) => {
    const act = b.dataset.pact;
    if (act === "toggle") return;              // chev collapse handled by the header click
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (act === "edit" || act === "set") {
        const h = actorOrWarn(); if (!h) return;
        const p = t.protocol || {};
        st.draft = { review_chain: p.review_chain || "", handoff_to: p.handoff_to || "", autonomy: p.autonomy || "", notes: p.notes || "" };
        st.editing = true; st.collapsed = false; renderDetail(true);
      } else if (act === "cancel") {
        st.editing = false; st.draft = null; renderDetail(true);
      } else if (act === "save") {
        saveProtocol(t);
      }
    });
  });
  // keep the draft in sync with typed input so a blurred mid-edit repaint doesn't lose text
  box.querySelectorAll("[data-pfield]").forEach((el) => el.addEventListener("input", () => {
    if (!st.draft) st.draft = {};
    st.draft[el.dataset.pfield] = el.value;
  }));
}
function saveProtocol(t) {
  const h = actorOrWarn(); if (!h) return;
  const st = protoUI[t.id]; if (!st) return;
  const box = Tas$("proto-" + t.id);
  const get = (k) => { const el = box && box.querySelector('[data-pfield="' + k + '"]'); return el ? el.value : ((st.draft || {})[k] || ""); };
  // PARTIAL merge (Ledger contract): send all four; omitted keys would preserve, "" clears a key.
  const body = { actor_agent_id: h.id, review_chain: get("review_chain"), handoff_to: get("handoff_to"), autonomy: get("autonomy"), notes: get("notes") };
  const saveBtn = box && box.querySelector('[data-pact="save"]');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  patchJSON("/api/tasks/" + encodeURIComponent(t.id) + "/protocol", body)
    .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, d })).catch(() => ({ ok: r.ok, status: r.status, d: {} })))
    .then(({ ok, status, d }) => {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save protocol"; }
      if (ok) {
        st.editing = false; st.draft = null;
        // 200 echoes {task_id, protocol:{full merged}} — stamp it locally so the panel re-renders
        // immediately; the next snapshot poll confirms it via data.js.
        if (d && d.protocol) { const lt = (TasD().tasks || []).find((x) => x.id === t.id); if (lt) lt.protocol = d.protocol; }
        TasO.toast("Protocol saved", "ok");
        renderDetail(true);
        return;
      }
      TasO.toast("Save failed (" + status + ")" + (d.detail ? ": " + (typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail)) : ""), "danger");
    })
    .catch(() => { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save protocol"; } TasO.toast("Save failed — network error.", "danger"); });
}

/* ---------- worker runs (live feed) — shared engine, fetched per task ---------- */
