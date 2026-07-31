"""GH#110 — worker continuity: preserve a task worker's worktree/diff across wakes, classify a
Codex 429 as rate_limited (no cursor advance, no teardown), and inject a continuity snapshot
without a voluntary /orcha-snapshot.

Behavioral tests drive the real reaper (notifier.reap_workers) against a throwaway git repo with a
stand-in Popen; the /finish contract-widening test hits the real FastAPI endpoint (DB-backed).
Each test fails on the OLD behavior and passes on the GH#110 fix.
"""
import pathlib
import subprocess
import time

import pytest

from orcha_cli import notifier  # noqa: E402 (conftest puts orcha-cli on sys.path)


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def _make_repo(tmp_path):
    origin = tmp_path / "origin.git"
    _git(["init", "--bare", str(origin)], tmp_path)
    work = tmp_path / "work"
    work.mkdir()
    _git(["init"], work)
    _git(["symbolic-ref", "HEAD", "refs/heads/main"], work)
    _git(["config", "user.email", "t@t"], work)
    _git(["config", "user.name", "t"], work)
    (work / "README.md").write_text("hi\n")
    # Mirror production: .claude/settings.json is TRACKED (overlaid per-worktree by
    # _overlay_runtime_config), while orcha.json + orcha-tabs are gitignored (absent from a fresh
    # origin/main checkout). Without a tracked file under .claude, git collapses the whole
    # untracked dir to a single '?? .claude/' line and the overlay can't be excluded from a
    # dirty-check — which is exactly the §2c-reaper edge this suite must exercise faithfully.
    (work / ".gitignore").write_text(".claude/orcha.json\n.claude/orcha-tabs/\n.orcha-worktrees/\n")
    (work / ".claude").mkdir()
    (work / ".claude" / "settings.json").write_text('{"hooks": {}}')
    _git(["add", "-A"], work)
    _git(["commit", "-m", "init"], work)
    _git(["remote", "add", "origin", str(origin)], work)
    _git(["push", "-u", "origin", "main"], work)
    (work / ".claude" / "orcha.json").write_text('{}')   # gitignored runtime config
    return work


class _ExitedProc:
    def __init__(self, pid=999, returncode=0):
        self.pid = pid
        self.returncode = returncode
    def poll(self): return self.returncode
    def kill(self): pass
    def wait(self, timeout=None): return self.returncode


def _task_worker(work, wt, branch, log_path, runtime, *, task_id, wake_ack_ts=42.0):
    # GH #58 (R5): mirrors the spawn-path shape — no pending_ack_ts stash anymore; wake_ack_ts is
    # the bounded-release cursor _drain_task_failure advances to at FAILED_DRAIN_MAX.
    return {"proc": _ExitedProc(), "run_id": "RUN-1", "log_path": str(log_path),
            "worktree": wt, "branch": branch, "base_cwd": str(work),
            "task_worktree": True, "started_ts": 1.0, "wake_ack_ts": wake_ack_ts,
            "agent_id": "agent-X",
            "hard_deadline": time.time() + 100, "last_size": 0, "last_progress_ts": time.time(),
            "lines_offset": 0, "lines_seq": 1, "lines_buf": b"",
            "cap": 1200, "respawns": 0,
            "respawn_ctx": {"model_runtime": runtime, "task_id": task_id, "alias": "Andrew"}}


def _rate_limit_log(tmp_path, name="codex.log", retry_after=30):
    log = tmp_path / name
    log.write_text('{"type":"item.started","item":{"id":"1"}}\n'
                   '{"type":"rate_limit_event","retry_after":%d}\n' % retry_after)
    return log


def _success_log(tmp_path, name="ok.log"):
    log = tmp_path / name
    log.write_text('{"type":"item.completed","item":{"id":"1"}}\n{"type":"turn.completed"}\n')
    return log


def _wire(monkeypatch, posts, *, digest=None):
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body, **k: posts.append((url, body)) or {})
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"digest": digest})


# ---------- test 2: Claude ephemeral task worker preserved on clean exit ----------

def test_claude_task_worker_preserved_on_clean_exit(tmp_path, monkeypatch):
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_task_worktree(str(work), "Andrew", "claude-task")
    (pathlib.Path(wt) / "wip.py").write_text("half-done work\n")

    posts = []
    _wire(monkeypatch, posts)
    live = {"agent-X": _task_worker(work, wt, branch, _success_log(tmp_path),
                                    notifier.RUNTIME_CLAUDE, task_id="claude-task")}
    notifier.reap_workers("http://x", live, quiet=True, failed_drains={}, agent_hold_until={})

    assert pathlib.Path(wt).is_dir()                                  # kept, not torn down
    assert (pathlib.Path(wt) / "wip.py").read_text() == "half-done work\n"
    rc, out = notifier._run_git(["rev-list", "--count", "origin/main..HEAD"], cwd=wt)
    assert out.strip() == "1"                                         # checkpoint-committed
    # GH #58: a SUCCESSFUL drain advances via the ack-handled seam (contiguous floor) — never a
    # blanket delivered_ts high-water at the wake-ack
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack.get("delivered_ts") is None
    assert any(u.endswith("/events/ack-handled") for u, _ in posts)


# ---------- test 6a: Codex 429 clean-exit classified rate_limited, cursor withheld ----------

def test_codex_rate_limit_clean_exit_preserved_and_cursor_withheld(tmp_path, monkeypatch):
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_task_worktree(str(work), "Andrew", "rl-task")
    (pathlib.Path(wt) / "partial.txt").write_text("in-flight work\n")

    posts = []
    _wire(monkeypatch, posts)
    fd, hold = {}, {}
    live = {"agent-X": _task_worker(work, wt, branch, _rate_limit_log(tmp_path),
                                    notifier.RUNTIME_CODEX, task_id="rl-task")}
    notifier.reap_workers("http://x", live, quiet=True, failed_drains=fd, agent_hold_until=hold)

    finish = next(b for u, b in posts if "/finish" in u)
    assert finish["status"] == "rate_limited"                        # 429 is NOT a successful drain
    assert pathlib.Path(wt).is_dir()                                 # worktree PRESERVED
    rc, out = notifier._run_git(["rev-list", "--count", "origin/main..HEAD"], cwd=wt)
    assert out.strip() == "0"                                        # rate-limited → preserve, don't commit
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert "delivered_ts" not in ack                                 # cursor NOT advanced
    assert ack["release_lease"] is True                              # lease freed so a later wake retries
    # DoD(3): a rate-limited drain must NOT ack/close pending notifications
    assert not any(u.endswith("/events/ack-handled") for u, _ in posts)
    assert not any("triage-close" in u for u, _ in posts)
    assert fd[("agent-X", "rl-task")] == 1                           # one failed drain counted
    assert hold.get("agent-X") and hold["agent-X"] > time.time()     # rate-limit hold-down armed


def test_context_only_rework_rate_limit_keeps_directive_pending(tmp_path, monkeypatch):
    """A rejected-verification directive can be the only pending event. The server grounds that
    run with context_task_id while wake_task_id remains empty. It must still get a task worktree and
    the task failure path, or a Codex 429 that exits zero will acknowledge the rejection forever."""
    work = _make_repo(tmp_path)
    aid = "00000000-0000-0000-0000-000000000001"
    tid = "rework-task"
    directive_id = 314
    candidate = {
        "agent_id": aid,
        "alias": "Andrew",
        "should_wake": True,
        "headless_cwd": str(work),
        "tmux_target": None,
        "pending_events": 1,
        "auto_start_task_ids": [],
        "wake_task_id": None,
        "context_task_id": tid,
        "handled_event_ids": [directive_id],
        "reason": "rework requested",
        "latest_event": "task_verified",
        "max_event_ts": 42.0,
        "ack_through_ts": 42.0,
        "headless_flags": None,
        "model_runtime": notifier.RUNTIME_CODEX,
    }
    scan = {"active": True, "candidates": [candidate]}
    posts = []

    monkeypatch.setattr(notifier, "_get_json", lambda *a, **k: scan)
    monkeypatch.setattr(
        notifier,
        "_post_json",
        lambda url, body, **k: posts.append((url, body))
        or ({"claimed": True} if "wake-claim" in url else
            {"run_id": "RUN-REWORK"} if url.endswith("/runs") else {}),
    )
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(
        notifier,
        "spawn_headless",
        lambda *a, **k: (True, "codex exec", _ExitedProc(pid=777)),
    )

    live = {}
    notifier.tick(
        "http://x",
        "container",
        dry_run=False,
        cooldown=0,
        min_idle=0,
        quiet=True,
        live_workers=live,
    )
    worker = live[aid]
    assert worker["task_worktree"] is True
    assert worker["respawn_ctx"]["task_id"] == tid
    assert worker["wake_task_id"] == tid
    assert worker["handled_event_ids"] == [directive_id]

    posts.clear()
    worker["log_path"] = str(_rate_limit_log(tmp_path, "rework-rate-limit.log"))
    fd, hold = {}, {}
    notifier.reap_workers(
        "http://x",
        live,
        quiet=True,
        failed_drains=fd,
        agent_hold_until=hold,
    )

    finish = next(body for url, body in posts if "/finish" in url)
    assert finish["status"] == "rate_limited"
    assert not any(url.endswith("/events/ack-handled") for url, _ in posts)
    wake_ack = next(body for url, body in posts if url.endswith("/wake-ack"))
    assert "delivered_ts" not in wake_ack
    assert fd[(aid, tid)] == 1


# ---------- test 6b: /finish endpoint accepts the new terminal statuses (contract) ----------

@pytest.mark.asyncio
async def test_finish_accepts_rate_limited_and_records_it(client, make_agent):
    a = await make_agent("Rated")
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "wake_event": "task_assigned"})
    assert r.status_code == 201, r.text
    run_id = r.json()["run_id"]
    # old contract 422s anything but exited|killed → the row would stay running/orphaned (fail-first)
    fin = await client.post(f"/api/runs/{run_id}/finish", json={"status": "rate_limited", "exit_code": 0})
    assert fin.status_code == 200, fin.text
    assert fin.json()["status"] == "rate_limited"
    # 'failed' is accepted too
    fin2 = await client.post(f"/api/runs/{run_id}/finish", json={"status": "failed", "exit_code": 1})
    assert fin2.status_code == 200, fin2.text
    assert fin2.json()["status"] == "failed"


# ---------- test 7: continuity snapshot synthesized without a voluntary /orcha-snapshot ----------

def test_continuity_digest_synthesized_and_no_clobber(tmp_path, monkeypatch):
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_task_worktree(str(work), "Andrew", "digest-task")
    (pathlib.Path(wt) / "built.txt").write_text("meaningful output\n")

    # (a) no newer agent digest → a continuity snapshot is synthesized, pointing at the branch
    posts = []
    _wire(monkeypatch, posts, digest=None)
    live = {"agent-X": _task_worker(work, wt, branch, _success_log(tmp_path),
                                    notifier.RUNTIME_CODEX, task_id="digest-task")}
    notifier.reap_workers("http://x", live, quiet=True, failed_drains={}, agent_hold_until={})
    dg = next(b for u, b in posts if u.endswith("/digest"))
    threads = " ".join(t["text"] for t in dg["open_threads"])
    assert branch in threads and "origin/main" in threads            # newer than run + resume-from-branch
    assert "in progress" in (dg["current_focus"] or "").lower() or "saved" in (dg["current_focus"] or "").lower()

    # (b) a NEWER agent-written digest already exists → don't clobber it
    posts2 = []
    _wire(monkeypatch, posts2, digest={"snapshot_ts": time.time() + 1000, "current_focus": "richer"})
    live2 = {"agent-X": _task_worker(work, wt, branch, _success_log(tmp_path),
                                     notifier.RUNTIME_CODEX, task_id="digest-task")}
    notifier.reap_workers("http://x", live2, quiet=True, failed_drains={}, agent_hold_until={})
    assert not any(u.endswith("/digest") for u, _ in posts2)          # no clobber of the newer digest


# ---------- bound test (R3a/R5): the withheld cursor is bounded + survives live_workers.pop ----------

def test_failed_drain_bound_advances_cursor_after_N_and_clears_on_success(tmp_path, monkeypatch):
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_task_worktree(str(work), "Andrew", "flaky")
    fd, hold = {}, {}                                                 # DAEMON-SCOPE — survives across wakes

    def one_wake(log, monkeypatch_local):
        posts = []
        _wire(monkeypatch_local, posts)
        # a FRESH live_workers each wake (the prior reap pop()'d it) — the counter must NOT reset
        live = {"agent-X": _task_worker(work, wt, branch, log, notifier.RUNTIME_CODEX, task_id="flaky")}
        notifier.reap_workers("http://x", live, quiet=True, failed_drains=fd, agent_hold_until=hold)
        return posts

    # two consecutive rate-limited drains: cursor withheld both times; counter climbs to 2
    p1 = one_wake(_rate_limit_log(tmp_path, "rl1.log"), monkeypatch)
    assert "delivered_ts" not in next(b for u, b in p1 if u.endswith("/wake-ack"))
    p2 = one_wake(_rate_limit_log(tmp_path, "rl2.log"), monkeypatch)
    assert "delivered_ts" not in next(b for u, b in p2 if u.endswith("/wake-ack"))
    assert fd[("agent-X", "flaky")] == 2                             # SURVIVED the live_workers.pop (R5)

    # a SUCCESSFUL drain in between clears the key
    (pathlib.Path(wt) / "done.txt").write_text("progress\n")
    one_wake(_success_log(tmp_path), monkeypatch)
    assert ("agent-X", "flaky") not in fd                            # cleared on success

    # now FAILED_DRAIN_MAX consecutive fails → on the Nth, advance the cursor + surface a failure
    posts = None
    for i in range(notifier.FAILED_DRAIN_MAX):
        posts = one_wake(_rate_limit_log(tmp_path, f"rlx{i}.log"), monkeypatch)
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack.get("delivered_ts") == 42.0                          # force-advanced to wake_ack_ts at the bound
    assert any("failed to finish" in (b.get("body") or "").lower()
               for u, b in posts if u.endswith("/messages"))        # human-visible failure line
    assert ("agent-X", "flaky") not in fd                           # counter cleared after release


# ---------- BLOCKER 1 (PR #121 review): checkpoint-respawn keeps task-worktree protection ----------

def _respawn_worker(work, wt, branch, runtime, *, task_id, wake_ack_ts=42.0):
    """A tracked worker carrying the respawn_ctx + GH#110 continuity keys _checkpoint_and_respawn
    reads, mirroring the shape spawn_headless builds."""
    return {"proc": _ExitedProc(), "run_id": "RUN-A", "log_path": None,
            "base_cwd": str(work), "worktree": wt, "branch": branch,
            "task_worktree": True, "wake_ack_ts": wake_ack_ts, "started_ts": 1.0,
            "agent_id": "agent-X", "cap": 1200, "respawns": 0,
            "respawn_ctx": {"prompt": "p", "flags": None, "alias": "Andrew", "model": None,
                            "model_runtime": runtime, "task_id": task_id,
                            "task_worktree": True, "event": "task_message"}}


def test_checkpoint_respawn_preserves_task_worktree_and_cursor(tmp_path, monkeypatch):
    # Fails on OLD behavior: the rebuilt live_workers[aid] dropped task_worktree/wake_ack_ts, so
    # the respawned worker's clean exit force-removed the durable worktree (Andrew's vanished APK)
    # and a later FAILED_DRAIN_MAX release had no cursor to advance to.
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_task_worktree(str(work), "Andrew", "long-build")
    (pathlib.Path(wt) / "apk.txt").write_text("android build artifact\n")

    monkeypatch.setattr(notifier, "_kill_worker", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "")
    monkeypatch.setattr(notifier, "_capture_diff", lambda wtree, **k: "diff")
    new_proc = _ExitedProc(pid=1234)
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "cmd", new_proc))

    posts = []
    _wire(monkeypatch, posts)
    live = {"agent-X": _respawn_worker(work, wt, branch, notifier.RUNTIME_CLAUDE, task_id="long-build")}
    notifier._checkpoint_and_respawn("http://x", "agent-X", live["agent-X"], live, quiet=True)

    rebuilt = live["agent-X"]                                        # the respawned worker
    assert rebuilt["task_worktree"] is True                         # STILL a task worker (carried through)
    assert rebuilt["wake_ack_ts"] == 42.0                           # bounded-release cursor carried through
    assert rebuilt["started_ts"] == 1.0 and rebuilt["agent_id"] == "agent-X"

    posts2 = []
    _wire(monkeypatch, posts2)
    notifier.reap_workers("http://x", live, quiet=True, failed_drains={}, agent_hold_until={})
    assert pathlib.Path(wt).is_dir()                                # NOT force-removed
    assert (pathlib.Path(wt) / "apk.txt").read_text() == "android build artifact\n"
    rc, out = notifier._run_git(["rev-list", "--count", "origin/main..HEAD"], cwd=wt)
    assert out.strip() == "1"                                       # checkpoint-committed
    # GH #58: success advances via ack-handled, never a blanket delivered_ts at the wake-ack
    ack = next(b for u, b in posts2 if u.endswith("/wake-ack"))
    assert ack.get("delivered_ts") is None
    assert any(u.endswith("/events/ack-handled") for u, _ in posts2)


def test_checkpoint_respawn_spawn_failure_preserves_task_worktree(tmp_path, monkeypatch):
    # The respawn-FAILURE branch must PRESERVE (not force-teardown) a durable task worktree.
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_task_worktree(str(work), "Andrew", "rf-task")
    (pathlib.Path(wt) / "wip.txt").write_text("in-flight\n")

    monkeypatch.setattr(notifier, "_kill_worker", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: "")
    monkeypatch.setattr(notifier, "_capture_diff", lambda wtree, **k: "diff")
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (False, "cmd", None))

    posts = []
    _wire(monkeypatch, posts)
    live = {"agent-X": _respawn_worker(work, wt, branch, notifier.RUNTIME_CLAUDE, task_id="rf-task")}
    notifier._checkpoint_and_respawn("http://x", "agent-X", live["agent-X"], live, quiet=True)

    assert "agent-X" not in live                                    # worker released
    assert pathlib.Path(wt).is_dir()                                # task worktree PRESERVED
    rc, out = notifier._run_git(["rev-list", "--count", "origin/main..HEAD"], cwd=wt)
    assert out.strip() == "1"                                       # checkpoint-committed before release
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert "delivered_ts" not in ack                               # cursor withheld → retry next wake
    assert ack["kind"] == "worker_checkpoint_respawn_failed"
    assert any(u.endswith("/messages") for u, _ in posts)          # saved-ref surfaced to the feed


# ---------- BLOCKER 2 (PR #121 review): §2c terminal-task worktree reaper ----------

def test_terminal_task_worktrees_reclaimed_conservatively(tmp_path, monkeypatch):
    # Fails on OLD behavior: no §2c reaper existed, so durable orcha/task-* worktrees accumulated
    # forever after a task went terminal.
    work = _make_repo(tmp_path)
    wt_clean, br_clean = notifier._provision_task_worktree(str(work), "Andrew", "done-clean")
    wt_dirty, br_dirty = notifier._provision_task_worktree(str(work), "Andrew", "done-dirty")
    (pathlib.Path(wt_dirty) / "uncommitted.txt").write_text("not saved\n")   # real worker work → keep
    wt_live, br_live = notifier._provision_task_worktree(str(work), "Ethan", "still-live")

    def fake_get(url, **k):
        if "/runs" in url:
            if "TC/runs" in url:
                return {"runs": [{"worktree": wt_clean, "branch": br_clean, "base_cwd": str(work)}]}
            if "TD/runs" in url:
                return {"runs": [{"worktree": wt_dirty, "branch": br_dirty, "base_cwd": str(work)}]}
            if "TL/runs" in url:
                return {"runs": [{"worktree": wt_live, "branch": br_live, "base_cwd": str(work)}]}
            return {"runs": []}
        if "status=completed" in url:
            return {"tasks": [{"id": "TC"}, {"id": "TD"}, {"id": "TL"}]}
        return {"tasks": []}                                        # cancelled → none
    monkeypatch.setattr(notifier, "_get_json", fake_get)

    live_workers = {"agent-Ethan": {"worktree": wt_live}}           # a live worker still holds TL's tree
    swept, fd = set(), {("agent-X", "TC"): 3}
    removed = notifier.reap_terminal_task_worktrees("http://x", "CID", str(work), live_workers,
                                                    swept, quiet=True, failed_drains=fd)

    assert removed == 1                                             # only the clean, non-live worktree
    assert not pathlib.Path(wt_clean).exists()                     # reclaimed
    rc, _ = notifier._run_git(["rev-parse", "--verify", "--quiet", f"refs/heads/{br_clean}"], cwd=work)
    assert rc != 0                                                  # no-commit branch deleted
    assert pathlib.Path(wt_dirty).is_dir()                         # dirty tree PRESERVED (work never lost)
    assert (pathlib.Path(wt_dirty) / "uncommitted.txt").exists()
    assert pathlib.Path(wt_live).is_dir()                          # live worktree left alone
    assert ("agent-X", "TC") not in fd                             # note (c): fail-drain counter cleared
    assert "TC" in swept                                           # clean → swept once
    assert "TD" not in swept and "TL" not in swept                 # dirty + live → deferred for retry


def test_terminal_task_worktree_with_commits_keeps_branch(tmp_path, monkeypatch):
    # A branch that carries commits beyond origin/main (the open-PR case) must be KEPT when its
    # worktree is reclaimed — never delete work a PR was cut from.
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_task_worktree(str(work), "Andrew", "pr-task")
    (pathlib.Path(wt) / "feature.py").write_text("shipped\n")
    notifier._checkpoint_task_worktree(str(work), wt, branch, "pr-task", "RUN-1")   # commit, clean tree

    def fake_get(url, **k):
        if "/runs" in url:
            return {"runs": [{"worktree": wt, "branch": branch, "base_cwd": str(work)}]}
        if "status=completed" in url:
            return {"tasks": [{"id": "TP"}]}
        return {"tasks": []}
    monkeypatch.setattr(notifier, "_get_json", fake_get)

    removed = notifier.reap_terminal_task_worktrees("http://x", "CID", str(work), {}, set(), quiet=True)
    assert removed == 1                                            # clean tree → worktree removed
    assert not pathlib.Path(wt).exists()
    rc, _ = notifier._run_git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=work)
    assert rc == 0                                                 # branch with commits KEPT (PR-safe)


def test_terminal_reaper_paginates_past_page_one(tmp_path, monkeypatch):
    # PR #121 R3 regression: the list endpoint clamps limit→100, and terminal tasks are never
    # deleted — so a NEWLY-terminal task (the one owning a fresh durable worktree) sits beyond the
    # first page once a container has >100 completed tasks. A one-shot limit=100 GET is permanently
    # blind to it. Fails on OLD (unpaginated) behavior: the page-2 task is never seen → removed==0
    # and its worktree survives forever. Passes on NEW behavior: the reaper walks all pages.
    work = _make_repo(tmp_path)
    wt_new, br_new = notifier._provision_task_worktree(str(work), "Andrew", "page2-task")   # clean tree

    # Page 1 = 100 OLD, already-swept-shaped tasks with no durable worktree; page 2 = the new task.
    page1 = [{"id": f"OLD{i}"} for i in range(100)]
    page2 = [{"id": "NEW"}]

    def fake_get(url, **k):
        if "/runs" in url:
            if "NEW/runs" in url:
                return {"runs": [{"worktree": wt_new, "branch": br_new, "base_cwd": str(work)}]}
            return {"runs": []}                                     # old tasks own nothing durable
        if "status=completed" in url:
            if "offset=0" in url:
                return {"tasks": page1, "total": 101, "has_more": True}
            if "offset=100" in url:
                return {"tasks": page2, "total": 101, "has_more": False}
            return {"tasks": [], "has_more": False}
        return {"tasks": [], "has_more": False}                    # cancelled → none
    monkeypatch.setattr(notifier, "_get_json", fake_get)

    swept: set = set()
    removed = notifier.reap_terminal_task_worktrees("http://x", "CID", str(work), {}, swept, quiet=True)

    assert removed == 1                                            # the page-2 task's worktree reclaimed
    assert not pathlib.Path(wt_new).exists()                      # reclaimed despite being past page 1
    assert "NEW" in swept                                         # swept once
    assert "OLD0" in swept and "OLD99" in swept                  # page 1 also fully processed


# ---------- PR #121 review blocker: lingering terminal-FAILURE worker routes to retry ----------

class _LiveProc:
    """A worker process that is still ALIVE (poll() -> None) — the completed-but-lingering path."""
    def __init__(self, pid=998):
        self.pid = pid
        self.returncode = None
    def poll(self): return None
    def kill(self): pass
    def wait(self, timeout=None): return 0


def test_codex_lingering_terminal_failure_preserved_and_cursor_withheld(tmp_path, monkeypatch):
    """A Codex task worker whose log already shows a terminal turn.failed and that lingers past
    the graceful-exit window must drain 'failed' — preserve the worktree, withhold the cursor,
    count the failed drain — NOT be booked as a completed 'exited' drain that checkpoint-commits,
    clears the counter and advances the cursor (skipping the retry the events were owed)."""
    work = _make_repo(tmp_path)
    wt, branch = notifier._provision_task_worktree(str(work), "Andrew", "fail-task")
    (pathlib.Path(wt) / "partial.txt").write_text("in-flight work\n")

    log = tmp_path / "codex-failed.log"
    log.write_text('{"type":"item.completed","item":{"id":"1"}}\n{"type":"turn.failed"}\n')

    posts = []
    _wire(monkeypatch, posts)
    monkeypatch.setattr(notifier, "_kill_worker", lambda proc, **k: None)  # never signal a real pgid
    fd, hold = {}, {}
    w = _task_worker(work, wt, branch, log, notifier.RUNTIME_CODEX, task_id="fail-task")
    w["proc"] = _LiveProc()
    w["hard_deadline"] = time.time() - 5          # over the cap -> watchdog section
    w["result_seen_ts"] = 1.0                     # graceful-exit window long expired -> kill branch
    notifier.reap_workers("http://x", {"agent-X": w}, quiet=True,
                          failed_drains=fd, agent_hold_until=hold)

    finish = next(b for u, b in posts if "/finish" in u)
    assert finish["status"] == "failed"                              # NOT a completed 'exited' drain
    assert pathlib.Path(wt).is_dir()                                 # worktree PRESERVED
    rc, out = notifier._run_git(["rev-list", "--count", "origin/main..HEAD"], cwd=wt)
    assert out.strip() == "0"                                        # failed -> no checkpoint commit
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert "delivered_ts" not in ack                                 # cursor withheld -> wake retries
    assert ack["kind"] == "worker_drain_failed"
    assert fd[("agent-X", "fail-task")] == 1                         # failed drain counted, not cleared


# ---------- GH #58 R5 blocker: a REAL tick()-spawned worker still stops the failure hot-loop ----------

@pytest.mark.asyncio
async def test_tick_spawned_task_worker_bound_release_advances_real_cursor(
        tmp_path, client, container, make_agent, make_task, db, monkeypatch):
    """PR #167 R5 blocker: the spawn path retired the pending_ack_ts stash, so a worker produced by
    the REAL tick() (not a hand-seeded live-worker dict) reached FAILED_DRAIN_MAX with no release
    cursor — the bound-hit wake-ack posted delivered_ts=None ("no advance"), left the same events
    pending, and the identical failure cycle restarted from zero instead of stopping.

    Drives the real wake-scan + tick() to build the tracked worker, then reaps that worker (only
    proc/log_path overridden to simulate each Codex-429 exit) through FAILED_DRAIN_MAX drains.

    TEETH: drop wake_ack_ts from tick's live_workers entry (the old shape) and the bound-hit ack
    has no real delivered_ts → the final asserts flip red."""
    work = _make_repo(tmp_path)
    andy = await make_agent("TickAndy")
    poster = await make_agent("TickPoster")
    task = await make_task("flaky tick task", "dod", assignee_alias="TickAndy")
    tid = task["id"]
    # Codex runtime so a 429 log classifies the drain rate_limited (the GH#110 failure path)
    r = await client.post(f"/api/agents/{andy['agent_id']}/model", json={"model": "gpt-5.5"})
    assert r.status_code == 200, r.text
    # a teammate's task-thread note → a task_message event for TickAndy (a task-linked code wake)
    db.execute("INSERT INTO agent_tasks (agent_id, task_id, assignment_status) "
               "VALUES (%s, %s, 'working')", (poster["agent_id"], tid))
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": poster["agent_id"], "body": "please retry the build"})
    assert r.status_code == 201, r.text

    scan = (await client.get(f"/api/containers/{container['id']}/wake-scan",
                             params={"cooldown": 0, "min_idle": 0})).json()

    posts = []

    def _get(url, **k):
        return scan if "wake-scan" in url else {"digest": None}

    def _post(url, body, **k):
        posts.append((url, body))
        if "wake-claim" in url:
            return {"claimed": True}
        if "reachability" in url:
            return {"headless_cwd": str(work)}   # spawnable in the throwaway repo THIS tick
        return {}

    monkeypatch.setattr(notifier, "_get_json", _get)
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_triage_wake", lambda *a, **k: {"wake": True, "reason": "test"})
    monkeypatch.setattr(notifier, "spawn_headless",
                        lambda *a, **k: (True, "codex exec", _ExitedProc(pid=777)))

    live: dict = {}
    notifier.tick("http://x", container["id"], dry_run=False, cooldown=0, min_idle=0,
                  quiet=True, live_workers=live, base_cwd=str(work))

    spawned = live.get(andy["agent_id"])
    assert spawned is not None, "tick must track TickAndy's ephemeral task worker"
    assert spawned["task_worktree"] is True                        # durable per-(agent+task) worktree
    cursor = spawned.get("wake_ack_ts")
    assert cursor is not None                                      # the bounded-release cursor EXISTS

    # now drive THAT worker shape through FAILED_DRAIN_MAX consecutive Codex-429 drains
    fd, hold = {}, {}
    ack = None
    for i in range(notifier.FAILED_DRAIN_MAX):
        w = dict(spawned)                                          # each wake re-spawns the same shape
        w["proc"] = _ExitedProc()
        w["log_path"] = str(_rate_limit_log(tmp_path, f"tick-rl{i}.log"))
        round_posts = []
        monkeypatch.setattr(notifier, "_post_json",
                            lambda url, body, **k: round_posts.append((url, body)) or {})
        notifier.reap_workers("http://x", {andy["agent_id"]: w}, quiet=True,
                              failed_drains=fd, agent_hold_until=hold)
        ack = next(b for u, b in round_posts if u.endswith("/wake-ack"))
        if i < notifier.FAILED_DRAIN_MAX - 1:
            assert "delivered_ts" not in ack                       # withheld → retry next wake

    assert ack["kind"] == "worker_drain_failed_released"
    assert ack.get("delivered_ts") == cursor                       # released on the REAL stashed cursor
    assert ack.get("delivered_ts") is not None                     # ...not a None no-advance
    assert (andy["agent_id"], tid) not in fd                       # counter cleared after release
