/* Conversation panel module: bridge states, failure guards, teardown, and maximize controls. */
function onTermState(state, info) {
  const a = O().agentById(agentId), nm = a ? a.alias : "agent";
  const tag = document.getElementById("termTagText");
  const set = (s) => { if (tag) tag.textContent = s; };
  const code = info && info.code;
  const holder = info && info.holder;   // present ONLY when a lease is genuinely HELD (4409)
  // ISS-67: while the bridge is still booting on a cold reopen, terminal.js retries with
  // bounded backoff and reports progress here — show "starting bridge… (n/N)" instead of a
  // silent "connecting…", and (critically) DON'T hard-fail "not reachable" until it gives up.
  if (state === "connecting") {
    set(info && info.bridgeStarting ? ("starting bridge… (" + info.attempt + "/" + info.max + ")") : "connecting…");
    return;
  }
  // connected → CLEAR any saving/hand-off overlay (the `.term-saving` cover is absolutely
  // positioned over the whole panel; after a yield→connected hand-off it must come off or the
  // live terminal stays hidden — P1, kedar review #179).
  // ISS-80: also drop any leftover busy/error guard (`.term-error`) — a force-start/preempt that
  // earlier hit a 4409 "busy" left that overlay on this #convTerm; once the live session attaches
  // it must clear so the guard never sits over the live terminal (same reconcile-on-action fix as
  // hideSaving, kedar review #179). Symmetric with showSaving/hideSaving above.
  if (state === "connected") { termConnected = true; hideSaving(); hideError(); set("live · paired as " + nm); applyLock(); return; }
  if (state === "snapshotting") { showSaving("close"); set("saving…"); return; }
  // ISS-69(b): the bridge yields an IDLE warm resident on preempt — Forge's contract emits a
  // `yielding` frame (holder="resident") while it snapshots + releases the lease, then a normal
  // `connected`. Show the handoff in flight (its own copy — NOT "closing") so the panel isn't a
  // silent "connecting…"; the `connected` branch above clears it once the terminal is live.
  if (state === "yielding") { showSaving("handoff"); set("handing off…"); return; }
  // The bridge sends a `lease_denied` frame for BOTH the not-human denial (close 4403, reason
  // "actor not human", NO holder) AND the genuinely-busy case (close 4409, carries `holder`).
  // Distinguish them so 4403 isn't mislabeled "busy" (Page diagnosis) — key off `holder`/code.
  if (code === 4409 || (state === "lease_denied" && holder)) {   // BUSY: a live lease is held
    // ISS-69(a): say WHAT is holding the embodiment ("in a live conversation" / "in a live
    // terminal" / "running a task") instead of the raw lease_kind; append the bridge's `reason`
    // as the detail when present (e.g. an active resident's "mid-response" deferral).
    const reason = info && info.reason ? String(info.reason) : "";
    termFail("busy", nm + " is busy",
      nm + " is " + holderDoing(holder) + "." + (reason ? " " + reason + "." : "") +
      " End that session, then re-open here — or use Pair to hand it off."); return;
  }
  if (code === 4403 || state === "lease_denied") {               // DENIED: no valid human actor
    termFail("denied", "Not permitted",
      "Couldn't pair as " + nm + " — pick an acting human (top-right) the bridge recognizes, then re-open."); return;
  }
  if (code === 4404) { termFail("denied", "Agent not recognized", "The bridge didn't recognize this agent — reload and try again."); return; }
  if (code === 4400) { termFail("denied", "Bad request", "The terminal request was malformed (missing ids)."); return; }
  // Part B (ISS-84 #244): the bridge CLASSIFIES the child CLI's exit and carries a typed
  // `exitClass` on the frame (state "agent_exited"), so we render the matching corrective prompt
  // instead of the generic "bridge not reachable" copy below. MUST precede both that bucket and
  // the agent_exited cleanup at the foot. Gate purely on `info.exitClass` presence (the bridge
  // sets it only when it actually classified the exit).
  if (info && info.exitClass) { preflightFail(info); return; }
  // never reached "connected" → the bridge is unreachable (down / starting up / wrong port).
  if (!termConnected && (state === "error" || state === "closed")) {
    termFail("down", "Terminal bridge not reachable",
      "It starts with the workspace — if you just (re)installed it may still be coming up. Otherwise start it with:  orcha terminal-bridge"); return;
  }
  // a live session ended normally → tidy up (snapshot already shown via 'snapshotting').
  if (state === "closed" || state === "agent_exited" || state === "error" || state === "no_human") {
    if (state === "closed") O().toast("Terminal closed — session snapshotted", "ok");
    unpair();
  }
}
// failure → keep the panel OPEN with a VISIBLE message (no silent flash); header Close → unpair.
// The dead ws/xterm is torn down + the composer unlocks (termConnected stays false). Optional
// `cta` (ISS-84 #244) = array of {label, kind?, onClick} corrective-action buttons rendered under
// the message; omitted by the existing busy/denied/down callers (backward compatible).
function termFail(kind, title, msg, cta) {
  if (window.OrchaTerm) OrchaTerm.cleanup(agentId);
  applyLock();
  const term = document.getElementById("convTerm"); if (!term) return;
  const tag = document.getElementById("termTagText"); if (tag) tag.textContent = kind;
  let ov = term.querySelector(".term-error");
  if (!ov) { ov = document.createElement("div"); ov.className = "term-error"; term.appendChild(ov); }
  const acts = (cta && cta.length)
    ? `<div class="te-cta">` + cta.map((c, i) => `<button class="btn sm ${c.kind || "ghost"}" data-cta="${i}">${O().esc(c.label)}</button>`).join("") + `</div>`
    : "";
  ov.innerHTML = `${O().icon("shield", "")}<div class="te-tx"><div class="st">${O().esc(title)}</div><div class="sub">${O().esc(msg)}</div>${acts}</div>`;
  if (cta && cta.length) cta.forEach((c, i) => { const b = ov.querySelector('[data-cta="' + i + '"]'); if (b && c.onClick) b.addEventListener("click", c.onClick); });
}
// Part B (ISS-84 #244): map a typed CLI-exit class to the right corrective prompt + CTA, keyed off
// the runtime (bridge `info.runtime`, else the agent's model_runtime). HONESTY GUARD (Helm
// sign-off): only not_installed/auth_required/usage_limit are named — anything else (incl.
// "unknown") degrades to a neutral "couldn't start — see terminal output" + Retry, NEVER a
// fabricated cause. We do not guess a balance or an auth state we can't observe.
function retryPair() { unpair(); gateThenPair(false); }
function preflightFail(info) {
  const a = O().agentById(agentId), nm = a ? a.alias : "agent";
  const runtime = (info && info.runtime) || ((a && a.model_runtime) || "claude");
  const isCodex = runtime === "codex";
  const product = isCodex ? "Codex CLI" : "Claude Code";
  const provider = isCodex ? "OpenAI" : "Claude";
  const hint = (info && info.install_hint) || (isCodex
    ? "Install Codex CLI or set ORCHA_CODEX_EXEC=/absolute/path/to/codex."
    : "Install Claude Code or set ORCHA_CLAUDE_EXEC=/absolute/path/to/claude.");
  const detail = info && info.detail ? String(info.detail) : "";
  const retry = { label: "Retry", kind: "approve", onClick: retryPair };
  switch (info && info.exitClass) {
    case "not_installed":
      return termFail("not installed", product + " isn't installed",
        product + " isn't on this host's PATH, so " + nm + "'s session can't start. " + hint,
        [{ label: "Copy install hint", onClick: () => O().copyText(hint) }, retry]);
    case "auth_required":
      return termFail("sign-in needed", "Sign in to " + provider,
        nm + "'s " + product + " needs to be authenticated with " + provider + " before it can run." +
        (detail ? " " + detail : "") + " Authenticate the CLI on the host, then retry.", [retry]);
    case "usage_limit":
      return termFail("usage limit", provider + " usage limit reached",
        nm + "'s " + product + " hit a " + provider + " usage limit." + (detail ? " " + detail : "") +
        " Top up or wait for it to reset, then retry.", [retry]);
    default:   // "unknown" / unrecognized — HONESTY GUARD: no fabricated cause
      return termFail("couldn't start", "Couldn't start the session",
        nm + "'s CLI exited before connecting — see the terminal output above for details.", [retry]);
  }
}
// the ref's "saving session" overlay — maps to Forge's snapshot write. mode "close" = the
// snapshot-on-close (Vault digest write); mode "handoff" = ISS-69 yield (snapshot an idle
// resident, then hand the human the terminal). hideSaving() removes it once we connect/leave.
function showSaving(mode) {
  const term = document.getElementById("convTerm"); if (!term || term.querySelector(".term-saving")) return;
  const nm = O().esc((O().agentById(agentId) || {}).alias || "the agent");
  const ov = document.createElement("div");
  ov.className = "term-saving";
  ov.innerHTML = (mode === "handoff")
    ? `<div class="ring"></div><div class="st">Handing off — saving session</div>
       <div class="sub">Snapshotting ${nm}'s live conversation, then handing you the terminal…</div>`
    : `<div class="ring"></div><div class="st">Closing — saving session</div>
       <div class="sub">Writing terminal history into ${nm}'s memory digest…</div>`;
  term.appendChild(ov);
}
function hideSaving() {
  const term = document.getElementById("convTerm"); if (!term) return;
  const ov = term.querySelector(".term-saving"); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
}
// ISS-80: remove the busy/error guard overlay that termFail() appended. Called from the
// `connected` branch so a successful Stop-and-Pair / force-start clears the stale "<agent> is
// busy" banner instead of leaving it over the now-live terminal. Symmetric to hideSaving().
function hideError() {
  const term = document.getElementById("convTerm"); if (!term) return;
  const ov = term.querySelector(".term-error"); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
}
function closePair() {
  showSaving();
  if (window.OrchaTerm && OrchaTerm.isOpen(agentId)) OrchaTerm.close(agentId);   // -> snapshot-on-close -> 'closed' -> unpair()
  else unpair();
}
function unpair() {
  paired = false; termConnected = false;
  if (window.OrchaTerm) OrchaTerm.cleanup(agentId);
  const slot = document.getElementById("convTermSlot"); if (slot) slot.innerHTML = "";
  const wrap = document.getElementById("convPairWrap"); if (wrap) wrap.classList.remove("paired");
  setPairBtn(false); applyLock();
  if (maxed === "term") setMaxed(null);   // the maximized panel just went away — restore the dock
}

/* ---------- ISS-65: maximize the conversation / terminal into a large overlay ----------
   Toggle a class on the EXISTING panel element so the live xterm socket + composer wiring
   survive (no DOM reparenting). Only one panel is maximized at a time. */
function convEl() { return host ? host.querySelector(".conv") : null; }
function setMaxed(which) { maxed = (maxed === which) ? null : which; applyMax(); }
function applyMax() {
  const conv = convEl(), term = document.getElementById("convTerm");
  if (conv) conv.classList.toggle("maximized", maxed === "conv");
  if (term) term.classList.toggle("maximized", maxed === "term");
  let bd = document.getElementById("convMaxBackdrop");
  if (maxed) {
    if (!bd) { bd = document.createElement("div"); bd.id = "convMaxBackdrop"; bd.className = "max-backdrop";
      bd.addEventListener("click", () => setMaxed(null)); document.body.appendChild(bd); }
  } else if (bd && bd.parentNode) { bd.parentNode.removeChild(bd); }
  syncMaxBtns();
  // the terminal panel changed size → let xterm's fit addon re-measure (terminal.js listens
  // on window 'resize' and refits every live session). Harmless for the conversation panel.
  if (typeof window.dispatchEvent === "function") { try { window.dispatchEvent(new Event("resize")); } catch (e) {} }
}
function syncMaxBtns() {
  const cm = document.getElementById("convMax");
  if (cm) { cm.innerHTML = O().icon(maxed === "conv" ? "minimize" : "maximize", ""); cm.title = maxed === "conv" ? "Restore conversation" : "Maximize conversation"; }
  const tm = document.getElementById("termMax");
  if (tm) { tm.innerHTML = O().icon(maxed === "term" ? "minimize" : "maximize", ""); tm.title = maxed === "term" ? "Restore terminal" : "Maximize terminal"; }
}
function clearMax() {   // teardown: drop the overlay + backdrop, reset state
  maxed = null;
  const bd = document.getElementById("convMaxBackdrop"); if (bd && bd.parentNode) bd.parentNode.removeChild(bd);
}
function onDocKey(e) { if (e.key === "Escape" && maxed) { e.preventDefault(); setMaxed(null); } }
