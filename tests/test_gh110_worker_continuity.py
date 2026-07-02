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
    _git(["add", "-A"], work)
    _git(["commit", "-m", "init"], work)
    _git(["remote", "add", "origin", str(origin)], work)
    _git(["push", "-u", "origin", "main"], work)
    (work / ".claude").mkdir()
    (work / ".claude" / "orcha.json").write_text('{}')
    return work


class _ExitedProc:
    def __init__(self, pid=999, returncode=0):
        self.pid = pid
        self.returncode = returncode
    def poll(self): return self.returncode
    def kill(self): pass
    def wait(self, timeout=None): return self.returncode


def _task_worker(work, wt, branch, log_path, runtime, *, task_id, pending_ack_ts=42.0):
    return {"proc": _ExitedProc(), "run_id": "RUN-1", "log_path": str(log_path),
            "worktree": wt, "branch": branch, "base_cwd": str(work),
            "task_worktree": True, "started_ts": 1.0, "pending_ack_ts": pending_ack_ts,
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
    # a SUCCESSFUL drain advances the cursor with the stashed ts (work actually drained)
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack.get("delivered_ts") == 42.0


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
    assert not any("triage-close" in u for u, _ in posts)
    assert fd[("agent-X", "rl-task")] == 1                           # one failed drain counted
    assert hold.get("agent-X") and hold["agent-X"] > time.time()     # rate-limit hold-down armed


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
    assert ack.get("delivered_ts") == 42.0                          # cursor force-advanced at the bound
    assert any("failed to finish" in (b.get("body") or "").lower()
               for u, b in posts if u.endswith("/messages"))        # human-visible failure line
    assert ("agent-X", "flaky") not in fd                           # counter cleared after release
