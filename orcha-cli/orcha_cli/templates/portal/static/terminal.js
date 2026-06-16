/* ============================================================================
   Orcha portal — S3 embedded terminal (live embodiment), spec §3b.
   An xterm.js panel wired to Forge's PTY websocket bridge. Opening a terminal
   claims the agent's `live` lease (single-embodiment invariant); the bridge runs
   `orcha use <agent>` AS the agent and the human drives it from the browser.

   ISS-71: sessions are a PER-AGENT REGISTRY that OUTLIVES the conversation panel,
   so navigating away from an agent and back KEEPS the live session. On nav-away we
   DETACH the xterm element from the DOM but leave the websocket OPEN — the bridge's
   _renew heartbeat (60s, lease TTL 180s) keeps the PTY + lease alive with no I/O,
   and ws ping/pong keeps the socket healthy (Forge confirmed: zero bridge change).
   On return we RE-ATTACH the same xterm element (scrollback + connection intact).
   The session ends only on an explicit close() or a true page reload.

   Forge PTY-bridge contract (b960aceb v1): WS <ws_url>/terminal?agent_id=<aid>&
   actor_agent_id=<human>[&preempt=1]; ws_url discovered via GET /api/terminal/config.
   FRAMES (JSON text): client {stdin|resize} ; server {stdout|status|error}.
   CLOSE codes: 4400 bad-req · 4403 not-human · 4404 unknown-agent · 4409 busy.
   ========================================================================== */
window.OrchaTerm = (function () {
  const O = () => window.Orcha;
  let _gen = 0;            // monotonic; each session captures one to invalidate stale async
  let _baseCache = null;   // discovered bridge ws base (cached on success)
  const sessions = {};     // agentId -> session (survives panel mount/teardown)
  const order = [];        // insertion order, for the retained-session cap
  const MAX_SESSIONS = 4;  // bound open sockets — close the oldest DETACHED beyond this

  // ISS-67: cold reopen hits the bridge while it's still booting, so the first ws fails to
  // connect (abnormal close, no policy frame). Instead of hard-failing the reopen ("bridge not
  // reachable" + forced re-click), retry with BOUNDED backoff while we've never reached
  // `connected`. Bounded — never an unbounded reconnect loop. ~6.7s total before giving up.
  const MAX_CONNECT_ATTEMPTS = 5;
  const CONNECT_BACKOFF_MS = [300, 700, 1200, 2000, 2500];

  // ISS-67 (A): perf instrumentation to pin where the reopen blank-wait goes (discovery vs ws
  // handshake vs first byte). User Timing marks/measure are no-ops if `performance` is absent.
  function perfMark(s, label) {
    try { if (typeof performance !== "undefined" && performance.mark) performance.mark("orcha-term:" + label + ":" + s.aid); } catch (e) {}
  }
  function perfMeasure(s) {
    try {
      if (typeof performance !== "undefined" && performance.measure)
        performance.measure("orcha-term:reopen-to-connected:" + s.aid, "orcha-term:open:" + s.aid);
    } catch (e) {}
  }
  // retry ONLY transport-level failures (bridge not yet accepting): abnormal closure / no status
  // frame / no code. NEVER retry a policy close (4400/4403/4404/4409 — they carry their own UX)
  // or a clean 1000 (a real session end).
  function retriable(code) { return code === 1006 || code === 1005 || code === undefined || code === null; }

  function libsReady() { return typeof window.Terminal === "function"; }

  // The PTY bridge is a HOST-side process, NOT the portal origin. Discover its ws base from
  // Forge's GET /api/terminal/config -> {ws_url}; fall back to the documented default.
  function resolveBridgeBase() {
    if (_baseCache) return Promise.resolve(_baseCache);
    if (typeof fetch === "undefined") return Promise.resolve("ws://127.0.0.1:8765");
    return fetch("/api/terminal/config")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.ws_url) { _baseCache = d.ws_url; return _baseCache; } return "ws://127.0.0.1:8765"; })
      .catch(function () { return "ws://127.0.0.1:8765"; });
  }

  // open() either RE-ATTACHES an existing live session for `aid` into `el`, or starts a fresh
  // one. opts: {preempt?, onState?(state, info)}. The xterm lives in `s.wrap`, an element we
  // move between hosts so its rendered buffer survives nav.
  function open(el, aid, opts) {
    opts = opts || {};
    const onState = typeof opts.onState === "function" ? opts.onState : function () {};
    const existing = sessions[aid];
    if (existing && existing.ws && existing.ws.readyState <= 1) {   // RE-ATTACH
      existing.onState = onState;
      existing.hostEl = el;
      if (existing.wrap) { el.appendChild(existing.wrap); refit(existing); }
      onState(existing.connected ? "connected" : "connecting", { reattached: true });
      return;
    }
    if (!libsReady()) { onState("error", { message: "terminal library not loaded" }); return; }
    const human = O().actingHuman();
    if (!human) { O().toast("Pick an acting human (top-right) first.", "danger"); onState("no_human"); return; }

    const s = { aid: aid, ws: null, term: null, fit: null, wrap: null, connected: false,
                hostEl: el, onState: onState, gen: ++_gen, winResize: null,
                connectUrl: null, attempt: 0, retryTimer: null, ioWired: false };
    sessions[aid] = s; order.push(aid); evictBeyondCap(aid);

    s.term = new window.Terminal({
      fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true, convertEol: true, scrollback: 5000,
      theme: { background: "#0b0e14", foreground: "#d5d9e0", cursor: "#3fb6a8" },
    });
    const FitAddon = window.FitAddon && window.FitAddon.FitAddon;
    if (FitAddon) { s.fit = new FitAddon(); s.term.loadAddon(s.fit); }
    s.wrap = (typeof document !== "undefined") ? document.createElement("div") : null;
    if (s.wrap) { s.wrap.className = "term-xterm"; s.wrap.style.height = "100%"; el.appendChild(s.wrap); s.term.open(s.wrap); }
    refit(s);

    onState("connecting");
    perfMark(s, "open");
    const myGen = s.gen;
    resolveBridgeBase().then(function (base) {
      if (!sessions[aid] || sessions[aid].gen !== myGen) return;   // detached/closed/reopened while discovering
      perfMark(s, "base-resolved");
      s.connectUrl = String(base).replace(/\/+$/, "") +
        "/terminal?agent_id=" + encodeURIComponent(aid) +
        "&actor_agent_id=" + encodeURIComponent(human.id) + (opts.preempt ? "&preempt=1" : "");
      wireTermIO(s);            // stdin/resize/window-resize: wired ONCE, survives reconnects
      connectWs(s, myGen);     // attempt 0; onclose drives bounded retries while never-connected
    });
  }

  // stdin/resize/window-resize handlers reference `s` (and s.ws via sendFrame, which guards on
  // readyState) so they're correct across reconnects — wire them ONCE, never per ws attempt.
  function wireTermIO(s) {
    if (s.ioWired) return;
    s.ioWired = true;
    s.term.onData(function (d) { sendFrame(s, { type: "stdin", data: d }); });
    s.term.onResize(function (size) { sendFrame(s, { type: "resize", cols: size.cols, rows: size.rows }); });
    s.winResize = function () { refit(s); };
    if (typeof window.addEventListener === "function") window.addEventListener("resize", s.winResize);
  }

  function connectWs(s, myGen) {
    const live = function () { return sessions[s.aid] && sessions[s.aid].gen === myGen; };
    if (!live()) return;
    perfMark(s, "ws-attempt-" + s.attempt);
    try { s.ws = new WebSocket(s.connectUrl); } catch (e) { s.onState("error", { message: String(e) }); cleanup(s.aid); return; }
    s.ws.onopen = function () { perfMark(s, "ws-open"); sendResize(s); };
    s.ws.onmessage = function (ev) {
      if (!live()) return;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "stdout") { if (s.term) s.term.write(m.data || ""); }
      else if (m.type === "status") { if (m.state === "connected") { s.connected = true; s.attempt = 0; perfMeasure(s); refit(s); sendResize(s); } s.onState(m.state, m); }
      else if (m.type === "error") { if (s.term) s.term.write("\r\n\x1b[31m[" + (m.message || "error") + "]\x1b[0m\r\n"); s.onState("error", m); }
    };
    s.ws.onclose = function (ev) {
      if (!live()) return;
      const code = ev && ev.code;
      // ISS-67 (B): never reached `connected` + a transport-level close → the bridge is most
      // likely still booting. Retry with bounded backoff instead of hard-failing the reopen.
      if (!s.connected && retriable(code) && s.attempt < MAX_CONNECT_ATTEMPTS) { scheduleRetry(s, myGen, code); return; }
      // otherwise a real end (policy close, clean 1000, post-connect drop, or retries exhausted).
      s.connected = false; const cb = s.onState; cleanup(s.aid); cb("closed", { code: code });
    };
    // a never-connected error precedes onclose for a failed connect; let onclose drive the
    // backoff so we don't flash an error mid-retry. Only surface errors on a LIVE session.
    s.ws.onerror = function () { if (live() && s.connected) s.onState("error", {}); };
  }

  // ISS-67 (B+C): schedule the next bounded connect attempt, and tell the host the bridge is
  // starting (so the panel shows "starting bridge… (n/N)" instead of a silent "connecting…").
  function scheduleRetry(s, myGen, code) {
    const delay = CONNECT_BACKOFF_MS[Math.min(s.attempt, CONNECT_BACKOFF_MS.length - 1)];
    s.attempt += 1;
    s.onState("connecting", { bridgeStarting: true, attempt: s.attempt, max: MAX_CONNECT_ATTEMPTS, code: code });
    s.retryTimer = setTimeout(function () {
      s.retryTimer = null;
      if (!sessions[s.aid] || sessions[s.aid].gen !== myGen) return;   // detached/closed/reopened mid-backoff
      connectWs(s, myGen);
    }, delay);
  }

  function refit(s) { if (s && s.fit) { try { s.fit.fit(); } catch (e) {} } }
  function sendResize(s) { if (s && s.term) sendFrame(s, { type: "resize", cols: s.term.cols, rows: s.term.rows }); }
  function sendFrame(s, o) { if (s && s.ws && s.ws.readyState === 1) { try { s.ws.send(JSON.stringify(o)); } catch (e) {} } }

  // DETACH (ISS-71): on nav-away, pull the xterm element out of the DOM but KEEP the socket
  // open so the session survives. No host to notify while detached.
  function detach(aid) {
    const s = sessions[aid]; if (!s) return;
    if (s.wrap && s.wrap.parentNode) s.wrap.parentNode.removeChild(s.wrap);
    s.hostEl = null; s.onState = function () {};
  }

  // explicit close → ws.close(4001) tells the bridge "close NOW": snapshot + teardown + lease
  // release immediately. A bare ws.close() (nav away / refresh / network drop) is a warm DETACH —
  // the bridge parks the PTY for the grace window. 4001 = bridge CLOSE_NOW_CODE; onclose cleans up.
  function close(aid) {
    const s = sessions[aid]; if (!s) return;
    if (s.ws && s.ws.readyState <= 1) { try { s.ws.close(4001, "user-close"); } catch (e) {} }
    else cleanup(aid);
  }

  function cleanup(aid) {
    const s = sessions[aid]; if (!s) return;
    s.gen = -1;   // invalidate any in-flight async for this aid
    if (s.retryTimer) { try { clearTimeout(s.retryTimer); } catch (e) {} s.retryTimer = null; }   // ISS-67: cancel a pending backoff
    if (s.winResize && typeof window.removeEventListener === "function") window.removeEventListener("resize", s.winResize);
    if (s.ws) { try { s.ws.close(); } catch (e) {} }
    if (s.term) { try { s.term.dispose(); } catch (e) {} }
    if (s.wrap && s.wrap.parentNode) s.wrap.parentNode.removeChild(s.wrap);
    delete sessions[aid];
    const i = order.indexOf(aid); if (i >= 0) order.splice(i, 1);
  }

  // keep at most MAX_SESSIONS open sockets: close the oldest DETACHED session (never the one
  // just opened, never a still-attached one).
  function evictBeyondCap(keepAid) {
    let live = order.filter(function (a) { return sessions[a]; });
    for (let i = 0; live.length > MAX_SESSIONS && i < live.length; i++) {
      const a = live[i];
      if (a === keepAid) continue;
      if (sessions[a] && !sessions[a].hostEl) { close(a); live = order.filter(function (x) { return sessions[x]; }); i = -1; }
    }
  }

  // Part A (ISS-84 #244): DETERMINISTIC PRE-GATE readiness. Before opening a PTY, ask the bridge
  // whether the agent's selected runtime CLI (`claude`/`codex`) is installed on the host. Only the
  // bridge can know — the portal API runs IN the container and can't shutil.which the host PATH.
  // The bridge exposes a cheap HTTP readiness verb on the SAME host as its ws server (Anvil's
  // contract); we derive its http(s) base from the discovered ws base and GET /preflight.
  // Response shape (contract): {runtime, installed, exec_path, install_hint, override_env}.
  // FAIL-OPEN by design: any error / missing endpoint / timeout resolves to `null` so pairing is
  // NEVER blocked when the probe is unavailable (older bridge, bridge down, or before Anvil's verb
  // ships). Only a definitive {installed:false} gates the pair (handled by the caller).
  function httpBaseFromWs(wsBase) { return String(wsBase).replace(/^ws/i, "http").replace(/\/+$/, ""); }
  function preflight(aid) {
    if (typeof fetch === "undefined") return Promise.resolve(null);
    return resolveBridgeBase().then(function (base) {
      const url = httpBaseFromWs(base) + "/preflight?agent_id=" + encodeURIComponent(aid);
      // bound the wait so a non-responsive bridge can't stall the pre-gate; AbortController is a
      // no-op fallback if unavailable. ~1.5s is generous for a localhost shutil.which.
      let ctl = null, t = null;
      try { if (typeof AbortController === "function") { ctl = new AbortController(); t = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 1500); } } catch (e) {}
      return fetch(url, ctl ? { signal: ctl.signal } : undefined)
        .then(function (r) { if (t) clearTimeout(t); return r.ok ? r.json() : null; })
        .catch(function () { if (t) clearTimeout(t); return null; });
    }).catch(function () { return null; });
  }

  function hasSession(aid) { const s = sessions[aid]; return !!(s && s.ws && s.ws.readyState <= 1); }
  function isOpen(aid) { return hasSession(aid); }
  function isConnected(aid) { const s = sessions[aid]; return !!(s && s.connected); }
  // agentIds with a backgrounded/active live session — drives the roster "live" indicator.
  function liveAgentIds() { return Object.keys(sessions).filter(hasSession); }

  return { open, detach, close, cleanup, isOpen, isConnected, hasSession, liveAgentIds, libsReady, preflight };
})();
