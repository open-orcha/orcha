"""The devices of this Mac, read the way a session finds them. `available()`: what can take a run
this moment, booted iOS simulators (`ios_idb.booted_simulators`) and attached Android devices
(`android_u2.adb_devices`, state `device`). `inventory()`: everything the device picker offers, the
phones this Mac knows with what each needs, and the simulators and emulators that are stopped.
Reads only: it never boots, creates or claims a device. A tool that is missing or fails lists
nothing for its platform."""

from __future__ import annotations

import datetime as _dt
import json
import pathlib
import plistlib
import re
import subprocess
import threading
import time
from typing import Any, Optional

from . import android_u2, ios_idb, ios_phone, locks

COMMAND_TIMEOUT_S = 5.0
#: A phone's readiness takes two devicectl calls, and every open picker polls: it is read this
#: often, and a poll in between serves the last answer.
INVENTORY_TTL_S = 8.0
_ANDROID_VERSION = re.compile(r"versionName=(\S+)")
_ANDROID_CODE = re.compile(r"versionCode=(\d+)")
_ANDROID_UPDATED = re.compile(r"lastUpdateTime=([0-9-]+ [0-9:]+)")


def ios_devices() -> list[dict[str, Any]]:
    try:
        sims = ios_idb.booted_simulators()
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, json.JSONDecodeError):
        return []
    return [{"kind": "ios", "name": s.name, "udid": s.udid, "runtime": s.runtime, "state": "booted"} for s in sims]


def android_devices() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for serial, state in android_u2.adb_devices():
        if state != "device":
            continue
        row: dict[str, Any] = {"kind": "android", "name": android_u2.avd_name(serial) or serial, "serial": serial, "state": "device"}
        if not serial.startswith("emulator-"):
            row.update(physical=True, connection="network" if ":" in serial else "usb")
        out.append(row)
    return out


def available() -> list[dict[str, Any]]:
    """Every booted simulator and attached Android device on this machine; `held_by` says who has
    each one now (`locks.holder`), any project's run, or null."""
    return [{**d, "held_by": locks.holder(d["name"] if d["kind"] == "ios" else d["serial"])} for d in ios_devices() + android_devices()]


def ios_inventory() -> list[dict[str, Any]]:
    """The phones this Mac has paired, with what each needs, then every simulator."""
    rows: list[dict[str, Any]] = []
    for phone in ios_phone.phones():
        state = ios_phone.readiness(phone["udid"]) if phone["connection"] else ios_phone.not_connected(phone["udid"], phone["name"], phone["model"])
        rows.append({"kind": "ios", "physical": True, "udid": phone["udid"], "name": phone["name"], "model": phone["model"], "os": phone["os"],
                     "connection": phone["connection"], "ready": state.ready, "setup": ios_phone.setup_of(state)})
    try:
        sims = ios_idb.all_simulators()
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, json.JSONDecodeError):
        sims = []
    return rows + [{"kind": "ios", "name": s["name"], "udid": s["udid"], "runtime": s["runtime"], "state": s["state"].lower()} for s in sims]


_ANDROID_SETUP = {
    "unauthorized": {"code": "device_not_trusted", "title": "Not allowed yet.", "fix": "Unlock the phone and tap Allow on \"Allow USB debugging?\", then run again."},
    "offline": {"code": "device_disconnected", "title": "Phone offline.", "fix": "Unplug the phone, plug it in again and unlock it, then run again."},
}
_ANDROID_LOCKED = {"code": "device_locked", "title": "Phone is locked.", "fix": "Unlock the phone and keep it unlocked while the run goes, then run again."}


def android_inventory() -> list[dict[str, Any]]:
    """Attached Android phones with what each needs, running emulators, then the stopped AVDs."""
    rows: list[dict[str, Any]] = []
    running: set[str] = set()
    for serial, state in android_u2.adb_devices():
        if serial.startswith("emulator-"):
            if state == "device":
                name = android_u2.avd_name(serial) or serial
                running.add(name)
                rows.append({"kind": "android", "name": name, "serial": serial, "state": "running"})
            continue
        facts = android_u2.phone_facts(serial) if state == "device" else {"model": None, "os": None}
        setup = _ANDROID_SETUP.get(state) or (_ANDROID_LOCKED if android_u2.is_locked(serial) else None)
        rows.append({"kind": "android", "physical": True, "name": facts["model"] or serial, "serial": serial, "model": facts["model"], "os": facts["os"],
                     "connection": "network" if ":" in serial or "._adb-tls" in serial else "usb", "ready": setup is None, "setup": setup})
    return rows + [{"kind": "android", "name": n, "serial": None, "state": "stopped"} for n in android_u2.avd_names() if n not in running]


_inventory: dict[str, Any] = {"at": -INVENTORY_TTL_S, "rows": []}
_inventory_guard = threading.Lock()


def inventory() -> list[dict[str, Any]]:
    """Everything the device picker offers, each with `held_by`. Read at most every
    `INVENTORY_TTL_S` (one reader at a time; the others wait for it)."""
    with _inventory_guard:
        if time.monotonic() - _inventory["at"] >= INVENTORY_TTL_S:
            _inventory["rows"] = ios_inventory() + android_inventory()
            _inventory["at"] = time.monotonic()
        rows = list(_inventory["rows"])
    return [{**d, "held_by": locks.holder(d["name"] if d["kind"] == "ios" or not d.get("serial") else d["serial"])} for d in rows]


def _phone_installed(app_id: str, name: str) -> Optional[dict[str, Any]]:
    phone = ios_phone.find(name)
    app = ios_phone.installed_app(phone["udid"], app_id) if phone and phone["connection"] else None
    if app is None:
        return None
    return {"device": phone["name"], "version": app.get("version"), "build": app.get("bundleVersion"), "installed_at": None}


def _ios_installed(app_id: str, name: Optional[str]) -> Optional[dict[str, Any]]:
    device = next((d for d in ios_devices() if not name or d["name"] == name), None)
    if device is None and name:
        return _phone_installed(app_id, name)
    if device is None:
        return None
    got = subprocess.run(["xcrun", "simctl", "get_app_container", device["udid"], app_id, "app"], capture_output=True,
                         text=True, timeout=COMMAND_TIMEOUT_S, check=False)
    bundle = pathlib.Path(got.stdout.strip())
    if got.returncode != 0 or not (bundle / "Info.plist").is_file():
        return None
    with (bundle / "Info.plist").open("rb") as f:
        info = plistlib.load(f)
    at = _dt.datetime.fromtimestamp(bundle.stat().st_mtime, _dt.timezone.utc)
    return {"device": device["name"], "version": info.get("CFBundleShortVersionString"), "build": info.get("CFBundleVersion"),
            "installed_at": at.isoformat()}


def _android_installed(app_id: str, name: Optional[str]) -> Optional[dict[str, Any]]:
    device = next((d for d in android_devices() if not name or d["name"] == name), None)
    if device is None:
        return None
    got = subprocess.run(["adb", "-s", device["serial"], "shell", "dumpsys", "package", app_id], capture_output=True,
                         text=True, timeout=COMMAND_TIMEOUT_S, check=False)
    version = _ANDROID_VERSION.search(got.stdout or "")
    if got.returncode != 0 or version is None:
        return None
    code, updated = _ANDROID_CODE.search(got.stdout), _ANDROID_UPDATED.search(got.stdout)
    return {"device": device["name"], "version": version.group(1), "build": code.group(1) if code else None,
            "installed_at": updated.group(1).replace(" ", "T") if updated else None}


def installed_build(platform: str, app_id: str, device_name: Optional[str] = None) -> Optional[dict[str, Any]]:
    """The build of `app_id` a session would open: `{device, version, build, installed_at}`, or None
    when no device has it or it cannot be read. Reads only; it never boots or installs anything."""
    try:
        if platform == "ios":
            return _ios_installed(app_id, device_name)
        if platform == "android":
            return _android_installed(app_id, device_name)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, json.JSONDecodeError, plistlib.InvalidFileException):
        return None
    return None
