"""The iOS simulator client: `idb_companion` lifecycle plus a thin async facade over fb-idb's
gRPC `Client`, and the `xcrun simctl` calls the session needs.

Adapted from `drivers/ios_idb.py` and the parts of `cloud/simctl.py` a session uses.
One `IdbClient` per simulator. `init_companion()` stops any companion left behind for the
simulator, spawns `idb_companion --udid <udid> --grpc-port <port>` on a free localhost port,
waits until the port accepts connections, opens the gRPC client and checks the companion behind
the port serves this simulator; `cleanup()` closes both. Action methods return `True`/a value
on success and `False`/`None` on failure (logged), so the session reports what happened instead
of unwinding on one flaky gesture; the session adds per-call timeouts and restarts on top.

Never creates, erases or deletes a simulator, never boots one, never downloads a runtime: only
booted simulators are listed and driven. Its `simctl` calls are read-only except
`ensure_app_accessibility` (two accessibility defaults idb needs), `launch_app`/`terminate_app`.

fb-idb is imported inside the methods: this module imports without the `qa` extra.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import shutil
import socket
import subprocess
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

log = logging.getLogger(__name__)

LOG_DIR = Path.home() / ".orcha" / "qa" / "logs"
#: A busy Mac takes far longer than an idle one to load the companion; killing it mid-load loses the
#: session over nothing (Snug Log, load 600: healthy simulator, every later call failed).
COMPANION_READY_TIMEOUT_S = 90.0
#: A `simctl` call that has not answered in this long is not coming.
#: simctl answers in a second on an idle Mac and takes minutes on a busy one.
SIMCTL_TIMEOUT_S = 120.0
BOOT_TIMEOUT_S = 180.0
#: How long a plain tap holds, in seconds. idb's own tap lifts in the same instant it touches
#: down, and a SwiftUI switch takes that for no touch at all; a long press starts at 0.5 s.
TAP_HOLD_S = 0.1
#: After stopping stale companions: how long to wait for them to exit, polled.
STALE_EXIT_WAIT_S = 1.0
STALE_EXIT_POLL_S = 0.1

T = TypeVar("T")


# ---------- simctl ----------


@dataclass(frozen=True)
class Simulator:
    udid: str
    name: str
    runtime: str = ""  # "iOS 26.5"
    device_type: str = ""  # com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro


@dataclass(frozen=True)
class AppInfo:
    bundle_id: str
    name: str
    system: bool
    path: str = ""


def runtime_label(runtime_key: str) -> str:
    """`com.apple.CoreSimulator.SimRuntime.iOS-26-5` -> `iOS 26.5`."""
    tail = str(runtime_key or "").rsplit(".", 1)[-1]
    head, _, rest = tail.partition("-")
    return f"{head} {rest.replace('-', '.')}".strip() if rest else tail


def parse_booted(json_text: str) -> list[Simulator]:
    data = json.loads(json_text)
    out: list[Simulator] = []
    for runtime, devices in (data.get("devices") or {}).items():
        for d in devices:
            if d.get("state") == "Booted":
                out.append(Simulator(
                    udid=d["udid"], name=d["name"], runtime=runtime_label(runtime),
                    device_type=str(d.get("deviceTypeIdentifier") or ""),
                ))
    return out


def booted_simulators() -> list[Simulator]:
    """`xcrun simctl list devices booted -j`: the booted simulators (never boots one)."""
    out = subprocess.run(
        ["xcrun", "simctl", "list", "devices", "booted", "-j"],
        capture_output=True, text=True, check=True, timeout=SIMCTL_TIMEOUT_S,
    )
    return parse_booted(out.stdout)


def all_simulators() -> list[dict[str, Any]]:
    """Every available iOS simulator on this Mac, booted or not: `{udid, name, runtime, state}`,
    `state` as simctl says it (`Booted`, `Shutdown`). Reads only."""
    out = subprocess.run(["xcrun", "simctl", "list", "devices", "available", "-j"],
                         capture_output=True, text=True, check=True, timeout=SIMCTL_TIMEOUT_S)
    rows = []
    for runtime, devices in (json.loads(out.stdout).get("devices") or {}).items():
        word = runtime.rsplit(".", 1)[-1]
        if not word.startswith("iOS-"):
            continue
        rows += [{"udid": d["udid"], "name": d["name"], "runtime": word.replace("-", " ", 1).replace("-", "."), "state": d.get("state") or ""}
                 for d in devices or []]
    return rows


def stopped_simulator(name: str) -> Simulator | None:
    """The simulator called `name` when it exists and is shut down, else None."""
    hit = next((d for d in all_simulators() if d["name"] == name and d["state"] == "Shutdown"), None)
    return Simulator(udid=hit["udid"], name=hit["name"], runtime=hit["runtime"]) if hit else None


def boot_simulator(udid: str) -> None:
    """Boot an existing simulator a person picked, and wait until it has finished. It never creates one."""
    subprocess.run(["xcrun", "simctl", "boot", udid], capture_output=True, text=True, timeout=SIMCTL_TIMEOUT_S, check=False)
    subprocess.run(["xcrun", "simctl", "bootstatus", udid, "-b"], capture_output=True, text=True, timeout=BOOT_TIMEOUT_S, check=True)


def is_booted(udid_or_name: str) -> bool:
    """Whether a simulator (by udid or name) is booted. True when simctl cannot tell, so a
    lock is never taken from a device that may be in use."""
    try:
        sims = booted_simulators()
    except Exception:  # noqa: BLE001
        return True
    return any(s.udid == udid_or_name or s.name == udid_or_name for s in sims)


def parse_listapps(json_text: str) -> list[AppInfo]:
    data = json.loads(json_text)
    apps = [
        AppInfo(
            bundle_id=bid,
            name=str(info.get("CFBundleDisplayName") or info.get("CFBundleName") or bid),
            system=info.get("ApplicationType") == "System",
            path=str(info.get("Path") or ""),
        )
        for bid, info in data.items()
    ]
    return sorted(apps, key=lambda a: (a.system, a.name.lower()))


def installed_apps(udid: str) -> list[AppInfo]:
    raw = subprocess.run(
        ["xcrun", "simctl", "listapps", udid], capture_output=True, text=True, check=True, timeout=SIMCTL_TIMEOUT_S,
    )
    as_json = subprocess.run(
        ["plutil", "-convert", "json", "-o", "-", "-"],
        input=raw.stdout, capture_output=True, text=True, check=True, timeout=SIMCTL_TIMEOUT_S,
    )
    return parse_listapps(as_json.stdout)


def process_path(pid: int) -> str | None:
    """Executable path of a host process (simulator apps run as host processes)."""
    try:
        out = subprocess.run(["ps", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True, timeout=SIMCTL_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return None
    path = out.stdout.strip()
    return path or None


AX_DOMAIN = "com.apple.Accessibility"
AX_APP_KEY = "ApplicationAccessibilityEnabled"
AX_KEY = "AccessibilityEnabled"
#: Every key idb's tree read needs on, in the order they are turned on.
AX_KEYS = (AX_APP_KEY, AX_KEY)


def app_accessibility(udid: str, key: str = AX_APP_KEY, timeout_s: float = SIMCTL_TIMEOUT_S) -> bool | None:
    """One accessibility default of the simulator: True/False as its defaults say, None when
    unset or the read failed. Never raises."""
    try:
        out = subprocess.run(
            ["xcrun", "simctl", "spawn", udid, "defaults", "read", AX_DOMAIN, key],
            capture_output=True, text=True, timeout=timeout_s,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    value = out.stdout.strip().lower()
    return True if value in ("1", "true", "yes") else False if value in ("0", "false", "no") else None


def ensure_app_accessibility(udid: str, timeout_s: float = SIMCTL_TIMEOUT_S) -> tuple[str, ...] | None:
    """Turn on every accessibility default idb needs (`AX_KEYS`) that is not on already: the keys
    this turned on (empty when all were on), None when one could not be written. Apps launched
    afterwards are readable; one already running needs a relaunch. Never raises. (With an XCUITest
    run's leftovers the first key is off and every app answers `describe-all` with an empty
    Application node; on a new simulator the second is unset and idb fails every read.)"""
    turned: list[str] = []
    for key in AX_KEYS:
        if app_accessibility(udid, key, timeout_s) is True:
            continue
        try:
            out = subprocess.run(
                ["xcrun", "simctl", "spawn", udid, "defaults", "write", AX_DOMAIN, key, "-bool", "true"],
                capture_output=True, text=True, timeout=timeout_s,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if out.returncode != 0:
            return None
        turned.append(key)
    return tuple(turned)


def terminate_app(udid: str, bundle_id: str, timeout_s: float = SIMCTL_TIMEOUT_S) -> bool:
    """`xcrun simctl terminate`: True when the app was stopped (or was not running)."""
    try:
        out = subprocess.run(["xcrun", "simctl", "terminate", udid, bundle_id], capture_output=True, text=True, timeout=timeout_s)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return out.returncode == 0 or "found nothing to terminate" in (out.stderr or "").lower()


def launch_app(udid: str, bundle_id: str, timeout_s: float = SIMCTL_TIMEOUT_S, args: list[str] | None = None) -> bool:
    """`xcrun simctl launch`: True when it launched. Never raises. (idb's launch hangs on an app
    frozen under a system sheet; CoreSimulator does not.) `args`: the app's launch arguments
    (the run's language, `-AppleLanguages (sw)`)."""
    try:
        out = subprocess.run(["xcrun", "simctl", "launch", udid, bundle_id, *(args or [])], capture_output=True, text=True, timeout=timeout_s)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return out.returncode == 0


def is_flutter_app(app_path: str | None) -> bool:
    return bool(app_path) and os.path.isdir(os.path.join(str(app_path), "Frameworks", "Flutter.framework"))


# ---------- the companion ----------


def _free_port(start: int = 10882, attempts: int = 100) -> int:
    # A random offset: sessions starting together on two simulators must not pick the same port.
    start += random.randrange(0, 4000)
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"no free port in {start}-{start + attempts}")


def _companion_pids(udid: str) -> list[int]:
    try:
        out = subprocess.run(["pgrep", "-f", f"idb_companion --udid {udid}"], capture_output=True, text=True, timeout=5).stdout
    except Exception:  # noqa: BLE001
        return []
    pids = []
    for pid_s in out.split():
        try:
            pids.append(int(pid_s))
        except ValueError:
            continue
    return [p for p in pids if p != os.getpid()]


def _kill_stale_companions(udid: str) -> int:
    """Terminate every `idb_companion --udid <udid>`: one left behind by a session that never
    cleaned up keeps its own accessibility connection, and with several attached the tree read
    hangs on every screen. Blocking: call it off the event loop."""
    killed = 0
    for pid in _companion_pids(udid):
        try:
            subprocess.run(["kill", "-TERM", str(pid)], capture_output=True, timeout=5)
            killed += 1
        except Exception:  # noqa: BLE001
            continue
    if killed:
        log.warning("stopped %d stale idb_companion process(es) for %s", killed, udid)
    return killed


async def _stop_stale_companions(udid: str) -> int:
    killed = await asyncio.to_thread(_kill_stale_companions, udid)
    if killed:
        deadline = time.monotonic() + STALE_EXIT_WAIT_S
        while time.monotonic() < deadline and await asyncio.to_thread(_companion_pids, udid):
            await asyncio.sleep(STALE_EXIT_POLL_S)
    return killed


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        try:
            s.connect(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _accessibility_options(nested: bool) -> Any:
    """fb-idb >= 1.2's `AccessibilityInfoOptions`, or None on 1.1.x (whose call takes keywords)."""
    try:
        from idb.common.types import AccessibilityInfoOptions  # type: ignore[attr-defined]
    except ImportError:
        return None
    return AccessibilityInfoOptions(nested=nested)


def _point_target(x: int, y: int) -> Any:
    try:
        from idb.common.types import AccessibilityPoint  # type: ignore[attr-defined]
    except ImportError:
        return (x, y)
    return AccessibilityPoint(x=x, y=y)


class IdbClient:
    def __init__(self, udid: str, port: int | None = None):
        self.udid = udid
        self.port = port or _free_port()
        self.companion_process: subprocess.Popen[str] | None = None
        self._client: Any = None
        self._client_cm: Any = None
        self._stderr_file: Any = None

    @property
    def client(self) -> Any:
        """The raw fb-idb gRPC client. Raises when `init_companion()` has not succeeded."""
        if self._client is None:
            raise RuntimeError("idb client not connected; call init_companion() first")
        return self._client

    async def init_companion(self, binary: str = "idb_companion", ready_timeout_s: float = COMPANION_READY_TIMEOUT_S, attempts: int = 3) -> bool:
        """Start idb_companion and connect, making sure the companion behind the port is this
        simulator's: on a port another session's companion already holds, retry on a new port."""
        for attempt in range(attempts):
            if attempt:
                self.port = _free_port()
            if not await self._init_companion_once(binary, ready_timeout_s):
                if self.companion_process is None or attempt == attempts - 1:
                    return False
                continue
            try:
                target = await self._client.describe()
                serves = getattr(target, "udid", None)
            except Exception:  # noqa: BLE001 - an unreadable target is retried like a wrong one
                serves = None
            if serves == self.udid:
                return True
            log.error("port %s serves simulator %s, not %s; retrying on another port", self.port, serves, self.udid)
            await self.cleanup()
        return False

    async def _init_companion_once(self, binary: str, ready_timeout_s: float) -> bool:
        if self.companion_process is not None and self.companion_process.poll() is None and self._client:
            return True
        await self.cleanup()
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            self._stderr_file = open(LOG_DIR / f"idb_companion-{self.udid}.log", "a")  # noqa: SIM115 - closed in cleanup
        except OSError:
            self._stderr_file = subprocess.DEVNULL
        await _stop_stale_companions(self.udid)
        cmd = [binary, "--udid", self.udid, "--grpc-port", str(self.port)]
        try:
            self.companion_process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=self._stderr_file, text=True)
        except FileNotFoundError:
            log.error("idb_companion not found on PATH (brew install facebook/fb/idb-companion)")
            self.companion_process = None
            return False
        deadline = time.monotonic() + ready_timeout_s
        while time.monotonic() < deadline:
            if self.companion_process.poll() is not None:
                log.error("idb_companion exited early (code %s)", self.companion_process.returncode)
                await self.cleanup()
                return False
            if await asyncio.to_thread(_port_open, self.port):
                break
            await asyncio.sleep(0.25)
        else:
            log.error("idb_companion did not open port %s within %.0fs", self.port, ready_timeout_s)
            await self.cleanup()
            return False
        try:
            from idb.common.types import TCPAddress
            from idb.grpc.client import Client

            self._client_cm = Client.build(address=TCPAddress(host="localhost", port=self.port), logger=log)
            self._client = await self._client_cm.__aenter__()
        except Exception as e:  # noqa: BLE001 - surfaced as False; the session reports it
            log.error("idb gRPC connect failed: %s: %s", type(e).__name__, e)
            await self.cleanup()
            return False
        return True

    async def cleanup(self) -> None:
        """Close the gRPC client and stop the companion (SIGTERM, then SIGKILL after 5 s)."""
        if self._client_cm is not None:
            try:
                await self._client_cm.__aexit__(None, None, None)
            except Exception as e:  # noqa: BLE001 - best-effort close
                log.debug("idb client close: %s", e)
            finally:
                self._client = None
                self._client_cm = None
        self._client = None
        proc = self.companion_process
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        await asyncio.wait_for(asyncio.to_thread(proc.wait), timeout=5.0)
                    except asyncio.TimeoutError:
                        proc.kill()
                        await asyncio.to_thread(proc.wait)
            except Exception as e:  # noqa: BLE001 - best-effort stop
                log.debug("idb_companion stop: %s", e)
            finally:
                self.companion_process = None
        if self._stderr_file not in (None, subprocess.DEVNULL):
            try:
                self._stderr_file.close()
            except Exception:  # noqa: BLE001
                pass
        self._stderr_file = None

    def __del__(self) -> None:
        proc = self.companion_process
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass

    # ---------- reads ----------

    async def accessibility_tree(self) -> list[dict]:
        """The flat accessibility tree (the shape of `idb ui describe-all --json`). Both fb-idb
        call shapes work: 1.1.x `accessibility_info(point, nested)`, 1.2+ `(target, options)`."""
        options = _accessibility_options(nested=False)
        if options is None:
            info = await self.client.accessibility_info(point=None, nested=False)
        else:
            info = await self.client.accessibility_info(None, options)
        parsed = json.loads(info.json)
        return parsed if isinstance(parsed, list) else [parsed]

    async def describe_point(self, x: int, y: int, nested: bool = True) -> Any:
        """The accessibility node under a point, as plain JSON; None on failure."""

        async def go(c: Any) -> Any:
            options = _accessibility_options(nested=nested)
            if options is None:
                info = await c.accessibility_info(point=(x, y), nested=nested)
            else:
                info = await c.accessibility_info(_point_target(x, y), options)
            return json.loads(info.json)

        return await self._call("describe_point", go, None)

    async def describe(self) -> Any:
        """idb's target description (`screen_dimensions` in points)."""
        return await self.client.describe()

    async def screenshot(self) -> bytes | None:
        """PNG bytes of the current screen."""
        return await self._call("screenshot", lambda c: c.screenshot(), None)

    # ---------- actions ----------

    async def jpeg_frames(self, fps: int = 15, quality: float = 0.6, scale: float = 0.5) -> AsyncIterator[bytes]:
        """The screen as a stream of whole JPEGs, `scale` times its pixel size, until the caller
        stops iterating. idb's MJPEG stream when the companion can make one; else its H.264
        stream decoded by `ffmpeg` (the companion's JPEG encoder fails to start on some macOS
        versions: "Failed to start Compression Session -12902"). Raises when neither works or
        the stream fails later (no client, the companion went away)."""
        from idb.common.types import VideoFormat

        from orcha_cli.qa.device.live_frames import split_jpegs

        rest = b""
        try:
            async for chunk in self.client.stream_video(
                output_file=None, fps=fps, format=VideoFormat.MJPEG, compression_quality=quality, scale_factor=scale
            ):
                frames, rest = split_jpegs(rest + chunk)
                for frame in frames:
                    yield frame
            return
        except Exception as e:  # noqa: BLE001 - fall through to H.264 when MJPEG never started
            if rest or not shutil.which("ffmpeg"):
                raise
            log.info("idb mjpeg stream unavailable (%s); decoding h264 with ffmpeg", e)
        async for frame in self._h264_as_jpegs(fps, scale):
            yield frame

    async def _h264_as_jpegs(self, fps: int, scale: float) -> AsyncIterator[bytes]:
        from idb.common.types import VideoFormat

        from orcha_cli.qa.device.live_frames import split_jpegs

        ffmpeg = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            # A small probe so frames come out as they arrive (the default probe buffers
            # seconds of video first); full-range output, which the JPEG encoder needs.
            "-flags", "low_delay", "-probesize", "4096", "-analyzeduration", "0",
            "-f", "h264", "-i", "pipe:0",
            "-pix_fmt", "yuvj420p", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        assert ffmpeg.stdin is not None and ffmpeg.stdout is not None
        stdin = ffmpeg.stdin

        async def feed() -> None:
            try:
                async for chunk in self.client.stream_video(
                    output_file=None, fps=fps, format=VideoFormat.H264, compression_quality=0.6, scale_factor=scale
                ):
                    stdin.write(chunk)
                    await stdin.drain()
            finally:
                stdin.close()

        feeder = asyncio.create_task(feed())
        rest = b""
        try:
            while True:
                chunk = await ffmpeg.stdout.read(65536)
                if not chunk:
                    break
                frames, rest = split_jpegs(rest + chunk)
                for frame in frames:
                    yield frame
            if feeder.done() and feeder.exception() is not None:
                raise feeder.exception()  # type: ignore[misc]
            raise RuntimeError("h264 stream ended")
        finally:
            feeder.cancel()
            try:
                await feeder
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown
                pass
            if ffmpeg.returncode is None:
                ffmpeg.kill()
                await ffmpeg.wait()

    async def _call(self, name: str, fn: Callable[[Any], Awaitable[T]], default: T) -> T:
        try:
            return await fn(self.client)
        except Exception as e:  # noqa: BLE001 - logged; callers see the default
            log.warning("idb %s failed: %s: %s", name, type(e).__name__, e)
            return default

    async def tap(self, x: int, y: int, duration: float | None = TAP_HOLD_S) -> bool:
        """Touch (x, y) for `duration` seconds: a plain tap's brief hold by default."""

        async def go(c: Any) -> bool:
            await c.tap(x=x, y=y, duration=duration)
            return True

        return await self._call("tap", go, False)

    async def swipe(self, x_start: int, y_start: int, x_end: int, y_end: int, duration: float | None = None) -> bool:
        async def go(c: Any) -> bool:
            await c.swipe(p_start=(x_start, y_start), p_end=(x_end, y_end), duration=duration)
            return True

        return await self._call("swipe", go, False)

    async def launch(self, bundle_id: str) -> bool:
        async def go(c: Any) -> bool:
            # fb-idb writes the launched pid as JSON to this process's stdout unless it is given a
            # pid file; on the MCP server's stdio that line would corrupt the protocol.
            try:
                await c.launch(bundle_id=bundle_id, args=list(getattr(self, "launch_args", None) or []), env={},
                               foreground_if_running=True, pid_file=os.devnull)
            except TypeError:  # an fb-idb without `pid_file`
                await c.launch(bundle_id=bundle_id, args=list(getattr(self, "launch_args", None) or []), env={}, foreground_if_running=True)
            return True

        return await self._call("launch", go, False)

    async def terminate(self, bundle_id: str) -> bool:
        async def go(c: Any) -> bool:
            await c.terminate(bundle_id)
            return True

        return await self._call("terminate", go, False)

    async def text(self, text: str) -> bool:
        async def go(c: Any) -> bool:
            await c.text(text)
            return True

        return await self._call("text", go, False)

    async def keys(self, events: list[Any]) -> bool:
        """Raw HID presses (accents with Option, which `text` cannot type)."""

        async def go(c: Any) -> bool:
            await c.send_events(events)
            return True

        return await self._call("keys", go, False)

    async def key(self, key_code: int) -> bool:
        async def go(c: Any) -> bool:
            await c.key(key_code)
            return True

        return await self._call("key", go, False)

    async def button(self, name: str) -> bool:
        """A hardware button by name: HOME, LOCK, SIRI, SIDE_BUTTON (`HIDButtonType`)."""

        async def go(c: Any) -> bool:
            from idb.common.types import HIDButtonType

            await c.button(button_type=getattr(HIDButtonType, name))
            return True

        return await self._call("button", go, False)

    async def open_url(self, url: str) -> bool:
        async def go(c: Any) -> bool:
            await c.open_url(url)
            return True

        return await self._call("open_url", go, False)

    async def install(self, app_path: str | Path) -> bool:
        """Install a `.app` bundle (or `.ipa`) on the simulator."""

        async def go(c: Any) -> bool:
            with open(app_path, "rb") as f:
                async for _artifact in c.install(bundle=f):
                    pass
            return True

        return await self._call("install", go, False)
