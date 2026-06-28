/* ============================================================================
   Orcha portal — S1 conversation panel (+ S4 slash autocomplete, S5 presence).
   Mounts the turn-based chat for one agent into a host element. The composer is
   rendered ONCE and only the message list repaints on poll, so typing is never
   wiped (the host must mount this OUTSIDE the 3s Orcha.patch panel).

   Contracts (Vault conv-store #115 — STABLE):
     POST /api/agents/{aid}/conversations {actor_agent_id}        get-or-create
     GET  /api/agents/{aid}/conversation?limit=N                  {conversation, turns}
     GET  /api/conversations/{cid}/turns?after_seq=S&limit=N      {turns} (oldest->newest)
     POST /api/conversations/{cid}/turns {role,author_agent_id,content,run_id?,meta?}
   Per-turn work log = the turn.run_id's worker_run_lines, rendered by the SHARED
   run engine (Orcha.runCard + startRunStream), replayed on expand.

   PR2 (Forge E4) lights up: live mid-flight streaming via the conversation event
   stream (turn_started -> run_id), the Stop button (/interrupt), and the inline
   permission / ask-human cards (turn.meta.type). Built forward-compatible here.
   ========================================================================== */
window.OrchaConvo = (function () {
  const O = () => window.Orcha;
  let host = null, agentId = null, convId = null;
  let turns = [], lastSeq = 0, pollTimer = null;
  // ISS-68 PR-3: show the most-recent N turns first; "Load earlier" reveals older ones from the
  // already-fetched set (a client-side reveal — /conversations/{id}/turns has no before-cursor, so
  // we can't page older from the server without a backend change). Reset to 10 on each mount.
  let shown = 10;
  const CONV_PAGE = 20;
  const streamed = {};        // run_id -> stop fn (work-log streams started on expand)
  // ISS-68: per-agent conversation cache so switching agent tabs and back does NOT reload the
  // thread from scratch (visible flicker + lost scroll). On return we paint cached turns instantly
  // and only DELTA-refresh in the background (after_seq); a full reload happens only when there's
  // no cache or it's older than the TTL. Keyed by agent id (one panel mounted at a time).
  const convCache = {};
  const CONV_CACHE_TTL_MS = 60000;
  let slashOpen = false, slashItems = [], slashIdx = 0;
  let awaiting = false;        // optimistic: true from "human turn sent" until the reply lands
  let presence = null, presenceReason = null;   // Vault presence contract (req 6de81ae3), null until live
  let mountTok = 0;            // bumped on every (re)mount/teardown; stale in-flight responses no-op
  let paired = false;          // S3: a terminal panel is docked here
  let termConnected = false;   // S3: the docked terminal actually reached a live session
  let maxed = null;            // ISS-65: which panel is maximized — "conv" | "term" | null

  // ISS-69(a): name the lease HOLDER in human terms instead of leaking the wire `lease_kind`.
  // The holder kind reaches us on the 4409 lease_denied frame (holder=lease_kind) and on the
  // agent read payload's `embodiment`. resident = a warm conversation; live = a human terminal;
  // ephemeral = a background task. Used by both the busy copy and the preempt confirm modal.
  const HOLDER_DOING = { resident: "in a live conversation", live: "in a live terminal", ephemeral: "running a task" };
  function holderDoing(kind) { return HOLDER_DOING[kind] || "in another live session"; }

  // the /-palette mirrors the CLI work skills (presentational; sends as turn content)
  const SKILLS = [
    "/orcha-status", "/orcha-next", "/orcha-task-new", "/orcha-post", "/orcha-done",
    "/orcha-ask", "/orcha-inbox", "/orcha-outbox", "/orcha-respond", "/orcha-close",
    "/orcha-escalate", "/orcha-convert", "/orcha-accept-task", "/orcha-reject-task",
  ];

  /* ---------- #337: conversation file attachments (parity with #330 task-thread) ----------
     Mirror of the task-thread composer (tasks.html #301/#330): files stage + upload immediately
     on pick/drop/paste to the conversation-scoped store, then the stored ids ride on the turn POST
     body. The one conversation-specific wrinkle: a conversation is get-or-create, so an upload
     ensures the conversation exists FIRST (the upload route is conv-scoped). Reset per mount. */
  const ACCEPT_EXT = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "csv", "log", "json"];
  const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
  const extOf = (n) => (String(n || "").split(".").pop() || "").toLowerCase();
  const CLIP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  function fmtSize(n) {
    n = +n || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  let staged = [];          // [{key, name, size, kind, status:'uploading'|'done'|'failed', ref?}]
  let stagedSeq = 0;

  /* ---------- presence (S5): Vault contract, fall back to agent.status ---------- */
  // The conversation read payload carries a backend-derived `presence`
  // (idle|waking|working|busy|replied|stopped) + opaque `presence_reason` (req 6de81ae3).
  // It draws the distinction agent.status CAN'T: "working on MY turn" (→ thinking dots)
  // vs "busy on a task lease, your message is QUEUED" (→ busy pill + queued notice).
  // Until that field is live we degrade gracefully to deriving from agent.status.
  const PRES_LABEL = { idle: "idle", waking: "waking", working: "working", busy: "busy", replied: "replied", stopped: "offline" };
  function presenceOf() {
    if (presence != null) {                       // backend is talking — trust it
      const known = Object.prototype.hasOwnProperty.call(PRES_LABEL, presence);
      const l = known ? PRES_LABEL[presence] : "idle";   // forward-compat: unknown -> idle
      const k = (known && presence === "stopped") ? "offline" : (known ? presence : "idle");
      return { k, l, reason: presenceReason || null };
    }
    const a = O().agentById(agentId) || {};
    const cs = (window.__convMeta && window.__convMeta.status) || null;
    if (cs === "ended") return { k: "offline", l: "offline" };
    switch (a.status) {
      case "working": case "in_progress": return { k: "working", l: "working" };
      case "awaiting_human": case "awaiting_request": return { k: "waking", l: "waiting" };
      case "needs_verification": return { k: "replied", l: "replied" };
      case "terminated": return { k: "offline", l: "offline" };
      default: return { k: "idle", l: "idle" };
    }
  }
  // A reply is pending when the human's latest turn has no agent turn after it. Deriving
  // this from the DURABLE turns (req 1ccab87e) makes the indicator survive an agent-switch
  // + reload — the optimistic `awaiting` flag only covers the gap before the first poll.
  function awaitingReply() {
    if (awaiting) return true;
    const last = turns[turns.length - 1];
    return !!(last && last.role === "human");
  }

  /* ---------- API ---------- */
  function getJSON(url) { return fetch(url).then((r) => r.ok ? r.json() : Promise.reject(r.status)); }
  function postJSON(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  /* ---------- skeleton (rendered ONCE; composer never repaints) ---------- */
  function skeleton(a) {
    return `<div class="conv-wrap" id="convPairWrap">
      <div class="conv">
        <div class="conv-h">
          <div class="conv-who">${O().avatar(a.alias, "ai", "")}<div><div class="cn">${O().esc(a.alias)}</div>
            <div class="cr">${O().esc(a.role || "")}</div></div></div>
          <span class="presence" id="convPresence"></span>
          <button class="btn sm ghost" id="convPair" title="Pair in a live terminal as ${O().esc(a.alias)}">${O().icon("play", "")}<span>Pair in terminal</span></button>
          <button class="btn sm ghost conv-max" id="convMax" title="Maximize conversation" aria-label="Maximize conversation">${O().icon("maximize", "")}</button>
        </div>
        <div class="conv-list" id="convList"><div class="none" style="padding:18px">Loading conversation…</div></div>
        <div class="conv-lock" id="convLock" hidden>${O().icon("shield", "")}<span></span></div>
        <div class="conv-composer">
          <div class="slash" id="convSlash" hidden></div>
          <button type="button" class="conv-attach" id="convAttach" title="Attach files (or drag-drop / paste)" aria-label="Attach files">${CLIP_ICON}</button>
          <input id="convAttachInput" type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.log,.json" style="display:none">
          <textarea id="convInput" class="conv-in" rows="1" placeholder="Message ${O().esc(a.alias)} — type / for skills…"></textarea>
          <button class="btn approve" id="convSend">${O().icon("arrow", "")}Send</button>
        </div>
        <div class="conv-tray" id="convTray"></div>
        <div class="conv-note">Turn-based: ${O().esc(a.alias)} wakes, works, and replies. Live token streaming + Stop + permission cards arrive with E4.</div>
      </div>
      <div class="term-slot" id="convTermSlot"></div>
    </div>`;
  }
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

  /* ---------- ISS-64: persist the composer draft across navigation ----------
     Switching agent tabs remounts this panel, and navigating to another portal page reloads it
     entirely — both wipe the textarea. Persist the per-agent draft in sessionStorage (survives
     page navigation within the tab) and rehydrate on mount; cleared once the turn is sent. */
  const draftKey = (aid) => "orcha:convdraft:" + aid;
  function saveDraft(v) {
    if (!agentId) return;
    try { v ? sessionStorage.setItem(draftKey(agentId), v) : sessionStorage.removeItem(draftKey(agentId)); } catch (e) {}
  }
  function loadDraft(aid) { try { return sessionStorage.getItem(draftKey(aid)) || ""; } catch (e) { return ""; } }

  /* ---------- render the message list (repaints on poll; composer untouched) ---------- */
  function renderList() {
    const list = document.getElementById("convList"); if (!list) return;
    if (!turns.length) { list.innerHTML = '<div class="none" style="padding:18px">No messages yet — say hello to start the conversation.</div>'; return; }
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    // ISS-68 PR-3: render only the most-recent `shown` turns; "Load earlier" reveals the rest.
    const startIdx = Math.max(0, turns.length - shown);
    const visible = turns.slice(startIdx);
    const earlier = startIdx > 0
      ? `<button class="btn sm ghost" style="display:block;margin:0 auto 12px" data-loadearlier>Load earlier · ${visible.length} of ${turns.length}</button>` : "";
    list.innerHTML = earlier + visible.map(bubble).join("") + (awaitingReply() ? indicatorBubble() : "");
    const le = list.querySelector("[data-loadearlier]");
    if (le) le.addEventListener("click", () => { shown += CONV_PAGE; renderList(); });
    // wire each work-log <details> to stream its run on first expand
    list.querySelectorAll("details[data-run]").forEach((d) => {
      d.addEventListener("toggle", () => {
        if (!d.open) return;
        const rid = d.dataset.run;
        if (streamed[rid]) return;
        const logEl = d.querySelector(".log"); if (!logEl) return;
        streamed[rid] = O().startRunStream(logEl, agentId, rid) || (() => {});
      });
    });
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  // The pending-reply indicator's SHAPE follows presence (S5): a resident actively
  // working the human's turn → animated thinking dots; an agent busy on another (task)
  // lease → an honest "queued" notice (never fake "thinking…"). idle right after send is
  // the optimistic gap before presence resolves → show dots for instant feedback.
  function indicatorBubble() {
    const p = presenceOf();
    if (p.k === "busy") return queuedBubble(p);
    if (p.k === "working" || p.k === "waking") return thinkingBubble();
    if (awaiting && p.k === "idle") return thinkingBubble();
    return queuedBubble(p);   // pending turn while the agent looks idle/replied/offline
  }
  // a transient agent-side "thinking…" indicator shown after the human sends, until the
  // agent's reply turn lands (S1 polish — gives immediate feedback that the agent is working).
  function thinkingBubble() {
    const a = O().agentById(agentId);
    return `<div class="turn agent">${O().avatar(a ? a.alias : "?", "ai", "sm")}
      <div class="tb"><div class="tmeta">${O().esc(a ? a.alias : "agent")}<span class="tt">thinking…</span></div>
        <div class="conv-thinking"><span></span><span></span><span></span></div></div></div>`;
  }
  // honest "your message is queued" notice when the agent is busy on another task lease.
  // presence_reason is opaque human-readable text from the backend (don't parse) — fall
  // back to a generic line when it's absent.
  function queuedBubble(p) {
    const a = O().agentById(agentId);
    const name = a ? a.alias : "agent";
    const msg = (p && p.reason) ? p.reason
      : name + " is busy with another task — your message is queued and will be answered when it's free.";
    return `<div class="turn agent">${O().avatar(name, "ai", "sm")}
      <div class="tb"><div class="tmeta">${O().esc(name)}<span class="tt">queued</span></div>
        <div class="conv-queued">${O().icon("clock", "")}<span>${O().esc(msg)}</span></div></div></div>`;
  }
  // #337: render a turn's attachments (read view), parity with the task thread. Images → inline
  // thumbnail (click = lightbox); everything else → a download chip. esc() the name; the url is a
  // same-origin /api/conversations/{cid}/attachments path the backend built.
  function attRow(a) {
    const url = O().esc(a.url || "");
    const nm = O().esc(a.name || a.id || "file");
    if (a.kind === "image") {
      return `<img class="att-img" src="${url}" alt="${nm}" title="${nm}" loading="lazy" data-lightbox="${url}">`;
    }
    return `<a class="att-file" href="${url}" target="_blank" rel="noopener" download>${FILE_ICON}
      <span>${nm}</span><span class="sz">${fmtSize(a.size)}</span></a>`;
  }
  function bubble(t) {
    const human = t.role === "human";
    const a = O().agentById(t.author_agent_id);
    const meta = t.meta || {};
    // S2 forward-compat: an agent turn flagged as a permission/ask card (lights up with E4)
    const card = !human && (meta.type === "permission_request" || meta.type === "ask_human");
    const work = (!human && t.run_id) ? `<details data-run="${O().esc(t.run_id)}">
      <summary class="work-sum">${O().icon("play", "")}work log · ${O().esc(t.run_id.slice ? t.run_id.slice(0, 8) : t.run_id)}</summary>
      <div class="log" id="convlog-${O().esc(t.run_id)}"></div></details>` : "";
    const atts = (t.attachments || []).length
      ? `<div class="msg-atts">${t.attachments.map(attRow).join("")}</div>` : "";
    return `<div class="turn ${human ? "human" : "agent"}">
      ${human ? "" : O().avatar(a ? a.alias : "?", "ai", "sm")}
      <div class="tb">
        <div class="tmeta">${O().esc(human ? "you" : (a ? a.alias : "agent"))}<span class="tt">${t.created_at ? O().relTime(t.created_at) : ""}</span></div>
        ${card ? cardHtml(meta) : `<div class="tx md">${O().mdText(t.content || "")}</div>`}
        ${atts}
        ${work}
      </div></div>`;
  }
  function cardHtml(meta) {
    // PR2/E4 will make these interactive; here we render the affordance forward-compatibly.
    if (meta.type === "permission_request") {
      return `<div class="gcard perm"><div class="gh">${O().icon("shield", "")}Permission requested${meta.tool_name ? " · " + O().esc(meta.tool_name) : ""}</div>
        ${meta.tool_input ? `<pre class="gpre">${O().esc(typeof meta.tool_input === "string" ? meta.tool_input : JSON.stringify(meta.tool_input, null, 2))}</pre>` : ""}
        <div class="gnote">Allow / deny lands with E4.</div></div>`;
    }
    return `<div class="gcard ask"><div class="gh">${O().icon("spark", "")}${O().esc(meta.question || "Needs an answer")}</div>
      <div class="gnote">Reply lands with E4.</div></div>`;
  }

  function renderPresence() {
    const el = document.getElementById("convPresence"); if (!el) return;
    const p = presenceOf();
    el.className = "presence p-" + p.k;
    el.innerHTML = `<span class="d"></span>${O().esc(p.l)}`;
    applyLock();
  }
  // S3 §3b vice-versa lock: while the agent holds a `live` lease (a human owns the embodiment
  // in a terminal), the conversation is READ-ONLY — typing here would race the live session.
  // The daemon drains queued turns on close. Lease comes from the agent read payload (leaseOf);
  // absent until Forge ships the field → never locks (graceful).
  function applyLock() {
    const lock = document.getElementById("convLock");
    const inp = document.getElementById("convInput");
    const send = document.getElementById("convSend");
    if (!lock) return;
    const a = O().agentById(agentId);
    // locked while a `live` lease is held — our OWN connected pair session, or another
    // embodiment (from the read payload). NOT while the panel is merely connecting/errored,
    // so a bridge-down panel doesn't wrongly freeze the composer.
    const locked = (paired && termConnected) || (a && O().leaseOf(a) === "live");
    lock.hidden = !locked;
    if (locked) { const s = lock.querySelector("span"); if (s) s.textContent = (a ? a.alias : "Agent") + " is in a live terminal — conversation paused."; }
    if (inp) { inp.disabled = !!locked; }
    if (send) { send.disabled = !!locked; }
    const att = document.getElementById("convAttach"); if (att) att.disabled = !!locked;   // #337
  }

  /* ---------- load + poll ---------- */
  // snapshot the live conversation state into the per-agent cache (ISS-68 no-reload-on-switch).
  function cacheConv() {
    if (!agentId) return;
    convCache[agentId] = { convId: convId, turns: turns.slice(), lastSeq: lastSeq,
                           presence: presence, presenceReason: presenceReason, at: Date.now() };
  }
  function load() {
    const tok = mountTok;
    getJSON("/api/agents/" + encodeURIComponent(agentId) + "/conversation?limit=50")
      .then((d) => {
        if (tok !== mountTok) return;        // panel re-mounted on another conversation mid-flight
        convId = d.conversation ? d.conversation.id : null;
        window.__convMeta = d.conversation || null;
        presence = d.presence || null; presenceReason = d.presence_reason || null;   // top-level (Vault)
        turns = d.turns || [];
        lastSeq = turns.length ? turns[turns.length - 1].seq : 0;
        cacheConv();
        renderList(); renderPresence();
      })
      .catch(() => { const l = document.getElementById("convList"); if (l) l.innerHTML = '<div class="none" style="padding:18px">Conversation unavailable.</div>'; });
  }
  function poll() {
    if (!convId) { renderPresence(); load(); return; }
    refreshPresence();
    const tok = mountTok;
    getJSON("/api/conversations/" + encodeURIComponent(convId) + "/turns?after_seq=" + lastSeq + "&limit=50")
      .then((d) => {
        if (tok !== mountTok) return;        // stale: a different conversation is mounted now
        const fresh = d.turns || [];
        if (!fresh.length) return;
        if (fresh.some((t) => t.role === "agent")) awaiting = false;   // reply landed -> stop "thinking"
        turns = turns.concat(fresh);
        lastSeq = turns[turns.length - 1].seq;
        cacheConv();
        renderList();
      })
      .catch(() => {});
  }
  // presence + presence_reason ride on GET /api/conversations/{id} (NOT the /turns delta),
  // so refresh them on the same tick. If the endpoint/field isn't live yet this no-ops and
  // presenceOf falls back to agent.status. A presence change repaints the pending indicator.
  function refreshPresence() {
    const tok = mountTok, cid = convId;
    getJSON("/api/conversations/" + encodeURIComponent(cid))
      .then((d) => {
        if (tok !== mountTok) return;        // a stale poll must NOT paint another agent's presence
        const np = d.presence || null, nr = d.presence_reason || null;
        const changed = np !== presence || nr !== presenceReason;
        presence = np; presenceReason = nr;
        renderPresence();
        if (changed) renderList();
      })
      .catch(() => { if (tok === mountTok) renderPresence(); });   // not live yet -> keep status-derived
  }

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

  function send() {
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
    const tok = mountTok;   // a remount mid-send must not retarget another agent's conversation
    ensureConv(tok).then((res) => {
      if (tok !== mountTok) return;   // remounted for another agent → abandon this send
      if (!res.ok) { O().toast("Couldn't open conversation (" + (res.status || "") + ")", "danger"); return; }
      return postJSON("/api/conversations/" + encodeURIComponent(convId) + "/turns",
        { role: "human", author_agent_id: h.id, content: v, attachments: atts.length ? atts : undefined })
        .then((r) => {
          if (tok !== mountTok) return;   // remounted before the turn landed → don't paint a stale panel
          if (!r.ok) { O().toast("Send failed (" + r.status + ")", "danger"); return; }
          inp.value = ""; autosize(inp); saveDraft("");   // ISS-64: drop the persisted draft once sent
          staged = []; renderTray();                      // #337: clear the staging tray once sent
          O().toast("Sent — " + (O().agentById(agentId) || {}).alias + " will reply.", "ok");
          awaiting = true; renderList(); poll();   // show the "thinking…" indicator until the reply lands
        });
    });
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

  /* ---------- lifecycle ---------- */
  function mount(el, aid) {
    teardown();
    host = el; agentId = aid; convId = null; turns = []; lastSeq = 0; awaiting = false;
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

  return { mount, teardown, presenceOf, awaitingReply };
})();
