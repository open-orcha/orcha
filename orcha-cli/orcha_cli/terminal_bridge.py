"""S3 R1 — host-side PTY / websocket bridge for the LIVE embedded-terminal embodiment (§3b).

The portal's xterm.js panel opens a localhost websocket to this bridge. The bridge:
  1. verifies the actor is a human + claims the agent's `live` single-flight lease,
  2. provisions an ISOLATED git worktree off origin/main (ISS-8 — live code work must NOT
     tangle the shared checkout; today only ephemeral DAEMON wakes are isolated),
  3. spawns `orcha use <alias>` in a PTY (Vault's cmd_use execs interactive `claude` AS the
     agent, per the ORCHA_LIVE env contract) in that worktree,
  4. relays stdio as JSON frames + window resizes,
  5. renews the lease while connected, and on close drives: snapshot → worktree teardown →
     lease release.

The terminal must run host-side: `orcha use` needs the host `claude` CLI + the user's auth
+ the agent's repo, none of which exist in the portal container. So this lives beside the
notifier daemon (the existing host process that already spawns host workers + owns leases).

`websockets` is imported LAZILY (only inside serve_bridge), so this module — and its unit
tests — import without the dependency (which Vault adds to orcha-cli deps in his R1 PR).
"""
import fcntl
import json
import os
import pty
import signal
import struct
import termios
import time

from . import notifier

# Bridge defaults (localhost / trusted-local only — §9).
BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 8765
LIVE_LEASE_TTL_SECS = 180          # short + renewed while connected (E1 single-flight)
LIVE_RENEW_SECS = 60               # renew cadence well within the TTL
PTY_READ_BYTES = 65536
# ISS-67/B1: after a ws closes, the live claude+PTY+worktree are held WARM (not torn down) for this
# window so a reopen reattaches the SAME session instantly (zero re-injection). Tied to
# LIVE_LEASE_TTL_SECS as the SINGLE source of truth (Page's call): warm-PTY lifetime == the
# "this session is still yours" lease window, so there's no drift where the lease is still held but
# the warm PTY already died (a 90s cap would create exactly that gap). The lease is RENEWED through
# the whole window and released only at grace-expiry teardown — so the two windows coincide exactly.
# Flippable at PR-verify (90s vs 180s) — surfaced to Kedar per Page.
LIVE_GRACE_SECS = LIVE_LEASE_TTL_SECS
# Bound the screen replayed to a reattaching client (a reopened xterm starts blank) so it shows the
# current screen instantly instead of waiting for the next PTY output. Tail of the relayed buffer.
LIVE_REPLAY_CAP = 65536
# select() timeout for the PTY reader: small so the reader loop notices a park/stop promptly and
# releases the master_fd (no blocked read thread left holding it) before a reattach starts a fresh
# reader on the SAME fd — two concurrent readers would split the byte stream.
PTY_SELECT_TIMEOUT = 0.2
# ISS-69(b): how long the bridge keeps retrying a preempt claim while an idle resident yields.
# Must span more than one daemon tick (the daemon reads the yield request on its ~2s wake-renew
# and closes the resident) plus the resident's graceful SIGTERM→SIGKILL snapshot window.
PREEMPT_RETRY_TOTAL_SECS = 20.0
PREEMPT_RETRY_INTERVAL_SECS = 1.0
# ISS-73: tail-cap on the persisted live-session transcript (mirrors notifier._capture_run_output).
LIVE_RUN_OUTPUT_CAP = 200_000
# [P1 #218] App close code the frontend sends on an EXPLICIT "Close & save session" (OrchaTerm
# .close → ws.close(CLOSE_NOW_CODE)). It means: snapshot + teardown + release the lease NOW.
# Every other closure (browser nav/refresh = 1001, network drop = 1006, no code at all) is a
# warm DETACH → park for the grace window. Without this distinction an intentional close held
# the lease (agent unwakeable/paired) for up to LIVE_GRACE_SECS.
CLOSE_NOW_CODE = 4001

# #297: the runtime a model-less-but-resolved target (a human) normalizes to. Mirrors
# __main__.RUNTIME_CLAUDE; kept local so this module imports without pulling in the host CLI.
RUNTIME_CLAUDE = "claude"


# ---------- ENV contract (Vault req 9f5caa8e) ----------

def build_spawn_env(alias, cold, session_id=None, base_env=None, model=None, runtime=None,
                    run_token=None):
    """The env the PTY's `orcha use <alias>` inherits. Vault's cmd_use reads these:
      ORCHA_LIVE=1            → exec interactive claude (not the export print)
      ORCHA_LIVE_COLD=1|0     → cold boot (inject persona+digest+history) vs resume
      ORCHA_LIVE_RESUME_SID   → session to `claude --resume` when COLD=0
      ORCHA_LIVE_MODEL        → the agent's selected model id to pin on a COLD boot (#297)
      ORCHA_LIVE_RUNTIME      → the agent's runtime ('claude'|'codex') (#297)
      ORCHA_RUN_TOKEN         → GH#91/90 WORK embodiment token (gated task-lifecycle calls carry it)
      ORCHA_ALIAS             → run AS the agent (set ALWAYS)

    #297: the bridge already resolved the agent's model+runtime from the /persona fetch that
    authorized this terminal, so it hands them down here. cmd_use prefers them over a second,
    fail-open /persona round-trip (which silently degraded to claude+DEFAULT_MODEL when the
    re-fetch's binding/agent_id was incomplete or /persona was slow). RUNTIME is set whenever the
    bridge resolved a target (even a model-less human → 'claude') so cmd_use can tell a
    bridge-spawn (trust env) from a direct `orcha use` (resolve + warn on degrade) apart. MODEL is
    pinned only on a COLD boot; a WARM --resume keeps the session's already-booted model.
    """
    env = dict(os.environ if base_env is None else base_env)
    env["ORCHA_ALIAS"] = alias
    env["ORCHA_LIVE"] = "1"
    if run_token:
        env["ORCHA_RUN_TOKEN"] = str(run_token)
    else:
        env.pop("ORCHA_RUN_TOKEN", None)             # no token (mint failed) → degraded, gated calls 403
    env["ORCHA_LIVE_COLD"] = "1" if cold else "0"
    if not cold and session_id:
        env["ORCHA_LIVE_RESUME_SID"] = str(session_id)
    else:
        env.pop("ORCHA_LIVE_RESUME_SID", None)
    if model:
        env["ORCHA_LIVE_MODEL"] = str(model)
    else:
        env.pop("ORCHA_LIVE_MODEL", None)            # human/unresolved → no --model (don't leak a stale one)
    if runtime:
        env["ORCHA_LIVE_RUNTIME"] = str(runtime)
    else:
        env.pop("ORCHA_LIVE_RUNTIME", None)
    return env


# ---------- JSON frame protocol (contract → Frame) ----------

def make_frame(ftype, **fields):
    """Server→client frame as a JSON string. types: stdout | status | error."""
    return json.dumps({"type": ftype, **fields})


def parse_frame(raw):
    """Client→server frame → dict, or None if malformed. types: stdin | resize."""
    try:
        d = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return d if isinstance(d, dict) and "type" in d else None


def set_winsize(master_fd, cols, rows):
    """Apply an xterm resize to the PTY (TIOCSWINSZ). Best-effort; ignores bad fds."""
    try:
        cols = max(1, min(int(cols), 10000))
        rows = max(1, min(int(rows), 10000))
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        return True
    except (OSError, ValueError, TypeError):
        return False


def apply_client_frame(frame, master_fd):
    """Route a parsed client frame to the PTY. Returns the action taken
    ('stdin'|'resize'|'ignored') so the relay loop + tests can assert behavior."""
    if not frame:
        return "ignored"
    t = frame.get("type")
    if t == "stdin":
        data = frame.get("data")
        if isinstance(data, str) and data:
            os.write(master_fd, data.encode("utf-8", "replace"))
            return "stdin"
        return "ignored"
    if t == "resize":
        set_winsize(master_fd, frame.get("cols"), frame.get("rows"))
        return "resize"
    return "ignored"


# ---------- worktree teardown with live-human safety ----------

def _worktree_is_dirty(worktree):
    """True if the worktree has uncommitted changes (staged or unstaged or untracked)."""
    rc, out = notifier._run_git(["status", "--porcelain"], cwd=worktree)
    return rc == 0 and bool(out.strip())


def safe_teardown_worktree(base_cwd, worktree, branch):
    """Tear down a LIVE session's worktree WITHOUT ever discarding uncommitted human work.

    Unlike the ephemeral daemon path (which force-removes — a one-shot worker leaves nothing
    a human cares about), a live terminal may leave edits the person isn't done with. So:
    only remove when the worktree is CLEAN (committed work on the branch is preserved by
    notifier._teardown_worktree, which keeps a branch that has commits); if it's DIRTY,
    PRESERVE the worktree and report it. Returns 'removed' | 'preserved-dirty' | 'noop'.
    """
    if not worktree:
        return "noop"
    if _worktree_is_dirty(worktree):
        return "preserved-dirty"
    notifier._teardown_worktree(base_cwd, worktree, branch)
    return "removed"


# ---------- GH#91/90: embodiment token (a live terminal is a WORK embodiment) ----------

def mint_live_token(api_base, aid):
    """Mint a WORK embodiment token (kind='live') for a live terminal session. The live terminal
    is a WORK embodiment — a human legitimately claims/works tasks through it — so the token's lane
    is 'work', which passes the server's `_require_work_lane` gate on the task-lifecycle endpoints.
    Uses the SAME A2 API mechanism (`notifier._post_json`) every other bridge call uses. Best-effort:
    returns the run_token string, or None if the mint POST fails (a token failure must NEVER block a
    human's live terminal — the caller continues token-less/degraded on None)."""
    tok = notifier._post_json(
        f"{api_base}/api/agents/{aid}/embodiment-tokens",
        {"lane": "work", "kind": "live"})
    return (tok or {}).get("run_token")


def revoke_live_token(api_base, token):
    """Revoke a minted embodiment token (idempotent server-side). Best-effort no-op when the token
    was never minted (token is None). Same API mechanism as every other bridge call."""
    if not token:
        return
    notifier._post_json(f"{api_base}/api/embodiment-tokens/{token}/revoke", {})


# ---------- lease lifecycle (reuse E1 single-flight via the API) ----------

def claim_live_lease(api_base, aid, preempt=False):
    """Claim the agent's `live` lease before spawning. Returns the claim dict
    {claimed, lease_kind, cold, session_id, ...} (cold/session_id drive Vault's boot).
    A non-claim (someone else holds the embodiment) returns claimed=False + reason.
    ISS-69(b): with preempt=True, a claim blocked by an IDLE warm resident records a yield
    request (reason "yield_pending") that the daemon honors — caller retries until it wins."""
    return notifier._post_json(
        f"{api_base}/api/agents/{aid}/wake-claim",
        {"lease_ttl": LIVE_LEASE_TTL_SECS, "kind": "live", "lease_kind": "live",
         "event": "live_terminal", "preempt": bool(preempt), "lane": "work"})


def renew_live_lease(api_base, aid):
    return notifier._post_json(
        f"{api_base}/api/agents/{aid}/wake-renew",
        {"lease_ttl": LIVE_LEASE_TTL_SECS, "lease_kind": "live", "lane": "work"})


def release_live_lease(api_base, aid):
    return notifier._post_json(
        f"{api_base}/api/agents/{aid}/wake-ack",
        {"kind": "live", "release_lease": True, "event": "live_terminal_closed",
         "lane": "work"})


async def acquire_live_lease(api_base, aid, preempt=False, on_yielding=None):
    """Claim the `live` lease, honoring ISS-69(b) preempt-yield. Returns the final claim dict
    (claimed True on success, or the last claimed:False dict on failure). ws-free so it's unit
    testable; the caller turns the result into frames + a close code.

    Flow: one claim. If it wins → return it. If it's denied with reason "yield_pending" (an IDLE
    resident was asked to yield), call on_yielding() ONCE (the caller emits a "yielding" frame) and
    retry on a short cadence while the daemon snapshots + releases that resident — until we win or
    the budget runs out. Any OTHER denial (ephemeral wake / another live terminal / non-preempt)
    returns immediately: those holders don't yield."""
    import asyncio
    claim = claim_live_lease(api_base, aid, preempt=preempt)
    if (claim and claim.get("claimed")) or not (claim and claim.get("reason") == "yield_pending"):
        return claim
    # An idle resident is yielding — tell the human, then retry until the lease frees.
    if on_yielding is not None:
        await on_yielding()
    attempts = max(1, int(PREEMPT_RETRY_TOTAL_SECS / PREEMPT_RETRY_INTERVAL_SECS))
    for _ in range(attempts):
        await asyncio.sleep(PREEMPT_RETRY_INTERVAL_SECS)
        claim = claim_live_lease(api_base, aid, preempt=preempt)
        if claim and claim.get("claimed"):
            return claim
        # Still "yield_pending" → resident hasn't released yet (e.g. finishing an in-flight turn);
        # keep waiting. A DIFFERENT denial (someone else grabbed it) → give up now.
        if not (claim and claim.get("reason") == "yield_pending"):
            return claim
    return claim       # budget exhausted — caller renders lease_denied (the resident never yielded)


# ---------- ISS-73: record the live session as a worker_run (audit trail) ----------

def start_live_run(api_base, aid, wake_event="live_terminal", pid=None, token_id=None):
    """Record a worker_run (wake_kind='live', lane='work') for a live terminal session so it shows
    up in run history alongside ephemeral/resident runs (GET /api/agents/<id>/runs). Uses the SAME
    A2 route the notifier uses for headless spawns — keeps the 'only the API touches the DB'
    invariant. GH#91/90: posts the real PTY `pid` + `token_id` (the minted WORK token) so the server
    binds the token to the new run row (run_id + pid) — this stops the container dead-pid sweep from
    false-orphaning an active terminal.
    Best-effort: returns the run_id, or None if the POST fails (run bookkeeping must NEVER block a
    human's live session, so the caller tolerates None everywhere)."""
    run = notifier._post_json(
        f"{api_base}/api/agents/{aid}/runs",
        {"wake_kind": "live", "wake_event": wake_event, "lane": "work",
         "pid": pid, "token_id": token_id})
    return (run or {}).get("run_id")


def finish_live_run(api_base, run_id, status="exited", output=None, exit_code=None):
    """Close the live session's worker_run with the relayed transcript as the run log (tail-capped,
    mirroring the ephemeral path's _capture_run_output). Best-effort no-op when the run was never
    recorded (run_id is None)."""
    if not run_id:
        return
    if output is not None and len(output) > LIVE_RUN_OUTPUT_CAP:
        output = "...[truncated]...\n" + output[-LIVE_RUN_OUTPUT_CAP:]
    notifier._post_json(
        f"{api_base}/api/runs/{run_id}/finish",
        {"status": status, "exit_code": exit_code, "output": output})


# ---------- PTY spawn ----------

def spawn_pty(alias, cold, session_id, cwd, base_env=None, model=None, runtime=None,
              run_token=None):
    """Fork `orcha use <alias>` onto a PTY in `cwd` with the ORCHA_LIVE env. Returns
    (pid, master_fd). The child is its own session leader so we can signal the whole group.
    model/runtime (#297) are the agent's bridge-resolved selection, passed through to cmd_use.
    run_token (GH#91/90) is the WORK embodiment token injected as ORCHA_RUN_TOKEN."""
    env = build_spawn_env(alias, cold, session_id, base_env=base_env, model=model,
                          runtime=runtime, run_token=run_token)
    pid, master_fd = pty.fork()
    if pid == 0:  # child
        try:
            if cwd:
                os.chdir(cwd)
            os.execvpe("orcha", ["orcha", "use", alias], env)
        except Exception as exc:  # pragma: no cover - child error path
            os.write(2, f"orcha terminal bridge: exec failed: {exc}\n".encode())
            os._exit(127)
    return pid, master_fd


def terminate_pty(pid, master_fd, grace=5.0):
    """SIGHUP the session (so claude saves), then SIGKILL after a grace window; close the fd."""
    for sig in (signal.SIGHUP, signal.SIGTERM):
        try:
            os.killpg(os.getpgid(pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            break
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                break
        except ChildProcessError:
            break
        time.sleep(0.1)
    else:
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        os.close(master_fd)
    except OSError:
        pass


# ---------- the async serve wrapper (thin; lazy websockets) ----------

async def serve_bridge(api_base, base_cwd, host=BRIDGE_HOST, port=BRIDGE_PORT, quiet=True):
    """Run the localhost websocket server. Imported lazily so the module loads without
    `websockets`. Each connection runs handle_connection (the orchestration is unit-tested
    via its injectable pieces above)."""
    import asyncio
    import websockets  # lazy: runtime-only dep (Vault's R1 PR adds it)

    async def _handler(ws):
        await handle_connection(ws, api_base, base_cwd, quiet=quiet)

    async with websockets.serve(_handler, host, port):
        if not quiet:
            print(f"[terminal-bridge] listening on ws://{host}:{port}/terminal")
        try:
            await asyncio.Future()  # run forever
        finally:
            # Graceful loop shutdown: retire any parked warm sessions (kill their PTY + release the
            # lease) so they don't outlive the bridge. A hard SIGKILL skips this — the orphan-lease
            # reaper (ISS-60-B) is the backstop for a leaked live lease in that case.
            _retire_all_warm()


# ---------- ISS-67/B1: grace-window keepalive registry ----------
#
# After a ws closes, the live claude+PTY+worktree are held WARM (not torn down) for LIVE_GRACE_SECS
# so a reopen reattaches the SAME session instantly (the reopen-latency fix). This registry holds the
# parked sessions; it must outlive any single handle_connection coroutine. The bridge is ONE process
# with ONE asyncio event loop, so plain-dict access is race-free (no awaits between get and pop).

_WARM_SESSIONS = {}        # aid -> _WarmSession


class _WarmSession:
    """A live PTY held warm between ws connections. Owns the claude PTY (pid+master_fd), its stable
    worktree, the live lease (renewed by the expiry task during grace), the ISS-73 run record, and a
    bounded tail of relayed output (replayed to a reattaching client so a reopened xterm isn't
    blank). While parked it is DETACHED from any ws; a reattach adopts pid+fd+worktree as-is."""

    def __init__(self, aid, alias, api_base, base_cwd, pid, master_fd,
                 worktree, branch, run_id, rec, run_token=None):
        self.aid = aid
        self.alias = alias
        self.api_base = api_base
        self.base_cwd = base_cwd
        self.pid = pid
        self.master_fd = master_fd
        self.worktree = worktree
        self.branch = branch
        self.run_id = run_id
        self.rec = rec
        self.run_token = run_token          # GH#91/90 WORK token; revoked once at final retire
        self._expiry_task = None

    def pty_alive(self):
        return _pid_alive(self.pid)

    def cancel_expiry(self):
        if self._expiry_task is not None:
            self._expiry_task.cancel()
            self._expiry_task = None


def _pid_alive(pid):
    """True if `pid` is a live process. Used at detach to decide park-vs-teardown: a session is kept
    warm ONLY if its claude is genuinely still running (a browser-close while alive); a dead/absent
    pid has nothing to keep warm → teardown."""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _take_warm(aid):
    """Atomically remove + return the parked warm session for `aid` (None if absent). No await
    between the get and the pop, so two concurrent reopens can't both adopt the same session — the
    loser sees None and falls to the claim path (which 4409s while the winner still holds the lease)."""
    return _WARM_SESSIONS.pop(aid, None)


def _park_warm(session, quiet=True):
    """Park a detached-but-alive session and schedule its grace-window expiry. The expiry task keeps
    the lease renewed for the whole window, then (if no reopen adopted it) retires it."""
    import asyncio
    _WARM_SESSIONS[session.aid] = session
    session._expiry_task = asyncio.ensure_future(_expire_warm(session, quiet=quiet))


async def _expire_warm(session, quiet=True):
    """Hold `session` warm for LIVE_GRACE_SECS, renewing the lease so it stays the agent's until the
    window ends; then — only if no reopen adopted it — retire it (PTY→snapshot, worktree teardown,
    lease release, run close). A reattach cancels this task AND pops the registry entry, so either
    signal stops the teardown."""
    import asyncio
    aid = session.aid
    try:
        elapsed = 0
        while elapsed < LIVE_GRACE_SECS:
            await asyncio.sleep(min(LIVE_RENEW_SECS, LIVE_GRACE_SECS - elapsed))
            elapsed += LIVE_RENEW_SECS
            if _WARM_SESSIONS.get(aid) is not session:
                return                          # adopted by a reopen (or replaced) — not ours to renew
            renew_live_lease(session.api_base, aid)
    except asyncio.CancelledError:
        return                                  # reattach cancelled us — the reopen owns the PTY now
    if _WARM_SESSIONS.pop(aid, None) is not session:
        return                                  # raced with a reattach that already took it
    _retire_warm(session, quiet=quiet)


def _retire_warm(session, quiet=True):
    """Full teardown of a warm session (grace expired, PTY died, or bridge shutdown): kill the PTY
    (fires the agent's SessionEnd snapshot), safe-teardown the worktree (clean→remove, dirty→preserve
    so human edits survive into the next reuse), release the lease, close the run. Mirrors the
    original close handoff; every step is best-effort so one failure can't strand the lease."""
    disp = None
    try:
        terminate_pty(session.pid, session.master_fd)
        disp = safe_teardown_worktree(session.base_cwd, session.worktree, session.branch)
    finally:
        release_live_lease(session.api_base, session.aid)
        finish_live_run(session.api_base, session.run_id, "exited",
                        output="".join(session.rec["chunks"]))
        # GH#91/90: revoke the WORK embodiment token ONCE, at final retire. Both close paths funnel
        # here; warm-park does NOT retire (the expiry task only renews), so the token is not revoked
        # during the grace window — only when the session is genuinely over. Idempotent server-side.
        revoke_live_token(session.api_base, getattr(session, "run_token", None))
    if not quiet:
        print(f"[terminal-bridge] warm session retired for {session.alias} (worktree {disp})")
    return disp


def _retire_all_warm():
    """Retire every parked warm session (bridge shutdown). Best-effort."""
    for aid in list(_WARM_SESSIONS.keys()):
        session = _WARM_SESSIONS.pop(aid, None)
        if session is None:
            continue
        session.cancel_expiry()
        try:
            _retire_warm(session)
        except Exception:
            pass


async def handle_connection(ws, api_base, base_cwd, quiet=True):
    """One live terminal session: auth → (reattach a warm session | claim+worktree+PTY) → relay →
    park-warm-or-teardown. ISS-67/B1: on the normal browser-close path the PTY is kept WARM for
    LIVE_GRACE_SECS so a reopen reattaches the SAME session instantly (zero re-injection); a real
    `claude` exit (PTY death) tears down immediately.

    Kept thin; the testable units (env, frames, lease calls, worktree teardown, warm registry) live
    above.
    """
    path = _ws_path(ws)
    params = _parse_qs(path)
    aid = params.get("agent_id")
    actor = params.get("actor_agent_id")
    if not aid or not actor:
        await ws.send(make_frame("error", message="agent_id + actor_agent_id required"))
        await ws.close(code=4400)
        return

    # Auth: the ACTOR must be a human (Orcha#30) — this fetch is for authorization ONLY.
    # Read /persona, NOT the bare /api/agents/{id}: that route is PATCH-only (#83), so a GET 405s →
    # _get_json returns None → the actor looked not-human → lease_denied BEFORE the claim (the
    # "pairing always busy" bug, Page diagnosis). /persona is a GET returning {alias, kind, role, …}.
    actor_agent = notifier._get_json(f"{api_base}/api/agents/{actor}/persona")
    if not actor_agent or actor_agent.get("kind") != "human":
        await ws.send(make_frame("status", state="lease_denied", reason="actor not human"))
        await ws.close(code=4403)
        return
    # Resolve the TARGET agent (whose terminal this is) — its alias is authoritative, so the
    # PTY boots AS the agent (`orcha use <agent>` + ORCHA_ALIAS=<agent>); never the human's.
    # [review P1] don't reuse the actor fetch's alias. (Same /persona GET route — the bare route 405s.)
    target_agent = notifier._get_json(f"{api_base}/api/agents/{aid}/persona")
    if not target_agent:
        await ws.send(make_frame("error", message=f"agent {aid} not found"))
        await ws.close(code=4404)
        return
    alias = target_agent.get("alias") or aid
    # #297: this SAME /persona fetch already carries the agent's authoritative model + runtime
    # (resolved server-side). Capture them now and hand them to the PTY spawn so the live boot pins
    # the agent's selection deterministically — WITHOUT cmd_use having to re-fetch /persona from
    # inside the worktree (that second, fail-open round-trip is the regression: a missing binding
    # agent_id or a slow/unreachable /persona silently degraded to claude+DEFAULT_MODEL). If this
    # fetch had failed we'd have 4404'd above, so reaching here means these are trustworthy.
    live_model = target_agent.get("model")
    # A human target carries model=None AND model_runtime=None (/persona only sets runtime when
    # model is truthy, main.py:2565-2566). Normalize the resolved-but-model-less case to RUNTIME_CLAUDE
    # so ORCHA_LIVE_RUNTIME is ALWAYS set on a bridge-spawn: that env var is the trust marker cmd_use
    # uses to take env over a 2nd fail-open /persona fetch. Without this, a human pairing would pass
    # runtime=None → build_spawn_env pops ORCHA_LIVE_RUNTIME → cmd_use refetches /persona AND fires a
    # spurious "#297 could not resolve model" warn (a human has no model to match). model stays None →
    # still no --model. (Lens P2, PR #309.)
    live_runtime = target_agent.get("model_runtime") or RUNTIME_CLAUDE
    # ISS-69(b): the frontend sends &preempt=1 on the "Pair anyway" path. If an IDLE warm resident
    # holds the embodiment, that makes it YIELD (snapshot + release) instead of a hard 4409.
    preempt = params.get("preempt") in ("1", "true", "yes")

    async def _on_yielding():
        await _safe_send(ws, make_frame("status", state="yielding", holder="resident"))

    # ISS-67/B1: REATTACH a warm session parked from a recent close, instantly — the SAME claude+PTY
    # +worktree, no claim/provision/spawn, no re-injection. We already passed the human-actor auth,
    # the same gate every connect passes (so any human may reopen, exactly as any human may pair). The
    # lease is still held (the expiry task renewed it through the grace window), so no re-claim.
    warm = _take_warm(aid)
    if warm is not None and warm.pty_alive():
        warm.cancel_expiry()
        pid, master_fd = warm.pid, warm.master_fd
        worktree, branch, run_id, rec = warm.worktree, warm.branch, warm.run_id, warm.rec
        run_token = warm.run_token          # GH#91/90: carry the still-valid WORK token across reattach
        await ws.send(make_frame("status", state="connected",
                                 worktree=bool(worktree), cold=False, reattached=True))
        # Replay the recent screen so the reopened (blank) xterm shows context immediately rather
        # than waiting for the next PTY output. Frame clears the panel before reattaching, so this
        # is the screen, not a duplicate of a buffer the client kept.
        tail = "".join(rec["chunks"])[-LIVE_REPLAY_CAP:]
        if tail:
            await _safe_send(ws, make_frame("stdout", data=tail))
    else:
        # A dead/stale warm entry (PTY exited during grace) — make sure it's fully retired, then boot.
        if warm is not None:
            warm.cancel_expiry()
            _retire_warm(warm, quiet=quiet)
        claim = await acquire_live_lease(api_base, aid, preempt=preempt, on_yielding=_on_yielding)
        if not (claim and claim.get("claimed")):
            why = (claim or {}).get("reason", "embodiment busy")
            await ws.send(make_frame("status", state="lease_denied",
                                     holder=(claim or {}).get("lease_kind"), reason=why))
            await ws.close(code=4409)
            return
        cold = bool(claim.get("cold", True))           # warm `--resume` deferred (no PTY sid source)
        session_id = claim.get("session_id")
        # ISS-67/B2: STABLE per-agent worktree (reused across reopens) — the prerequisite for a
        # coherent reattach (the warm claude's CWD is this path) and it preserves a human's edits.
        worktree, branch = notifier._provision_live_worktree(base_cwd, alias)
        run_cwd = worktree or base_cwd
        # GH#91/90: mint a WORK embodiment token (kind='live') BEFORE building the PTY env, so it can
        # be injected as ORCHA_RUN_TOKEN. The live terminal is a WORK embodiment (a human legitimately
        # claims/works tasks), so the token's lane is 'work' — it passes the server's _require_work_lane
        # gate on the task-lifecycle endpoints. Best-effort: None on mint failure → token-less/degraded
        # (gated calls will 403), but the terminal STILL opens — never block the human on a token.
        run_token = mint_live_token(api_base, aid)
        pid, master_fd = spawn_pty(alias, cold, session_id, run_cwd,
                                   model=live_model, runtime=live_runtime, run_token=run_token)
        # ISS-73: record this live session as a worker_run (wake_kind='live') so it appears in run
        # history with start/end/status + the relayed stream. GH#91/90: post the real PTY pid + the
        # minted token_id so the server binds the token to this run row (prevents the dead-pid sweep
        # from false-orphaning an active terminal). Best-effort — run_id may be None (a failed record
        # must never break the terminal); every run call below tolerates that.
        run_id = start_live_run(api_base, aid, pid=pid, token_id=run_token)
        if run_token and run_id is None:
            # The /runs bind failed → the token was never bound to a run row. REVOKE it (an unbound
            # token is dead weight the server's backstop would sweep anyway) and continue token-less/
            # degraded. Block the token, NOT the terminal — the human's session must still open.
            revoke_live_token(api_base, run_token)
            run_token = None
        rec = {"chunks": [], "len": 0}                 # bounded buffer of relayed output → run log on close
        await ws.send(make_frame("status", state="connected",
                                 worktree=bool(worktree), cold=cold))

    # Relay until the client closes the ws (→ maybe park warm) or `claude` exits (→ teardown).
    relay_alive = await _relay(ws, master_fd, rec, run_id, api_base, aid)
    # [P1 #218] An EXPLICIT user close (frontend sent CLOSE_NOW_CODE) must NOT park: the user
    # asked to end the session, so snapshot + release immediately — parking would hold the
    # lease (agent unwakeable) for the whole grace window. Only an UNcoded closure (nav away,
    # refresh, network drop) is a warm detach.
    user_closed = getattr(ws, "close_code", None) == CLOSE_NOW_CODE
    # Park warm ONLY if the relay never saw EOF AND claude is genuinely still running AND the
    # client didn't explicitly close. A dead/exited PTY or a user close → teardown.
    if relay_alive and _pid_alive(pid) and not user_closed:
        # Normal browser-close path: KEEP the session warm for a reopen. No snapshot/teardown/release
        # now — those run at grace-expiry (or on the next reattach's eventual close), so a glance-away
        # -and-back costs nothing and snapshot fires once per real session end, not per reopen.
        session = _WarmSession(aid, alias, api_base, base_cwd, pid, master_fd,
                               worktree, branch, run_id, rec, run_token=run_token)
        _park_warm(session, quiet=quiet)
        await _safe_send(ws, make_frame("status", state="detached", grace_secs=LIVE_GRACE_SECS))
        await _safe_close(ws)
        if not quiet:
            print(f"[terminal-bridge] session parked warm for {alias} ({LIVE_GRACE_SECS}s grace)")
    else:
        # The session is genuinely over — either `claude` exited (PTY death; snapshot already fired
        # via the ORCHA_LIVE SessionEnd as the PTY closed) or the user EXPLICITLY closed (CLOSE_NOW
        # code; _retire_warm's terminate_pty fires the SessionEnd snapshot). Tear down + release now.
        # The teardown/release MUST run even if the socket is already gone, so the status sends are
        # BEST-EFFORT.
        await _safe_send(ws, make_frame("status", state="snapshotting"))
        session = _WarmSession(aid, alias, api_base, base_cwd, pid, master_fd,
                               worktree, branch, run_id, rec, run_token=run_token)
        disp = _retire_warm(session, quiet=quiet)
        await _safe_send(ws, make_frame("status", state="closed", worktree=disp))
        await _safe_close(ws)
        if not quiet:
            print(f"[terminal-bridge] session closed for {alias} (worktree {disp})")


async def _relay(ws, master_fd, rec, run_id, api_base, aid):
    """Pump one attached session: PTY→ws (buffering the tail for the ISS-73 run log), renew the lease
    on a cadence, and route client frames (stdin/resize) into the PTY — until the client closes the
    ws OR the PTY dies. Returns True if the PTY is STILL ALIVE at detach (the client left first →
    park warm), False if it died (`claude` exited → tear down).

    The reader uses a select-timeout poll (not a blocking os.read) so that on a park it releases the
    master_fd within PTY_SELECT_TIMEOUT — a leftover blocked reader thread would otherwise split the
    byte stream with the fresh reader a reattach starts on the same fd."""
    import asyncio
    loop = asyncio.get_event_loop()
    stop = asyncio.Event()
    pty_died = {"v": False}

    async def _pty_to_ws():
        while not stop.is_set():
            readable = await loop.run_in_executor(None, _wait_readable, master_fd)
            if stop.is_set():
                break
            if not readable:
                continue                                # select timeout — re-check stop, keep polling
            data = _read_fd(master_fd)
            if not data:                                # EOF → the PTY (claude) exited
                pty_died["v"] = True
                stop.set()
                break
            text = data.decode("utf-8", "replace")
            await _safe_send(ws, make_frame("stdout", data=text))
            # ISS-73: buffer the relayed stream for the run log — NETWORK-FREE in this hot path
            # (the transcript is persisted once on teardown). Keep it memory-bounded on a long
            # session; finish_live_run tail-caps the persisted text anyway. The tail also feeds the
            # reattach screen-replay (B1), so the buffer is retained across a park.
            if run_id:
                rec["chunks"].append(text)
                rec["len"] += len(text)
                while rec["len"] > 2 * LIVE_RUN_OUTPUT_CAP and len(rec["chunks"]) > 1:
                    rec["len"] -= len(rec["chunks"].pop(0))

    async def _renew():
        while not stop.is_set():
            await asyncio.sleep(LIVE_RENEW_SECS)
            if not stop.is_set():
                renew_live_lease(api_base, aid)

    pty_task = asyncio.ensure_future(_pty_to_ws())
    renew_task = asyncio.ensure_future(_renew())
    try:
        async for raw in ws:
            apply_client_frame(parse_frame(raw), master_fd)
    except Exception:  # client dropped / protocol error
        pass
    finally:
        stop.set()
        renew_task.cancel()
        # Await the reader so its select-poll observes `stop` and releases the master_fd BEFORE we
        # return (and the session may be parked + reattached onto the same fd). Bounded by the select
        # timeout; hard-cancel as a backstop if it somehow doesn't settle.
        try:
            await asyncio.wait_for(asyncio.shield(pty_task), timeout=PTY_SELECT_TIMEOUT * 5 + 1.0)
        except Exception:
            pty_task.cancel()
    return not pty_died["v"]


async def _safe_send(ws, msg):
    """Best-effort frame send — the socket may already be closed (browser-close path)."""
    try:
        await ws.send(msg)
    except Exception:
        pass


async def _safe_close(ws):
    try:
        await ws.close()
    except Exception:
        pass


def _read_fd(fd):
    try:
        return os.read(fd, PTY_READ_BYTES)
    except OSError:
        return b""


def _wait_readable(fd, timeout=PTY_SELECT_TIMEOUT):
    """Block up to `timeout` for `fd` to have data. Returns True if readable, False on timeout
    (so the reader loop can re-check its stop flag and release the fd on a park) — never blocks
    indefinitely, which is what would otherwise strand a reader thread on a parked PTY."""
    import select
    try:
        r, _, _ = select.select([fd], [], [], timeout)
        return bool(r)
    except (OSError, ValueError):
        return False


def _parse_qs(path):
    """Parse the connect query string (…/terminal?agent_id=…&actor_agent_id=…[&preempt=1])."""
    from urllib.parse import urlparse, parse_qs
    q = parse_qs(urlparse(path).query)
    return {k: v[0] for k, v in q.items() if v}


def _ws_path(ws):
    """The request target across the allowed `websockets` range. <15 exposes it as `ws.path`; the
    v15 ServerConnection moved it to `ws.request.path`. Read both so a v15 install (what
    `websockets>=12` resolves to today) still gives us agent_id/actor_agent_id rather than ''."""
    p = getattr(ws, "path", None)
    if p:
        return p
    req = getattr(ws, "request", None)
    return getattr(req, "path", "") or "" if req is not None else ""


# ---------- auto-start singleton (mirror notifier.ensure_daemon so `orcha up` brings it up) ----------

def _bridge_pid_path(cwd):
    return cwd / ".claude" / ".orcha-terminal-bridge.pid"


def bridge_running(cwd):
    """Return the live bridge PID for this project, or None (stale/absent PID file)."""
    try:
        pid = int(_bridge_pid_path(cwd).read_text().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
        return pid
    except OSError:
        return None


def stop_bridge(cwd, quiet=False):
    """Stop this project's terminal bridge (SIGTERM via the PID file). Idempotent. Called by
    `orcha down` so the bridge dies with the stack, and by `ensure_bridge(restart=True)` on
    `orcha init` so a fresh bridge points at the NEW container's api_base (the bridge resolves
    api_base once at startup + binds the fixed port, so a re-init MUST restart it)."""
    import signal
    pid = bridge_running(cwd)
    pidf = _bridge_pid_path(cwd)
    if not pid:
        if pidf.exists():
            try:
                pidf.unlink()
            except OSError:
                pass
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        pidf.unlink()
    except (FileNotFoundError, OSError):
        pass
    if not quiet:
        print(f"[terminal-bridge] stopped (pid {pid})")
    return True


def ensure_bridge(cwd, quiet=False, restart=False):
    """Start `orcha terminal-bridge` detached iff one isn't already running for this project.

    Idempotent singleton (PID file under .claude/) — safe to call from `orcha up`/`init` and a
    SessionStart hook. Silent no-op when this isn't an Orcha project. A MANAGED embodiment never
    manages the bridge (a headless wake worker or the live terminal itself), mirroring the notifier.
    `restart=True` (used by `orcha init`) first stops any running bridge so the new one binds the
    fixed port + points at the just-created container — without it a re-init strands the old bridge
    on a dead api_base, yet the portal still advertises the same ws URL. Best-effort: if
    `websockets` isn't installed the spawned process exits — that surfaces in the bridge log."""
    import shutil
    import subprocess
    import sys
    if not (cwd / ".claude" / "orcha.json").exists():
        return False
    if os.environ.get("ORCHA_HEADLESS_WORKER") or os.environ.get("ORCHA_LIVE"):
        return False
    if restart:
        stop_bridge(cwd, quiet=True)
    pid = bridge_running(cwd)
    if pid:
        if not quiet:
            print(f"[terminal-bridge] already running (pid {pid})")
        return True
    exe = shutil.which("orcha")
    argv = ([exe, "terminal-bridge", "--quiet"] if exe
            else [sys.executable, "-m", "orcha_cli", "terminal-bridge", "--quiet"])
    log = cwd / ".claude" / ".orcha-terminal-bridge.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(log, "ab") as lf:
            proc = subprocess.Popen(argv, cwd=str(cwd), stdout=lf, stderr=lf,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
    except (OSError, subprocess.SubprocessError) as e:
        if not quiet:
            print(f"[terminal-bridge] could not start: {e}", file=sys.stderr)
        return False
    _bridge_pid_path(cwd).write_text(str(proc.pid))
    if not quiet:
        print(f"[terminal-bridge] started (pid {proc.pid}); log: {log}")
    return True
