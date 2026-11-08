"""A physical iPhone or iPad known to this Mac, through `xcrun devicectl`.

Simulators go through `simctl` and idb, which cannot reach a real device. What Orcha asks of a
phone outside the UI session lives here, adapted from `devices/ios_device.py`:

- `phones()`: every iPhone and iPad this Mac has paired, connected or not.
- `readiness(udid)`: whether a run can start and, if not, the one thing a person must do (connect
  it, trust this Mac, turn on Developer Mode, unlock it). Not ready is never a failed run.
- `installed_app(udid, bundle)`: whether the app under test is on the phone.

It only reads. It may be someone's personal phone: nothing here changes a setting, and it never
touches an app other than the one under test. All of it takes an injectable `run` for the tests.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

#: `00008150-00167C982240401C` (A12 and later) or 40 hex digits (older). A simulator's is a UUID.
_PHYSICAL_UDID = re.compile(r"^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$")
CALL_TIMEOUT_S = 30.0
LIST_TIMEOUT_S = 8.0

Runner = Callable[..., subprocess.CompletedProcess[str]]


def _run(cmd: list[str], timeout: float = CALL_TIMEOUT_S, **kwargs: Any) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False, **kwargs)


def is_physical_udid(udid: Optional[str]) -> bool:
    return bool(udid) and bool(_PHYSICAL_UDID.match(str(udid)))


def _error_text(data: Any, text: str, code: int) -> str:
    err = (data or {}).get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        desc = (err.get("userInfo") or {}).get("NSLocalizedDescription") or {}
        msg = desc.get("string") if isinstance(desc, dict) else desc
        if msg:
            return str(msg)[:300]
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("ERROR: ")] or text.splitlines()
    return (lines[0] if lines else f"exit {code}")[:300]


def devicectl(args: list[str], *, run: Optional[Runner] = None, timeout: float = CALL_TIMEOUT_S) -> tuple[Optional[dict[str, Any]], str]:
    """`xcrun devicectl <args> -j <file>`: `(result, error)`. `result` is devicectl's JSON `result`
    object (None on a failure, and `error` says why in devicectl's own words)."""
    fd, out = tempfile.mkstemp(prefix="orcha-devicectl-", suffix=".json")
    os.close(fd)
    try:
        try:
            proc = (run or _run)(["xcrun", "devicectl", *args, "-j", out], timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, f"devicectl {args[0] if args else ''} timed out after {int(timeout)}s"
        except OSError as e:
            return None, f"devicectl could not run: {e}"
        try:
            data = json.loads(Path(out).read_text() or "{}")
        except (OSError, ValueError):
            data = {}
        info = data.get("info") if isinstance(data, dict) else None
        if proc.returncode == 0 and (not isinstance(info, dict) or info.get("outcome") in (None, "success")):
            result = data.get("result") if isinstance(data, dict) else None
            return (result if isinstance(result, dict) else {}), ""
        return None, _error_text(data, (proc.stderr or proc.stdout or "").strip(), proc.returncode)
    finally:
        Path(out).unlink(missing_ok=True)


def word_for(model: str) -> str:
    return "iPad" if model.lower().startswith("ipad") else "iPhone"


def _connection_of(conn: dict[str, Any]) -> Optional[str]:
    """`usb`, `network`, or None when the phone is not here now."""
    if conn.get("tunnelState") != "connected":
        return None
    return "usb" if conn.get("transportType") == "wired" else "network"


def _phone(raw: dict[str, Any]) -> Optional[dict[str, Any]]:
    """One entry of `devicectl list devices`, or None for what is no phone: a watch, a simulator."""
    hw, dev = raw.get("hardwareProperties") or {}, raw.get("deviceProperties") or {}
    if hw.get("reality") != "physical" or hw.get("platform") != "iOS" or hw.get("deviceType") not in ("iPhone", "iPad"):
        return None
    udid = str(hw.get("udid") or "")
    if not is_physical_udid(udid):
        return None
    conn = raw.get("connectionProperties") or {}
    model = str(hw.get("marketingName") or hw.get("productType") or "")
    return {"udid": udid, "name": str(dev.get("name") or model or udid).strip(), "model": model,
            "os": f"iOS {dev['osVersionNumber']}" if dev.get("osVersionNumber") else None, "connection": _connection_of(conn),
            "paired": conn.get("pairingState") in (None, "paired")}


def phones(*, run: Optional[Runner] = None) -> list[dict[str, Any]]:
    """Every iPhone and iPad paired with this Mac: `{udid, name, model, os, connection, paired}`,
    `connection` None when it is not connected now. Empty when devicectl cannot answer."""
    result, _ = devicectl(["list", "devices"], run=run, timeout=LIST_TIMEOUT_S)
    return [p for p in (_phone(d) for d in (result or {}).get("devices") or []) if p]


def find(wanted: str, *, run: Optional[Runner] = None) -> Optional[dict[str, Any]]:
    """The phone with this UDID or name, or None. A simulator's name never matches."""
    want = (wanted or "").strip()
    return next((p for p in phones(run=run) if want and want in (p["udid"], p["name"])), None) if want else None


@dataclass
class Readiness:
    """Whether a run can start on the phone. `problem` and `fix` are None when it can."""

    udid: str
    name: str = ""
    model: str = ""
    code: Optional[str] = None
    problem: Optional[str] = None
    fix: Optional[str] = None

    @property
    def ready(self) -> bool:
        return self.problem is None


#: What each `code` is called on the device row, the link in front of its fix.
TITLES = {"device_disconnected": "{word} not connected.", "device_not_trusted": "Not trusted.", "developer_mode_off": "Developer Mode is off.",
          "device_locked": "{word} is locked.", "tools_missing": "Phone tools not installed."}


def setup_of(r: Readiness) -> Optional[dict[str, str]]:
    """What the device row shows under a phone that cannot run yet: a short title, then the fix."""
    if r.ready:
        return None
    return {"code": r.code or "", "title": TITLES.get(r.code or "", "Needs setup.").format(word=word_for(r.model)), "fix": r.fix or r.problem or ""}


def not_connected(udid: str, name: str = "", model: str = "") -> Readiness:
    word = word_for(model)
    return Readiness(udid, name=name, model=model, code="device_disconnected", problem=f"{name or udid} is not connected to this Mac",
                     fix=f"Connect the {word} to this Mac by cable, or put it on the same Wi-Fi with its screen on, then run again.")


def readiness(udid: str, *, run: Optional[Runner] = None) -> Readiness:
    """The phone's state from `devicectl device info details` and `lockState`, with the one fix in
    plain words when a run cannot start. Never raises."""
    result, _ = devicectl(["device", "info", "details", "--device", udid], run=run)
    if result is None:
        return not_connected(udid)
    dev, hw, conn = result.get("deviceProperties") or {}, result.get("hardwareProperties") or {}, result.get("connectionProperties") or {}
    model = str(hw.get("marketingName") or hw.get("productType") or "")
    word = word_for(model)
    r = Readiness(udid, name=str(dev.get("name") or model or udid).strip(), model=model)
    if conn.get("pairingState") not in (None, "paired"):
        r.code, r.problem = "device_not_trusted", f"this Mac is not trusted by {r.name}"
        r.fix = f"Unlock the {word}, tap Trust when it asks \"Trust This Computer?\", enter its passcode, then run again."
    elif conn.get("tunnelState") not in (None, "connected") and not dev.get("ddiServicesAvailable"):
        r.code, r.problem = "device_disconnected", f"{r.name} is paired but not connected"
        r.fix = f"Unlock the {word} and keep it connected to this Mac by cable or on the same Wi-Fi, then run again."
    elif str(dev.get("developerModeStatus") or "enabled") != "enabled":
        r.code, r.problem = "developer_mode_off", f"Developer Mode is off on {r.name}"
        r.fix = f"On the {word}, open Settings > Privacy & Security > Developer Mode, turn it on and restart the {word} when it asks, then run again."
    else:
        lock, _ = devicectl(["device", "info", "lockState", "--device", udid], run=run)
        if lock is not None and lock.get("passcodeRequired"):
            r.code, r.problem = "device_locked", f"{r.name} is locked"
            r.fix = f"Unlock the {word} and keep it unlocked while the run goes, then run again."
    return r


def installed_app(udid: str, bundle_id: str, *, run: Optional[Runner] = None) -> Optional[dict[str, Any]]:
    """The installed app's entry (`bundleVersion`, `version`, ...), or None."""
    result, _ = devicectl(["device", "info", "apps", "--device", udid, "--bundle-id", bundle_id], run=run)
    return next((a for a in (result or {}).get("apps") or [] if a.get("bundleIdentifier") == bundle_id), None)
