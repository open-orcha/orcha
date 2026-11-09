"""Fresh app state before a mobile scenario (`qa_scenarios.fresh`): a scenario about first launch
cannot pass on a device that already holds a profile from an earlier run, so a check clears the
app's data first by default (`start_scenario`).

- iOS simulator: the app's data container and its app group containers are emptied; the app stays
  installed. After clearing the containers are checked, and if something survives the app is
  reinstalled from its own installed bundle.
- Android: `adb shell pm clear <package>`.

Not reset: a scenario marked keep (`fresh` false) and one that restores a named session (it needs
the signed-in state its setup scenario left). A wanted reset that does not happen is said to the
agent, who reports the scenario blocked rather than judging it on a dirty app.
"""

from __future__ import annotations

import json
import plistlib
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .device.ios_phone import is_physical_udid

RESET_TIMEOUT_S = 30.0
INSTALL_TIMEOUT_S = 120.0
NO = frozenset({"no", "false", "0", "off", "keep"})
#: The container manager's record of what a container is; deleting it detaches the folder.
CONTAINER_METADATA = ".com.apple.mobile_container_manager.metadata.plist"
IOS_DATA_DIRS = ("Documents", "Library", "tmp", "SystemData")

Runner = Callable[[list[str]], tuple[int, str]]


def _run(cmd: list[str]) -> tuple[int, str]:
    timeout = INSTALL_TIMEOUT_S if cmd[:3] == ["xcrun", "simctl", "install"] else RESET_TIMEOUT_S
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, f"{type(e).__name__}: {e}"
    return proc.returncode, proc.stdout or ""


def _list(value: Any) -> list[Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    return list(value or []) if isinstance(value, list) else []


def _fresh_flag(scenario: dict[str, Any]) -> bool | None:
    """The scenario's own `Fresh:` choice: True, False, or None when it says nothing."""
    fresh = scenario.get("fresh")
    if isinstance(fresh, str):
        if fresh.strip().lower() in NO:
            return False
        return True if fresh.strip() else None
    if fresh is False or fresh == 0:
        return False
    if fresh is True or fresh == 1:
        return True
    return None


def _restores_session(scenario: dict[str, Any]) -> bool:
    """It starts from a named session a setup scenario saved, and is not that setup itself."""
    return bool(scenario.get("session")) and "setup" not in _list(scenario.get("tags"))


def wants_fresh(scenario: dict[str, Any]) -> bool:
    """Whether this scenario starts from cleared app data (mobile). `fresh` is the column (0/1/
    None) or a scenario file's `Fresh:` text. A dependency no longer opts out."""
    flag = _fresh_flag(scenario)
    if flag is not None:
        return flag
    return not _restores_session(scenario)


def rebuilds_dependencies(scenario: dict[str, Any]) -> bool:
    """A reset scenario that depends on others: the state those scenarios make has to be made
    again after the reset. `Fresh: no` keeps the device's state instead."""
    return bool(_list(scenario.get("depends_on"))) and wants_fresh(scenario)


def reset_for(scenarios: list[dict[str, Any]], target_kind: str | None) -> bool:
    """A request resets the app before qa-run when it is a mobile run and its first scenario
    wants a fresh start (a fan-out child has exactly one scenario)."""
    if target_kind not in ("ios", "android") or not scenarios:
        return False
    return wants_fresh(scenarios[0])



# ---------- iOS simulator ----------


@dataclass
class ResetResult:
    """What a reset did. `done`: the app's data is known to be clear. `needs_setup`: a reset was
    tried and the data may have survived; the scenario must not be judged on it."""

    done: bool
    line: str
    needs_setup: str | None = None
    verified: bool = False
    survivors: list[str] = field(default_factory=list)
    # A scenario that starts ready: the saved starting state was put
    # back after the reset (`restored`, in `took_s`), or could not be and the app starts fresh.
    restored: bool = False
    took_s: float | None = None
    restore_failed: str | None = None

    def __iter__(self):  # `done, line = reset_app(...)`, as before
        return iter((self.done, self.line))


def _clear_dir(path: Path) -> int | None:
    """Empty `path` (keep the directory itself and the container manager's metadata). Returns how
    many entries were removed, or None when `path` is not a directory."""
    if not path.is_dir():
        return None
    n = 0
    for child in path.iterdir():
        if child.name == CONTAINER_METADATA:
            continue
        try:
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
            n += 1
        except OSError:
            continue
    return n


def _left_in(path: Path) -> list[str]:
    """What the app wrote that is still in `path` (the metadata plist is not the app's)."""
    if not path.is_dir():
        return []
    return sorted(c.name for c in path.iterdir() if c.name != CONTAINER_METADATA)


def _parse_groups(out: str) -> list[tuple[str, str]]:
    """`simctl get_app_container … groups` output as `(group id, reported path)` pairs."""
    pairs = []
    for line in out.splitlines():
        parts = line.split("\t") if "\t" in line else line.split(None, 1)
        if len(parts) == 2 and parts[1].strip().startswith("/"):
            pairs.append((parts[0].strip(), parts[1].strip()))
    return pairs


def app_group_root(data_container: Path) -> Path | None:
    """`…/data/Containers/Shared/AppGroup` for a data container at
    `…/data/Containers/Data/Application/<uuid>`; None for any other layout."""
    parts = data_container.parts
    if len(parts) < 4 or parts[-3:-1] != ("Data", "Application"):
        return None
    return data_container.parent.parent.parent / "Shared" / "AppGroup"


def container_identifier(container: Path) -> str | None:
    """The identifier the container manager recorded for `container` (`group.com.x`), or None."""
    try:
        with (container / CONTAINER_METADATA).open("rb") as fh:
            meta = plistlib.load(fh)
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None
    value = meta.get("MCMMetadataIdentifier") if isinstance(meta, dict) else None
    return str(value) if value else None


def group_containers(data_container: Path, listed: list[tuple[str, str]]) -> dict[str, list[Path]]:
    """Each app group id simctl lists, with every folder that holds it: the reported path when it
    exists, and every container on this device whose metadata names the group (#229: simctl
    reported `FA690FAF…`, which did not exist; the store lived in `7FD25F6A…`)."""
    found: dict[str, list[Path]] = {gid: [] for gid, _ in listed}
    for gid, path in listed:
        p = Path(path)
        if p.is_dir():
            found[gid].append(p)
    root = app_group_root(data_container)
    if root is not None and root.is_dir() and found:
        for container in sorted(root.iterdir()):
            gid = container_identifier(container) if container.is_dir() else None
            if gid in found and container not in found[gid]:
                found[gid].append(container)
    return found


def _ios_containers(udid: str, bundle_id: str, run: Runner) -> tuple[Path | None, list[tuple[str, str]], str]:
    code, out = run(["xcrun", "simctl", "get_app_container", udid, bundle_id, "data"])
    if code != 0 or not out.strip():
        return None, [], out.strip()[:160] or f"exit {code}"
    data = Path(out.strip().splitlines()[-1].strip())
    code, out = run(["xcrun", "simctl", "get_app_container", udid, bundle_id, "groups"])
    return data, (_parse_groups(out) if code == 0 else []), ""


def _clear_ios(data: Path, listed: list[tuple[str, str]]) -> tuple[int, int, list[str], list[str]]:
    """Clear the data container and every group container. Returns (items removed, groups
    cleared, notes, what survived)."""
    removed, cleared, notes, survivors = 0, 0, [], []
    for sub in IOS_DATA_DIRS:
        removed += _clear_dir(data / sub) or 0
    for gid, folders in group_containers(data, listed).items():
        reported = dict(listed).get(gid, "")
        if reported and not Path(reported).is_dir():
            where = ", ".join(f.name[:8] + "…" for f in folders) or "nowhere on this simulator"
            notes.append(f"{gid}: simctl names a missing folder ({Path(reported).name[:8]}…); its data is in {where}")
        for folder in folders:
            n = _clear_dir(folder)
            if n is not None:
                removed += n
                cleared += 1
    for sub in ("Documents", "Library", "tmp"):
        survivors += [f"{sub}/{name}" for name in _left_in(data / sub)]
    for gid, folders in group_containers(data, listed).items():
        for folder in folders:
            survivors += [f"{gid}/{name}" for name in _left_in(folder)]
    return removed, cleared, notes, survivors


def _reinstall_ios(udid: str, bundle_id: str, run: Runner) -> str | None:
    """Uninstall the app and install the same bundle again (a copy of the installed one).
    Returns an error, or None."""
    code, out = run(["xcrun", "simctl", "get_app_container", udid, bundle_id, "app"])
    app = Path(out.strip().splitlines()[-1].strip()) if code == 0 and out.strip() else None
    if app is None or not app.is_dir():
        return f"no installed bundle to reinstall ({out.strip()[:120] or f'exit {code}'})"
    tmp = Path(tempfile.mkdtemp(prefix="orcha-reinstall-"))
    try:
        copy = tmp / app.name
        shutil.copytree(app, copy, symlinks=True)
        code, out = run(["xcrun", "simctl", "uninstall", udid, bundle_id])
        if code != 0:
            return f"uninstall failed ({out.strip()[:120] or f'exit {code}'})"
        code, out = run(["xcrun", "simctl", "install", udid, str(copy)])
        if code != 0:
            return f"install failed ({out.strip()[:120] or f'exit {code}'}); {bundle_id} is no longer installed"
        return None
    except OSError as e:
        return f"could not copy the installed bundle ({e})"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def reset_ios(udid: str, bundle_id: str, run: Runner = _run) -> ResetResult:
    """Terminate the app, empty its data and app group containers on the simulator, check that
    nothing survived, and reinstall the app when something did."""
    run(["xcrun", "simctl", "terminate", udid, bundle_id])
    data, listed, err = _ios_containers(udid, bundle_id, run)
    if data is None:
        msg = f"fresh: could not find {bundle_id}'s data on the simulator ({err}); app data NOT reset"
        return ResetResult(False, msg, needs_setup=msg)
    removed, cleared, notes, survivors = _clear_ios(data, listed)
    note = "".join(f"; {n}" for n in notes)
    extra = f" and {_plural(cleared, 'app group')}" if cleared else ""
    if not survivors:
        return ResetResult(
            True, f"fresh: cleared {bundle_id}'s app data{extra} ({_plural(removed, 'item')}){note}; verified empty; Fresh: no keeps it",
            verified=True,
        )
    error = _reinstall_ios(udid, bundle_id, run)
    if error is None:
        run(["xcrun", "simctl", "terminate", udid, bundle_id])
        data, listed, err = _ios_containers(udid, bundle_id, run)
        if data is not None:
            _, _, _, survivors = _clear_ios(data, listed)
            if not survivors:
                return ResetResult(
                    True, f"fresh: {bundle_id}'s data survived clearing, so the app was reinstalled{note}; verified empty; Fresh: no keeps it",
                    verified=True,
                )
        error = err or "data still there after reinstalling"
    shown = ", ".join(survivors[:4]) + (f" and {len(survivors) - 4} more" if len(survivors) > 4 else "")
    msg = f"fresh: app data NOT reset: {shown} survived ({error}){note}"
    return ResetResult(False, msg, needs_setup=msg, survivors=survivors)


def reset_android(serial: str, package: str, run: Runner = _run) -> ResetResult:
    code, out = run(["adb", "-s", serial, "shell", "pm", "clear", package])
    if code != 0 or "Success" not in out:
        msg = f"fresh: pm clear {package} failed ({out.strip()[:160] or f'exit {code}'}); app data NOT reset"
        return ResetResult(False, msg, needs_setup=msg)
    return ResetResult(True, f"fresh: cleared {package}'s app data (pm clear); Fresh: no keeps it", verified=True)


def reset_app(target_kind: str | None, device_id: str | None, app_id: str | None, run: Runner = _run) -> ResetResult:
    """Reset one app's data on one device. Never raises. No device to reset on is a reset that
    did not happen (`needs_setup`): a run on an emulator it booted used to skip it silently
    (its device never learned the serial) and judge a fresh-install scenario on old data."""
    if not device_id:
        msg = "fresh: no device serial or udid to reset the app on; app data NOT reset"
        return ResetResult(False, msg, needs_setup=msg)
    if not app_id:
        return ResetResult(False, "fresh: no app id to reset; the app keeps its data")
    # A target locator ("android:com.x", "ios:app.joi") names the app with its platform in front;
    # `pm clear` / simctl need the bare id, or the reset fails and data carries over between runs.
    if target_kind and app_id.startswith(f"{target_kind}:"):
        app_id = app_id.split(":", 1)[1]
    if "://" in app_id or app_id.startswith("/"):
        return ResetResult(False, f"fresh: {app_id} is not an installed app id; the app keeps its data")
    if target_kind == "ios" and is_physical_udid(device_id):
        msg = (f"fresh: a physical iPhone cannot clear {app_id}'s data, and Orcha never removes an app from a phone; app data NOT reset. "
               "Delete and reinstall the app on the phone, run on a simulator, or give the scenario Fresh: no")
        return ResetResult(False, msg, needs_setup=msg)
    try:
        if target_kind == "ios":
            return reset_ios(device_id, app_id, run)
        if target_kind == "android":
            return reset_android(device_id, app_id, run)
    except Exception as e:  # noqa: BLE001 - a crashed reset is a precondition not met, never a crashed run
        msg = f"fresh: reset failed ({type(e).__name__}: {e}); app data NOT reset"
        return ResetResult(False, msg, needs_setup=msg)
    return ResetResult(False, "")
