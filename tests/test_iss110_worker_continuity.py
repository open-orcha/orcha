"""#110 — Worker continuity: a task worker's code must survive the wake boundary.

Andrew (a Codex Android dev) built an APK in a timestamped worktree, exited without a PR, and
Orcha force-removed the worktree + deleted the branch — the next nudge started clean from
origin/main and had to reconstruct the app from logs. These tests pin the fix:

  1/2. a durable task worker (Codex + Claude) that leaves uncommitted work is PRESERVED across
       exit, and the next same-task wake reattaches to it.
  3.   a non-code request-answer wake still uses the cheap disposable path (no durable worktree).
  4.   a clean exit with a non-empty diff records a durable branch/worktree ref + checkpoints it.
  5.   worktree dir gone but branch alive → the next wake reattaches FROM THE BRANCH.
  6.   a Codex 429/rate-limit exit is classified rate_limited, preserves the worktree, and rewinds
       the wake cursor (no silent progress loss).
  7.   after a meaningful run the daemon writes a fresh continuity digest (Codex has no SessionEnd
       hook), newer than the run and free of stale pre-work instructions.

Exercises the real git helpers against a throwaway repo (bare origin + working clone), with the
API calls monkeypatched to capture what the daemon would POST — mirroring test_worktree_diff.py.
"""
import pathlib
import subprocess

from orcha_cli import notifier  # noqa: E402 (conftest puts orcha-cli on sys.path)


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def _make_repo(tmp_path):
    """A bare 'origin' with a main branch + a working clone wired to it (same as ISS-8 tests)."""
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
    return work


class _ExitedProc:
    """A Popen stand-in that has already exited with the given return code."""
    def __init__(self, pid=4242, rc=0):
        self.pid = pid
        self._rc = rc

    def poll(self):
        return self._rc

    @property
    def returncode(self):
        return self._rc


def _capture_api(monkeypatch):
    """Record every _post_json / _get_json the daemon makes; GET /digest returns a stub prior."""
    posts = []

    def fake_post(url, body=None, **k):
        posts.append((url, body))
        if url.endswith("/runs"):
            return {"run_id": "R"}
        if "wake-claim" in url:
            return {"claimed": True}
        return {}

    def fake_get(url, **k):
        if url.endswith("/digest"):
            return {"digest": {"current_focus": "Android paused at plan-review gate.",
                               "decisions": [{"d": "keep"}], "learnings": ["l"],
                               "open_threads": ["Resume task OLD: stale note"]}}
        return {}

    monkeypatch.setattr(notifier, "_post_json", fake_post)
    monkeypatch.setattr(notifier, "_get_json", fake_get)
    return posts


def _durable_worker(work, alias, task_id, *, runtime, run_id="R", log_path=None,
                    prev_delivered_ts=5.0):
    wt, branch = notifier._provision_task_worktree(str(work), alias, task_id)
    (work / ".claude").mkdir(exist_ok=True)
    (work / ".claude" / "orcha.json").write_text('{"api_base_url":"http://x"}')
    return {
        "proc": _ExitedProc(), "durable": True, "task_id": task_id,
        "worktree": wt, "branch": branch, "base_cwd": str(work),
        "run_id": run_id, "log_path": log_path, "prev_delivered_ts": prev_delivered_ts,
        "respawn_ctx": {"model_runtime": runtime},
    }, wt, branch


# ---------- 1 & 2: uncommitted task work survives + next wake reattaches ----------

def _preserve_and_reattach(tmp_path, monkeypatch, runtime):
    work = _make_repo(tmp_path)
    posts = _capture_api(monkeypatch)
    w, wt, branch = _durable_worker(work, "Andrew", "task-abc-0001", runtime=runtime)
    # the worker built an app but never committed / opened a PR
    (pathlib.Path(wt) / "android").mkdir()
    (pathlib.Path(wt) / "android" / "app-debug.apk").write_text("APK BYTES\n")

    disp = notifier._finish_worker_clean("http://x", "a1", w, quiet=True, exit_code=0)
    assert disp == "preserved"
    # worktree NOT discarded; the APK is still there
    assert pathlib.Path(wt).is_dir()
    assert (pathlib.Path(wt) / "android" / "app-debug.apk").read_text() == "APK BYTES\n"
    # the uncommitted work was checkpoint-committed to the branch (durable fallback)
    rc, out = notifier._run_git(["rev-list", "--count", f"origin/main..{branch}"], cwd=str(work))
    assert rc == 0 and int(out.strip()) >= 1

    # the next same-(agent+task) wake reattaches to the SAME worktree with the app present
    wt2, branch2 = notifier._provision_task_worktree(str(work), "Andrew", "task-abc-0001")
    assert (wt2, branch2) == (wt, branch)
    assert (pathlib.Path(wt2) / "android" / "app-debug.apk").exists()


def test_codex_task_worker_uncommitted_work_survives(tmp_path, monkeypatch):
    _preserve_and_reattach(tmp_path, monkeypatch, runtime="codex")


def test_claude_task_worker_uncommitted_work_survives(tmp_path, monkeypatch):
    _preserve_and_reattach(tmp_path, monkeypatch, runtime="claude")


# ---------- 3: a non-code / non-task wake uses the cheap disposable path ----------

def test_noncode_wake_uses_disposable_path(monkeypatch):
    """tick() must NOT provision a durable task worktree for a wake with no task id; a pure
    request-answer stays on the no-worktree fast path (calls neither provisioner)."""
    task_calls, disp_calls = [], []
    monkeypatch.setattr(notifier, "_provision_task_worktree",
                        lambda b, a, t: task_calls.append((a, t)) or ("/wt", "orcha/task-x"))
    monkeypatch.setattr(notifier, "_provision_worktree",
                        lambda b, a: disp_calls.append(a) or ("/wt", "orcha/wk-x"))
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "spawn_headless", lambda *a, **k: (True, "cmd", _ExitedProc()))
    monkeypatch.setattr(notifier, "_post_json",
                        lambda url, body=None, **k: {"claimed": True} if "wake-claim" in url
                        else ({"run_id": "R"} if url.endswith("/runs") else {}))

    def scan(latest, auto=None, wake_task_id=None, pending=1):
        return {"active": True, "candidates": [{
            "agent_id": "00000000-0000-0000-0000-000000000009", "alias": "B",
            "should_wake": True, "headless_cwd": "/proj", "tmux_target": None,
            "pending_events": pending, "auto_start_task_ids": auto or [],
            "wake_task_id": wake_task_id, "reason": "wake", "latest_event": latest,
            "max_event_ts": 1.0, "delivered_ts": 0.5, "headless_flags": None}]}

    # pure answer-to-our-ask → no worktree at all
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: scan("request_answered"))
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={})
    assert task_calls == [] and disp_calls == []

    # a task wake → durable provisioner (keyed on the task), never the disposable one
    task_calls.clear(); disp_calls.clear()
    monkeypatch.setattr(notifier, "_get_json",
                        lambda url, **k: scan("task_assigned", auto=["task-7"]))
    notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True,
                  live_workers={})
    assert task_calls == [("B", "task-7")] and disp_calls == []


# ---------- 4: clean exit records a durable branch/worktree/patch ref ----------

def test_clean_exit_records_durable_ref_and_diff(tmp_path, monkeypatch):
    work = _make_repo(tmp_path)
    posts = _capture_api(monkeypatch)
    w, wt, branch = _durable_worker(work, "Dev", "task-xyz-0002", runtime="codex")
    (pathlib.Path(wt) / "feature.py").write_text("print('hi')\n")

    notifier._finish_worker_clean("http://x", "a1", w, quiet=True, exit_code=0)

    finish = next(b for (u, b) in posts if u.endswith("/runs/R/finish"))
    assert finish["status"] == "exited"
    assert finish["diff"] and "feature.py" in finish["diff"]
    # the branch is a durable, PR-ready ref (a checkpoint commit sits on it beyond origin/main)
    rc, out = notifier._run_git(["rev-list", "--count", f"origin/main..{branch}"], cwd=str(work))
    assert rc == 0 and int(out.strip()) >= 1


# ---------- 5: dir pruned but branch alive → reattach from the branch ----------

def test_reattach_from_branch_when_worktree_removed(tmp_path):
    work = _make_repo(tmp_path)
    (work / ".claude").mkdir()
    (work / ".claude" / "orcha.json").write_text('{"api_base_url":"http://x"}')

    wt, branch = notifier._provision_task_worktree(str(work), "Dev", "task-reattach-9")
    (pathlib.Path(wt) / "keep.txt").write_text("durable work\n")
    _git(["add", "-A"], wt)
    _git(["commit", "-m", "work"], wt)
    # simulate the prune: dir removed, BRANCH kept
    notifier._remove_task_worktree_keep_branch(str(work), wt)
    assert not pathlib.Path(wt).exists()
    _, blist = notifier._run_git(["branch", "--list", branch], cwd=str(work))
    assert branch in blist

    # next wake must reattach FROM THE BRANCH (not a fresh origin/main checkout)
    wt2, branch2 = notifier._provision_task_worktree(str(work), "Dev", "task-reattach-9")
    assert branch2 == branch and pathlib.Path(wt2).is_dir()
    assert (pathlib.Path(wt2) / "keep.txt").read_text() == "durable work\n"


# ---------- 6: Codex rate-limit exit → rate_limited, preserved, cursor rewound ----------

def test_codex_rate_limit_exit_classified_and_cursor_rewound(tmp_path, monkeypatch):
    work = _make_repo(tmp_path)
    posts = _capture_api(monkeypatch)
    log = work / "codex.log"
    log.write_text(
        '{"type":"item.started","item":{"id":"1"}}\n'
        '{"type":"rate_limit_event","msg":{"type":"rate_limit_event","status":"rejected"},'
        '"api_error_status":429,"reset_at":1782959999}\n'
        '{"type":"error","message":"You\'ve hit your session limit (429)."}\n'
    )
    w, wt, branch = _durable_worker(work, "Andrew", "task-rl-0003", runtime="codex",
                                    log_path=str(log), prev_delivered_ts=7.0)
    (pathlib.Path(wt) / "wip.txt").write_text("half done\n")

    disp = notifier._finish_worker_clean("http://x", "a1", w, quiet=True, exit_code=0)
    assert disp == "rate_limited"
    # run marked killed/rate_limited (NOT a successful exit)
    finish = next(b for (u, b) in posts if u.endswith("/runs/R/finish"))
    assert finish["status"] == "killed" and "rate_limited" in (finish["kill_reason"] or "")
    # worktree preserved (work intact)
    assert pathlib.Path(wt).is_dir() and (pathlib.Path(wt) / "wip.txt").exists()
    # cursor rewound to the pre-wake value so the nudge re-surfaces
    reopen = next(b for (u, b) in posts if u.endswith("/wake-reopen"))
    assert reopen["before_ts"] == 7.0
    # a rate-limited drain must NOT write a "progress" digest
    assert not any(u.endswith("/digest") and b for (u, b) in posts)


def test_codex_rate_limited_exit_detector_ignores_success(tmp_path):
    """A worker that backed off on a 429 but then COMPLETED its turn is not a rate-limit exit."""
    log = tmp_path / "ok.log"
    log.write_text(
        '{"type":"rate_limit_event","api_error_status":429}\n'
        '{"type":"turn.completed","msg":{"type":"turn.completed"}}\n'
    )
    assert notifier._codex_rate_limited_exit(str(log)) is None


# ---------- 7: post-run continuity digest is fresh + free of stale pre-work text ----------

def test_post_run_digest_reflects_progress_not_stale(tmp_path, monkeypatch):
    work = _make_repo(tmp_path)
    posts = _capture_api(monkeypatch)
    w, wt, branch = _durable_worker(work, "Andrew", "task-dig-0004", runtime="codex")
    (pathlib.Path(wt) / "android").mkdir()
    (pathlib.Path(wt) / "android" / "MainActivity.kt").write_text("class Main\n")

    notifier._finish_worker_clean("http://x", "a1", w, quiet=True, exit_code=0)

    digest = next(b for (u, b) in posts if u.endswith("/agents/a1/digest"))
    # focus reflects real progress, not the stale "paused at plan-review" prior
    assert "plan-review" not in (digest["current_focus"] or "")
    assert branch in digest["current_focus"]
    # prior decisions/learnings carried forward (never fabricated/dropped)
    assert digest["decisions"] == [{"d": "keep"}] and digest["learnings"] == ["l"]
    # the stale resume-note was replaced; the fresh one points at the durable worktree + files
    resume = [t for t in digest["open_threads"] if isinstance(t, str) and t.startswith("Resume task")]
    assert len(resume) == 1 and "stale note" not in resume[0]
    assert "MainActivity.kt" in resume[0] and wt in resume[0]
