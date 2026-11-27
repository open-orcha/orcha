"""The test browser's first-use download (`orcha_cli.qa.browser_setup`): with a fake Playwright
command line (no network), progress lands in the status file, a failure reads as one plain
sentence, a second caller joins the running download, and `start_session` answers "waiting:"."""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import textwrap
import time

import pytest

from orcha_cli.qa import browser_setup as bs

FAKE = textwrap.dedent('''
    import pathlib, sys
    where = pathlib.Path(sys.argv[1])
    mode = sys.argv[2]
    args = sys.argv[3:]
    if "--dry-run" in args:
        print("browser: chromium-headless-shell version 140.0")
        print(f"  Install location:    {where}")
        print("  Download url:        https://example.invalid/x.zip")
        raise SystemExit(0)
    if mode == "fail":
        print("Downloading Chromium Headless Shell")
        print("Error: getaddrinfo ENOTFOUND cdn.playwright.dev")
        raise SystemExit(1)
    if mode == "nospace":
        print("Error: ENOSPC: no space left on device, write")
        raise SystemExit(1)
    if mode in ("silent", "closed"):
        import os, subprocess, time
        # Like Playwright's Python entrypoint: it starts a child (Node) that does the download.
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        (where.parent / "pids").parent.mkdir(parents=True, exist_ok=True)
        (where.parent / "pids").write_text(f"{os.getpid()} {child.pid}")
        if mode == "closed":
            os.close(1)
            os.close(2)
        time.sleep(60)
    for pct in (10, 40, 100):
        print(f"|■■■■■■■■                | {pct:3d}% of 92.1 MiB", flush=True)
    where.mkdir(parents=True, exist_ok=True)
    (where / "INSTALLATION_COMPLETE").write_text("")
''')


@pytest.fixture()
def fake(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(pathlib.Path, "home", classmethod(lambda cls: home))
    script = tmp_path / "fake_playwright.py"
    script.write_text(FAKE)
    where = tmp_path / "ms-playwright" / "chromium_headless_shell-1"
    state = {"mode": "ok"}
    monkeypatch.setattr(bs, "playwright_available", lambda: True)
    monkeypatch.setattr(bs, "playwright_cmd", lambda *args: [sys.executable, str(script), str(where), state["mode"], *args])
    return {"where": where, "state": state, "home": home}


def test_missing_then_download_reports_progress_and_ready(fake):
    assert not bs.installed()
    assert bs.status()["state"] == "missing"
    seen = []
    real_write = bs._write
    bs._write = lambda **f: seen.append(f) or real_write(**f)
    try:
        assert bs.run() == 0
    finally:
        bs._write = real_write
    assert [f["percent"] for f in seen if f.get("state") == "downloading"] == [0, 10, 40, 100]
    assert any(f.get("size") == "92.1 MiB" for f in seen)
    assert bs.installed()
    assert bs.status() == {"installed": True, "state": "ready", "percent": 100, "size": "92.1 MiB", "error": None, "message": None}
    assert bs.ensure_for_session() is None


@pytest.mark.parametrize(("mode", "words"), [("fail", "No internet connection"), ("nospace", "Not enough disk space")])
def test_failure_reads_as_one_plain_sentence(fake, mode, words):
    fake["state"]["mode"] = mode
    assert bs.run() == 1
    st = bs.status()
    assert st["state"] == "failed" and st["error"].startswith(words)
    note = bs.ensure_for_session()  # the agent hears the failure once…
    assert note.startswith("error: the test browser could not be downloaded: " + words)
    assert bs.status()["state"] == "missing"  # …and its next call tries again


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:  # a zombie still answers kill(0); ps says whether it has ended
        out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False).stdout
    except OSError:
        return True
    return bool(out.strip()) and not out.strip().startswith("Z")


@pytest.mark.parametrize("mode", ["silent", "closed"])
def test_a_hung_installer_is_ended_at_the_deadline(fake, monkeypatch, mode):
    """Silent, or with its output closed, the installer is still ended at the deadline (with the
    child it started), the download recorded as failed and the lock released."""
    fake["state"]["mode"] = mode
    monkeypatch.setattr(bs, "INSTALL_TIMEOUT_S", 1.0)
    began = time.monotonic()
    assert bs.run() == 1
    assert time.monotonic() - began < 15
    st = bs.status()
    assert st["state"] == "failed" and st["error"] == bs.TIMEOUT_WORDS
    assert not bs.downloading()
    pids = [int(x) for x in (fake["where"].parent / "pids").read_text().split()]
    deadline = time.monotonic() + 5
    while any(_alive(pid) for pid in pids) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not any(_alive(pid) for pid in pids)


def test_a_second_caller_joins_the_running_download(fake, monkeypatch):
    spawned = []
    monkeypatch.setattr(bs, "_spawn_runner", lambda: spawned.append(1))
    with bs._lock() as mine:
        assert mine
        st = bs.start()
        assert st["state"] == "downloading" and spawned == []
        note = bs.ensure_for_session()
        assert note.startswith("waiting: downloading the test browser (one time, about 100 MB)")
        assert bs.run() == 0 and not bs.installed()  # a second runner leaves at once
    assert spawned == []


def test_start_spawns_one_runner_and_answers_downloading(fake, monkeypatch):
    spawned = []
    monkeypatch.setattr(bs, "_spawn_runner", lambda: spawned.append(bs.runner_cmd()))
    monkeypatch.setattr(bs.time, "sleep", lambda s: None)
    st = bs.start()
    assert st["state"] == "downloading"
    assert spawned == [[sys.executable, "-m", "orcha_cli.qa.browser_setup", "run"]]
    assert bs._read()["percent"] == 0


def test_waiting_text_carries_the_percent():
    assert "40% done" in bs.waiting_text({"percent": 40})
    assert bs.waiting_text({"percent": None}).startswith("waiting: ")


def test_plain_error_falls_back_to_the_last_line():
    assert bs.plain_error("one\nsomething odd happened\n") == "The download stopped: something odd happened"
    assert bs.plain_error("") == "The download stopped."
    assert bs.plain_error("EACCES: permission denied").startswith("Embodent can't write")


def test_without_playwright_status_says_the_tools_are_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(pathlib.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(bs, "playwright_available", lambda: False)
    st = bs.status()
    assert st["state"] == "failed" and "missing" in st["error"]
    assert bs.ensure_for_session().startswith("error: the test browser could not be downloaded")
