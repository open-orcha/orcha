"""S3 — embedded terminal panel + §3b locking UX (xterm.js over Forge's PTY ws bridge).

Frame's span (spec §3b): the xterm.js panel, the lease-aware open/guard UX, and the
both-ways lock. Built against Forge's contracts — PTY ws bridge (req b960aceb) and
lease-on-the-read-payload (req 959cfbcd).

Phase 7: the vanilla static/{terminal.js,conversation.js,agents.html} surface was ported
to the React SPA. The React equivalents this suite now greps:
  - frontend/src/components/terminal/orchaTerm.ts    — the OrchaTerm engine (registry,
    ISS-71 warm detach/re-attach, ISS-67 bounded reconnect, pty frame protocol)
  - frontend/src/components/terminal/TerminalPane.tsx — pairing UX (§3b guards, ISS-69
    contention copy, ISS-84 preflight gate, exitClass prompts)
  - frontend/src/components/terminal/xtermAssets.ts  — runtime loader for the VENDORED
    xterm assets (still shipped under static/vendor/, served at /assets/vendor/)
  - frontend/src/pages/agents/Conversation.tsx        — the pair-button lift + live-lock
  - frontend/src/pages/agents/agents.css              — the lifted terminal/lock CSS

The node `__TERMJS__`-substitution behavioral harnesses moved to Vitest, driving the
REAL engine with a fake WebSocket + fake window xterm:
  - frontend/src/components/terminal/orchaTerm.test.ts     (engine sims — this file's
    old node harnesses: frame protocol, ISS-71 detach/reattach, ISS-67 backoff/policy)
  - frontend/src/components/terminal/TerminalPane.test.tsx (pairing UX: preflight
    block, live-lease guard, resident hand-off preempt, gate/attach happy path)
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
STATIC = PORTAL / "static"  # the vendored xterm libs still ship here (served at /assets/vendor/)
FRONTEND = PORTAL / "frontend" / "src"
TERMDIR = FRONTEND / "components" / "terminal"


def test_xterm_is_vendored_not_cdn():
    vend = STATIC / "vendor"
    xj = (vend / "xterm.js").read_bytes()
    assert len(xj) > 100_000 and b"Terminal" in xj, "xterm.js missing / not the real library"
    assert (vend / "xterm.css").exists(), "xterm.css not vendored"
    fit = (vend / "addon-fit.js").read_bytes()
    assert b"FitAddon" in fit, "addon-fit not vendored"
    assert (vend / "README.md").exists(), "no provenance note for the vendored libs"
    # the SPA loads the vendored copies at runtime (xtermAssets.ts), never a CDN
    assets = (TERMDIR / "xtermAssets.ts").read_text()
    assert '"/assets/vendor/xterm.js"' in assets and '"/assets/vendor/addon-fit.js"' in assets, \
        "xtermAssets.ts doesn't load the vendored terminal scripts"
    assert "/assets/vendor/xterm.css" in assets, "xterm.css not linked"
    assert "cdn.jsdelivr" not in assets and "unpkg" not in assets, "must not load xterm from a CDN at runtime"
    # and the SPA never bundles a SECOND copy of xterm from npm
    pkg = (PORTAL / "frontend" / "package.json").read_text()
    assert '"xterm"' not in pkg and '"@xterm' not in pkg, "xterm must stay vendored, not an npm dependency"


def test_lease_helper_reads_the_embodiment_field_141_exposes():
    status = (FRONTEND / "lib" / "status.ts").read_text()
    assert "export function leaseOf" in status, "leaseOf not defined/exported"
    assert '["idle", "ephemeral", "resident", "live"]' in status, "lease enum wrong"
    # #141 exposes the lease as `embodiment` on the agent read payload — must read THAT, or the
    # guard/lock never engage and the browser shows a busy agent as free (review P1).
    assert "agent.embodiment" in status, "doesn't read the `embodiment` field #141 exposes"
    assert 'return v && LEASES.indexOf(v) >= 0 ? v : "idle"' in status, "absent/unknown lease should default to idle"
    # and the data adapter must pass `embodiment` through (it whitelists agent fields)
    adapter = (FRONTEND / "api" / "client.ts").read_text()
    assert "embodiment: a.embodiment" in adapter, "data adapter drops the embodiment field"
    assert "embodiment" in (FRONTEND / "types.ts").read_text(), "Agent type drops the embodiment field"


def test_terminal_module_speaks_the_pty_contract():
    # Behavioral proof lives in frontend/src/components/terminal/orchaTerm.test.ts
    # ("speaks the Forge PTY frame protocol…"); these greps pin the wire contract text.
    js = (TERMDIR / "orchaTerm.ts").read_text()
    assert "export function open" in js and "export function close" in js, "no OrchaTerm engine surface"
    # Contract v1 (b960aceb): the bridge is a HOST-side process, discovered via the portal's
    # GET /api/terminal/config -> {ws_url}; NOT the portal origin. Path/query:
    #   <ws_url>/terminal?agent_id=<aid>&actor_agent_id=<human>[&preempt=1]
    assert "export function resolveBridgeBase" in js and '"/api/terminal/config"' in js, "doesn't discover the bridge ws_url"
    assert '"/terminal?agent_id=" + encodeURIComponent(aid)' in js, "agent_id not a query param"
    assert '"&actor_agent_id=" + encodeURIComponent(humanId)' in js, "actor_agent_id missing"
    assert '"&preempt=1"' in js, "no preempt flag"
    assert "location.host" not in js, "must NOT target the portal origin (the bridge is host-side)"
    assert '"ws://127.0.0.1:8765"' in js, "no documented fallback when discovery is absent"
    # JSON frames both ways
    assert 'type: "stdin"' in js and 'type: "resize"' in js, "no stdin/resize client frames"
    assert 'm.type === "stdout"' in js and 'm.type === "status"' in js and 'm.type === "error"' in js, "doesn't handle server frames"
    # explicit close == close-NOW (4001, bridge snapshots + releases immediately);
    # a bare ws.close() (cleanup path) stays the warm-detach signal
    assert '.close(4001' in js, "no close-now path (snapshot-on-close trigger)"
    assert "ws.close()" in js.replace(".close(4001", ""), "no bare-close path (warm detach)"


def test_s3_integration_visible_connect_states():
    # R1 integration: connect failures are VISIBLE (no silent flash-and-die). The panel stays
    # open with a clear message; the composer doesn't lock until a session truly connects.
    c = (TERMDIR / "TerminalPane.tsx").read_text()
    assert "const termFail" in c, "no visible-failure handler"
    assert "termConnected" in c, "doesn't track whether a session actually connected"
    # bridge-down / busy / denied messages, and the 'connecting' state never auto-unpairs
    assert "Terminal bridge not reachable" in c, "no bridge-down message"
    assert "orcha terminal-bridge" in c, "doesn't tell the user how to start the bridge"
    # the bridge sends `lease_denied` for BOTH 4403 (not-human, no holder) and 4409 (busy, holder);
    # they must be DISTINGUISHED (Page diagnosis) — busy keys off `holder`, denial is the rest.
    assert 'code === 4409 || (state === "lease_denied" && holder)' in c, "busy not gated on a held lease (holder/4409)"
    assert 'code === 4403 || state === "lease_denied"' in c, "not-human denial (4403 / holderless lease_denied) not surfaced"
    assert "Couldn't pair as" in c and "acting human" in c, "denial message doesn't point at the human actor"
    assert 'state === "lease_denied" || code === 4409' not in c, "regressed: any lease_denied still lumped as busy"
    # the lock only engages once truly connected (a bridge-down panel must not freeze the composer)
    conv = (FRONTEND / "pages" / "agents" / "Conversation.tsx").read_text()
    assert "(pairing.paired && pairing.termConnected)" in conv, "lock not gated on a real connection"
    css = (FRONTEND / "pages" / "agents" / "agents.css").read_text()
    assert ".term-error" in css, "no failure-state styling"


def test_pair_in_terminal_lifted_into_the_conversation():
    # the §3b terminal is the reference "Pair in terminal" design, docked in the conversation
    # (Conversation.tsx owns the shell via usePairing; OrchaTerm is the engine).
    conv = (FRONTEND / "pages" / "agents" / "Conversation.tsx").read_text()
    assert 'id="convPair"' in conv and "Pair in terminal" in conv, "no Pair-in-terminal control in the conversation header"
    c = (TERMDIR / "TerminalPane.tsx").read_text()
    assert "togglePair" in c and "openPair" in c and "usePairing" in c, "pair flow missing"
    # the lifted shell: traffic lights, the live pairtag, the close-&-save button, xterm in term-body
    assert 'className="lights"' in c and 'className="pairtag"' in c and 'id="termBody"' in c, "reference term shell not lifted"
    assert "Close & save session" in c, "no close-&-save affordance"
    # §3b guard matrix driven by the lease: idle->open, busy->human preempt, live->blocked
    assert "leaseOf(a)" in c, "pair guard doesn't read the lease"
    # ISS-69(b): the preempt path has holder-specific copy (resident=hand-off warm conversation,
    # ephemeral=stop the task) rather than one generic "Preempt the running session?" title.
    assert 'lease === "ephemeral" || lease === "resident"' in c and ("Hand off the live conversation?" in c and "Preempt the running task?" in c), "no holder-specific busy preempt path"
    assert 'lease === "live"' in c, "doesn't block when a live lease is already held"
    # session opens through the shared OrchaTerm engine; close codes + snapshot overlay surfaced
    assert "OrchaTerm.open(" in c and "OrchaTerm.close(aid)" in c, "not wired to the OrchaTerm engine"
    assert "4403" in c and "4409" in c, "ws close codes not handled"
    assert "term-saving" in c and "saving session" in c.lower(), "snapshot-on-close overlay missing"
    # the old #142 separate panel stays retired in the React port
    assert 'id="termWrap"' not in c + conv and "mountTerm" not in c + conv, "old #142 terminal panel resurrected"
    # the reference CSS is present
    css = (FRONTEND / "pages" / "agents" / "agents.css").read_text()
    assert ".conv-wrap.paired" in css and ".term-h .pairtag" in css and ".term-saving" in css, "reference term CSS not lifted"


def test_iss69_contention_ux_names_holder_and_handles_yield():
    """ISS-69 — embodiment-contention UX. (a) DISPLAY: the busy message names the lease HOLDER in
    human terms (resident=in a live conversation, live=in a live terminal, ephemeral=running a
    task) + appends the wire `reason`; the roster shows the embodiment kind. (b)-FRONTEND: the
    resident preempt is framed as a warm-conversation HAND-OFF, and the bridge's `yielding` status
    frame (Forge's contract) renders 'handing off…'."""
    c = (TERMDIR / "TerminalPane.tsx").read_text()
    # (a) holder named in human terms, not the raw lease_kind
    assert "HOLDER_DOING" in c and '"in a live conversation"' in c and '"in a live terminal"' in c and '"running a task"' in c, \
        "busy copy doesn't name the holder in human terms"
    assert "info.reason" in c, "the bridge `reason` detail isn't surfaced on a busy lease"
    assert "is busy with another live session" not in c, "still leaks the old generic busy copy"
    # (b) resident = hand-off warm conversation; ephemeral = stop the task
    assert "Hand off the live conversation?" in c and "warm conversation" in c, "no resident hand-off framing"
    assert "Preempt the running task?" in c, "no ephemeral-task preempt framing"
    # (b) the bridge's yield status frame is handled (Forge contract: state==='yielding')
    assert 'state === "yielding"' in c and "handing off" in c.lower(), "the `yielding` handoff frame isn't handled"
    # (b) P1 (kedar #179): the full-panel `.term-saving` hand-off overlay MUST be cleared on
    # `connected`, else a successful yield→connected hand-off leaves the live terminal covered.
    conn_branch = c[c.index('state === "connected"'):c.index('state === "connected"') + 400]
    assert "setSaving(null)" in conn_branch, "the connected branch doesn't clear the saving/hand-off overlay"
    assert "setError(null)" in conn_branch, "the connected branch doesn't clear a leftover busy/error guard (ISS-80)"
    # the hand-off overlay has its own copy, not the close flow's "Closing — saving session"
    assert 'setSaving("handoff")' in c and "Handing off — saving session" in c, "hand-off overlay reuses the close copy"
    assert "Closing — saving session" in c, "close flow lost its own overlay copy"
    # (a) roster surfaces the embodiment kind from the read payload, colour-coded by kind
    roster = (FRONTEND / "pages" / "agents" / "AgentsPage.tsx").read_text()
    assert "function EmbodBadge" in roster and "leaseOf(a)" in roster, "roster doesn't surface the embodiment lease"
    css = (FRONTEND / "pages" / "agents" / "agents.css").read_text()
    assert ".rrow .rlive.resident" in css and ".rrow .rlive.ephemeral" in css, "roster badge not colour-coded by embodiment kind"


def test_conversation_locks_while_agent_in_live_terminal():
    conv = (FRONTEND / "pages" / "agents" / "Conversation.tsx").read_text()
    # locked while a live lease is held — by another embodiment OR our own CONNECTED pair session
    assert 'leaseOf(agent) === "live"' in conv and "(pairing.paired && pairing.termConnected)" in conv, \
        "lock not driven by live lease / our connected pair"
    assert "disabled={locked}" in conv, "composer not disabled while locked"
    assert conv.count("disabled={locked}") >= 2, "both the input and Send must lock"
    assert "conversation paused" in conv, "no lock banner copy"
    # the lock CSS must gate on the VISIBLE banner — a sibling selector matches a [hidden]
    # .conv-lock too, so without :not([hidden]) every UNLOCKED composer would be dead (P1).
    css = (FRONTEND / "pages" / "agents" / "agents.css").read_text()
    assert ".conv-lock:not([hidden]) + .conv-composer" in css, "lock CSS not gated on the visible banner"
    assert ".conv-lock + .conv-composer" not in css.replace(".conv-lock:not([hidden]) + .conv-composer", ""), \
        "an ungated .conv-lock + .conv-composer rule would disable every composer"
    # the banner is DOM-hidden (not just styled) when unlocked
    assert "hidden={!locked}" in conv, "lock banner not [hidden]-gated on the locked state"


def test_terminal_js_syntax_and_frame_protocol():
    # Vanilla shape: `node --check` + a node harness driving open() end-to-end. React shape:
    # syntax/typing is `tsc --noEmit` (frontend `npm run build` / typecheck), and the behavioral
    # harness is frontend/src/components/terminal/orchaTerm.test.ts
    # ("speaks the Forge PTY frame protocol over the discovered bridge socket"): discovery →
    # contract URL, connected status → onState, stdout → xterm.write, keystroke → stdin frame,
    # resize → resize frame, close → 4001 close-now. Here: pin the Vitest harness exists and
    # covers those beats, so the protocol sim can't silently vanish.
    t = (TERMDIR / "orchaTerm.test.ts").read_text()
    assert "speaks the Forge PTY frame protocol" in t, "frame-protocol Vitest scenario missing"
    for beat in ('"/api/terminal/config"', "/terminal?agent_id=a1&actor_agent_id=h1&preempt=1",
                 '{ type: "stdin", data: "x" }', '{ type: "resize", cols: 120, rows: 40 }', "4001"):
        assert beat in t, f"frame-protocol harness lost a beat: {beat}"


# ---------- ISS-71: per-agent session registry survives navigate-away-and-back ----------

def test_iss71_wiring():
    c = (TERMDIR / "TerminalPane.tsx").read_text()
    # nav-away (pane unmount) DETACHES (keeps the socket open) — never a hard teardown
    unmount = c[c.index("const onHostUnmount"):c.index("const onHostUnmount") + 300]
    assert "OrchaTerm.detach(aid)" in unmount, "nav-away must detach (keep alive), not close"
    assert "OrchaTerm.cleanup" not in unmount and "OrchaTerm.close" not in unmount, \
        "must not hard-teardown the terminal on nav"
    # returning to an agent with a live session re-docks it
    assert "OrchaTerm.hasSession(aid)" in c and "openPair(false)" in c, "doesn't reattach a surviving session on mount"
    t = (TERMDIR / "orchaTerm.ts").read_text()
    assert "export function detach" in t and "export function cleanup" in t and "export function liveAgentIds" in t, \
        "registry API missing"
    assert "const sessions: Record<string, Session> = {}" in t, "no per-agent session registry"
    assert "MAX_SESSIONS" in t and "evictBeyondCap" in t, "retained-session cap missing"
    # Forge caveat: a backgrounded live session is surfaced in the roster — the React roster
    # reads the server-side `embodiment` lease (EmbodBadge), which a live PTY session holds.
    roster = (FRONTEND / "pages" / "agents" / "AgentsPage.tsx").read_text()
    assert "EmbodBadge" in roster, "no roster indicator for a live/backgrounded terminal lease"
    css = (FRONTEND / "pages" / "agents" / "agents.css").read_text()
    assert ".rrow .rlive" in css, "no roster live-badge styling"


def test_iss71_detach_keeps_socket_open_reattach_reuses_it():
    # Behavioral proof moved to frontend/src/components/terminal/orchaTerm.test.ts
    # ("ISS-71: detach keeps the socket open; reattach re-docks the same wrap and reuses the
    # same socket"): detach leaves the DOM but readyState stays OPEN, reattach re-docks the
    # SAME wrap element with NO new WebSocket, explicit close ends the session.
    t = (TERMDIR / "orchaTerm.test.ts").read_text()
    assert "ISS-71: detach keeps the socket open" in t, "ISS-71 Vitest scenario missing"
    for beat in ("OrchaTerm.detach(", "closeCalls.length).toBe(0)", "toBe(wrap)", "instances.length).toBe(1)"):
        assert beat in t, f"ISS-71 harness lost a beat: {beat}"
    # and the engine's detach really is a DOM-only operation (no ws.close on that path)
    src = (TERMDIR / "orchaTerm.ts").read_text()
    detach_fn = src[src.index("export function detach"):src.index("export function close")]
    detach_body = detach_fn.split("\n//")[0]  # stop at the trailing comment block for close()
    assert ".close(" not in detach_body, "detach must NOT close the socket"


# ---------- ISS-67: bounded reconnect-backoff while the bridge is still booting ----------

def test_iss67_reconnect_wiring():
    """String teeth: the backoff seam + progressive UX are actually wired."""
    t = (TERMDIR / "orchaTerm.ts").read_text()
    assert "MAX_CONNECT_ATTEMPTS" in t and "CONNECT_BACKOFF_MS" in t, "no bounded backoff config"
    assert "function retriable" in t and "1006" in t, "no transport-vs-policy close discrimination"
    # never retry a policy close — those codes carry their own UX downstream
    assert "scheduleRetry" in t and "s.attempt < MAX_CONNECT_ATTEMPTS" in t, "retry isn't bounded by attempt count"
    assert "bridgeStarting: true" in t, "retry doesn't report progress to the host"
    assert "performance.mark" in t and "performance.measure" in t, "ISS-67(A) instrumentation missing"
    # the consumer surfaces the progressive state instead of an instant 'not reachable'
    c = (TERMDIR / "TerminalPane.tsx").read_text()
    assert "bridgeStarting" in c and "starting bridge" in c, "TerminalPane doesn't show the bridge-starting UX"


def test_iss67_never_connected_close_retries_then_connects():
    # Behavioral proof moved to frontend/src/components/terminal/orchaTerm.test.ts:
    #   "ISS-67: a never-connected transport close (1006) retries with backoff, then connects"
    #   "ISS-67: the retry budget is BOUNDED — exhausting it hard-fails with 'closed'"
    #   "ISS-67: policy closes (4409 busy / 4403 denied) NEVER retry — 'closed' propagates at once"
    # (fake timers drive the 300…2500ms backoff ladder against the real engine).
    t = (TERMDIR / "orchaTerm.test.ts").read_text()
    assert "never-connected transport close (1006) retries with backoff" in t, "ISS-67 retry scenario missing"
    assert "retry budget is BOUNDED" in t, "ISS-67 bounded-budget scenario missing"
    assert "policy closes (4409 busy / 4403 denied) NEVER retry" in t, "ISS-67 policy-close scenario missing"
    for beat in ("bridgeStarting && e.i.attempt === 1", "advanceTimersByTimeAsync(300)",
                 "[300, 700, 1200, 2000, 2500]", "useFakeTimers"):
        assert beat in t, f"ISS-67 harness lost a beat: {beat}"
