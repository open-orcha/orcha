"""The Quality tab's readiness list and Download now (`qa_setup_routes`, `orcha_cli.qa.readiness`):
one row per platform with plain words, simulators/adb/browser states, the app-install gate on
"Turn on QA tools", and the browser download route (a person only)."""

from __future__ import annotations

import pytest

from orcha_cli.qa import browser_setup, readiness
from orcha_cli.qa import cli as qa_cli
from orcha_cli.qa.device import tools
from portal_backend import qa_setup_routes


@pytest.fixture
async def team(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("Bot")
    return human["agent_id"], bot["agent_id"]


ALL = {"mcp": True, "idb": True, "uiautomator2": True, "adbutils": True, "PIL": True, "playwright": True}


@pytest.fixture
def mac(monkeypatch):
    """A Mac with every tool, faked: tests switch one thing off at a time."""
    state = {"mods": dict(ALL), "idb": "/app/idb_companion", "xcrun": True, "sims": [{"name": "iPhone 17 Pro", "udid": "U", "runtime": "iOS-26"}],
             "adb": "/sdk/platform-tools/adb", "devs": [{"serial": "emulator-5554", "state": "device"}], "avds": ["Pixel_9"],
             "browser": {"installed": True, "state": "ready", "percent": 100, "size": None, "error": None, "message": None}}
    monkeypatch.delenv("ORCHA_SIDECAR", raising=False)
    monkeypatch.setattr(qa_cli, "_extra_status", lambda: [{"module": m, "package": m, "installed": ok, "version": None} for m, ok in state["mods"].items()])
    monkeypatch.setattr(tools, "idb_companion_path", lambda: state["idb"])
    monkeypatch.setattr(readiness.shutil, "which", lambda name: "/usr/bin/xcrun" if name == "xcrun" and state["xcrun"] else None)
    monkeypatch.setattr(qa_cli, "booted_simulators", lambda: (state["sims"], "simctl failed" if state["sims"] is None else ""))
    monkeypatch.setattr(tools, "adb_path", lambda: state["adb"])
    monkeypatch.setattr(qa_cli, "adb_devices", lambda: (state["devs"], ""))
    from orcha_cli.qa.device import android_u2

    monkeypatch.setattr(android_u2, "avd_names", lambda: state["avds"])
    monkeypatch.setattr(browser_setup, "status", lambda: state["browser"])
    monkeypatch.setattr(qa_setup_routes, "_readiness", {"at": -1e9, "rows": []})
    return state


def _by(rows):
    return {r["platform"]: r for r in rows}


def test_everything_ready(mac):
    rows = _by(readiness.platforms())
    assert [r for r in ("ios", "android", "web") if rows[r]["ready"]] == ["ios", "android", "web"]
    assert rows["ios"]["words"] == "Ready: iPhone 17 Pro running."
    assert rows["android"]["words"] == "Ready: emulator-5554 attached."


def test_ios_rows_say_what_is_missing(mac, monkeypatch):
    mac["sims"] = []
    assert readiness.ios() == {"platform": "ios", "ready": True, "words": "Ready. No simulator is running: one starts when a run starts.",
                               "link": None, "browser": None}
    mac["xcrun"] = False
    assert readiness.ios()["words"] == readiness.XCODE_WORDS and not readiness.ios()["ready"]
    mac["idb"] = None
    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    assert readiness.ios()["words"] == tools.IDB_MISSING_APP
    mac["mods"]["idb"] = False
    assert readiness.ios()["words"] == "The iPhone simulator test tools are missing from this install. Update or reinstall Embodent."


def test_android_rows_point_at_android_studio(mac, monkeypatch):
    mac["devs"] = []
    assert readiness.android()["ready"] and "one starts when a run starts" in readiness.android()["words"]
    mac["avds"] = []
    assert readiness.android() == {"platform": "android", "ready": False, "words": readiness.NO_AVD_WORDS, "link": None, "browser": None}
    mac["adb"] = None
    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    row = readiness.android()
    assert not row["ready"] and row["words"].startswith("Embodent can't find adb") and row["link"] == tools.PLATFORM_TOOLS_URL


def test_web_rows_follow_the_browser_download(mac):
    for state, words in (("missing", "downloads the first time you test a website"), ("downloading", "40% done"),
                         ("failed", "No internet connection.")):
        mac["browser"] = {"installed": False, "state": state, "percent": 40 if state == "downloading" else None, "size": None,
                          "error": "No internet connection." if state == "failed" else None, "message": None}
        row = readiness.web()
        assert not row["ready"] and words in row["words"] and row["browser"]["state"] == state
    mac["mods"]["playwright"] = False
    assert "website test tools are missing" in readiness.web()["words"]


def test_a_broken_check_never_hides_the_others(mac, monkeypatch):
    monkeypatch.setattr(readiness, "android", lambda: 1 / 0)
    rows = _by(readiness.platforms())
    assert rows["ios"]["ready"] and rows["web"]["ready"]
    assert not rows["android"]["ready"] and rows["android"]["words"].startswith("Embodent couldn't check this")


async def test_readiness_route(client, container, team, mac):
    cid = container["id"]
    mac["browser"] = {"installed": False, "state": "downloading", "percent": 10, "size": "92 MiB", "error": None, "message": "x"}
    got = (await client.get(f"/api/containers/{cid}/qa/setup/readiness")).json()
    assert got["available"] is True and [p["platform"] for p in got["platforms"]] == ["ios", "android", "web"]
    web = _by(got["platforms"])["web"]
    assert web["browser"]["state"] == "downloading" and web["browser"]["percent"] == 10
    mac["browser"] = {**mac["browser"], "percent": 60}  # progress is read fresh, the device rows from the cache
    mac["sims"] = []
    got = _by((await client.get(f"/api/containers/{cid}/qa/setup/readiness")).json()["platforms"])
    assert got["web"]["browser"]["percent"] == 60 and got["ios"]["words"] == "Ready: iPhone 17 Pro running."


async def test_readiness_route_without_the_package(client, container, team, monkeypatch):
    monkeypatch.setattr(qa_setup_routes, "_qa_module", lambda name: None)
    got = (await client.get(f"/api/containers/{container['id']}/qa/setup/readiness")).json()
    assert got == {"available": False, "reason": qa_setup_routes.NO_PACKAGE, "platforms": []}


async def test_download_now_is_for_a_person(client, container, team, monkeypatch):
    cid, (human, bot) = container["id"], team
    started = []
    monkeypatch.setattr(browser_setup, "start", lambda: started.append(1) or {"installed": False, "state": "downloading", "percent": 0})
    assert (await client.post(f"/api/containers/{cid}/qa/setup/browser", json={"actor_agent_id": bot})).status_code == 403
    assert started == []
    r = await client.post(f"/api/containers/{cid}/qa/setup/browser", json={"actor_agent_id": human})
    assert r.status_code == 200 and r.json()["state"] == "downloading" and started == [1]


async def test_turn_on_is_refused_in_the_app_without_the_libraries(client, container, team, tmp_path, monkeypatch, mac):
    cid = container["id"]
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    mac["mods"]["mcp"] = False
    got = (await client.get(f"/api/containers/{cid}/qa/tools")).json()
    assert got["can_enable"] is True  # a source install: the doctor names what is missing
    monkeypatch.setenv("ORCHA_SIDECAR", "1")
    got = (await client.get(f"/api/containers/{cid}/qa/tools")).json()
    assert got == {"tools_on": False, "can_enable": False, "reason": qa_setup_routes.NO_LIBRARIES.format(missing="mcp")}
