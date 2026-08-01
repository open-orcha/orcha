/* Conversation panel module: mount teardown and delegated attachment lightbox. */
/* ---------- lifecycle ---------- */
function mount(el, aid) {
  teardown();
  host = el; agentId = aid; convId = null; turns = []; lastSeq = 0; awaiting = false;
  sending = false; pendingLocal = null; failedSends = []; pollBusy = false;   // send-UX state never leaks across agents
  shown = 10;   // ISS-68 PR-3: start collapsed to the most-recent 10 turns on each mount
  staged = []; stagedSeq = 0;   // #337: a fresh composer per mount — drop any staged attachments
  presence = null; presenceReason = null; paired = false; termConnected = false;
  const a = O().agentById(aid);
  if (!a || a.kind === "human") { el.innerHTML = ""; return; }
  el.innerHTML = skeleton(a);
  const inp = document.getElementById("convInput");
  document.getElementById("convSend").addEventListener("click", send);
  inp.addEventListener("input", () => onInput(inp));
  inp.addEventListener("keydown", onKey);
  inp.addEventListener("blur", () => setTimeout(closeSlash, 120));
  wireAttach();   // #337: paperclip / drag-drop / paste → stage + upload conversation attachments
  const pb = document.getElementById("convPair"); if (pb) pb.addEventListener("click", togglePair);
  const mb = document.getElementById("convMax"); if (mb) mb.addEventListener("click", () => setMaxed("conv"));
  document.addEventListener("keydown", onDocKey);   // ISS-65: Escape restores a maximized panel
  // ISS-64: rehydrate any draft typed before the user navigated away (per-agent, sessionStorage).
  const draft = loadDraft(aid);
  if (draft) { inp.value = draft; autosize(inp); }
  // ISS-71: if a live terminal session survived a previous nav, re-dock it (reattach) instead
  // of showing the un-paired guard. openPair() detects the existing session and reattaches.
  if (window.OrchaTerm && OrchaTerm.hasSession(aid)) openPair(false);
  // ISS-68: if we have a FRESH cache for this agent, paint it instantly and only delta-refresh
  // (no full reload / flicker on a tab switch). Stale or missing cache → a full load().
  const cached = convCache[aid];
  if (cached && (Date.now() - cached.at) < CONV_CACHE_TTL_MS) {
    convId = cached.convId; turns = cached.turns.slice(); lastSeq = cached.lastSeq;
    presence = cached.presence; presenceReason = cached.presenceReason;
    renderList(); renderPresence();
    poll();                       // background top-up via after_seq (append, not reload)
  } else {
    load();
  }
  pollTimer = setInterval(poll, 3000);
}
function teardown() {
  mountTok++;                  // invalidate any in-flight load/poll/presence responses
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  document.removeEventListener("keydown", onDocKey);   // ISS-65
  clearMax();                  // drop any maximize overlay/backdrop before the panel goes away
  // ISS-71: nav-away DETACHES the terminal (xterm out of the DOM, socket stays open) so the
  // session survives; it is only CLOSED via the explicit Close button (closePair) or reload.
  if (agentId && window.OrchaTerm) { try { OrchaTerm.detach(agentId); } catch (e) {} }
  paired = false; termConnected = false;
  Object.values(streamed).forEach((stop) => { try { stop(); } catch (e) {} });
  for (const k in streamed) delete streamed[k];
  if (host) host.innerHTML = "";
  host = null; agentId = null; convId = null; turns = []; lastSeq = 0; awaiting = false;
  sending = false; pendingLocal = null; failedSends = []; pollBusy = false;
  presence = null; presenceReason = null;
}

/* #337: image lightbox — delegated click bound ONCE at module load (not per-mount, so it can't
   accumulate across remounts). An in-thread image thumbnail opens a full-size overlay; click
   anywhere (or Esc) closes it. Parity with the task-thread lightbox (tasks.html #301).
   Guarded on `document` so the module stays importable in a barebones JS harness that only
   exercises the pure helpers (e.g. presenceOf) and never stubs the DOM. */
if (typeof document !== "undefined") document.addEventListener("click", (ev) => {
  const img = ev.target.closest && ev.target.closest("[data-lightbox]"); if (!img) return;
  const url = img.getAttribute("data-lightbox"); if (!url) return;
  const box = document.createElement("div"); box.className = "att-lightbox";
  box.innerHTML = `<img src="${O().esc(url)}" alt="">`;
  const close = () => box.remove();
  box.addEventListener("click", close);
  document.addEventListener("keydown", function onKey(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } });
  document.body.appendChild(box);
});
