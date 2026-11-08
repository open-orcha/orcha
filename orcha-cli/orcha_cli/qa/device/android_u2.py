"""The Android device client: uiautomator2 for the screen and text input, adb shell for gestures,
keys and intents.

Adapted from `drivers/android_u2.py`. `UiAutomatorClient` keeps one uiautomator2
connection per serial (reconnecting when the on-device server drops) and returns a screenshot
plus the flattened view hierarchy (`get_screen_data`), or the hierarchy alone for a settle poll
(`get_hierarchy`). `AndroidController` sends taps, swipes, keys, text and intents. Every call
here is blocking: the session runs them with `asyncio.to_thread` and a timeout.

Text the XML dumper cannot hold (an emoji becomes "..") is read back through uiautomator2's
JSON-RPC, and marked `[emoji]` when that fails, so a node is never taken for one with no name.

uiautomator2/adbutils/PIL are imported inside the methods: this module imports without the extra.
"""

from __future__ import annotations

import io
import logging
import os
import re
import shlex
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_SHELL_SPECIAL = set('&<>|;()$`\\"\'')
ADB_TIMEOUT_S = 15.0
AVD_BOOT_TIMEOUT_S = 180.0


@dataclass
class ScreenData:
    png: bytes
    elements: list[dict[str, Any]]
    width: int
    height: int


def parse_hierarchy(hierarchy_xml: str) -> list[dict[str, Any]]:
    """Flatten a uiautomator `dump_hierarchy` XML into one dict per node, document order, keeping
    every attribute (`resource-id`, `text`, `content-desc`, `bounds` as `[x1,y1][x2,y2]`,
    `class`, `package`, `clickable`, ...)."""
    out: list[dict[str, Any]] = []
    try:
        root = ET.fromstring(hierarchy_xml)
    except ET.ParseError as e:
        log.error("hierarchy XML parse failed: %s", e)
        return out

    def walk(node: ET.Element) -> None:
        el: dict[str, Any] = dict(node.attrib)
        if el:
            out.append(el)
        for child in node:
            walk(child)

    walk(root)
    return out


#: uiautomator's XML dumper writes each half of an emoji's surrogate pair as ".".
_STRIPPED = ".."
#: A Java regex for a text holding a character outside the Basic Multilingual Plane.
_SUPPLEMENTARY = "(?s).*[^\\u0000-\\uFFFF].*"
UNREADABLE = "[emoji]"
_ONLY_DOTS = re.compile(r"^(?:\.\.)+$")


def _bounds_key(bounds: Any) -> str:
    if isinstance(bounds, dict):
        return f"[{bounds.get('left')},{bounds.get('top')}][{bounds.get('right')},{bounds.get('bottom')}]"
    return str(bounds or "")


def stripped_nodes(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in elements if _STRIPPED in str(e.get("text") or "") or _STRIPPED in str(e.get("content-desc") or "")]


def restore_stripped_text(elements: list[dict[str, Any]], infos: list[dict[str, Any]] | None) -> int:
    """Put back the text the dumper stripped, from `infos` (uiautomator2 `objInfo` dicts), matched
    by bounds. With `infos` None (the read failed) a text made only of stripped pairs becomes
    `UNREADABLE`. Returns how many nodes changed."""
    by_bounds: dict[str, dict[str, Any]] = {}
    for info in infos or []:
        by_bounds.setdefault(_bounds_key(info.get("bounds")), info)
    changed = 0
    for e in stripped_nodes(elements):
        info = by_bounds.get(_bounds_key(e.get("bounds")))
        for attr, key in (("text", "text"), ("content-desc", "contentDescription")):
            value = str(e.get(attr) or "")
            if _STRIPPED not in value:
                continue
            real = str((info or {}).get(key) or "")
            if real and len(real.encode("utf-16-le")) // 2 == len(value):
                e[attr] = real
            elif infos is None and _ONLY_DOTS.match(value):
                e[attr] = UNREADABLE
            else:
                continue
            changed += 1
    return changed


def _read_stripped(device: Any, elements: list[dict[str, Any]]) -> None:
    if not stripped_nodes(elements):
        return
    infos: list[dict[str, Any]] | None = []
    try:
        for field_name in ("textMatches", "descriptionMatches"):
            infos.extend(device.jsonrpc.objInfoOfAllInstances(device(**{field_name: _SUPPLEMENTARY}).selector) or [])
    except Exception as e:  # noqa: BLE001 - the dump still stands; mark what it lost instead
        log.info("could not read emoji text back from uiautomator2: %s", e)
        infos = None
    restore_stripped_text(elements, infos)


class UiAutomatorClient:
    def __init__(self, serial: str):
        self.serial = serial
        self._device: Any = None
        self._window_size: tuple[int, int] | None = None

    def connect(self) -> Any:
        if self._device is not None:
            try:
                _ = self._device.info  # liveness probe
                return self._device
            except Exception:  # noqa: BLE001 - reconnect below
                log.warning("uiautomator2 connection to %s lost; reconnecting", self.serial)
                self._device = None
        import uiautomator2 as u2

        self._device = u2.connect(self.serial)
        return self._device

    def get_screen_data(self) -> ScreenData:
        device = self.connect()
        shot = device.screenshot()
        if shot is None:
            raise RuntimeError("uiautomator2 returned no screenshot")
        xml = device.dump_hierarchy(compressed=True)
        elements = parse_hierarchy(xml)
        _read_stripped(device, elements)
        buf = io.BytesIO()
        shot.save(buf, format="PNG", compress_level=1)
        return ScreenData(png=buf.getvalue(), elements=elements, width=shot.width, height=shot.height)

    def get_hierarchy(self) -> tuple[list[dict[str, Any]], int, int]:
        """The hierarchy without a screenshot: `(elements, width, height)` (size cached)."""
        device = self.connect()
        xml = device.dump_hierarchy(compressed=True)
        if self._window_size is None:
            try:
                w, h = device.window_size()
                self._window_size = (int(w), int(h))
            except Exception:  # noqa: BLE001 - the nodes are measured instead
                self._window_size = (0, 0)
        elements = parse_hierarchy(xml)
        _read_stripped(device, elements)
        return elements, self._window_size[0], self._window_size[1]

    def send_text(self, text: str) -> None:
        """Append text through uiautomator2's input path and put back the keyboard that was
        selected before (never turning a successful insertion into a retry)."""
        if not text:
            return
        device = self.connect()
        previous = device.current_ime()
        if not previous or previous == "null":
            raise RuntimeError("Android input method is unavailable before text entry")
        try:
            device.send_keys(text)
        finally:
            try:
                if device.current_ime() != previous:
                    restored = device.shell(["ime", "set", previous])
                    if getattr(restored, "exit_code", 0) != 0:
                        log.warning("Android keyboard restoration did not succeed")
            except Exception as error:  # noqa: BLE001 - keep the insertion's original outcome
                log.warning("Android keyboard restoration failed (%s)", type(error).__name__)

    def restart(self) -> None:
        """Stop uiautomator2's on-device server and drop the link; the next read starts it again."""
        stop = getattr(self._device, "stop_uiautomator", None)
        if stop is not None:
            try:
                stop()
            except Exception:  # noqa: BLE001
                pass
        self._device = None


def adb(serial: str, *args: str, timeout: float = ADB_TIMEOUT_S) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["adb", "-s", serial, *args], capture_output=True, text=True, timeout=timeout)


def phone_facts(serial: str) -> dict[str, str | None]:
    """A phone's model and Android version, for the device list. Empty values when unread."""
    def prop(name: str) -> str:
        try:
            return adb(serial, "shell", "getprop", name, timeout=5).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""
    version = prop("ro.build.version.release")
    return {"model": prop("ro.product.model") or None, "os": f"Android {version}" if version else None}


def adb_devices() -> list[tuple[str, str]]:
    """`adb devices`: `(serial, state)` for each entry (empty when adb is missing)."""
    try:
        out = subprocess.run(["adb", "devices"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    rows = []
    for line in out.splitlines()[1:]:
        parts = line.strip().split("\t")
        if len(parts) == 2:
            rows.append((parts[0], parts[1]))
    return rows


def first_device() -> str | None:
    """The first `adb devices` entry in state `device`."""
    return next((s for s, state in adb_devices() if state == "device"), None)


def serial_named(name: str) -> str | None:
    """The attached device whose serial or AVD name is `name`."""
    ready = [s for s, state in adb_devices() if state == "device"]
    if name in ready:
        return name
    return next((s for s in ready if avd_name(s) == name), None)


def emulator_bin() -> str | None:
    """The Android SDK's `emulator`, or None."""
    for root in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"), str(Path.home() / "Library/Android/sdk")):
        if root and (Path(root) / "emulator" / "emulator").is_file():
            return str(Path(root) / "emulator" / "emulator")
    return shutil.which("emulator")


def avd_names() -> list[str]:
    """The AVDs on this Mac, running or not; a tool's own template is no device."""
    binary = emulator_bin()
    if not binary:
        return []
    try:
        out = subprocess.run([binary, "-list-avds"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [n.strip() for n in out.splitlines() if n.strip() and not n.lower().startswith("verdikt") and " " not in n.strip()]


def default_avd() -> str | None:
    """The emulator Default boots when none runs: the first phone-sized AVD, else the first."""
    names = avd_names()
    phones = [n for n in names if not any(w in n.lower() for w in ("tablet", "fold", "tv", "wear", "auto"))]
    return (phones or names or [None])[0]


def boot_avd(name: str, timeout: float = AVD_BOOT_TIMEOUT_S) -> str | None:
    """Start an existing AVD a person picked and wait until Android has booted: its serial, or None
    when it did not come up. Headless, the way this Mac's emulator runs (a Flutter app draws black
    there). It keeps running after the session, like one a person started. It never creates one."""
    binary = emulator_bin()
    if not binary or name not in avd_names():
        return None
    subprocess.Popen([binary, "-avd", name, "-no-window", "-no-audio", "-no-boot-anim"], stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        serial = serial_named(name)
        if serial and adb(serial, "shell", "getprop", "sys.boot_completed", timeout=5).stdout.strip() == "1":
            return serial
        time.sleep(2.0)
    return None


_KEYGUARD = re.compile(r"\b(isKeyguardShowing|mIsShowing|mShowingLockscreen|mDreamingLockscreen)=(true|false)\b")


def is_locked(serial: str) -> bool:
    """Whether the phone shows its lock screen. False when it cannot be told."""
    try:
        out = adb(serial, "shell", "dumpsys window | grep -E 'isKeyguardShowing|mIsShowing|mShowingLockscreen|mDreamingLockscreen'", timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return any(value == "true" for _, value in _KEYGUARD.findall(out or ""))


def is_connected(serial: str) -> bool:
    """Whether `serial` is attached and ready. True when adb cannot tell (a lock is never taken
    from a device that may be in use)."""
    rows = adb_devices()
    if not rows:
        try:
            subprocess.run(["adb", "version"], capture_output=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return True
    return any(s == serial and state == "device" for s, state in rows)


def avd_name(serial: str) -> str | None:
    """An emulator's AVD name (`Pixel_9_Pro`), else the device model; None when unknown."""
    for prop in ("ro.boot.qemu.avd_name", "ro.kernel.qemu.avd_name", "ro.product.model"):
        try:
            out = adb(serial, "shell", "getprop", prop, timeout=5).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
        if out:
            return out
    return None


@dataclass
class AndroidController:
    serial: str
    ui: UiAutomatorClient
    _device: Any = field(default=None, init=False, repr=False)

    @property
    def device(self) -> Any:
        if self._device is None:
            from adbutils import AdbClient

            self._device = AdbClient().device(serial=self.serial)
        return self._device

    def shell(self, cmd: str) -> str:
        out = self.device.shell(cmd)
        return out if isinstance(out, str) else str(out)

    def tap(self, x: int, y: int, long_press_ms: int | None = None) -> str | None:
        try:
            if long_press_ms:
                self.shell(f"input swipe {x} {y} {x} {y} {int(long_press_ms)}")
            else:
                self.shell(f"input tap {x} {y}")
            return None
        except Exception as e:  # noqa: BLE001 - reported to the caller
            return f"adb tap failed: {e}"

    def swipe(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 400) -> str | None:
        try:
            self.shell(f"input touchscreen swipe {x1} {y1} {x2} {y2} {int(duration_ms)}")
            return None
        except Exception as e:  # noqa: BLE001
            return f"adb swipe failed: {e}"

    def keyevent(self, code: str | int) -> bool:
        try:
            self.shell(f"input keyevent {code}")
            return True
        except Exception as e:  # noqa: BLE001
            log.error("keyevent %s failed: %s", code, e)
            return False

    def input_text(self, text: str) -> bool:
        try:
            self.ui.send_text(text)
            return True
        except Exception as e:  # noqa: BLE001 - fall back to plain adb input
            log.warning("uiautomator2 send_text failed (%s); using adb input text", e)
            return self.input_text_adb(text)

    def input_text_adb(self, text: str) -> bool:
        """`input text` cannot type spaces or shell-special characters directly: spaces become
        `%s`, specials are escaped, and literal `%s` sequences are typed as a space key event."""
        try:
            parts = text.split("%s")
            for i, part in enumerate(parts):
                chunk = "".join("%s" if ch == " " else (f"\\{ch}" if ch in _SHELL_SPECIAL else ch) for ch in part)
                if chunk:
                    self.shell(f"input text '{chunk}'")
                if i < len(parts) - 1:
                    self.shell("input keyevent 62")
            return True
        except Exception as e:  # noqa: BLE001
            log.error("adb input text failed: %s", e)
            return False

    def open_url(self, url: str, package: str | None = None) -> str:
        """`am start -W -a VIEW -d <url> [package]`: what `am` printed (it exits 0 on errors too)."""
        cmd = f"am start -W -a android.intent.action.VIEW -d {shlex.quote(url)}"
        if package:
            cmd += f" {shlex.quote(package)}"
        return self.shell(cmd)

    def launch(self, package: str) -> str:
        return self.shell(f"monkey -p {shlex.quote(package)} -c android.intent.category.LAUNCHER 1")

    def force_stop(self, package: str) -> str:
        return self.shell(f"am force-stop {shlex.quote(package)}")


def am_start_problem(out: str | None) -> str | None:
    """What `am start` said went wrong (it exits 0 and prints the error), or None."""
    for line in str(out or "").splitlines():
        text = line.strip()
        if text.startswith(("Error", "Exception")) or "unable to resolve Intent" in text or "does not exist" in text:
            return text[:200]
    return None


def focused_package(serial: str) -> str | None:
    """The package of the focused window (`dumpsys window`'s mCurrentFocus), or None."""
    try:
        out = adb(serial, "shell", "dumpsys", "window", timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return focused_package_of(out)


def focused_package_of(dumpsys: str) -> str | None:
    m = re.search(r"mCurrentFocus.*?\s([\w.]+)/", dumpsys)
    return m.group(1) if m else None
