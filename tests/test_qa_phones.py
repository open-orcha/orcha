"""Physical phones and stopped devices: the inventory, readiness, the session and its wiring."""
from __future__ import annotations

import asyncio
import base64
import json
import pathlib
import subprocess
from types import SimpleNamespace

import pytest

from orcha_cli import notifier_protocol
from orcha_cli.qa import fresh_state
from orcha_cli.qa.device import android_u2, appium_local, ios_idb, ios_phone, listing
from orcha_cli.qa.device.base import SessionError
from orcha_cli.qa.device.ios_phone_session import IosPhoneSession, ios_raw, session_error
from orcha_cli.qa.device.webdriver import WebDriverError, meaningful_message, tap_actions

UDID = "00008150-00167C982240401C"


def phone_entry(name="My iPhone", udid=UDID, reality="physical", platform="iOS", kind="iPhone", tunnel="connected", transport="wired"):
    return {"hardwareProperties": {"reality": reality, "platform": platform, "deviceType": kind, "udid": udid, "marketingName": "iPhone 17 Pro Max"},
            "deviceProperties": {"name": name, "osVersionNumber": "26.6.1"},
            "connectionProperties": {"tunnelState": tunnel, "transportType": transport, "pairingState": "paired"}}


def devicectl_run(results):
    """A devicectl stand-in: writes the JSON for the sub-command to the `-j` file."""
    def run(cmd, timeout=0, **_):
        out = cmd[cmd.index("-j") + 1]
        key = " ".join(cmd[2:cmd.index("-j")])
        body = next((v for k, v in results.items() if key.startswith(k)), None)
        if body is None:
            return subprocess.CompletedProcess(cmd, 1, "", "ERROR: Unable to find device")
        pathlib.Path(out).write_text(json.dumps({"info": {"outcome": "success"}, "result": body}))
        return subprocess.CompletedProcess(cmd, 0, "", "")
    return run


# ---------- the phones this Mac knows ----------


def test_phones_keeps_iphones_and_ipads_only():
    run = devicectl_run({"list devices": {"devices": [
        phone_entry(), phone_entry(name="iPad", udid="00008027-000945C826E3002E", kind="iPad", tunnel="unavailable", transport=None),
        phone_entry(name="Watch", kind="appleWatch", platform="watchOS"), phone_entry(name="Sim", reality="simulated", udid="16D2179E-3CBA-443C-9D8E-4A72F8EDF8B7"),
    ]}})
    got = ios_phone.phones(run=run)
    assert [(p["name"], p["connection"]) for p in got] == [("My iPhone", "usb"), ("iPad", None)]
    assert got[0]["os"] == "iOS 26.6.1"


def test_physical_udids_are_told_from_simulators():
    assert ios_phone.is_physical_udid(UDID)
    assert ios_phone.is_physical_udid("a" * 40)
    assert not ios_phone.is_physical_udid("16D2179E-3CBA-443C-9D8E-4A72F8EDF8B7")
    assert not ios_phone.is_physical_udid(None)


@pytest.mark.parametrize("details,lock,code", [
    ({"connectionProperties": {"pairingState": "unpaired"}}, {}, "device_not_trusted"),
    ({"connectionProperties": {"tunnelState": "disconnected"}, "deviceProperties": {}}, {}, "device_disconnected"),
    ({"deviceProperties": {"developerModeStatus": "disabled"}}, {}, "developer_mode_off"),
    ({}, {"passcodeRequired": True}, "device_locked"),
    ({}, {"passcodeRequired": False}, None),
])
def test_readiness_names_the_one_thing_to_do(details, lock, code):
    r = ios_phone.readiness(UDID, run=devicectl_run({"device info details": details, "device info lockState": lock}))
    assert r.code == code
    assert r.ready is (code is None)
    if code:
        assert r.fix and ios_phone.setup_of(r)["fix"] == r.fix


def test_readiness_of_a_phone_that_does_not_answer():
    r = ios_phone.readiness(UDID, run=devicectl_run({}))
    assert r.code == "device_disconnected" and "cable" in r.fix


def test_inventory_lists_phones_stopped_devices_and_what_each_needs(monkeypatch):
    monkeypatch.setattr(listing, "_inventory", {"at": -999.0, "rows": []})
    monkeypatch.setattr(ios_phone, "phones", lambda: [{"udid": UDID, "name": "Away", "model": "iPhone 13", "os": "iOS 26.7", "connection": None, "paired": True}])
    monkeypatch.setattr(ios_idb, "all_simulators", lambda: [{"udid": "s1", "name": "iPhone 17 Pro", "runtime": "iOS 26.5", "state": "Booted"},
                                                            {"udid": "s2", "name": "iPad Pro", "runtime": "iOS 26.5", "state": "Shutdown"}])
    monkeypatch.setattr(android_u2, "adb_devices", lambda: [("emulator-5554", "device"), ("R58M", "device"), ("ABC", "unauthorized")])
    monkeypatch.setattr(android_u2, "avd_name", lambda s: "Pixel_9_Pro")
    monkeypatch.setattr(android_u2, "phone_facts", lambda s: {"model": "SM-S918B", "os": "Android 15"})
    monkeypatch.setattr(android_u2, "is_locked", lambda s: False)
    monkeypatch.setattr(android_u2, "avd_names", lambda: ["Pixel_9_Pro", "Pixel_9a"])
    monkeypatch.setattr(listing.locks, "holder", lambda name: None)
    rows = {d["name"]: d for d in listing.inventory()}
    assert rows["Away"]["ready"] is False and rows["Away"]["setup"]["code"] == "device_disconnected"
    assert rows["iPad Pro"]["state"] == "shutdown"
    assert rows["Pixel_9_Pro"]["state"] == "running"
    assert rows["Pixel_9a"] == {"kind": "android", "name": "Pixel_9a", "serial": None, "state": "stopped", "held_by": None}
    assert rows["SM-S918B"]["physical"] and rows["SM-S918B"]["ready"]
    assert rows["ABC"]["setup"]["code"] == "device_not_trusted"


def test_inventory_is_read_once_between_polls(monkeypatch):
    monkeypatch.setattr(listing, "_inventory", {"at": -999.0, "rows": []})
    calls = []
    monkeypatch.setattr(listing, "ios_inventory", lambda: calls.append(1) or [])
    monkeypatch.setattr(listing, "android_inventory", lambda: [])
    listing.inventory()
    listing.inventory()
    assert len(calls) == 1


def test_avd_names_leaves_out_a_tools_templates(monkeypatch):
    monkeypatch.setattr(android_u2, "emulator_bin", lambda: "/sdk/emulator")
    monkeypatch.setattr(android_u2.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout="Pixel_9a\nverdikt-tpl-phone\nVerdikt_Pilot\nINFO    | noise here\n"))
    assert android_u2.avd_names() == ["Pixel_9a"]


# ---------- page source ----------

SOURCE = """<?xml version="1.0"?>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Snug" label="Snug" x="0" y="0" width="440" height="956" visible="true" enabled="true">
  <XCUIElementTypeWindow type="XCUIElementTypeWindow" x="0" y="0" width="440" height="956" visible="true">
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="add" label="Add" x="10" y="20" width="44" height="44" visible="true" enabled="true"/>
    <XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" value="secret" x="10" y="80" width="200" height="44" visible="true" enabled="true"/>
    <XCUIElementTypeToggle type="XCUIElementTypeToggle" label="On" x="10" y="130" width="60" height="30" visible="true" selected="true"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Hidden" x="0" y="0" width="10" height="10" visible="false"/>
  </XCUIElementTypeWindow>
</XCUIElementTypeApplication>"""


def test_page_source_reads_as_a_simulator_tree():
    raw = ios_raw(SOURCE, foreground="com.x.snug")
    assert raw[0]["type"] == "Application" and raw[0]["frame"]["width"] == 440
    assert [r["type"] for r in raw[1:]] == ["Button", "SecureTextField", "Switch"]
    assert raw[1]["AXLabel"] == "Add" and raw[1]["AXUniqueId"] == "add"
    assert raw[2]["AXValue"] == ""
    assert raw[3]["traits"] == ["Selected"]


# ---------- the session ----------


class FakeDriver:
    def __init__(self, hub="", fail_first=False):
        self.calls, self.session_id, self.fail_first = [], None, fail_first

    async def new_session(self, caps):
        self.calls.append(("new", caps))
        if self.fail_first:
            raise WebDriverError("xcodebuild failed with code 65")
        self.session_id = "s"
        return "s"

    async def quit(self):
        self.calls.append(("quit",))

    async def window_rect(self):
        return {"width": 440, "height": 956}

    async def mobile(self, command, params=None):
        self.calls.append((command, params))
        return {"bundleId": "com.x.snug"} if command == "activeAppInfo" else None

    async def screenshot(self):
        return base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")

    async def page_source(self):
        return SOURCE

    async def actions(self, actions):
        self.calls.append(("actions", actions))

    async def poll_screenshot(self):
        return None


def session(monkeypatch, tmp_path, driver=None, ready=True, installed=True):
    monkeypatch.setenv(appium_local.TOOLS_ENV, str(tmp_path))
    monkeypatch.setattr(appium_local, "installed", lambda *a: True)
    monkeypatch.setattr(appium_local, "signing_team", lambda *a, **k: "ABCDE12345")
    monkeypatch.setattr(appium_local, "stop_wda", lambda *a, **k: 0)
    state = ios_phone.Readiness(UDID, name="My iPhone") if ready else ios_phone.Readiness(UDID, name="My iPhone", code="device_locked", problem="My iPhone is locked", fix="Unlock it.")
    monkeypatch.setattr(ios_phone, "readiness", lambda u: state)
    monkeypatch.setattr(ios_phone, "installed_app", lambda u, b: {"version": "1.0.1", "bundleVersion": "14"} if installed else None)
    server = SimpleNamespace(url="http://127.0.0.1:1", stop=lambda: None)
    driver = driver or FakeDriver()
    return IosPhoneSession(phone={"udid": UDID, "name": "My iPhone", "model": "iPhone 17 Pro Max"}, driver_factory=lambda hub: driver, server_factory=lambda: server, claim_lock=False), driver


def test_a_phone_session_opens_the_installed_app_and_ends_clean(monkeypatch, tmp_path):
    async def go():
        s, driver = session(monkeypatch, tmp_path)
        shot = await s.start("com.x.snug")
        assert shot.elements and s.width == 440
        assert await s.app_version() == "1.0.1 (14)"
        assert ("launchApp", {"bundleId": "com.x.snug"}) in driver.calls
        caps = driver.calls[0][1]
        assert caps["appium:udid"] == UDID and caps["appium:noReset"] is True and caps["appium:xcodeOrgId"] == "ABCDE12345"
        assert "appium:usePrebuiltWDA" not in caps
        assert appium_local.wda_derived(UDID, "com.x.snug").joinpath(appium_local.WDA_STATE_FILE).is_file()
        await s.end()
        assert ("quit",) in driver.calls and s.driver is None
    asyncio.run(go())


def test_a_tap_lands_on_the_element_in_points(monkeypatch, tmp_path):
    async def go():
        s, driver = session(monkeypatch, tmp_path)
        await s.start("com.x.snug")
        said = await s.tap("Add")
        assert "tapped at (32, 42)" in said
        assert [c for c in driver.calls if c[0] == "actions"][0][1] == tap_actions(32, 42)
        await s.end()
    asyncio.run(go())


def test_a_phone_that_is_not_ready_says_what_to_do(monkeypatch, tmp_path):
    async def go():
        s, driver = session(monkeypatch, tmp_path, ready=False)
        with pytest.raises(SessionError, match="Unlock it"):
            await s.start("com.x.snug")
        assert not driver.calls
    asyncio.run(go())


def test_an_app_not_on_the_phone_says_how_to_put_it_there(monkeypatch, tmp_path):
    async def go():
        s, driver = session(monkeypatch, tmp_path, installed=False)
        with pytest.raises(SessionError, match="devicectl device install app --device " + UDID):
            await s.start("com.x.snug")
        assert not driver.calls
    asyncio.run(go())


def test_a_signing_failure_is_said_with_the_fix():
    assert "Apple Development" in session_error("My iPhone", "xcodebuild failed with code 65")
    assert session_error("My iPhone", "device is locked").startswith("My iPhone is locked")


def test_webdriver_messages_lose_the_stack():
    assert meaningful_message("\n\nbad thing\nBuild info: x\nmore") == "bad thing"


# ---------- signing ----------


def test_wda_is_reused_only_for_the_same_team(tmp_path):
    env = {appium_local.TOOLS_ENV: str(tmp_path)}
    assert appium_local.wda_bundle_id("com.premium.snug", env) == "com.premium.orcha.WebDriverAgentRunner"
    derived = appium_local.wda_derived(UDID, "com.x.y", environ=env)
    (derived / "Build" / "Products").mkdir(parents=True)
    (derived / "Build" / "Products" / "a.xctestrun").write_text("x")
    appium_local.remember_wda(UDID, "com.x.y", "TEAM", environ=env)
    assert appium_local.wda_prebuilt(UDID, "com.x.y", "TEAM", environ=env)
    assert not appium_local.wda_prebuilt(UDID, "com.x.y", "OTHER", environ=env)
    appium_local.forget_wda(UDID, "com.x.y", environ=env)
    assert not appium_local.wda_prebuilt(UDID, "com.x.y", "TEAM", environ=env)


def test_the_team_comes_from_the_project(tmp_path):
    proj = tmp_path / "ios" / "Snug.xcodeproj"
    proj.mkdir(parents=True)
    (proj / "project.pbxproj").write_text('DEVELOPMENT_TEAM = H3J6T4Y8AC;\n')
    assert appium_local.repo_team(tmp_path) == "H3J6T4Y8AC"
    assert appium_local.signing_team({appium_local.TEAM_ENV: "ZZZZZZZZZZ"}, root=tmp_path) == "ZZZZZZZZZZ"


# ---------- what a phone cannot do ----------


def test_fresh_state_on_a_phone_is_never_claimed_and_never_removes_the_app():
    calls = []
    got = fresh_state.reset_app("ios", UDID, "com.x.snug", run=lambda cmd: calls.append(cmd) or (0, ""))
    assert got.needs_setup and "NOT reset" in got.needs_setup
    assert not calls


# ---------- a step's device reaches its worker ----------


def test_a_steps_device_is_told_to_the_worker():
    lines = notifier_protocol._qa_step_lines({"skill": "/orcha-qa-check", "platform": "ios", "device": "My iPhone"})
    assert any('device="My iPhone"' in line for line in lines)
    assert not any(line.startswith("Device") for line in notifier_protocol._qa_step_lines({"skill": "/orcha-qa-check"}))
