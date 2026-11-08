"""A local Appium server that drives a physical iPhone or iPad over XCUITest.

Apple allows UI automation on a real device only through XCUITest, so Orcha runs Appium with its
XCUITest driver on this Mac. The driver builds WebDriverAgent (an XCUITest runner app) with the
team's Apple Development signing and installs it on the phone next to the app under test.

Contained, never global: Appium and the driver live in `~/.orcha/tools/appium`
(`$ORCHA_APPIUM_HOME` overrides it), pinned below. `install()` puts them there; `orcha qa phone-tools`
runs it, and a session that needs them installs them first. WebDriverAgent is built once per phone
and app, in `<tools>/wda-derived/<udid>/<WDA bundle id>`: the first session takes one to three
minutes, and after it has started there (`remember_wda`) the next ones reuse it (about 20 s).

One server per session: `start()` picks a free port, waits for `/status`, `Server.stop()` ends it.
Signing comes from the project (`DEVELOPMENT_TEAM` in its Xcode project), else this Mac's Apple
Development certificate; `$ORCHA_IOS_TEAM_ID` and `$ORCHA_IOS_SIGNING_ID` override it.
"""

from __future__ import annotations

import json
import os
import re
import signal
import socket
import subprocess
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

APPIUM_VERSION = "3.8.0"
XCUITEST_VERSION = "12.19.1"
TOOLS_ENV = "ORCHA_APPIUM_HOME"
TEAM_ENV = "ORCHA_IOS_TEAM_ID"
SIGNING_ENV = "ORCHA_IOS_SIGNING_ID"
WDA_BUNDLE_ENV = "ORCHA_WDA_BUNDLE_ID"
DEFAULT_SIGNING_ID = "Apple Development"
START_TIMEOUT_S = 60.0
INSTALL_TIMEOUT_S = 900.0
WDA_LAUNCH_TIMEOUT_MS = 240_000
NEW_COMMAND_TIMEOUT_S = 900
WDA_STATE_FILE = "orcha-wda.json"
#: Directories a project's Xcode project is not in.
_SKIP_DIRS = {"node_modules", "Pods", "build", "DerivedData", ".git", ".build", ".orcha"}
_TEAM = re.compile(r"DEVELOPMENT_TEAM\s*=\s*\"?([A-Z0-9]{10})\"?\s*;")
_CERT_TEAM = re.compile(r"OU\s*=\s*([A-Z0-9]{10})\b")


class AppiumUnavailable(Exception):
    """Appium or its XCUITest driver is not installed, or the server did not start."""


def tools_dir(environ: Optional[dict[str, str]] = None) -> Path:
    env = os.environ if environ is None else environ
    return Path(env[TOOLS_ENV]).expanduser() if env.get(TOOLS_ENV) else Path.home() / ".orcha" / "tools" / "appium"


def appium_bin(tools: Path) -> Path:
    return tools / "node_modules" / ".bin" / "appium"


def appium_home(tools: Path) -> Path:
    return tools / "home"


def installed(tools: Optional[Path] = None) -> bool:
    tools = tools or tools_dir()
    return appium_bin(tools).exists() and (appium_home(tools) / "node_modules" / "appium-xcuitest-driver" / "package.json").is_file()


def _env(tools: Path) -> dict[str, str]:
    env = dict(os.environ)
    env["APPIUM_HOME"] = str(appium_home(tools))
    env["PATH"] = os.pathsep.join(p for p in (env.get("PATH"), "/opt/homebrew/bin", "/usr/local/bin") if p)
    return env


def install_commands(tools: Path) -> list[list[str]]:
    return [["npm", "install", "--prefix", str(tools), f"appium@{APPIUM_VERSION}", "--no-fund", "--no-audit"],
            [str(appium_bin(tools)), "driver", "install", f"xcuitest@{XCUITEST_VERSION}"]]


def install(tools: Optional[Path] = None, *, run: Any = subprocess.run) -> None:
    """Put the pinned Appium and XCUITest driver in `tools`, never globally. Raises `AppiumUnavailable`."""
    tools = tools or tools_dir()
    tools.mkdir(parents=True, exist_ok=True)
    for cmd in install_commands(tools):
        try:
            done = run(cmd, env=_env(tools), capture_output=True, text=True, timeout=INSTALL_TIMEOUT_S)
        except (OSError, subprocess.SubprocessError) as e:
            raise AppiumUnavailable(f"could not install the phone tools: {e}") from e
        if done.returncode != 0:
            tail = " ".join((done.stderr or done.stdout or "").split())[-300:]
            raise AppiumUnavailable(f"could not install the phone tools ({Path(cmd[0]).name} exit {done.returncode}): {tail}")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@dataclass
class Server:
    process: Any
    port: int
    log_path: Optional[Path] = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def alive(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def stop(self, grace_s: float = 10.0) -> None:
        """End the server and what it started in its process group."""
        proc = self.process
        if proc is None or proc.poll() is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            proc.terminate()
        try:
            proc.wait(timeout=grace_s)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                proc.kill()


def _ready(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/status", timeout=2) as resp:  # noqa: S310 - our own loopback server
            return resp.status == 200
    except OSError:
        return False


def start(*, tools: Optional[Path] = None, log_path: Optional[Path] = None, timeout_s: float = START_TIMEOUT_S,
          popen: Any = subprocess.Popen) -> Server:
    """Start a server on 127.0.0.1 and wait until it answers. Raises `AppiumUnavailable`."""
    tools = tools or tools_dir()
    if not installed(tools):
        raise AppiumUnavailable(f"Appium with its XCUITest driver is not installed in {tools}: run `orcha qa phone-tools`")
    port = _free_port()
    cmd = [str(appium_bin(tools)), "server", "--address", "127.0.0.1", "--port", str(port), "--log-no-colors", "--log-timestamp"]
    log = open(log_path, "ab") if log_path else subprocess.DEVNULL  # noqa: SIM115 - the child owns it
    try:
        proc = popen(cmd, env=_env(tools), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    finally:
        if log_path:
            log.close()
    server = Server(proc, port, log_path)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if not server.alive():
            raise AppiumUnavailable("the Appium server exited at start")
        if _ready(server.url):
            return server
        time.sleep(0.5)
    server.stop()
    raise AppiumUnavailable(f"the Appium server did not answer within {int(timeout_s)}s")


# ---------- signing ----------


def repo_team(root: Optional[Path] = None) -> Optional[str]:
    """The `DEVELOPMENT_TEAM` of the Xcode project under `root` (the project this worker runs in)."""
    root = root or Path.cwd()
    for folder, dirs, _ in os.walk(root):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".") and folder.count(os.sep) - str(root).count(os.sep) < 4]
        for d in dirs:
            if d.endswith(".xcodeproj"):
                try:
                    found = _TEAM.search((Path(folder) / d / "project.pbxproj").read_text(errors="ignore"))
                except OSError:
                    continue
                if found:
                    return found.group(1)
    return None


def mac_team(*, run: Any = subprocess.run) -> Optional[str]:
    """The team of this Mac's Apple Development certificate, or None."""
    try:
        pem = run(["security", "find-certificate", "-c", DEFAULT_SIGNING_ID, "-p"], capture_output=True, timeout=10)
        if pem.returncode != 0 or not pem.stdout:
            return None
        subject = run(["openssl", "x509", "-noout", "-subject"], input=pem.stdout, capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    found = _CERT_TEAM.search((subject.stdout or b"").decode("utf-8", "replace"))
    return found.group(1) if found else None


def signing_team(environ: Optional[dict[str, str]] = None, *, root: Optional[Path] = None) -> Optional[str]:
    env = os.environ if environ is None else environ
    return env.get(TEAM_ENV) or repo_team(root) or mac_team()


def wda_bundle_id(app_bundle_id: str, environ: Optional[dict[str, str]] = None) -> str:
    """WebDriverAgent's bundle id under the app's own prefix, so automatic signing registers it
    with the same team."""
    env = os.environ if environ is None else environ
    if env.get(WDA_BUNDLE_ENV):
        return env[WDA_BUNDLE_ENV]
    parts = [p for p in app_bundle_id.split(".") if p][:2] or ["com", "orcha"]
    return ".".join([*parts, "orcha", "WebDriverAgentRunner"])


# ---------- WebDriverAgent, built once per phone and app ----------


def wda_derived(udid: str, bundle_id: str, tools: Optional[Path] = None, environ: Optional[dict[str, str]] = None) -> Path:
    env = os.environ if environ is None else environ
    return (tools or tools_dir(env)) / "wda-derived" / udid / wda_bundle_id(bundle_id, env)


def _wda_key(team: Optional[str], bundle_id: str, env: Any) -> dict[str, Any]:
    return {"team": team, "wda_bundle_id": wda_bundle_id(bundle_id, env), "xcuitest": XCUITEST_VERSION}


def wda_prebuilt(udid: str, bundle_id: str, team: Optional[str], tools: Optional[Path] = None, environ: Optional[dict[str, str]] = None) -> bool:
    """Whether WebDriverAgent started on this phone for this app, with the same team and driver."""
    env = os.environ if environ is None else environ
    derived = wda_derived(udid, bundle_id, tools, env)
    try:
        state = json.loads((derived / WDA_STATE_FILE).read_text())
    except (OSError, ValueError):
        return False
    if not isinstance(state, dict) or any(state.get(k) != v for k, v in _wda_key(team, bundle_id, env).items()):
        return False
    return any((derived / "Build" / "Products").glob("*.xctestrun"))


def remember_wda(udid: str, bundle_id: str, team: Optional[str], tools: Optional[Path] = None, environ: Optional[dict[str, str]] = None) -> None:
    env = os.environ if environ is None else environ
    derived = wda_derived(udid, bundle_id, tools, env)
    try:
        derived.mkdir(parents=True, exist_ok=True)
        (derived / WDA_STATE_FILE).write_text(json.dumps({**_wda_key(team, bundle_id, env), "at": time.time()}))
    except OSError:
        pass


def forget_wda(udid: str, bundle_id: str, tools: Optional[Path] = None, environ: Optional[dict[str, str]] = None) -> None:
    """The reused build did not start (a new Xcode, an expired profile): the next one rebuilds."""
    try:
        (wda_derived(udid, bundle_id, tools, environ) / WDA_STATE_FILE).unlink(missing_ok=True)
    except OSError:
        pass


def capabilities(*, udid: str, bundle_id: str, team: Optional[str], prebuilt: bool, tools: Optional[Path] = None,
                 environ: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """XCUITest capabilities for the installed app on a phone. The session never reinstalls or
    clears it (`noReset`): a phone may be someone's own."""
    env = os.environ if environ is None else environ
    caps: dict[str, Any] = {
        "platformName": "iOS",
        "appium:automationName": "XCUITest",
        "appium:udid": udid,
        "appium:bundleId": bundle_id,
        "appium:noReset": True,
        "appium:newCommandTimeout": NEW_COMMAND_TIMEOUT_S,
        "appium:wdaLaunchTimeout": WDA_LAUNCH_TIMEOUT_MS,
        "appium:wdaConnectionTimeout": WDA_LAUNCH_TIMEOUT_MS,
        "appium:derivedDataPath": str(wda_derived(udid, bundle_id, tools, env)),
        "appium:updatedWDABundleId": wda_bundle_id(bundle_id, env),
        "appium:xcodeSigningId": env.get(SIGNING_ENV) or DEFAULT_SIGNING_ID,
        "appium:allowProvisioningDeviceRegistration": True,
    }
    if team:
        caps["appium:xcodeOrgId"] = team
    if prebuilt:
        caps["appium:usePrebuiltWDA"] = True
    return caps


def stop_wda(udid: str, tools: Optional[Path] = None, *, run: Any = subprocess.run, kill: Any = os.kill) -> int:
    """End the xcodebuild running WebDriverAgent on `udid`: Appium starts it in a process group of
    its own, so stopping the server leaves it (and WebDriverAgent on the phone) running. Never raises."""
    tools = tools or tools_dir()
    try:
        out = run(["pgrep", "-fl", "APPIUM_XCODEBUILD_WDA_MARKER"], capture_output=True, text=True, timeout=10).stdout or ""
    except (OSError, subprocess.SubprocessError):
        return 0
    stopped = 0
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        if pid.isdigit() and "xcodebuild" in cmd and f"id={udid}" in cmd and str(tools / "wda-derived") in cmd:
            try:
                kill(int(pid), signal.SIGTERM)
                stopped += 1
            except OSError:
                pass
    return stopped
