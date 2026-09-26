"""Reconcile orphaned runs, leases, and completed-task worktrees."""

from __future__ import annotations

import datetime
import json
from typing import Optional

# Remote-runner spec §3.3c/§3.5: sandbox rows are reconciled by CONTAINER liveness.
# Imported as a module so tests can monkeypatch `_sandbox.probe` etc. (attribute
# lookup at call time).
from . import sandbox as _sandbox

# M7 (remote-runner deferred follow-up, field bug "first chat message dies as
# 'sandbox container vanished'"): minimum age before the sweep may take a
# DESTRUCTIVE verdict on a container-backed run it cannot fully observe.
# `docker run` on a loaded daemon can take many seconds to actually CREATE the
# container (live evidence: 15s between a run row's POST landing and the
# container's network join) — during that window `docker inspect` answers "no
# such container", which is "not born yet", never "vanished". The same window
# covers the inverse race: a container that IS up whose run-row POST hasn't
# landed (in flight / transiently failed) must not be stopped as an orphan.
# Both checks are deferrals, not exemptions — past the grace, the existing
# vanish/orphan-stop semantics apply unchanged.
ORPHAN_BOOT_GRACE_SECS = 90.0


def _age_secs(iso_ts) -> Optional[float]:
    """Seconds since an RFC3339/ISO timestamp (docker inspect StartedAt or a run
    row's started_at), or None when absent/unparseable — callers decide the
    fail-safe direction explicitly."""
    if not iso_ts:
        return None
    started = _sandbox._parse_started_at(str(iso_ts))
    if started is None:
        return None
    return (datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()


def live_sandbox_shield(live_workers: dict, live_residents: dict) -> frozenset:
    """Container names of THIS daemon's live in-memory sandbox embodiments — the
    orphan pass must never stop them. Residents: a warm session owns a run row
    only PER TURN, so between turns its (deliberately long-lived) container has
    no open row. One-shot workers: the container is spawned BEFORE the run-row
    POST, so a booting wake (or one whose row POST transiently failed) is
    row-less while genuinely alive — previously only residents were shielded and
    such a worker was stopped by the next sweep."""
    return frozenset(
        w["sandbox_container_id"] for w in live_workers.values()
        if w.get("sandbox_container_id")
    ) | frozenset(
        r["sandbox_container_id"] for r in live_residents.values()
        if r.get("sandbox_container_id")
    )


def reap_orphan_leases(api_base: str, cid: str, quiet: bool, services) -> None:
    """Release single-flight leases whose agents stopped heartbeating."""
    res = services._post_json(
        f"{api_base}/api/containers/{cid}/reap-orphan-leases", {}
    )
    if res and res.get("reaped") and not quiet:
        for row in res["reaped"]:
            print(
                f"[notifier] reaped ORPHAN {row.get('lease_kind')} lease for "
                f"{row.get('alias')} (no heartbeat "
                f"{float(row.get('idle_seconds') or 0):.0f}s) — lease released "
                "(ISS-60B)"
            )


def _reconcile_sandbox_run(
    api_base: str, r: dict, sbx: str, *, quiet: bool = True, services
) -> int:
    """Remote-runner Task 5: reconcile ONE sandbox-backed 'running' row against its
    container's actual state (spec §3.5). Reuses the sweep's `_finish_run` transport
    (POST /api/runs/{id}/finish). Returns 1 when the row was finished, else 0.

    The finish paths stamp FIRST and `docker rm` AFTER — a crash between the two
    leaves a stopped container for a later sweep, never an unstamped run."""
    state = _sandbox.probe(sbx)
    run_id = r.get("run_id")
    # The row's per-wake log (§3.3d: written inside the container onto the WORKSPACE,
    # so the host path is readable here) — pass it through every finish exactly like
    # the normal reap path does, so an ADOPTED run's output is captured into
    # worker_runs.output instead of finishing output=NULL (§5 criterion 3).
    log_path = r.get("log_path")
    if state is None:
        # M7 boot grace: a YOUNG row whose container isn't probeable yet is the
        # cold-boot race, not a vanish — `docker run` is still creating the
        # container (observed 15s on a loaded box) while the row already landed.
        # Defer the verdict; a genuinely vanished container is stamped once the
        # row outlives the grace (so #342's "busy forever" stays bounded).
        row_age = _age_secs(r.get("started_at"))
        if row_age is not None and row_age < ORPHAN_BOOT_GRACE_SECS:
            if not quiet:
                print(f"[notifier] sandbox container {sbx} not probeable but run "
                      f"{run_id} is only {row_age:.0f}s old (< {ORPHAN_BOOT_GRACE_SECS:.0f}s "
                      f"boot grace) — deferring vanished verdict (M7)")
            return 0
        # container gone without a trace (removed out-of-band; the C2 daemon gate in
        # the caller already ruled out "docker down", so None here means GONE) —
        # finish the row so the agent stops reading as busy forever (#342 semantics).
        ok = services._finish_run(
            api_base, run_id, "killed", -1, log_path,
            kill_reason=json.dumps({"run_id": str(run_id),
                                    "agent_id": r.get("agent_id"),
                                    "cause": "sandbox_container_vanished",
                                    "detail": "sandbox container vanished"}))
        if not quiet:
            print(f"[notifier] sandbox container {sbx} VANISHED — finished run {run_id} "
                  f"as killed (Task 5 reaper)")
        return 1 if ok else 0                  # failed POST → retried next sweep
    # cwd for per-workspace config + api-config reap: same resolution the worktree
    # sweep uses — the run's recorded worktree (its spawn cwd) else its base_cwd.
    cwd = r.get("worktree") or r.get("base_cwd")
    if state.running:
        if r.get("wake_kind") == "resident":
            # Resident lane un-deferral: a warm resident session is long-lived BY
            # DESIGN (it idles between conversation turns for hours) — the one-shot
            # max-runtime deadline does not apply. A RUNNING resident container is
            # always the adoption case: leave it be. Vanished (above) and exited
            # (below) handling still applies unchanged.
            return 0
        max_secs = (_sandbox.SandboxConfig.load(cwd).max_runtime_secs if cwd
                    else _sandbox.DEFAULT_MAX_RUNTIME_SECS)
        if _sandbox.past_deadline(state, max_runtime_secs=max_secs):
            # runaway (spec §3.5): stop now; the NEXT sweep observes 'exited' and
            # stamps the row with the container's REAL exit code — never guessed here.
            _sandbox.stop(sbx)
            if not quiet:
                print(f"[notifier] sandbox container {sbx} past its {max_secs}s "
                      f"max-runtime deadline — docker stop issued; run {run_id} will be "
                      f"stamped from its exit state next sweep (spec §3.5)")
        # else ALIVE within deadline → ADOPTED (spec §3.3c): even when this daemon's
        # Popen handle died with a restart, the run is NOT orphaned — leave it be.
        return 0
    # exited: stamp the row, THEN rm the container (+ its per-run api-config file).
    if state.oom_killed:
        ok = services._finish_run(
            api_base, run_id, "killed", state.exit_code, log_path,
            kill_reason=json.dumps({"run_id": str(run_id),
                                    "agent_id": r.get("agent_id"),
                                    "cause": "sandbox_oom",
                                    "detail": "out of memory — raise sandbox.memory"},
                                   ensure_ascii=False))
    else:
        ok = services._finish_run(api_base, run_id, "exited", state.exit_code, log_path)
    if not ok:
        # I5 (Task-5 review): the stamp did NOT land — removing now would destroy
        # the only evidence of the exit state AND leave the row 'running' forever
        # (next sweep would probe a GONE container and mis-stamp it 'vanished').
        # The container is already exited, so retrying next sweep is free.
        return 0
    _sandbox.remove(sbx)                       # never -v: volumes are durable state
    if cwd:
        _sandbox.remove_api_config(cwd, sbx)
    if not quiet:
        outcome = ("killed: out of memory" if state.oom_killed
                   else f"exited {state.exit_code}")
        print(f"[notifier] reaped sandbox container {sbx} for run {run_id} ({outcome}) — "
              f"row stamped, container removed, volumes untouched (Task 5 reaper)")
    return 1


def reap_orphaned_runs(
    api_base: str,
    cid: str,
    live_pids=frozenset(),
    *,
    live_sandbox=frozenset(),
    quiet: bool = True,
    services,
) -> int:
    """Reconcile database run rows whose host processes no longer exist.

    Remote-runner Task 5 (spec §3.3c + §3.5): a row with a `sandbox_container_id` is a SANDBOX
    wake — its truth is the CONTAINER's state (docker inspect), never the host pid. The foreground
    `docker run` client pid dies with a daemon restart while the detached container keeps working,
    so a dead pid on these rows is the ADOPTION case, not an orphan: probe the container instead
    (vanished → finish killed; running past the workspace deadline → docker stop, stamped next
    sweep; running within it → leave alone; exited → stamp exit code/OOM THEN rm — volumes never).
    After the per-run loop an orphan pass stops any live managed container no open run row
    references (drain sidecars are label-exempt via managed_containers). `live_sandbox`
    shields THIS daemon's live in-memory sandbox containers from that orphan pass — a warm
    sandboxed RESIDENT records a run row only per-turn, so between turns its (deliberately
    long-lived) container has NO open row and would otherwise read as an orphan; one-shot
    sandbox WORKERS ride the same shield for their row-POST window. Both destructive
    verdicts (vanished-stamp on a probe-less row, orphan-stop on a row-less container)
    additionally honor ORPHAN_BOOT_GRACE_SECS — during a cold boot the container and its
    run row become visible at independent times, and neither half may be reaped while the
    other is still being born. Returns the number of dead runs reaped."""
    data = services._get_json(f"{api_base}/api/containers/{cid}/running-runs")
    if data is None:
        # API unreachable/booting — decide NOTHING this tick. Especially not the orphan
        # pass below: an empty view from a dead API must never stop live containers.
        return 0
    runs = data.get("runs", [])

    def alive(row):
        pid = row.get("pid")
        return (pid in live_pids) or services._run_pid_alive(pid)

    reaped = 0
    seen_sandbox: set = set()
    live_sandbox_lanes: set = set()
    # C2 (Task-5 review): ONE docker-daemon gate per sweep, BEFORE any sandbox
    # reconciliation. When the daemon is unreachable/hung, probe's None means
    # UNKNOWN — not vanished: reconcile NOTHING (no probes, no finishes, no
    # stops), shield EVERY sandbox row's lane (unknown ≠ dead — its lease must
    # not be ripped either), and skip the orphan pass. With a healthy daemon,
    # probe-None ⇒ genuinely gone is sound.
    docker_ok = _sandbox.daemon_reachable()
    for row in runs:
        sbx = row.get("sandbox_container_id")
        if not sbx:
            continue
        seen_sandbox.add(sbx)
        if not docker_ok:
            live_sandbox_lanes.add((row.get("agent_id"), row.get("lane") or "work"))
            continue
        try:
            finished = _reconcile_sandbox_run(
                api_base, row, sbx, quiet=quiet, services=services
            )
        except Exception:
            # a docker hiccup on ONE run must never abort the sweep for the rest
            # (the helpers themselves never raise; this is belt-and-braces).
            # M6: outcome unknown → conservatively shield this lane's lease too.
            live_sandbox_lanes.add((row.get("agent_id"), row.get("lane") or "work"))
            continue
        reaped += finished
        if not finished:
            # container still RUNNING (adopted / stopping past-deadline): this lane
            # HAS a live embodiment. The pid path below must treat it as a live
            # sibling — a lane-scoped lease release would orphan EVERY running row
            # in the lane server-side, ripping the adopted sandbox run with it
            # (whose container the orphan pass would then stop next sweep).
            live_sandbox_lanes.add((row.get("agent_id"), row.get("lane") or "work"))

    by_agent_lane: dict = {}
    for row in runs:
        if row.get("sandbox_container_id"):
            continue                     # reconciled above by CONTAINER liveness
        key = (row.get("agent_id"), row.get("lane") or "work")
        by_agent_lane.setdefault(key, []).append(row)

    for (agent_id, lane), rows in by_agent_lane.items():
        dead = [row for row in rows if not alive(row)]
        if not dead:
            continue
        live_sibling = (
            any(alive(row) for row in rows)
            or (agent_id, lane) in live_sandbox_lanes
        )
        if live_sibling:
            for row in dead:
                services._finish_run(
                    api_base, row.get("run_id"), "killed", -1, None
                )
        else:
            services._post_json(
                f"{api_base}/api/agents/{agent_id}/wake-ack",
                {
                    "kind": "orphan_run_sweep",
                    "release_lease": True,
                    "lane": lane,
                },
            )
        reaped += len(dead)
        if not quiet:
            outcome = (
                "finished orphans, kept lease (live sibling)"
                if live_sibling
                else "released lease"
            )
            print(
                f"[notifier] swept {len(dead)} dead-pid orphaned "
                f"{lane}-lane run(s) for {agent_id} ({outcome}) (#342)"
            )

    # Task 5 orphan pass (spec §3.5), ONCE per sweep: a live managed container that no
    # open run row references → stop it (a wake whose row was orphaned/finished behind
    # its back must not burn CPU forever). Scoped to THIS project's cid label (C1 —
    # another stack's containers on the same host are invisible here) and gated on a
    # reachable docker daemon (C2 — a dead daemon's empty view is not "no orphans").
    # Drain sidecars never appear here — they own no run row BY DESIGN and
    # managed_containers label-exempts them. Stop only, never rm, and workspace
    # volumes are never auto-deleted.
    if docker_ok:
        try:
            for name in _sandbox.managed_containers(cid):
                if name in seen_sandbox:
                    continue             # an open run row references it — not an orphan
                if name in live_sandbox:
                    continue             # THIS daemon's live handle (an idle warm
                                         # resident / booting worker) — not an orphan
                # M7 boot grace: a row-less container younger than the grace is a
                # BOOTING wake whose run-row POST hasn't landed (in flight, or a
                # transient failure the spawner already warned about) — stopping it
                # kills the run's first turn mid-boot. One inspect per candidate;
                # candidates are rare. Probe/parse failure → skip this sweep
                # (fail-safe: never stop what we cannot age — retried next sweep).
                cstate = _sandbox.probe(name)
                age = _age_secs(cstate.started_at) if cstate is not None else None
                if age is None or age < ORPHAN_BOOT_GRACE_SECS:
                    if not quiet:
                        why = ("unprobeable" if cstate is None or age is None
                               else f"only {age:.0f}s old")
                        print(f"[notifier] row-less managed container {name} is {why} "
                              f"(< {ORPHAN_BOOT_GRACE_SECS:.0f}s boot grace) — orphan "
                              f"stop deferred to a later sweep (M7)")
                    continue
                _sandbox.stop(name)
                if not quiet:
                    print(f"[notifier] stopped ORPHAN sandbox container {name} — no open "
                          f"worker_runs row references it (spec §3.5; volumes untouched)")
        except Exception:
            pass                         # docker trouble must never take down the sweep
    return reaped


def reap_terminal_task_worktrees(
    api_base: str,
    cid: str,
    base_cwd: Optional[str],
    live_workers: dict,
    swept_tasks: set,
    quiet: bool,
    failed_drains: Optional[dict],
    services,
) -> int:
    """Reclaim clean durable worktrees after their tasks become terminal."""
    if not base_cwd or not services._is_git_repo(base_cwd):
        return 0

    live_worktrees = {
        worker.get("worktree")
        for worker in live_workers.values()
        if worker.get("worktree")
    }
    removed = 0
    for state in services._TERMINAL_TASK_STATES:
        removed += _reap_terminal_state(
            api_base,
            cid,
            state,
            base_cwd,
            live_worktrees,
            swept_tasks,
            quiet,
            failed_drains,
            services,
        )
    return removed


def _reap_terminal_state(
    api_base: str,
    cid: str,
    state: str,
    base_cwd: str,
    live_worktrees: set,
    swept_tasks: set,
    quiet: bool,
    failed_drains: Optional[dict],
    services,
) -> int:
    """Page through one terminal state and reclaim each eligible worktree."""
    removed = 0
    offset = 0
    for _page in range(services._TERMINAL_SWEEP_MAX_PAGES):
        data = services._get_json(
            f"{api_base}/api/containers/{cid}/tasks"
            f"?status={state}&sort=time&dir=asc"
            f"&limit={services._TERMINAL_SWEEP_PAGE_SIZE}&offset={offset}"
        ) or {}
        page_tasks = data.get("tasks", [])
        for task in page_tasks:
            removed += _reap_terminal_task(
                api_base,
                task,
                state,
                base_cwd,
                live_worktrees,
                swept_tasks,
                quiet,
                failed_drains,
                services,
            )
        if not data.get("has_more") or not page_tasks:
            break
        offset += len(page_tasks)
    return removed


def _reap_terminal_task(
    api_base: str,
    task: dict,
    state: str,
    base_cwd: str,
    live_worktrees: set,
    swept_tasks: set,
    quiet: bool,
    failed_drains: Optional[dict],
    services,
) -> int:
    """Reclaim the distinct durable worktrees recorded for one terminal task."""
    task_id = task.get("id")
    if not task_id or task_id in swept_tasks:
        return 0

    runs = services._get_json(f"{api_base}/api/tasks/{task_id}/runs") or {}
    seen: set = set()
    defer_sweep = False
    removed = 0
    for run in runs.get("runs", []):
        worktree, branch = run.get("worktree"), run.get("branch")
        if (
            not worktree
            or not branch
            or not str(branch).startswith("orcha/task-")
            or worktree in seen
        ):
            continue
        seen.add(worktree)
        if worktree in live_worktrees:
            defer_sweep = True
            continue
        try:
            outcome = services._reclaim_task_worktree(
                run.get("base_cwd") or base_cwd, worktree, branch
            )
        except Exception:
            outcome = "preserved-dirty"
        if outcome == "removed":
            removed += 1
            if not quiet:
                print(
                    f"[notifier] reclaimed durable task worktree {worktree} "
                    f"(branch {branch}) — task terminal ({state}), clean tree"
                )
        elif outcome == "preserved-dirty":
            defer_sweep = True
            if not quiet:
                print(
                    f"[notifier] task {task_id} terminal but its worktree "
                    f"{worktree} has uncommitted work — PRESERVED for a human, "
                    "not reclaimed"
                )

    if failed_drains is not None:
        for key in [key for key in failed_drains if key[1] == task_id]:
            failed_drains.pop(key, None)
    if not defer_sweep:
        swept_tasks.add(task_id)
    return removed
