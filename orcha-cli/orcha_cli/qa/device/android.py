"""One live Android session over uiautomator2 + adb.

Adapted from `sessions/android.py`, uiautomator2 path only. the original's own on-device
accessibility agent (its APK, event-signal settle and drawing-order layers) is not ported: the
settle polls the hierarchy, and what covers a target is judged on the tree order. Also not
ported: physical-device setup, FLAG_SECURE and black-capture checks, logcat, video,
appearance, API stubs (adb reverse), launch extras, app data save/restore.

`android_to_raw` maps uiautomator's flattened hierarchy into idb-shaped node dicts (with an
`Application` node first naming the foreground package and the screen size), so the tree, its
text, targets and the settle are shared with iOS. Coordinates are device pixels.

The device is the named serial, else the first `adb devices` entry in state `device`; it is
claimed with `/tmp/claude-sim-lock-<serial>` (`locks.py`). Nothing here creates or wipes an AVD.
"""

from __future__ import annotations

import asyncio
import dataclasses
import io
import re
import sys
import time
from collections.abc import Awaitable, Callable
from typing import Any

from orcha_cli.qa.device import android_u2, locks
from orcha_cli.qa.device.base import DeviceBusy, SessionBase, SessionError, left, refusal
from orcha_cli.qa.device.screen import (
    EMPTY_TREE_RETRY_S,
    RENDER_POLL_S,
    Probe,
    Screen,
    needs_pixels,
    now,
    poll_sleep,
    settle,
    shape_of,
)
from orcha_cli.qa.device.targets import (
    Target,
    chosen,
    covering,
    off_screen,
    refind,
    resolve,
    tree_order_layers,
)
from orcha_cli.qa.device.tree import Element, parse_tree, screen_size, tree_hash

ADB_CALL_TIMEOUT_S = 30.0
# Live frames (`AndroidSession.start_live`): at most this many a second, each no larger than
# LIVE_LONG_SIDE on its long side, a capture abandoned after the timeout.
LIVE_FPS = 4
LIVE_LONG_SIDE = 1280
LIVE_CAPTURE_TIMEOUT_S = 5.0
#: Between retries of a screen read after the second failure in a row; the reader is restarted
#: after the last.
READ_RETRY_BACKOFF_S = (1.0, 2.0, 3.0, 5.0)
#: After a launch, how long the session waits for the app to come to the front before it takes a
#: helper app in front for a leftover task stack.
LAUNCH_FOCUS_WAIT_S = 1.5
#: After the session brought the app back to the front, how long it may take (a cold start).
APP_BACK_WAIT_S = 3.0
FOCUS_TAPS = 3
KEYEVENT = {"back": "KEYCODE_BACK", "home": "KEYCODE_HOME", "enter": "KEYCODE_ENTER", "recent": "KEYCODE_APP_SWITCH"}
#: Windows that may be in front of the app without the app having left (a permission dialog).
SYSTEM_PACKAGES = frozenset({"com.android.permissioncontroller", "com.google.android.permissioncontroller"})
SYSTEM_UI_PACKAGE = "com.android.systemui"
TEXT_TYPES = frozenset({"TextField", "SecureTextField", "TextView"})

# Android view-class simple name -> Element `type`; anything else falls back to the
# clickable/has-content heuristic in `_map_element`.
CLASS_TYPE_MAP = {
    "Button": "Button",
    "ImageView": "Image",
    "ImageButton": "Button",
    "CheckBox": "Switch",
    "Switch": "Switch",
    "RadioButton": "Radio",
    "EditText": "TextField",
    "TextView": "StaticText",
}
SKIP_CLASSES = frozenset({"RecyclerView", "ListView"})
WINDOW_SYSTEM = 3


def _simple_class(class_name: str) -> str:
    return class_name.rsplit(".", 1)[-1] if class_name else ""


def parse_bounds(bounds: str) -> tuple[int, int, int, int]:
    """`"[x1,y1][x2,y2]"` -> (x1, y1, x2, y2); malformed input yields zeros."""
    m = re.match(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", bounds or "")
    if not m:
        return (0, 0, 0, 0)
    x1, y1, x2, y2 = (int(g) for g in m.groups())
    return (x1, y1, x2, y2)


def _truthy(value: Any) -> bool:
    return value in (True, "true", "True", "1", 1)


def _map_element(e: dict) -> dict | None:
    cls = _simple_class(str(e.get("class") or ""))
    clickable = _truthy(e.get("clickable"))
    text = str(e.get("text") or "")
    desc = str(e.get("content-desc") or "")
    if cls in SKIP_CLASSES:
        return None
    node_type = CLASS_TYPE_MAP.get(cls)
    if node_type in ("TextField", None) and _truthy(e.get("password")):
        node_type = "SecureTextField"
    if node_type is None:
        if clickable:
            node_type = "Button"
        elif text or desc:
            node_type = "StaticText"
        else:
            return None  # a plain container with no signal
    x1, y1, x2, y2 = parse_bounds(str(e.get("bounds") or ""))
    label = desc or text
    value = text if node_type in ("TextField", "SecureTextField") else ""
    resource_id = str(e.get("resource-id") or "")
    identifier = resource_id.rsplit("/", 1)[-1] if "/" in resource_id else resource_id
    traits: list[str] = []
    if _truthy(e.get("focused")):
        traits.append("Focused")
    if _truthy(e.get("password")):
        traits.append("Secure")  # a custom or Compose password field: still masked
    if _truthy(e.get("selected")) or _truthy(e.get("checked")):
        traits.append("Selected")
    if e.get("package") == SYSTEM_UI_PACKAGE or str(e.get("window-type") or "") == str(WINDOW_SYSTEM):
        traits.append("System")
    return {
        "type": node_type,
        "AXLabel": label,
        "AXValue": value,
        "AXUniqueId": identifier,
        "frame": {"x": x1, "y": y1, "width": max(0, x2 - x1), "height": max(0, y2 - y1)},
        "enabled": _truthy(e.get("enabled", True)) or e.get("enabled") is None,
        "traits": traits,
    }


def android_to_raw(elements: list[dict], *, width: int = 0, height: int = 0, foreground_package: str | None = None) -> list[dict]:
    """Flattened uiautomator hierarchy entries -> idb-shaped dicts for `parse_tree`, after a
    pseudo `Application` node (label = the foreground package, frame = the screen)."""
    if width <= 0 or height <= 0:
        for e in elements:
            _, _, x2, y2 = parse_bounds(e.get("bounds", ""))
            width, height = max(width, x2), max(height, y2)
    pkg = foreground_package or (elements[0].get("package") if elements else None)
    out: list[dict] = [{
        "type": "Application",
        "AXLabel": str(pkg) if pkg else "unknown",
        "frame": {"x": 0, "y": 0, "width": width, "height": height},
        "enabled": True,
    }]
    for e in elements:
        node = _map_element(e)
        if node is not None:
            out.append(node)
    name_rows(out)
    return out


#: Texts a nameless clickable row borrows from inside it, at most.
ROW_NAME_TEXTS = 2


def _inside_frame(inner: dict, outer: dict) -> bool:
    a, b = inner["frame"], outer["frame"]
    return (b["x"] <= a["x"] and b["y"] <= a["y"] and a["x"] + a["width"] <= b["x"] + b["width"]
            and a["y"] + a["height"] <= b["y"] + b["height"] and a["width"] > 0 and a["height"] > 0)


def name_rows(nodes: list[dict]) -> None:
    """A clickable row with no text of its own (a `LinearLayout` holding a title and a summary)
    takes the texts inside it as its label, "Network & internet, Mobile, Wi-Fi, hotspot": the
    agent sees what the row is, and a tap by that text lands on the row. The hierarchy lists a
    row's children after it."""
    for i, node in enumerate(nodes):
        if node["type"] != "Button" or node["AXLabel"] or "System" in node["traits"]:
            continue
        texts: list[str] = []
        for other in nodes[i + 1:]:
            if other["type"] == "StaticText" and other["AXLabel"] and _inside_frame(other, node):
                texts.append(other["AXLabel"])
                if len(texts) == ROW_NAME_TEXTS:
                    break
        if texts:
            node["AXLabel"] = ", ".join(texts)


def foreground_package(elements: list[dict], focused: str | None) -> str:
    """`dumpsys window`'s focused package is authoritative (the status bar sorts first in the
    dump); the first node's package only when dumpsys said nothing."""
    if focused:
        return focused
    for e in elements:
        pkg = e.get("package")
        if pkg and pkg != SYSTEM_UI_PACKAGE:
            return str(pkg)
    return "unknown"


def android_name(package: str) -> str:
    """How the agent is told what an Android package in front is."""
    if package == SYSTEM_UI_PACKAGE:
        return "the system UI"
    low = package.lower()
    if "launcher" in low or low.endswith(".home"):
        return "the launcher"
    return package


def _live_jpeg(png: bytes) -> bytes:
    """A screencap PNG as the live frame's JPEG, scaled down to `LIVE_LONG_SIDE`."""
    from PIL import Image as PILImage

    img = PILImage.open(io.BytesIO(png)).convert("RGB")
    img.thumbnail((LIVE_LONG_SIDE, LIVE_LONG_SIDE))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    return buf.getvalue()


#: A window's header and its flags in `dumpsys window windows`.
_WINDOW_HEADER = re.compile(r"Window\{[0-9a-f]+ u\d+ ([^}\s]+)\}")
_WINDOW_FLAGS = re.compile(r"\bfl=(0x[0-9a-fA-F]+|[A-Z_][A-Z0-9_ ]*)")
#: FLAG_SECURE's bit, for builds that print the flags as hex (`fl=#81810100`).
FLAG_SECURE_BIT = 0x2000


def package_is_secure(dumpsys: str, package: str) -> bool:
    """Whether a window of `package` is FLAG_SECURE in a `dumpsys window windows` (pure)."""
    current: str | None = None
    for line in dumpsys.splitlines():
        header = _WINDOW_HEADER.search(line)
        if header and ("Window #" in line or line.lstrip().startswith("Window{")):
            current = header.group(1)
            continue
        if current is None or not (current == package or current.startswith(f"{package}/")):
            continue
        m = _WINDOW_FLAGS.search(line)
        if m is None:
            hexed = re.search(r"\bfl=#?([0-9a-fA-F]{6,8})\b", line)
            if hexed and int(hexed.group(1), 16) & FLAG_SECURE_BIT:
                return True
            continue
        value = m.group(1).strip()
        if int(value, 16) & FLAG_SECURE_BIT if value.startswith("0x") else "SECURE" in value.split():
            return True
    return False


class AndroidSession(SessionBase):
    """An Android emulator driven through uiautomator2 + adb. `AndroidSession(serial=...)` then
    `await s.start(package)`; see `base.SessionBase` for the actions."""

    platform = "android"

    def __init__(
        self,
        *,
        serial: str | None = None,
        device_name: str | None = None,
        ui_factory: Callable[[str], Any] | None = None,
        controller_factory: Callable[[str, Any], Any] | None = None,
        any_device: bool = False,
        **kw: Any,
    ) -> None:
        super().__init__(device_name=device_name, **kw)
        self._want_serial = serial
        #: A name is a preference: a second run takes another attached device.
        self.any_device = any_device
        self._ui_factory = ui_factory or android_u2.UiAutomatorClient
        self._controller_factory = controller_factory or (lambda s, ui: android_u2.AndroidController(serial=s, ui=ui))
        self.ui: Any = None
        self.controller: Any = None
        self._read_failures = 0
        self._degraded_reason = ""
        self._live: list[Element] | None = None
        #: The live frame loop while a session runs (`start_live`).
        self._live_task: Any = None

    @property
    def serial(self) -> str:
        return self.udid

    # ---------- lifecycle ----------

    async def start(self, app_id: str, launch: bool = True) -> Screen:
        serial = self._want_serial
        if not serial and self.device_name:
            # A named device: its serial ("emulator-5554") or its AVD name ("Pixel_9_Pro").
            serial = await asyncio.to_thread(android_u2.serial_named, self.device_name)
            if not serial and not self.any_device:
                serial = await self._boot_named()
            if not serial:
                attached = ", ".join(s for s, state in await asyncio.to_thread(android_u2.adb_devices) if state == "device") or "none"
                raise SessionError(f"no Android device named {self.device_name} is attached (attached: {attached}); the session never creates one.")
        serial = serial or await asyncio.to_thread(android_u2.first_device)
        if not serial and not (self._want_serial or self.device_name):
            # Default with nothing running: boot the first phone-sized emulator, as the picker says.
            first = await asyncio.to_thread(android_u2.default_avd)
            if first:
                self.device_name = first
                serial = await self._boot_named()
        if not serial:
            raise SessionError("no Android emulator found (`adb devices` lists none in state device). Boot an existing AVD; the session never creates one.")
        if self.claim_lock:
            candidates = [serial]
            if self.any_device or not (self._want_serial or self.device_name):
                ready = await asyncio.to_thread(android_u2.adb_devices)
                candidates += [s for s, state in ready if state == "device" and s != serial]
            for cand in candidates:
                self.lock = locks.claim(cand, is_booted=lambda c=cand: android_u2.is_connected(c))
                if self.lock is not None:
                    serial = cand
                    break
            if self.lock is None:
                held = ", ".join(f"{c} ({locks.lock_path(c)})" for c in candidates)
                raise DeviceBusy(f"{held} is in use by another agent. Wait for it, or name another device.", candidates)
        try:
            await self._attach(serial, app_id, launch)
        except BaseException:
            if self.lock is not None:
                self.lock.release()
                self.lock = None
            raise
        shot = await self._after_look(self.last_screen) if self.last_screen is not None else await self._capture(0)
        self._mark_seen(shot)
        return shot

    async def _boot_named(self) -> str | None:
        """Start the AVD a person picked, when it exists and is not running. The lock on its name
        keeps a second run from starting it too; the session claims the serial after."""
        if self.device_name not in await asyncio.to_thread(android_u2.avd_names):
            return None
        lock = locks.claim(self.device_name, is_booted=lambda: True) if self.claim_lock else None
        if self.claim_lock and lock is None:
            raise DeviceBusy(f"{self.device_name} is being started by another run.", [self.device_name])
        try:
            self._stage(f"Starting {self.device_name.replace('_', ' ')}, about a minute")
            serial = await asyncio.to_thread(android_u2.boot_avd, self.device_name)
        finally:
            if lock is not None:
                lock.release()
        if not serial:
            raise SessionError(f"{self.device_name} did not boot. Start it in Android Studio, then run again.")
        return serial

    async def _attach(self, serial: str, app_id: str, launch: bool) -> None:
        self.udid, self.app_id, self.app_name = serial, app_id, app_id
        self.started_at = time.time()
        if not self.device_name:
            self.device_name = await asyncio.to_thread(android_u2.avd_name, serial) or serial
        self._stage(f"Connecting to {self.device_name.replace('_', ' ')}")
        self.ui = self._ui_factory(serial)
        self.controller = self._controller_factory(serial, self.ui)
        installed = await self._shell(f"pm path {app_id}", "pm path")
        if "package:" not in installed:
            raise SessionError(f"{app_id} is not installed on {self.device_name} ({serial})")
        try:
            await self._adb(asyncio.to_thread(self.ui.connect), "uiautomator2 connect", timeout=60)
        except Exception as e:  # noqa: BLE001
            raise SessionError(f"uiautomator2 could not connect to {serial}: {type(e).__name__}: {e}") from e
        if launch:
            self._stage("Opening the app")
            # Home first: a helper app a previous session left in front would survive force-stop.
            await self._shell("input keyevent KEYCODE_HOME", "keyevent")
            await self._shell(f"am force-stop {app_id}", "force-stop")
            await self._shell(f"monkey -p {app_id} -c android.intent.category.LAUNCHER 1", "launch")
            focused = await self._wait_foreground(app_id, LAUNCH_FOCUS_WAIT_S)
            if focused != app_id and focused not in ("unknown", ""):
                # A helper package grabbed focus from a leftover task stack: stop it and relaunch.
                await self._shell(f"am force-stop {focused}", "force-stop")
                await self._shell(f"am force-stop {app_id}", "force-stop")
                await self._shell("input keyevent KEYCODE_HOME", "keyevent")
                await self._shell(f"monkey -p {app_id} -c android.intent.category.LAUNCHER 1", "launch")
                await self._wait_foreground(app_id, LAUNCH_FOCUS_WAIT_S)
        self._stage("Waiting for the app to show its first screen")
        await self._wait_until_rendered()

    async def _live_frame(self) -> bytes | None:
        """One live frame: `adb exec-out screencap -p` on its own adb process (never the
        session's uiautomator2 link, which the action being played may be using), as a JPEG
        no larger than `LIVE_LONG_SIDE`. None when the capture failed or timed out."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "adb", "-s", self.serial, "exec-out", "screencap", "-p",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
        except (OSError, ValueError):
            return None
        try:
            png, _ = await asyncio.wait_for(proc.communicate(), timeout=LIVE_CAPTURE_TIMEOUT_S)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return None
        if proc.returncode != 0 or not png.startswith(b"\x89PNG"):
            return None
        try:
            return await asyncio.to_thread(_live_jpeg, png)
        except Exception:  # noqa: BLE001 - a corrupt capture is skipped
            return None

    # ---------- what the session records about the device ----------

    async def app_version(self) -> str | None:
        """The installed app's version, `"1.4.0 (212)"` (`dumpsys package`), or None when unreadable."""
        try:
            out = await self._shell(f"dumpsys package {self.app_id}", "dumpsys package")
        except Exception:  # noqa: BLE001 - an unreachable device just means "unknown"
            return None
        name = re.search(r"versionName=(\S+)", out or "")
        code = re.search(r"versionCode=(\d+)", out or "")
        return (f"{name.group(1)} ({code.group(1)})" if name and code else name.group(1) if name else code.group(1) if code else None)

    async def appearance_setting(self) -> str | None:
        """`cmd uimode night` as `light` or `dark`; None when the device is unreachable or night
        mode is on an auto or custom schedule (what the screen shows then cannot be named)."""
        try:
            out = await self._shell("cmd uimode night", "uimode-night")
        except Exception:  # noqa: BLE001 - an unreachable device just means "unknown"
            return None
        word = (out or "").strip().split(":")[-1].strip().lower()
        return {"yes": "dark", "no": "light"}.get(word)

    async def secure_window(self) -> bool:
        """Whether the app under test has a FLAG_SECURE window on screen, which is why a frame of
        it comes back black. Only a blank frame asks (`dumpsys window`)."""
        try:
            dump = await self._shell("dumpsys window windows", "dumpsys window", timeout=10)
        except Exception:  # noqa: BLE001 - can't tell: say nothing rather than guess
            return False
        return package_is_secure(dump or "", self.app_id)

    async def start_live(self, writer: Any, first_frame_s: float = 8.0) -> bool:
        """Stream the device screen into `writer` (a `live_frames.LiveFrameWriter`): a
        screencap loop, one capture right after another (at most `LIVE_FPS` a second), so the
        page follows the device on its own (a splash that moves on, a screen still loading
        after a tap). Each frame carries the newest command that had run when its capture
        started, so a capture begun before a tap is never taken for the screen after it.
        False when no frame came within `first_frame_s`: the page then shows the frame of each
        step. A failing capture is retried, more slowly."""
        if self._live_task is not None:
            return True
        first = asyncio.Event()
        loop = asyncio.get_running_loop()

        async def pump() -> None:
            failures = 0
            while True:
                started = loop.time()
                seq = getattr(writer, "cmd_seq", None)
                frame = await self._live_frame()
                if frame:
                    writer.offer(frame, seq)
                    first.set()
                    failures = 0
                else:
                    failures += 1
                    if failures in (1, 10):
                        print("live frames: android screencap failed", file=sys.stderr)
                wait = 1.0 / LIVE_FPS - (loop.time() - started) if failures == 0 else min(5.0, 0.5 * failures)
                await asyncio.sleep(max(0.0, wait))

        self._live_task = asyncio.create_task(pump())
        try:
            await asyncio.wait_for(first.wait(), timeout=first_frame_s)
            return True
        except asyncio.TimeoutError:
            await self.stop_live()
            return False

    async def stop_live(self) -> None:
        task, self._live_task = self._live_task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown
            pass

    async def _teardown(self, terminate: bool) -> None:
        if self.controller is None:
            return
        if terminate and self.app_id:
            try:
                await self._shell(f"am force-stop {self.app_id}", "force-stop", timeout=10)
            except Exception:  # noqa: BLE001
                pass
        self.controller = None
        self.ui = None

    async def _adb(self, coro: Awaitable[Any], what: str, timeout: float = ADB_CALL_TIMEOUT_S) -> Any:
        """Await a device call with a timeout so a wedged adb/uiautomator2 link can't hang."""
        try:
            return await asyncio.wait_for(coro, timeout=timeout)
        except asyncio.TimeoutError:
            raise SessionError(f"android {what} timed out after {int(timeout)}s") from None

    async def _shell(self, cmd: str, what: str, timeout: float = ADB_CALL_TIMEOUT_S) -> str:
        if self.controller is None:
            raise SessionError("the session has ended; start a new one")
        out = await self._adb(asyncio.to_thread(self.controller.shell, cmd), what, timeout)
        return out if isinstance(out, str) else str(out)

    async def _foreground_now(self) -> str | None:
        return await asyncio.to_thread(android_u2.focused_package, self.udid)

    async def _wait_foreground(self, package: str, within: float) -> str:
        deadline = now() + within
        while True:
            focused = await self._foreground_now() or "unknown"
            if focused == package or now() >= deadline:
                return focused
            await poll_sleep(RENDER_POLL_S)

    # ---------- perception ----------

    async def _capture(self, settle_s: float = 0.0) -> Screen:
        """Screenshot + tree, retried for up to `settle_s` while the tree is empty. A read that
        fails once serves the last screen flagged degraded; the next one in a row retries with a
        backoff and a restart."""
        got = await self._read_or_degrade(lambda: self._read_screen(settle_s))
        if got is None:
            return self._degraded_screen()
        png, raw, elements, pkg = got
        w, h = screen_size(elements)
        if w > 0 and h > 0:
            self.width, self.height = w, h
        violation = self.lock_app and pkg not in SYSTEM_PACKAGES and pkg != self.app_id
        shot = Screen(
            png=png, raw=raw, elements=elements, tree_hash=tree_hash(elements), size=(self.width, self.height),
            foreground=pkg, foreground_name=self.app_name if pkg == self.app_id else android_name(pkg),
            locked_app_violation=violation,
            tree_available=True,
        )
        self.last_screen = shot
        return shot

    async def _read_screen(self, settle_s: float) -> tuple[bytes, list[dict], list[Element], str]:
        if self.ui is None:
            raise SessionError("the session has ended; start a new one")
        deadline = time.time() + settle_s
        while True:
            data, focus = await asyncio.gather(
                self._adb(self._screen_data(), "get_screen_data"),
                asyncio.to_thread(android_u2.focused_package, self.udid),
            )
            pkg = foreground_package(data.elements, focus)
            raw = android_to_raw(data.elements, width=data.width, height=data.height, foreground_package=pkg)
            elements = parse_tree(raw)
            if len(elements) > 1 or time.time() >= deadline:
                return data.png, raw, elements, pkg
            await poll_sleep(EMPTY_TREE_RETRY_S)

    async def _screen_data(self) -> Any:
        """`get_screen_data` with one retry: the on-device server sometimes drops a connection
        right after a fresh handshake."""
        try:
            return await asyncio.wait_for(asyncio.to_thread(self.ui.get_screen_data), timeout=ADB_CALL_TIMEOUT_S)
        except Exception:  # noqa: BLE001
            await asyncio.sleep(1.0)
            return await asyncio.wait_for(asyncio.to_thread(self.ui.get_screen_data), timeout=ADB_CALL_TIMEOUT_S)

    async def _read_or_degrade(self, read: Callable[[], Awaitable[Any]]) -> Any:
        """`read()`; the first failure in a row returns None (the caller serves the last screen,
        flagged degraded); the next retries after `READ_RETRY_BACKOFF_S` and then restarts
        uiautomator2 once. The failure that outlasts all of that is raised."""
        try:
            out = await read()
        except Exception as e:  # noqa: BLE001
            failed: BaseException = e
        else:
            self._read_failures = 0
            return out
        self._read_failures += 1
        if self._read_failures == 1 and self.last_screen is not None:
            self._degraded_reason = str(failed)
            return None
        for delay in READ_RETRY_BACKOFF_S:
            await asyncio.sleep(delay)
            try:
                out = await read()
            except Exception as e:  # noqa: BLE001
                failed = e
                continue
            self._read_failures = 0
            return out
        try:
            await asyncio.to_thread(self.ui.restart)
            out = await read()
        except Exception as e:  # noqa: BLE001
            failed = e
        else:
            self._read_failures = 0
            return out
        raise SessionError(f"android screen could not be read after {len(READ_RETRY_BACKOFF_S)} retries and a restart: {failed}")

    def _degraded_screen(self) -> Screen:
        last = self.last_screen
        assert last is not None
        note = (f"degraded: the screen could not be read just now ({self._degraded_reason}); this is the last screen "
                "read, look again before relying on it")
        self.last_screen = dataclasses.replace(last, degraded=True, extra=f"{note}\n\n{last.extra}" if last.extra else note, notes=[], settled=None)
        return self.last_screen

    async def _hierarchy(self) -> tuple[list[dict], int, int]:
        if self.ui is None:
            raise SessionError("the session has ended; start a new one")
        return await self._adb(asyncio.to_thread(self.ui.get_hierarchy), "dump_hierarchy")

    async def probe(self) -> Probe:
        """A settle poll: the hierarchy only; the frame only when the tree cannot describe the
        screen. A read that fails once is the last screen's tree."""

        async def read() -> Probe:
            nodes, width, height = await self._hierarchy()
            elements = parse_tree(android_to_raw(nodes, width=width, height=height))
            if needs_pixels(elements, True):
                data = await self._adb(self._screen_data(), "get_screen_data")
                return Probe(elements=elements, tree_available=True, png=data.png)
            return Probe(elements=elements, tree_available=True)

        got = await self._read_or_degrade(read)
        if got is None:
            last = self.last_screen
            assert last is not None
            return Probe(elements=last.elements, tree_available=last.tree_available, png=last.png)
        return got

    async def _live_elements(self) -> list[Element] | None:
        """The tree as it is now (hierarchy only); None when the device can't be read."""
        try:
            nodes, width, height = await self._hierarchy()
        except Exception:  # noqa: BLE001 - the screen the agent saw still gives a point
            return None
        return parse_tree(android_to_raw(nodes, width=width, height=height))

    # ---------- actions ----------

    async def _tap(self, target: Target, long_press_ms: int | None) -> str:
        kind = "long_press" if long_press_ms else "tap"
        shot = self.last_screen or await self._capture(0)
        elements = shot.elements
        point, how = resolve(target, elements)
        if point is None:
            return f"tap failed: {how}"
        live = await self._live_elements()
        seen = chosen(target, elements)
        if seen is not None and live:
            cur = refind(seen, live)
            if cur is not None and cur.center != point:
                point, how = cur.center, f"{how}, re-found on the live screen (was at {point})"
        away = off_screen(point, self.width, self.height, unit="px")
        if away:
            return f"error: {away}"
        over = self._covered(target, elements, live or elements, point)
        if over:
            return f"error: target is covered by {over}"
        gone = await self._app_left(kind)
        if gone:
            return f"error: {gone}"
        error = await self._send_tap(point, long_press_ms)
        if error:
            return f"tap failed: {error}"
        verb = f"long-pressed {long_press_ms}ms" if long_press_ms else "tapped"
        return f"{verb} at {point} via {how}"

    def _covered(self, target: Target, elements: list[Element], live: list[Element], point: tuple[int, int]) -> str | None:
        """What is drawn over the element `target` names (the tree order, only a layer over the
        whole element); None for explicit bounds and when nothing covers it."""
        if target.bounds:
            return None
        seen = chosen(target, elements)
        if seen is None:
            return None
        cur = refind(seen, live) or (seen if live is elements else None)
        if cur is None:
            return None
        layers = tree_order_layers(live)
        mine = next((layer for layer in layers if layer.index == cur.index), None)
        hit = covering(mine, layers, point, whole=True) if mine is not None else None
        return hit.name if hit else None

    async def _app_left(self, kind: str) -> str | None:
        """None when an input meant for the app may go; else what the agent is told: nothing was
        sent, and with `lock_app` the app was brought back the way a launch brings it."""
        front = await self._foreground_now()
        seen = self.seen_foreground or self.app_id
        if not front or not left(front, self.app_id, seen, SYSTEM_PACKAGES):
            return None
        stopped = await self._stopped()
        brought, still = None, None
        if self.lock_app:
            try:
                await self._shell(f"monkey -p {self.app_id} -c android.intent.category.LAUNCHER 1", "launch")
                now_front = await self._wait_foreground(self.app_id, APP_BACK_WAIT_S)
            except Exception:  # noqa: BLE001 - the agent is told it is not back
                now_front = "unknown"
            brought, still = now_front == self.app_id, android_name(now_front) if now_front != "unknown" else None
        line = refusal(self.app_name or self.app_id, android_name(front), kind, brought_back=brought, still=still, stopped=stopped)
        print(f"orcha qa: {line}", file=sys.stderr, flush=True)
        return line

    async def _stopped(self) -> bool:
        """Whether the app's process is gone (it crashed or the system closed it)."""
        try:
            out = await self._shell(f"pidof {self.app_id}", "pidof", timeout=5)
        except Exception:  # noqa: BLE001 - only the wording depends on it
            return False
        return not out.strip()

    async def _send_tap(self, point: tuple[int, int], long_press_ms: int | None = None) -> str | None:
        if self.controller is None:
            raise SessionError("the session has ended; start a new one")
        return await self._adb(asyncio.to_thread(self.controller.tap, point[0], point[1], long_press_ms), "tap")

    async def _swipe_points(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int) -> str:
        err = await self._adb(asyncio.to_thread(self.controller.swipe, x1, y1, x2, y2, duration_ms), "swipe")
        if err:
            return f"swipe failed: {err}"
        return f"swiped ({x1},{y1})->({x2},{y2}) in {duration_ms}ms"

    async def _press(self, key: str) -> str:
        if key not in KEYEVENT:
            return "error: key must be one of back, enter, home, recent"
        ok = await self._adb(asyncio.to_thread(self.controller.keyevent, KEYEVENT[key]), "keyevent")
        return f"pressed {key}" if ok else f"press failed: adb could not send {key}"

    async def _open_url(self, url: str) -> str:
        out = await self._adb(asyncio.to_thread(self.controller.open_url, url), "open_url")
        problem = android_u2.am_start_problem(out)
        return f"open_url failed: {url}: {problem}" if problem else f"opened {url}"

    async def _launch(self, app_id: str) -> str:
        await self._shell(f"monkey -p {app_id} -c android.intent.category.LAUNCHER 1", "launch")
        return f"launched {app_id}"

    async def _terminate(self, app_id: str) -> str:
        await self._shell(f"am force-stop {app_id}", "force-stop")
        return f"terminated {app_id}"

    # ---------- text ----------

    def _refind_field(self, target: Target, before: Element | None, elements: list[Element]) -> Element | None:
        if target.id:
            for e in elements:
                if e.identifier == target.id:
                    return e
        if before is not None:
            best, best_overlap = None, 0
            for e in elements:
                if e.type not in TEXT_TYPES:
                    continue
                ox = max(0, min(e.x2, before.x2) - max(e.x1, before.x1))
                oy = max(0, min(e.y2, before.y2) - max(e.y1, before.y1))
                if ox * oy > best_overlap:
                    best, best_overlap = e, ox * oy
            return best
        focused = next((e for e in elements if e.type in TEXT_TYPES and "Focused" in e.traits), None)
        return focused or next((e for e in elements if e.type in TEXT_TYPES), None)

    def _field_at(self, point: tuple[int, int], elements: list[Element]) -> Element | None:
        hits = [e for e in elements if e.x1 <= point[0] <= e.x2 and e.y1 <= point[1] <= e.y2 and e.type in TEXT_TYPES]
        return min(hits, key=lambda e: (e.x2 - e.x1) * (e.y2 - e.y1)) if hits else None

    async def _focus(self, target: Target, kind: str = "type") -> tuple[Element | None, str | None]:
        shot = self.last_screen or await self._capture(0)
        elements = shot.elements
        if not target.has_locator:
            return None, await self._app_left(kind)
        point, how = resolve(target, elements)
        if point is None:
            return None, how
        live = await self._live_elements() or elements
        seen = chosen(target, elements)
        cur = refind(seen, live) if seen is not None else None
        if cur is not None:
            point = cur.center
        elem = self._field_at(point, live)
        if elem is not None:
            point = elem.center
        away = off_screen(point, self.width, self.height, what="field", unit="px")
        if away:
            return None, away
        gone = await self._app_left(kind)
        if gone:
            return None, gone
        # A tap meant for a field is sometimes swallowed (an autocomplete popup, the keyboard
        # still animating in): tap again only when the tree shows focus on another element.
        for _ in range(FOCUS_TAPS):
            before = shape_of(self.last_screen) if self.last_screen else None
            await self._send_tap(point)
            await settle(self, after="focus", before_shape=before)
            if elem is None or self.last_screen is None or elem.type not in ("TextField", "SecureTextField"):
                break
            again = refind(elem, self.last_screen.elements)
            if again is None:
                break
            elem, point = again, again.center
            if "Focused" in again.traits or not any("Focused" in e.traits for e in self.last_screen.elements if e is not again):
                break
        return elem, None

    async def _type_text(self, target: Target, text: str) -> str:
        before_hash = self.last_screen.tree_hash if self.last_screen else None
        before, err = await self._focus(target)
        if err:
            return f"type failed: {err}"
        typed_on = shape_of(self.last_screen) if self.last_screen else None
        ok_sent = await self._adb(asyncio.to_thread(self.controller.input_text, text), "input_text")
        if ok_sent is False:
            return "type failed: neither uiautomator2 nor adb input could type it"
        await settle(self, after="type", before_shape=typed_on)
        after_screen = self.last_screen
        assert after_screen is not None
        after_screen.settled = self.last_settled
        elem = self._refind_field(target, before, after_screen.elements)
        if elem is not None and elem.type == "SecureTextField":
            return f"typed {text!r} into secure field; verified: unknown (masked)"
        value = elem.value if elem is not None else None
        if value is not None:
            ok = value.lower().endswith(text.lower())
            return f"typed {text!r}; verified: {str(ok).lower()}; field value now {value!r}"
        changed = before_hash is not None and after_screen.tree_hash != before_hash
        hint = "screen changed after typing, check the screenshot" if changed else "screen unchanged"
        return f"typed {text!r}; verified: unknown (field not readable; {hint})"

    async def _clear_text(self, target: Target) -> str:
        before, err = await self._focus(target, "clear")
        if err:
            return f"clear failed: {err}"
        typed_on = shape_of(self.last_screen) if self.last_screen else None
        n = len(before.value) if before and before.value else 50
        await self._shell("input keyevent KEYCODE_MOVE_END", "keyevent")
        # One shell call for all the deletes (each `input keyevent` is a process on the device).
        await self._shell("input keyevent " + " ".join(["KEYCODE_DEL"] * n), "keyevent", timeout=60)
        await settle(self, after="clear", before_shape=typed_on)
        after_screen = self.last_screen
        assert after_screen is not None
        after_screen.settled = self.last_settled
        after = self._refind_field(target, before, after_screen.elements)
        value = after.value if after else "?"
        cleared = after is not None and (
            after.value == "" or (before is not None and after.value != before.value and len(after.value) < len(before.value))
        )
        return f"sent {n} deletes; cleared: {str(cleared).lower()}; field value now {value!r}"
