/* Conversation panel module: terminal open, reattach, and preflight flow. */
/* ---------- S3 §3b: "Pair in terminal" (reference design lifted onto the OrchaTerm engine).
   Docks a live xterm session (Forge PTY ws bridge) beside the thread; lease-guarded. ---------- */
function setPairBtn(on) {
  const b = document.getElementById("convPair"); if (!b) return;
  b.classList.toggle("ghost", !on);
  const t = b.querySelector("span"); if (t) t.textContent = on ? "Terminal paired" : "Pair in terminal";
}
function togglePair() {
  if (paired) { closePair(); return; }
  const a = O().agentById(agentId); if (!a) return;
  const lease = O().leaseOf(a);
  if (lease === "live") { O().toast(a.alias + " already holds a live session", "danger"); return; }
  if (lease === "ephemeral" || lease === "resident") {   // busy -> human-gated graceful preempt (§3b)
    // ISS-69(b): distinct copy per holder. A resident is a WARM CONVERSATION — handing it off
    // snapshots it so the agent can resume; an ephemeral is a background TASK that gets stopped.
    const isConvo = lease === "resident";
    O().modal({
      title: isConvo ? "Hand off the live conversation?" : "Preempt the running task?",
      approve: false,
      primary: isConvo ? "Hand off & pair" : "Stop & pair",
      desc: isConvo
        ? "Hand off " + a.alias + "'s warm conversation? It's saved (snapshotted) first, then you get the live terminal — " + a.alias + " can resume from the saved state."
        : a.alias + " is running a task. Pairing gracefully stops it — its progress is snapshotted first — and gives you the live terminal.",
      onPrimary: () => { O().closeModal(); gateThenPair(true); } });
    return;
  }
  gateThenPair(false);   // idle -> open directly
}
// Part A (ISS-84 #244): DETERMINISTIC READINESS PRE-GATE. Before starting a FRESH live session,
// ask the bridge whether the selected runtime CLI is installed on the host — the one signal
// knowable before launch (subscription/auth/usage surface REACTIVELY, Part B). installed===false
// is the only pre-launch blocker. FAIL-OPEN: a null probe (endpoint absent / bridge down / older
// bridge / timeout) proceeds straight to openPair so we never block on an unavailable probe — the
// frontend ships ahead of Anvil's bridge verb and lights up once it lands. Re-attach skips the
// gate entirely (that session is already live; nothing to pre-check).
function gateThenPair(preempt) {
  const reattach = !!(window.OrchaTerm && OrchaTerm.hasSession(agentId));
  if (reattach || !window.OrchaTerm || typeof OrchaTerm.preflight !== "function") { openPair(preempt); return; }
  OrchaTerm.preflight(agentId).then(function (pf) {
    if (pf && pf.installed === false) { showNotInstalled(pf); return; }
    openPair(preempt);
  }).catch(function () { openPair(preempt); });   // any probe failure -> fail-open
}
// Pre-gate blocker UX: the runtime CLI isn't installed on the host, so a PTY would just exit.
// Surface the install prompt (modal, existing theme) instead of opening a doomed terminal.
// pf = bridge preflight {runtime, install_hint, override_env, ...}; copy mirrors the canonical
// install-hint strings (__main__.py:1695-1697) and is keyed off the agent's model_runtime.
function showNotInstalled(pf) {
  const a = O().agentById(agentId), nm = a ? a.alias : "the agent";
  const runtime = (pf && pf.runtime) || ((a && a.model_runtime) || "claude");
  const isCodex = runtime === "codex";
  const product = isCodex ? "Codex CLI" : "Claude Code";
  const hint = (pf && pf.install_hint) || (isCodex
    ? "Install Codex CLI or set ORCHA_CODEX_EXEC=/absolute/path/to/codex."
    : "Install Claude Code or set ORCHA_CLAUDE_EXEC=/absolute/path/to/claude.");
  O().modal({
    title: product + " isn't installed",
    desc: "Pairing as " + nm + " runs " + product + " on this host, but it isn't on the PATH. Install it (or point Orcha at it with the override env), then pair again.",
    body: `<div class="pf-hint"><code>${O().esc(hint)}</code></div>`,
    primary: "Copy install hint", cancel: "Dismiss",
    onPrimary: () => { O().copyText(hint); O().closeModal(); },
  });
}
// open a fresh session OR RE-ATTACH an existing one (ISS-71: the session survives nav, so
// returning to the agent re-docks the live terminal instead of opening a new one).
function openPair(preempt) {
  const reattach = !!(window.OrchaTerm && OrchaTerm.hasSession(agentId));
  if (!reattach && !O().actingHuman()) { O().toast("Pick an acting human (top-right) first.", "danger"); return; }
  if (!window.OrchaTerm || !OrchaTerm.libsReady()) { O().toast("Terminal unavailable — assets not loaded", "danger"); return; }
  const a = O().agentById(agentId);
  paired = true; termConnected = reattach && OrchaTerm.isConnected(agentId);
  const wrap = document.getElementById("convPairWrap"); if (wrap) wrap.classList.add("paired");
  setPairBtn(true); applyLock();
  const slot = document.getElementById("convTermSlot"); if (!slot) return;
  slot.innerHTML = termShell(a, reattach);
  slot.querySelector("#termClose").addEventListener("click", closePair);
  const tmx = slot.querySelector("#termMax"); if (tmx) tmx.addEventListener("click", () => setMaxed("term"));
  if (maxed === "term") applyMax();   // re-assert the maximized class onto the fresh #convTerm
  OrchaTerm.open(slot.querySelector("#termBody"), agentId, { preempt: preempt, onState: onTermState });
}
function termShell(a, reattach) {
  const nm = (a ? a.alias : "agent");
  return `<div class="term" id="convTerm">
    <div class="term-h">
      <div class="lights"><i class="r"></i><i class="y"></i><i class="g"></i></div>
      <div class="ttl">${O().esc(nm.toLowerCase())}@orcha — pair session</div>
      <span class="pairtag" id="termTag"><span class="d"></span><span id="termTagText">${reattach ? "reattaching…" : "connecting…"}</span></span>
      <div class="term-actions">
        <button class="x term-max" id="termMax" title="Maximize terminal">${O().icon("maximize", "")}</button>
        <button class="x" id="termClose" title="Close &amp; save session">${O().icon("x", "")}</button>
      </div>
    </div>
    <div class="term-body" id="termBody"></div>
  </div>`;
}
