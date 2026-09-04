# tests/test_sandbox_reaper.py
"""Sweep semantics (spec §3.5): liveness by docker inspect, deadline stop,
orphan stop, exit-code stamping, container rm AFTER stamping, volumes untouched.

PATH-shim fake docker: logs its argv to a file the assertions read; `inspect`
answers from a canned JSON payload, `ps` from a canned names+labels table
(docker ps has NO negative label filter, so the sidecar exclusion is client-side
— the shim's ps output must therefore carry the Labels column)."""
import json
import os
import stat

from orcha_cli import sandbox

_PS_DEFAULT = (
    "orcha-run-orphan1\torcha.container_name=orcha-run-orphan1,orcha.managed=1\n"
    "orcha-run-sidecar1\torcha.managed=1,orcha.sidecar=1\n"
)


def _shim(tmp_path, monkeypatch, inspect_json: dict, log: str, ps_output: str = _PS_DEFAULT):
    d = tmp_path / "bin"; d.mkdir(exist_ok=True)
    ps_file = tmp_path / "ps_out.txt"
    ps_file.write_text(ps_output)
    f = d / "docker"
    f.write_text(
        "#!/bin/sh\n"
        f"echo \"$@\" >> {log}\n"
        "case \"$1\" in\n"
        f"  inspect) echo '{json.dumps([inspect_json])}';;\n"
        f"  ps) cat {ps_file};;\n"
        "esac\nexit 0\n")
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")


def test_probe_running(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "running", "StartedAt": "2026-07-29T00:00:00Z",
                     "OOMKilled": False, "ExitCode": 0}}, str(tmp_path / "log"))
    st = sandbox.probe("orcha-run-x")
    assert st.running is True and st.exit_code is None


def test_probe_exited_maps_exit_and_oom(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "exited", "OOMKilled": True, "ExitCode": 137,
                     "StartedAt": "2026-07-29T00:00:00Z"}}, str(tmp_path / "log"))
    st = sandbox.probe("orcha-run-x")
    assert st.running is False and st.exit_code == 137 and st.oom_killed is True


def test_probe_gone_container_returns_none(tmp_path, monkeypatch):
    d = tmp_path / "bin"; d.mkdir()
    f = d / "docker"; f.write_text("#!/bin/sh\nexit 1\n")
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")
    assert sandbox.probe("orcha-run-x") is None


def test_probe_garbled_inspect_payload_returns_none(tmp_path, monkeypatch):
    d = tmp_path / "bin"; d.mkdir()
    f = d / "docker"; f.write_text("#!/bin/sh\necho 'not json'\nexit 0\n")
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")
    assert sandbox.probe("orcha-run-x") is None


def test_stop_past_deadline(tmp_path, monkeypatch):
    log = str(tmp_path / "log")
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "running", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": "2020-01-01T00:00:00Z"}}, log)   # ancient
    assert sandbox.past_deadline(sandbox.probe("orcha-run-x"), max_runtime_secs=7200)
    sandbox.stop("orcha-run-x")
    assert "stop" in open(log).read()


def test_not_past_deadline_when_fresh_or_exited(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "exited", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": "2020-01-01T00:00:00Z"}}, str(tmp_path / "log"))
    assert not sandbox.past_deadline(sandbox.probe("orcha-run-x"), max_runtime_secs=7200)
    assert not sandbox.past_deadline(None, max_runtime_secs=7200)


def test_not_past_deadline_on_unparseable_started_at(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "running", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": "not-a-timestamp"}}, str(tmp_path / "log"))
    assert not sandbox.past_deadline(sandbox.probe("orcha-run-x"), max_runtime_secs=7200)


def test_reap_removes_container_never_volumes(tmp_path, monkeypatch):
    log = str(tmp_path / "log")
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "exited", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": "2026-07-29T00:00:00Z"}}, log)
    sandbox.remove("orcha-run-x")
    contents = open(log).read()
    assert "rm orcha-run-x" in contents and " -v" not in contents   # volumes NEVER removed


def test_force_remove_uses_rm_f_but_never_volumes(tmp_path, monkeypatch):
    # Pre-dogfood fix 2: a killed drain sidecar's container survives the client
    # SIGKILL, is row-less AND orphan-exempt — plain rm fails on it forever
    # (immortal running container). force=True must issue `rm -f` (SIGKILL+rm);
    # the volume rule is unchanged: -v is NEVER passed.
    log = str(tmp_path / "log")
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "running", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": "2026-07-29T00:00:00Z"}}, log)
    sandbox.remove("orcha-run-x", force=True)
    contents = open(log).read()
    assert "rm -f orcha-run-x" in contents and " -v" not in contents


def test_remove_api_config_unlinks_and_tolerates_missing(tmp_path):
    d = tmp_path / ".orcha" / "sandbox"
    d.mkdir(parents=True)
    (d / "orcha-run-x.json").write_text("{}")
    sandbox.remove_api_config(tmp_path, "orcha-run-x")
    assert not (d / "orcha-run-x.json").exists()
    sandbox.remove_api_config(tmp_path, "orcha-run-x")          # already gone → no raise
    sandbox.remove_api_config(tmp_path / "nowhere", "orcha-run-y")


def test_managed_containers_lists_and_excludes_sidecars(tmp_path, monkeypatch):
    log = str(tmp_path / "log")
    _shim(tmp_path, monkeypatch, {"State": {}}, log)
    names = sandbox.managed_containers("CID123")
    # the sidecar-labeled line (orcha.sidecar=1) is EXCLUDED, the plain one kept
    assert names == ["orcha-run-orphan1"]
    # the ps invocation filters to the managed label AND this project's cid label
    # (C1: another stack's containers on the same host must be invisible), and asks
    # for the Labels column (docker ps has no negative label filter — the sidecar
    # exclusion is client-side)
    contents = open(log).read()
    assert "label=orcha.managed=1" in contents
    assert "label=orcha.cid=CID123" in contents
    assert "{{.Labels}}" in contents


def test_managed_containers_empty_on_docker_error(tmp_path, monkeypatch):
    d = tmp_path / "bin"; d.mkdir()
    f = d / "docker"; f.write_text("#!/bin/sh\nexit 1\n")
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")
    assert sandbox.managed_containers("CID123") == []


def test_daemon_reachable_gate(tmp_path, monkeypatch):
    log = str(tmp_path / "log")
    _shim(tmp_path, monkeypatch, {"State": {}}, log)
    assert sandbox.daemon_reachable() is True
    assert "info" in open(log).read()
    d = tmp_path / "bin2"; d.mkdir()
    f = d / "docker"; f.write_text("#!/bin/sh\nexit 1\n")
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")
    assert sandbox.daemon_reachable() is False


def test_past_deadline_parses_docker_nanosecond_started_at(tmp_path, monkeypatch):
    # I3: docker inspect emits NANOSECOND fractions ("....123456789Z"); Python
    # ≤3.10 fromisoformat accepts only 3/6 digits, so without normalization the
    # deadline silently never fires. Ancient nanosecond timestamp → past deadline.
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "running", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": "2020-01-01T00:00:00.123456789Z"}}, str(tmp_path / "log"))
    assert sandbox.past_deadline(sandbox.probe("orcha-run-x"), max_runtime_secs=7200)
    # and a FRESH nanosecond timestamp is within deadline
    import datetime
    fresh = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + ".987654321Z"
    st = sandbox.SandboxState(running=True, exit_code=None, oom_killed=False, started_at=fresh)
    assert not sandbox.past_deadline(st, max_runtime_secs=7200)


def test_sweep_helpers_never_raise_without_docker_binary(tmp_path, monkeypatch):
    # The sweep runs every daemon tick on HOST-mode machines too — a missing
    # docker binary must read as "nothing observable", never an exception.
    empty = tmp_path / "empty"; empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    assert sandbox.probe("orcha-run-x") is None
    assert sandbox.managed_containers("CID123") == []
    assert sandbox.daemon_reachable() is False
    sandbox.stop("orcha-run-x")
    sandbox.remove("orcha-run-x")


# ---- M7 boot grace, end-to-end through the REAL sandbox helpers (PATH shim) ----
# The fakes in test_iss342 prove the sweep's decision table; these prove the same
# decisions ride the real docker plumbing: managed_containers → probe(StartedAt)
# → age gate → stop/skip. The shim's `info` arm answers ok (daemon reachable) and
# `inspect` serves the canned State for the ps-listed orphan candidate.

import datetime as _dt

from orcha_cli import notifier


def _iso_ago(seconds: float) -> str:
    return (_dt.datetime.now(_dt.timezone.utc)
            - _dt.timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S") + "Z"


def _mute_api(monkeypatch):
    monkeypatch.setattr(notifier, "_get_json", lambda u, **k: {"runs": []})
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: {})


def test_orphan_pass_shim_young_rowless_container_not_stopped(tmp_path, monkeypatch):
    """StartedAt now-30s (< ORPHAN_BOOT_GRACE_SECS): the row-less candidate is a
    booting wake whose run-row POST hasn't landed — inspected but NOT stopped."""
    log = str(tmp_path / "log")
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "running", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": _iso_ago(30)}}, log)
    _mute_api(monkeypatch)
    assert notifier.reap_orphaned_runs("http://x", "CID123") == 0
    contents = open(log).read()
    assert "inspect orcha-run-orphan1" in contents        # the one grace probe ran
    assert "stop" not in contents                         # ...and deferred the stop


def test_orphan_pass_shim_old_rowless_container_stopped(tmp_path, monkeypatch):
    """StartedAt now-10min (> grace): the row-less candidate is a genuine orphan —
    stopped exactly as before the grace landed (and the sidecar stays exempt)."""
    log = str(tmp_path / "log")
    _shim(tmp_path, monkeypatch,
          {"State": {"Status": "running", "OOMKilled": False, "ExitCode": 0,
                     "StartedAt": _iso_ago(600)}}, log)
    _mute_api(monkeypatch)
    assert notifier.reap_orphaned_runs("http://x", "CID123") == 0
    contents = open(log).read()
    assert "stop --time 20 orcha-run-orphan1" in contents
    assert "orcha-run-sidecar1" not in "".join(
        line for line in contents.splitlines() if line.startswith("stop"))


def test_orphan_pass_shim_inspect_failure_skips_fail_safe(tmp_path, monkeypatch):
    """Probe-fail during the grace check (inspect exits 1 — e.g. the container is
    mid-`docker create` and has no inspectable object yet): age UNKNOWN → skip
    this sweep, never stop blind."""
    d = tmp_path / "bin"; d.mkdir(exist_ok=True)
    log = tmp_path / "log"
    ps_file = tmp_path / "ps_out.txt"
    ps_file.write_text(_PS_DEFAULT)
    f = d / "docker"
    f.write_text(
        "#!/bin/sh\n"
        f"echo \"$@\" >> {log}\n"
        "case \"$1\" in\n"
        "  inspect) exit 1;;\n"
        f"  ps) cat {ps_file};;\n"
        "esac\nexit 0\n")
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")
    _mute_api(monkeypatch)
    assert notifier.reap_orphaned_runs("http://x", "CID123") == 0
    contents = open(log).read()
    assert "inspect orcha-run-orphan1" in contents
    assert "stop" not in contents
