/* Conversation panel module: slash palette, upload tray, send flow, and keyboard handling. */
/* ---------- composer + S4 slash palette ---------- */
// Get-or-create the active conversation, resolving { ok, status?, noHuman? }. Shared by send()
// and the attachment upload (the upload route is conversation-scoped, so a file picked before
// the first turn still needs a real conversation id). Requires an acting human, like send().
// `tok` pins the mount this call serves. If the panel remounts for ANOTHER agent before the
// create resolves, we must NOT write the stale conversation id onto the (now different) global
// convId — that's the P1 data-integrity race: a later upload or turn would target the wrong
// agent's conversation. A stale completion drops to { ok:false, stale:true } and writes nothing.
function ensureConv(tok) {
  if (convId) return Promise.resolve({ ok: true });
  const h = O().actingHuman();
  if (!h) return Promise.resolve({ ok: false, noHuman: true });
  return postJSON("/api/agents/" + encodeURIComponent(agentId) + "/conversations", { actor_agent_id: h.id })
    .then((r) => r.ok ? r.json().then((c) => {
                          if (tok !== mountTok) return { ok: false, stale: true };   // remounted → drop it
                          convId = (c.conversation || c).id || convId; return { ok: true };
                        })
                      : { ok: false, status: r.status });
}

/* ---------- #337: attachment staging tray ---------- */
function renderTray() {
  const tray = document.getElementById("convTray"); if (!tray) return;
  tray.innerHTML = staged.map((s) => {
    const cls = s.status === "uploading" ? " uploading" : s.status === "failed" ? " failed" : "";
    const thumb = (s.status === "done" && s.ref && s.ref.kind === "image")
      ? `<img class="thumb" src="${O().esc(s.ref.url)}" alt="">`
      : `<span class="ic">${FILE_ICON}</span>`;
    const sub = s.status === "uploading" ? "uploading…" : s.status === "failed" ? "failed" : fmtSize(s.size);
    return `<span class="att-chip${cls}">${thumb}<span class="meta">
      <span class="nm">${O().esc(s.name)}</span><span class="sz">${sub}</span></span>
      <button type="button" class="rm" data-rm="${s.key}" title="Remove">×</button></span>`;
  }).join("");
  tray.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
    staged = staged.filter((s) => String(s.key) !== b.getAttribute("data-rm")); renderTray();
  }));
}
// Stage + upload files to the conversation store. Bad extensions are rejected up-front so we
// never open a conversation just to reject everything; valid files ensure the conversation, then
// each uploads immediately and lands its real server ref (id/url/kind) on its staged entry.
function uploadConvFiles(files) {
  const valid = Array.from(files || []).filter((f) => {
    if (f && ACCEPT_EXT.includes(extOf(f.name))) return true;
    O().toast("Unsupported file type: " + (f && f.name || "file"), "danger"); return false;
  });
  if (!valid.length) return;
  const tok = mountTok;   // the mount these uploads belong to; a remount invalidates the whole batch
  ensureConv(tok).then((res) => {
    if (tok !== mountTok) return;   // panel remounted for another agent → abandon (never stage into its tray)
    if (!res.ok) {
      O().toast(res.noHuman ? "Pick an acting human (top-right) first."
                            : "Couldn't open conversation (" + (res.status || "") + ")", "danger");
      return;
    }
    const cid = convId;   // pin the conversation each file uploads to (can't drift mid-batch)
    valid.forEach((f) => {
      const key = ++stagedSeq;
      const entry = { key, name: f.name, size: f.size, kind: IMG_EXT.includes(extOf(f.name)) ? "image" : "file", status: "uploading" };
      staged.push(entry); renderTray();
      const fd = new FormData(); fd.append("file", f, f.name);
      fetch("/api/conversations/" + encodeURIComponent(cid) + "/attachments", { method: "POST", body: fd })
        .then((r) => r.ok ? r.json() : r.json().then((d) => Promise.reject(d.detail || ("HTTP " + r.status))))
        .then((ref) => { if (tok !== mountTok) return; entry.status = "done"; entry.ref = ref; entry.size = ref.size; entry.kind = ref.kind; renderTray(); })
        .catch((err) => { if (tok !== mountTok) return; entry.status = "failed"; renderTray(); O().toast("Upload failed: " + (err || f.name), "danger"); });
    });
  });
}
function wireAttach() {
  const btn = document.getElementById("convAttach");
  const fin = document.getElementById("convAttachInput");
  const conv = convEl();
  const inp = document.getElementById("convInput");
  if (btn && fin) {
    btn.addEventListener("click", () => fin.click());
    fin.addEventListener("change", () => { uploadConvFiles(fin.files); fin.value = ""; });
  }
  if (conv) {
    ["dragenter", "dragover"].forEach((e) => conv.addEventListener(e, (ev) => { ev.preventDefault(); conv.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((e) => conv.addEventListener(e, (ev) => { ev.preventDefault(); if (e !== "dragleave" || ev.target === conv) conv.classList.remove("dragover"); }));
    conv.addEventListener("drop", (ev) => { if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) uploadConvFiles(ev.dataTransfer.files); });
  }
  if (inp) inp.addEventListener("paste", (ev) => {
    const items = ev.clipboardData && ev.clipboardData.files;
    if (items && items.length) uploadConvFiles(items);   // pasted image/file → stage (don't block text paste)
  });
  renderTray();
}

/* Dup-send root cause #1: send() had NO in-flight guard and only cleared the input after
   the POST resolved — a second Enter (or held-key repeat, or a "did it go through?" click
   while the portal is slow/restarting) re-read the same text and POSTed the same turn
   again. Everything now funnels through ONE guarded path: `sending` makes the second
   activation a no-op, the button is down with a spinner, and the composer is cleared
   optimistically (restored on failure — nothing is ever silently lost). */
function send() {
  if (sending) return;   // in flight: Enter/click/key-repeat are no-ops until it settles
  const inp = document.getElementById("convInput");
  const v = (inp.value || "").trim();
  const done = staged.filter((s) => s.status === "done");
  const pending = staged.some((s) => s.status === "uploading");
  if (pending) { O().toast("Wait for uploads to finish", "danger"); return; }
  if (!v && !done.length) return;   // #337: allow attachment-only turns (no text required)
  const h = O().actingHuman();
  if (!h) { O().toast("Pick an acting human (top-right) first.", "danger"); return; }
  closeSlash();
  const atts = done.map((s) => ({ id: s.ref.id, name: s.ref.name }));
  // Round-2 fix (blocker #1): a FAILED pendingLocal is never overwritten. If the user typed
  // something new while a failed bubble+Retry was still showing, stash it in failedSends —
  // its own bubble keeps rendering with its own Retry — instead of letting the new send's
  // submitTurn() below clobber the only copy of the earlier message.
  if (pendingLocal && pendingLocal.status === "failed") { failedSends.push(pendingLocal); pendingLocal = null; }
  // optimistic: clear the composer NOW (ISS-64 draft included) and paint a pending bubble;
  // the text + staged refs live on pendingLocal until the server owns the turn.
  inp.value = ""; autosize(inp); saveDraft("");
  const keepStaged = staged; staged = []; renderTray();
  submitTurn(v, atts, keepStaged, h);
}
// the ONE place a turn is POSTed (fresh sends and Retry both land here).
function submitTurn(v, atts, keepStaged, h) {
  sending = true; setSendBusy(true);
  pendingLocal = { content: v, atts, keepStaged, authorId: h.id, at: Date.now(), status: "sending", err: null };
  renderList();
  const tok = mountTok;   // a remount mid-send must not retarget another agent's conversation
  const fail = (msg) => { if (tok === mountTok) failSend(msg); };
  ensureConv(tok).then((res) => {
    if (tok !== mountTok || res.stale) return;   // remounted for another agent → abandon this send
    if (!res.ok) return fail(res.noHuman ? "Pick an acting human (top-right) first."
                                         : "Couldn't open conversation (" + (res.status || "") + ")");
    return postJSON("/api/conversations/" + encodeURIComponent(convId) + "/turns",
      { role: "human", author_agent_id: h.id, content: v, attachments: atts.length ? atts : undefined })
      .then((r) => {
        if (tok !== mountTok) return;   // remounted before the turn landed → don't paint a stale panel
        if (!r.ok) return fail("Send failed (" + r.status + ")");
        return r.json().catch(() => ({})).then((d) => {
          if (tok !== mountTok) return;
          settleSend(d && d.turn);
        });
      });
  }).catch(() => fail("Couldn't reach the portal — it may be restarting."));
}
// success: the server owns the turn. Reconcile the optimistic bubble with the durable row
// the POST returned (append by turn id; the poll's id/seq dedupe drops the copy IT fetches),
// then raise the honest awaiting-reply indicator.
function settleSend(t) {
  sending = false; setSendBusy(false); applyLock();   // minor #3: re-lock if a terminal paired mid-send
  if (t && !turns.some((x) => String(x.id) === String(t.id))) {
    turns.push(t);
    if (typeof t.seq === "number" && t.seq > lastSeq) lastSeq = t.seq;
  }
  pendingLocal = null;
  cacheConv();
  awaiting = true; renderList(); poll();   // show the "thinking…" indicator until the reply lands
}
// failure: nothing is lost and nothing auto-repeats — the composer gets the text back
// (only if the user hasn't typed something new), the staged refs return to the tray, and
// the pending bubble flips to an inline danger note with an explicit Retry.
function failSend(msg) {
  sending = false; setSendBusy(false); applyLock();   // minor #3: re-lock if a terminal paired mid-send
  if (!pendingLocal) return;   // a poll already reconciled this turn (it DID land server-side)
  pendingLocal.status = "failed"; pendingLocal.err = msg;
  const inp = document.getElementById("convInput");
  if (inp && !(inp.value || "").trim()) { inp.value = pendingLocal.content; autosize(inp); saveDraft(inp.value); }
  if (!staged.length && pendingLocal.keepStaged && pendingLocal.keepStaged.length) { staged = pendingLocal.keepStaged; renderTray(); }
  renderList();
}
// Retry on a failed bubble: re-submit EXACTLY that failed content through the same guarded
// path. `at` (the stage timestamp) identifies WHICH failed bubble — the live pendingLocal or
// one stashed in failedSends by a later send() (blocker #1) — since either can carry a Retry.
// The failure-restored composer text is taken back out first (when still untouched) so a
// follow-up Enter can't double it.
function retrySend(at) {
  if (sending) return;
  let p = null;
  if (pendingLocal && pendingLocal.status === "failed" && (at == null || pendingLocal.at === at)) {
    p = pendingLocal; pendingLocal = null;
  } else if (at != null) {
    const idx = failedSends.findIndex((f) => f.at === at);
    if (idx >= 0) p = failedSends.splice(idx, 1)[0];
  }
  if (!p) return;
  const h = O().actingHuman();
  if (!h) { O().toast("Pick an acting human (top-right) first.", "danger"); return; }
  const inp = document.getElementById("convInput");
  if (inp && (inp.value || "").trim() === p.content) { inp.value = ""; autosize(inp); saveDraft(""); }
  if (staged === p.keepStaged) { staged = []; renderTray(); }
  submitTurn(p.content, p.atts, p.keepStaged, h);
}
// Send button in-flight affordance: down + spinner while the POST runs (applyLock keeps
// it down across presence repaints via the `sending` flag).
function setSendBusy(busy) {
  const b = document.getElementById("convSend"); if (!b) return;
  b.disabled = !!busy;
  if (b.classList) b.classList[busy ? "add" : "remove"]("busy");
  b.innerHTML = busy ? '<span class="spin"></span>Sending' : O().icon("arrow", "") + "Send";
}
function autosize(inp) { inp.style.height = "auto"; inp.style.height = Math.min(inp.scrollHeight, 160) + "px"; }
function onInput(inp) {
  autosize(inp);
  const v = inp.value;
  saveDraft(v);   // ISS-64: persist the draft on every keystroke so navigation can't drop it
  if (v.startsWith("/") && !v.includes(" ")) filterSlash(v); else closeSlash();
}
// filterSlash: the QUERY changed -> recompute matches + reset the highlight to the top.
function filterSlash(q) {
  slashItems = SKILLS.filter((s) => s.startsWith(q)); slashIdx = 0;
  if (!slashItems.length) { closeSlash(); return; }
  slashOpen = true; renderSlash();
}
// renderSlash: redraw ONLY — preserves slashIdx so arrow navigation actually moves.
function renderSlash() {
  const box = document.getElementById("convSlash"); if (!box) return;
  box.hidden = false;
  box.innerHTML = slashItems.map((s, i) => `<div class="si ${i === slashIdx ? "on" : ""}" data-s="${O().esc(s)}">${O().esc(s)}</div>`).join("");
  box.querySelectorAll("[data-s]").forEach((it) => it.addEventListener("mousedown", (e) => { e.preventDefault(); pickSlash(it.dataset.s); }));
  const on = box.querySelector(".si.on"); if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
}
function closeSlash() { slashOpen = false; const b = document.getElementById("convSlash"); if (b) { b.hidden = true; b.innerHTML = ""; } }
function pickSlash(s) { const inp = document.getElementById("convInput"); inp.value = s + " "; closeSlash(); inp.focus(); autosize(inp); }
function onKey(e) {
  const inp = e.target;
  if (slashOpen) {
    // arrow nav redraws WITHOUT refiltering, so the highlight actually moves (review P2)
    if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = (slashIdx + 1) % slashItems.length; renderSlash(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; renderSlash(); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashItems[slashIdx]); return; }
    if (e.key === "Escape") { closeSlash(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
}
