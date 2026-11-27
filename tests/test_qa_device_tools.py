"""Where the QA device tools are found (`orcha_cli.qa.device.tools`): the Mac app's bundled
idb_companion first, Android Studio's adb from the SDK folders, and person-readable words when one
is missing. Also: inside the app, agents run the app's own `orcha` (`qa.launch.orcha_executable`)."""

from __future__ import annotations

import os
import pathlib
import sys

import pytest

from orcha_cli.qa import launch
from orcha_cli.qa.device import tools


def _exe(path: pathlib.Path) -> pathlib.Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    return path


@pytest.fixture()
def clean_env(monkeypatch, tmp_path):
    """No SDK variables, an empty home, an empty PATH folder and no bundled runtime."""
    for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT", "ORCHA_IDB_COMPANION", "ORCHA_SIDECAR"):
        monkeypatch.delenv(name, raising=False)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(pathlib.Path, "home", classmethod(lambda cls: home))
    empty_bin = tmp_path / "pathbin"
    empty_bin.mkdir()
    monkeypatch.setenv("PATH", str(empty_bin))
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    monkeypatch.setattr(sys, "prefix", str(runtime))
    return {"home": home, "pathbin": empty_bin, "runtime": runtime, "tmp": tmp_path}


# ---------- adb ----------


def test_adb_order_android_home_first(clean_env, monkeypatch):
    tmp = clean_env["tmp"]
    a = _exe(tmp / "a" / "platform-tools" / "adb")
    _exe(tmp / "b" / "platform-tools" / "adb")
    _exe(clean_env["home"] / "Library/Android/sdk/platform-tools/adb")
    _exe(clean_env["pathbin"] / "adb")
    monkeypatch.setenv("ANDROID_HOME", str(tmp / "a"))
    monkeypatch.setenv("ANDROID_SDK_ROOT", str(tmp / "b"))
    assert tools.adb_path() == str(a)


def test_adb_order_sdk_root_then_studio_folder_then_path(clean_env, monkeypatch):
    tmp = clean_env["tmp"]
    b = _exe(tmp / "b" / "platform-tools" / "adb")
    studio = _exe(clean_env["home"] / "Library/Android/sdk/platform-tools/adb")
    on_path = _exe(clean_env["pathbin"] / "adb")
    monkeypatch.setenv("ANDROID_HOME", str(tmp / "a"))  # set, but no adb in it: skipped
    monkeypatch.setenv("ANDROID_SDK_ROOT", str(tmp / "b"))
    assert tools.adb_path() == str(b)
    monkeypatch.delenv("ANDROID_SDK_ROOT")
    assert tools.adb_path() == str(studio)
    studio.unlink()
    assert tools.adb_path() == str(on_path)


def test_adb_skips_a_file_that_is_not_executable(clean_env):
    plain = clean_env["home"] / "Library/Android/sdk/platform-tools/adb"
    plain.parent.mkdir(parents=True)
    plain.write_text("not a program")
    plain.chmod(0o644)
    assert tools.adb_path() is None


def test_adb_missing_words_for_app_and_source(clean_env, monkeypatch):
    assert tools.adb_path() is None
    assert "platform-tools" in tools.adb_missing() and "Android Studio" in tools.adb_missing()
    assert "Embodent" not in tools.adb_missing()
    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    words = tools.adb_missing()
    assert words.startswith("Embodent can't find adb")
    assert tools.PLATFORM_TOOLS_URL in words


def test_use_adb_puts_its_folder_first_on_path_once(clean_env, monkeypatch):
    studio = _exe(clean_env["home"] / "Library/Android/sdk/platform-tools/adb")
    folder = str(studio.parent)
    monkeypatch.setenv("PATH", os.pathsep.join(["/usr/bin", folder, "/bin"]))
    assert tools.use_adb() == str(studio)
    assert os.environ["PATH"].split(os.pathsep) == [folder, "/usr/bin", "/bin"]
    tools.use_adb()
    assert os.environ["PATH"].split(os.pathsep).count(folder) == 1


def test_use_adb_leaves_path_alone_when_missing(clean_env):
    before = os.environ["PATH"]
    assert tools.use_adb() is None
    assert os.environ["PATH"] == before


def test_emulator_lookup_uses_the_same_sdk_folders(clean_env, monkeypatch):
    from orcha_cli.qa.device import android_u2

    emu = _exe(clean_env["home"] / "Library/Android/sdk/emulator/emulator")
    assert android_u2.emulator_bin() == str(emu)
    other = _exe(clean_env["tmp"] / "sdk2" / "emulator" / "emulator")
    monkeypatch.setenv("ANDROID_SDK_ROOT", str(clean_env["tmp"] / "sdk2"))
    assert android_u2.emulator_bin() == str(other)


def test_adb_devices_runs_the_found_adb(clean_env, monkeypatch):
    from orcha_cli.qa.device import android_u2

    studio = _exe(clean_env["home"] / "Library/Android/sdk/platform-tools/adb")
    seen = []

    class Done:
        stdout = "List of devices attached\nemulator-5554\tdevice\n"

    monkeypatch.setattr(android_u2.subprocess, "run", lambda cmd, **kw: seen.append(cmd) or Done())
    assert android_u2.adb_devices() == [("emulator-5554", "device")]
    assert seen[0][0] == str(studio)


# ---------- idb_companion ----------


def test_idb_companion_bundled_copy_beats_path(clean_env):
    bundled = _exe(clean_env["runtime"] / "libexec" / "idb-companion" / "idb_companion")
    _exe(clean_env["pathbin"] / "idb_companion")
    assert tools.idb_companion_path() == str(bundled)


def test_idb_companion_override_beats_bundled(clean_env, monkeypatch):
    _exe(clean_env["runtime"] / "libexec" / "idb-companion" / "idb_companion")
    mine = _exe(clean_env["tmp"] / "mine" / "idb_companion")
    monkeypatch.setenv("ORCHA_IDB_COMPANION", str(mine))
    assert tools.idb_companion_path() == str(mine)
    monkeypatch.setenv("ORCHA_IDB_COMPANION", str(clean_env["tmp"] / "nope"))  # missing: ignored
    assert tools.idb_companion_path() is not None and "runtime" in tools.idb_companion_path()


def test_idb_companion_path_fallback_and_missing(clean_env, monkeypatch):
    on_path = _exe(clean_env["pathbin"] / "idb_companion")
    assert tools.idb_companion_path() == str(on_path)
    on_path.unlink()
    assert tools.idb_companion_path() is None
    assert "brew install facebook/fb/idb-companion" in tools.idb_companion_missing()
    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    assert tools.idb_companion_missing() == tools.IDB_MISSING_APP
    assert "Reinstall Embodent" in tools.idb_companion_missing()


def test_ios_session_start_refuses_with_the_missing_words(clean_env, monkeypatch):
    import asyncio

    from orcha_cli.qa.device import ios
    from orcha_cli.qa.device.base import SessionError

    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    session = ios.IosSession.__new__(ios.IosSession)
    with pytest.raises(SessionError, match="Reinstall Embodent"):
        asyncio.run(ios.IosSession.start(session, "com.example.app"))


def test_companion_starts_the_bundled_binary(clean_env, monkeypatch):
    import asyncio

    from orcha_cli.qa.device import ios_idb

    bundled = _exe(clean_env["runtime"] / "libexec" / "idb-companion" / "idb_companion")
    used = []

    async def once(self, binary, ready_timeout_s):
        used.append(binary)
        return False

    monkeypatch.setattr(ios_idb.IdbClient, "_init_companion_once", once)
    client = ios_idb.IdbClient.__new__(ios_idb.IdbClient)
    client.companion_process = None
    assert asyncio.run(client.init_companion(attempts=1)) is False
    assert used == [str(bundled)]


# ---------- doctor ----------


def test_doctor_names_the_found_tools_and_app_words(clean_env, monkeypatch):
    from orcha_cli.qa import cli as qa_cli

    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    bundled = _exe(clean_env["runtime"] / "libexec" / "idb-companion" / "idb_companion")
    monkeypatch.setattr(qa_cli, "_identity_and_portal", lambda: (_Ident(), _Portal()))
    monkeypatch.setattr(qa_cli, "chromium_status", lambda: {"ok": True, "detail": "chromium"})
    checks = qa_cli.doctor_report(clean_env["tmp"])
    assert checks["idb_companion"] == {"ok": True, "detail": str(bundled)}
    assert not checks["adb"]["ok"] and checks["adb"]["detail"].startswith("Embodent can't find adb")
    assert checks["adb devices"]["detail"].startswith("Embodent can't find adb")


def test_doctor_extra_advice_fits_the_install(monkeypatch):
    from orcha_cli.qa import cli as qa_cli

    monkeypatch.delenv("ORCHA_SIDECAR", raising=False)
    assert "uv tool install" in qa_cli._extra_fix()
    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    assert "uv" not in qa_cli._extra_fix() and "Embodent" in qa_cli._extra_fix()


class _Ident:
    api_base = ""
    container_id = ""
    ok = True
    problems: list[str] = []

    def describe(self):
        return "agent"


class _Portal:
    def ping(self):
        return False


# ---------- agents run the app's own orcha ----------


def test_agents_run_the_apps_orcha_inside_the_app(clean_env, monkeypatch):
    runtime_bin = clean_env["runtime"] / "bin"
    launcher = _exe(runtime_bin / "orcha")
    monkeypatch.setattr(sys, "executable", str(runtime_bin / "python3"))
    other = _exe(clean_env["pathbin"] / "orcha")
    assert launch.orcha_executable() == str(other)  # not the app: first on PATH, as before
    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    assert launch.orcha_executable() == str(launcher)
    assert launch.server_entry() == {"command": str(launcher), "args": ["qa", "mcp"]}


def test_inside_the_app_without_a_launcher_falls_back_to_path(clean_env, monkeypatch):
    monkeypatch.setattr(sys, "executable", str(clean_env["runtime"] / "bin" / "python3"))
    other = _exe(clean_env["pathbin"] / "orcha")
    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    assert launch.orcha_executable() == str(other)


# ---------- the device picker ----------


def test_simulators_are_not_usable_without_the_ios_client(clean_env, monkeypatch):
    import importlib.util

    from orcha_cli.qa.device import ios_idb, ios_phone, listing

    real = importlib.util.find_spec
    has_idb = {"value": True}
    monkeypatch.setattr(importlib.util, "find_spec", lambda name, *a: (object() if has_idb["value"] else None) if name == "idb" else real(name, *a))
    monkeypatch.setattr(ios_phone, "phones", lambda: [])
    monkeypatch.setattr(ios_idb, "all_simulators", lambda: [{"udid": "s1", "name": "iPhone 17 Pro", "runtime": "iOS 26.5", "state": "Booted"}])
    bundled = _exe(clean_env["runtime"] / "libexec" / "idb-companion" / "idb_companion")
    assert listing.ios_client_setup() is None
    assert "ready" not in listing.ios_inventory()[0]  # usable: the row is as before
    bundled.unlink()
    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    row = listing.ios_inventory()[0]
    assert row["ready"] is False and row["setup"] == {"code": "ios_client_missing", "title": "Can't drive simulators.", "fix": tools.IDB_MISSING_APP}
    has_idb["value"] = False
    assert "Update or reinstall Embodent" in listing.ios_inventory()[0]["setup"]["fix"]
