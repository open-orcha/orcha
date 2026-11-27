"""The test browser's first-use download (`orcha_cli.qa.browser_setup`): with a fake Playwright
command line (no network), progress lands in the status file, a failure reads as one plain
sentence, a second caller joins the running download, and `start_session` answers "waiting:".
A slow download runs as long as data arrives; one that receives no data is ended after the
no-data limit (shortened here), and the next try works."""

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
    if mode.startswith("slow:"):
        # Like Playwright on a slow connection: each file grows in a new folder under TMPDIR, one
        # progress line per 10% (here: one line for the whole browser), the browser folder fills
        # as it unpacks, then a second file (ffmpeg) downloads with no line at all.
        import os, shutil, tempfile, time
        step, browser_s, ffmpeg_s = (float(x) for x in mode.split(":")[1:])
        where.parent.mkdir(parents=True, exist_ok=True)
        (where.parent / "tmpdir").write_text(os.environ.get("TMPDIR", ""))
        print("Downloading Chromium Headless Shell 140.0", flush=True)
        print("|                                                                                | " + "  0% of 92.1 MiB", flush=True)
        for name, seconds in (("chromium-headless-shell", browser_s), ("ffmpeg", ffmpeg_s)):
            folder = pathlib.Path(tempfile.mkdtemp(prefix="playwright-download-"))
            with open(folder / f"playwright-download-{name}-mac-arm64-1.zip", "ab") as part:
                end = time.monotonic() + seconds
                while time.monotonic() < end:
                    part.write(b"x" * 4096)
                    part.flush()
                    time.sleep(step)
            shutil.rmtree(folder)
            where.mkdir(parents=True, exist_ok=True)
            (where / f"{name}.bin").write_bytes(b"y" * 8192)
        (where / "INSTALLATION_COMPLETE").write_text("")
        raise SystemExit(0)
    if mode in ("silent", "closed", "data_then_stall"):
        import os, subprocess, tempfile, time
        # Like Playwright's Python entrypoint: it starts a child (Node) that does the download.
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        (where.parent / "pids").parent.mkdir(parents=True, exist_ok=True)
        (where.parent / "pids").write_text(f"{os.getpid()} {child.pid}")
        if mode == "data_then_stall":  # some data, then the connection stops
            folder = pathlib.Path(tempfile.mkdtemp(prefix="playwright-download-"))
            with open(folder / "playwright-download-chromium-headless-shell-mac-arm64-1.zip", "ab") as part:
                for _ in range(5):
                    part.write(b"x" * 4096)
                    part.flush()
                    time.sleep(0.05)
        if mode in ("closed", "data_then_stall"):
            os.close(1)
            os.close(2)
        time.sleep(60)
    for pct in (10, 40, 100):
        print(f"|■■■■■■■■                | {pct:3d}% of 92.1 MiB", flush=True)
    if mode == "two_files":  # like Playwright: a small second file (ffmpeg) after the browser
        print("Downloading FFMPEG playwright build v1011", flush=True)
        for pct in (10, 50, 100):
            print(f"|■■■■■■■■                | {pct:3d}% of 1.4 MiB", flush=True)
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


def test_percent_never_goes_back_for_the_second_file(fake):
    fake["state"]["mode"] = "two_files"
    seen = []
    real_write = bs._write
    bs._write = lambda **f: seen.append(f) or real_write(**f)
    try:
        assert bs.run() == 0
    finally:
        bs._write = real_write
    assert [f["percent"] for f in seen if f.get("state") == "downloading"] == [0, 10, 40, 100]
    assert all(f.get("size") in (None, "92.1 MiB") for f in seen)
    assert bs.status()["size"] == "92.1 MiB"


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


@pytest.fixture()
def short_limit(monkeypatch):
    """The no-data limit shortened to 0.8 s (5 minutes in the app); the old 30-minute total deadline,
    if the code still had one, shortened the same way."""
    # raising=False: the same test also runs against the code before this limit (it must fail there).
    monkeypatch.setattr(bs, "STALL_TIMEOUT_S", 0.8, raising=False)
    monkeypatch.setattr(bs, "POLL_S", 0.05, raising=False)
    monkeypatch.setattr(bs, "INSTALL_TIMEOUT_S", 0.8, raising=False)
    return 0.8


def test_a_slow_download_runs_past_the_old_deadline(fake, short_limit):
    """Data keeps arriving for 5x the limit, with output lines only at the start: the download completes. The
    second file (ffmpeg) prints nothing at all and lasts 2x the limit."""
    fake["state"]["mode"] = f"slow:0.1:{3 * short_limit}:{2 * short_limit}"
    began = time.monotonic()
    assert bs.run() == 0
    assert time.monotonic() - began > 4 * short_limit
    assert bs.status()["state"] == "ready" and bs.installed()
    assert (fake["where"].parent / "tmpdir").read_text() == str(bs.download_dir())
    assert not bs.download_dir().exists()  # the temporary folder is removed
    assert not bs.downloading()


def test_watch_keeps_a_download_with_sparse_progress_for_hours():
    """Controlled clock: 2 hours of a few KB every 4 minutes and an output line every 40 minutes, then
    the browser folder fills and a later file downloads. It never counts as stalled; once nothing
    changes, it does after the limit."""
    import tempfile

    with tempfile.TemporaryDirectory() as root:
        temp, browser = pathlib.Path(root, "tmp"), pathlib.Path(root, "browser")
        temp.mkdir()
        watch = bs._Watch([temp, browser], now=0.0)
        part = temp / "playwright-download-a" / "playwright-download-chromium-headless-shell-mac-arm64-1.zip"
        part.parent.mkdir()
        for minute in range(121):
            if minute % 4 == 0:
                with part.open("ab") as f:
                    f.write(b"x" * 1024)
            assert not watch.stalled(minute * 60.0, lines=minute // 40), minute
        now = 121 * 60.0
        part.unlink()  # unpacked: the part file goes, the browser folder fills
        browser.mkdir()
        (browser / "chrome-headless-shell").write_bytes(b"y" * 2048)
        assert not watch.stalled(now + 240, lines=3)
        later = temp / "playwright-download-b" / "playwright-download-ffmpeg-mac-arm64-1.zip"
        later.parent.mkdir()
        later.write_bytes(b"z" * 512)
        assert not watch.stalled(now + 480, lines=3)
        assert not watch.stalled(now + 480 + bs.STALL_TIMEOUT_S - 1, lines=3)
        assert not watch.stalled(now + 480 + bs.STALL_TIMEOUT_S + 30, lines=4)  # a new line counts too
        assert watch.stalled(now + 510 + 2 * bs.STALL_TIMEOUT_S, lines=4)


@pytest.mark.parametrize("mode", ["silent", "closed", "data_then_stall"])
def test_a_stalled_installer_is_ended_and_the_next_try_works(fake, short_limit, mode):
    """With no new data for the limit (silent, its output closed, or after some data), the installer
    is ended with the child it started, the download recorded as failed and the lock released. The
    next try downloads again."""
    fake["state"]["mode"] = mode
    began = time.monotonic()
    assert bs.run() == 1
    assert short_limit <= time.monotonic() - began < 15
    st = bs.status()
    assert st["state"] == "failed" and st["error"] == bs.STALL_WORDS
    assert not bs.downloading()
    assert not bs.download_dir().exists()
    pids = [int(x) for x in (fake["where"].parent / "pids").read_text().split()]
    deadline = time.monotonic() + 5
    while any(_alive(pid) for pid in pids) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not any(_alive(pid) for pid in pids)

    fake["state"]["mode"] = "ok"
    assert bs.ensure_for_session().startswith("error: the test browser could not be downloaded: " + bs.STALL_WORDS)
    assert bs.status()["state"] == "missing"
    assert bs.run() == 0
    assert bs.status()["state"] == "ready" and bs.installed()


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
