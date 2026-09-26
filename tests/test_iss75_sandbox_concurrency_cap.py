# tests/test_iss75_sandbox_concurrency_cap.py
"""Global sandbox concurrency cap — the notifier must budget the box (issue #75).

INCIDENT REGRESSION (OOM incident F1, 2026-08-01): six sandbox containers spawned
within 11 seconds — one per agent with a ready task, because NOTHING bounded
cross-agent concurrency — and an in-sandbox `npm ci` pushed the swapless 3.7 GB box
into global OOM (kernel `global_oom` at 14:52:56 killing pid 3782130), thrashed to
death, and needed an operator power cycle. The fix is a BOX-WIDE budget on concurrent
managed containers, enforced at the LAST moment before every spawn (both the ephemeral
wake lane and the resident boot lane), counting GROUND TRUTH (live `orcha.managed`
containers, host-wide) so racing daemons / restarts / multiple workspaces on one box
share one honest count and can't double-book past the budget between ticks.

Every test here has TEETH: revert the guard it exercises and it goes RED.
  - the herd test (test_six_agent_herd_*) is the direct 6-in-11s regression: with a
    cap of 1, exactly ONE of six simultaneous candidates spawns and the other five
    are deferred (kept eligible), instead of all six racing to OOM.
  - MUTATION for the derivation math: drop the `- BASE_RESERVE_MB`, or the `max(1, …)`
    floor, or the env-override precedence, and the corresponding test fails.
"""
import json

from orcha_cli import notifier, sandbox


# ---------- default derivation: memory-budget math (self-adjusts per box) ----------

def _cfg(mem="4g"):
    return sandbox.SandboxConfig(enabled=True, memory=mem)


def test_default_cap_is_memory_derived(monkeypatch):
    # 8 GiB box, 4 GiB per sandbox, 2 GiB reserve → (8192-2048)//4096 = 1.
    monkeypatch.delenv(sandbox.ENV_MAX_CONCURRENT, raising=False)
    monkeypatch.setattr(sandbox, "host_memory_mb", lambda: 8192)
    assert sandbox.concurrency_cap(_cfg("4g")) == 1
    # 32 GiB box, same per-sandbox cap → (32768-2048)//4096 = 7 (self-adjusts up).
    monkeypatch.setattr(sandbox, "host_memory_mb", lambda: 32768)
    assert sandbox.concurrency_cap(_cfg("4g")) == 7


def test_default_cap_floors_at_one_on_tiny_box(monkeypatch):
    # THE incident box: 3.7 GiB, 4 GiB per sandbox → (3789-2048)//4096 == 0, floored
    # to 1. A machine can always run at least one sandbox; the point is it must run
    # AT MOST one here — which is exactly the bound the 6-in-11s herd blew past.
    # MUTATION: drop the max(1, …) floor and this returns 0 (nothing ever spawns).
    monkeypatch.delenv(sandbox.ENV_MAX_CONCURRENT, raising=False)
    monkeypatch.setattr(sandbox, "host_memory_mb", lambda: 3789)
    assert sandbox.concurrency_cap(_cfg("4g")) == 1


def test_default_cap_subtracts_base_reserve(monkeypatch):
    # MUTATION: without the BASE_RESERVE_MB subtraction a 4 GiB box with a 1 GiB
    # per-sandbox cap would budget 4; with the 2 GiB reserve it budgets 2.
    monkeypatch.delenv(sandbox.ENV_MAX_CONCURRENT, raising=False)
    monkeypatch.setattr(sandbox, "host_memory_mb", lambda: 4096)
    assert sandbox.concurrency_cap(_cfg("1g")) == 2


def test_env_override_wins_over_derivation(monkeypatch):
    monkeypatch.setattr(sandbox, "host_memory_mb", lambda: 32768)  # would derive 7
    monkeypatch.setenv(sandbox.ENV_MAX_CONCURRENT, "3")
    assert sandbox.concurrency_cap(_cfg("4g")) == 3
    # A higher-than-derived override is honored too (operator's explicit choice).
    monkeypatch.setenv(sandbox.ENV_MAX_CONCURRENT, "20")
    assert sandbox.concurrency_cap(_cfg("4g")) == 20


def test_env_override_garbage_is_ignored(monkeypatch):
    monkeypatch.setattr(sandbox, "host_memory_mb", lambda: 8192)
    for bad in ("", "abc", "0", "-1", "2.5"):
        monkeypatch.setenv(sandbox.ENV_MAX_CONCURRENT, bad)
        # falls back to the derived value (1 here), never crashes on garbage
        assert sandbox.concurrency_cap(_cfg("4g")) == 1


def test_default_cap_on_non_linux_host_without_meminfo(monkeypatch):
    # /proc/meminfo is Linux-only; psutil is NOT a dependency. With no ground-truth
    # memory reading, fall back to a fixed sane default (env-overridable).
    monkeypatch.delenv(sandbox.ENV_MAX_CONCURRENT, raising=False)
    monkeypatch.setattr(sandbox, "host_memory_mb", lambda: None)
    assert sandbox.concurrency_cap(_cfg("4g")) == sandbox.DEFAULT_CAP_NO_MEMINFO
    # env override still wins even on a box with no meminfo
    monkeypatch.setenv(sandbox.ENV_MAX_CONCURRENT, "5")
    assert sandbox.concurrency_cap(_cfg("4g")) == 5


def test_host_memory_mb_reads_meminfo(monkeypatch, tmp_path):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:        8123456 kB\nMemFree:  100 kB\n")
    real_open = open

    def _fake_open(path, *a, **k):
        return real_open(meminfo if path == "/proc/meminfo" else path, *a, **k)

    monkeypatch.setattr("builtins.open", _fake_open)
    assert sandbox.host_memory_mb() == 8123456 // 1024


def test_host_memory_mb_returns_none_when_absent(monkeypatch):
    def _no_meminfo(path, *a, **k):
        raise OSError("no such file")

    monkeypatch.setattr("builtins.open", _no_meminfo)
    assert sandbox.host_memory_mb() is None


# ---------- per-sandbox memory parsing (docker --memory grammar) ----------

def test_sandbox_mem_mb_parses_units():
    assert sandbox.sandbox_mem_mb(_cfg("4g")) == 4096
    assert sandbox.sandbox_mem_mb(_cfg("1536m")) == 1536     # the configured 1536m cap
    assert sandbox.sandbox_mem_mb(_cfg("2048m")) == 2048
    assert sandbox.sandbox_mem_mb(_cfg("1048576k")) == 1024
    assert sandbox.sandbox_mem_mb(_cfg("2147483648")) == 2048  # bare bytes
    # garbage falls back to the image default cap, never divides by a bogus figure
    assert sandbox.sandbox_mem_mb(_cfg("nonsense")) == sandbox.sandbox_mem_mb(
        _cfg(sandbox.DEFAULT_MEMORY))


def test_workspace_1536m_cap_derivation(monkeypatch):
    # A workspace configured with the tighter 1536m per-sandbox cap on the incident
    # box: (3789-2048)//1536 == 1 (still floored/derived to 1 — one sandbox at a time).
    monkeypatch.delenv(sandbox.ENV_MAX_CONCURRENT, raising=False)
    monkeypatch.setattr(sandbox, "host_memory_mb", lambda: 3789)
    assert sandbox.concurrency_cap(_cfg("1536m")) == 1
    # a roomier 16 GiB box with 1536m sandboxes → (16384-2048)//1536 == 9
    monkeypatch.setattr(sandbox, "host_memory_mb", lambda: 16384)
    assert sandbox.concurrency_cap(_cfg("1536m")) == 9


# ---------- ground-truth counting: host-wide, sidecar-excluded, cid-agnostic ----------

def _docker_ps_stub(lines, returncode=0):
    class _CP:
        pass

    def _run(args, timeout=10):
        cp = _CP()
        cp.returncode = returncode
        cp.stdout = "\n".join(lines)
        cp.stderr = ""
        return cp

    return _run


def test_all_managed_containers_is_host_wide_not_cid_scoped(monkeypatch):
    # Two DIFFERENT projects' run containers on one box both count against the same
    # budget — the ps filter is orcha.managed only (NO orcha.cid), unlike the
    # cid-scoped managed_containers() the reaper uses.
    lines = [
        "orcha-run-aaa\torcha.managed=1,orcha.cid=PROJ_A",
        "orcha-run-bbb\torcha.managed=1,orcha.cid=PROJ_B",
    ]
    captured = {}

    def _run(args, timeout=10):
        captured["args"] = args

        class _CP:
            returncode = 0
            stdout = "\n".join(lines)
            stderr = ""

        return _CP()

    monkeypatch.setattr(sandbox, "_docker", _run)
    names = sandbox.all_managed_containers()
    assert names == ["orcha-run-aaa", "orcha-run-bbb"]
    joined = " ".join(captured["args"])
    assert "label=orcha.managed=1" in joined
    assert "orcha.cid" not in joined         # host-wide: NOT filtered by project


def test_all_managed_containers_excludes_sidecars(monkeypatch):
    # A drain sidecar carries orcha.sidecar=1 and owns no run row by design — it must
    # NOT be counted toward the budget (consistent with its reaper orphan-exemption).
    lines = [
        "orcha-run-work\torcha.managed=1,orcha.cid=P",
        "orcha-run-side\torcha.managed=1,orcha.sidecar=1,orcha.cid=P",
    ]
    monkeypatch.setattr(sandbox, "_docker", _docker_ps_stub(lines))
    assert sandbox.all_managed_containers() == ["orcha-run-work"]


def test_all_managed_containers_fails_open_on_docker_error(monkeypatch):
    monkeypatch.setattr(sandbox, "_docker", _docker_ps_stub([], returncode=127))
    assert sandbox.all_managed_containers() == []


# ---------- the spawn gate: cap_defers_spawn ----------

def test_cap_defers_when_at_or_over_budget(monkeypatch):
    monkeypatch.setattr(sandbox, "concurrency_cap", lambda cfg: 2)
    monkeypatch.setattr(sandbox, "all_managed_containers",
                        lambda: ["orcha-run-a", "orcha-run-b"])  # 2 live == cap
    reason = sandbox.cap_defers_spawn(_cfg())
    assert reason is not None and "2/2" in reason and "issue #75" in reason


def test_cap_allows_when_under_budget(monkeypatch):
    monkeypatch.setattr(sandbox, "concurrency_cap", lambda cfg: 2)
    monkeypatch.setattr(sandbox, "all_managed_containers", lambda: ["orcha-run-a"])
    assert sandbox.cap_defers_spawn(_cfg()) is None


def test_cap_fails_open_on_empty_count(monkeypatch):
    # docker unqueryable → count empty → allow the spawn (the reaper, not the cap,
    # backstops a genuine runaway; the cap must never wedge a healthy box).
    monkeypatch.setattr(sandbox, "concurrency_cap", lambda cfg: 1)
    monkeypatch.setattr(sandbox, "all_managed_containers", lambda: [])
    assert sandbox.cap_defers_spawn(_cfg()) is None


# ---------- end-to-end: the LAST-MOMENT enforcement in both spawn lanes ----------

def _sandbox_project(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({
        "api_base_url": "http://127.0.0.1:8000",
        "current_container_id": "CIDTEST",
        "sandbox": {"enabled": True},
    }))
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "docker-compose.yml").write_text("name: orcha-proj\n")
    return tmp_path


def test_spawn_headless_deferred_stamps_flag_and_skips_popen(tmp_path, monkeypatch):
    # The ephemeral wake lane: at/over budget → NO Popen, spawn_info['deferred']=True,
    # a "(deferred: …)" repr. MUTATION: remove the cap check in notifier_headless and
    # Popen fires (this test's _boom trips).
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: "cap reached (1/1)")

    def _boom(*a, **k):
        raise AssertionError("must not spawn a container when the cap defers")

    monkeypatch.setattr(notifier.subprocess, "Popen", _boom)
    info = {}
    sent, repr_, proc = notifier.spawn_headless(str(proj), "task", None, False,
                                                spawn_info=info)
    assert sent is False and proc is None
    assert info.get("deferred") is True
    assert "deferred" in repr_ and "cap reached" in repr_


def test_spawn_resident_deferred_stamps_flag_and_skips_popen(tmp_path, monkeypatch):
    # The resident boot lane rides the SAME cap: a resident IS a sandbox container.
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(sandbox, "cap_defers_spawn", lambda cfg: "cap reached (1/1)")

    def _boom(*a, **k):
        raise AssertionError("must not boot a resident container when the cap defers")

    monkeypatch.setattr(notifier.subprocess, "Popen", _boom)
    info = {}
    sent, repr_, proc = notifier.spawn_resident(str(proj), alias="Vox", spawn_info=info)
    assert sent is False and proc is None
    assert info.get("deferred") is True
    assert "deferred" in repr_


def test_dry_run_never_consults_cap(tmp_path, monkeypatch):
    # A dry-run creates no container, so it spends nothing against the budget and must
    # NOT be deferred — otherwise `--dry-run` output would lie about what would happen.
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)

    def _explode(cfg):
        raise AssertionError("cap must not be consulted in dry-run")

    monkeypatch.setattr(sandbox, "cap_defers_spawn", _explode)
    sent, repr_, proc = notifier.spawn_headless(str(proj), "task", None, True)
    assert "docker run" in repr_ and "deferred" not in repr_


def test_host_mode_never_consults_cap(tmp_path, monkeypatch):
    # Host mode (sandbox disabled) spawns no container — the cap is a SANDBOX concept
    # and must never gate a host-process wake.
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(
        {"api_base_url": "http://127.0.0.1:8000"}))

    def _explode(cfg):
        raise AssertionError("cap must not be consulted in host mode")

    monkeypatch.setattr(sandbox, "cap_defers_spawn", _explode)
    sent, repr_, proc = notifier.spawn_headless(str(tmp_path), "task", None, True)
    assert "docker run" not in repr_


# ---------- the 6-agent herd: the direct OOM-incident regression ----------

class _FakeProc:
    def __init__(self):
        self.pid = 4321
        self.returncode = None

    def poll(self):
        return self.returncode


def _herd_candidate(i):
    return {
        "agent_id": f"A{i}",
        "alias": f"agent{i}",
        "headless_cwd": None,   # set per-test to the sandbox project
        "reason": "ready task",
        "should_wake": True,
        "pending_events": 1,
        "latest_event": "task_ready",
    }


def test_six_agent_herd_respects_cap_of_one(tmp_path, monkeypatch):
    """OOM incident F1 regression: six agents with ready tasks all try to spawn in one
    tick (the 6-in-11s herd). With a box budget of 1, exactly ONE spawns and the other
    FIVE are deferred (kept eligible), instead of six racing containers to global OOM.

    The count is GROUND TRUTH: it climbs as each spawn lands, and the cap re-checks it
    at the last moment before every spawn — so the guard holds WITHIN a single tick, no
    in-memory bookkeeping needed. MUTATION: revert the cap check and all six spawn."""
    proj = _sandbox_project(tmp_path)

    # a growing ground-truth container list — one spawn appends one name
    live_containers: list[str] = []
    monkeypatch.setattr(sandbox, "concurrency_cap", lambda cfg: 1)
    monkeypatch.setattr(sandbox, "all_managed_containers", lambda: list(live_containers))
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)

    spawned = []

    def _spy_popen(argv, **kw):
        # the spawn "lands" a container — reflect it into the ground-truth count
        name = argv[argv.index("--name") + 1]
        live_containers.append(name)
        spawned.append(name)
        return _FakeProc()

    monkeypatch.setattr(notifier.subprocess, "Popen", _spy_popen)

    results = []
    for i in range(6):
        info = {}
        sent, repr_, proc = notifier.spawn_headless(str(proj), "task", None, False,
                                                    spawn_info=info)
        results.append((sent, info.get("deferred")))

    # exactly ONE spawned; the other FIVE were cap-deferred (not failed, not spawned)
    assert len(spawned) == 1, f"expected 1 container, six-in-11s herd spawned {len(spawned)}"
    assert sum(1 for sent, _ in results if sent) == 1
    assert sum(1 for _, deferred in results if deferred) == 5


def test_deferral_then_resume_when_a_slot_frees(tmp_path, monkeypatch):
    """A deferred candidate spawns on a LATER tick once a container exits and the
    ground-truth count drops back under budget — no starvation (fairness: the
    server-side wake-scan orders candidates ORDER BY created_at, oldest first, and a
    deferred candidate stays eligible, so it re-competes in that same stable order)."""
    proj = _sandbox_project(tmp_path)
    live_containers = ["orcha-run-existing"]   # box already at the cap of 1
    monkeypatch.setattr(sandbox, "concurrency_cap", lambda cfg: 1)
    monkeypatch.setattr(sandbox, "all_managed_containers", lambda: list(live_containers))
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(notifier.subprocess, "Popen", lambda argv, **kw: _FakeProc())

    # tick 1: at budget → deferred
    info1 = {}
    sent1, _, _ = notifier.spawn_headless(str(proj), "task", None, False, spawn_info=info1)
    assert sent1 is False and info1.get("deferred") is True

    # the existing container exits and is reaped → a slot frees
    live_containers.clear()

    # tick 2 (same candidate re-scanned): now UNDER budget → spawns
    info2 = {}
    sent2, _, _ = notifier.spawn_headless(str(proj), "task", None, False, spawn_info=info2)
    assert sent2 is True and not info2.get("deferred")


def test_residents_count_against_the_same_budget(tmp_path, monkeypatch):
    """Multi-lane sharing: a resident boot is deferred when the box is already at the
    cap with ONE-SHOT wake containers — both lanes draw on the same ground-truth count,
    so a resident can't sneak past a budget the wake lane already filled."""
    proj = _sandbox_project(tmp_path)
    # the cap of 1 is already consumed by a one-shot wake container
    monkeypatch.setattr(sandbox, "concurrency_cap", lambda cfg: 1)
    monkeypatch.setattr(sandbox, "all_managed_containers",
                        lambda: ["orcha-run-a-wake"])
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)

    def _boom(*a, **k):
        raise AssertionError("resident must not boot past a wake-filled budget")

    monkeypatch.setattr(notifier.subprocess, "Popen", _boom)
    info = {}
    sent, repr_, proc = notifier.spawn_resident(str(proj), alias="Vox", spawn_info=info)
    assert sent is False and info.get("deferred") is True
