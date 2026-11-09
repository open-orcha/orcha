"""App permissions before a check (`qa_scenarios.permissions`): the app under test gets its OS
permissions (microphone, photos, location, contacts) before each scenario, so no permission dialog
interrupts a test. A scenario that tests the prompt itself says `ask`: nothing is granted and the
app asks as it would for a new user.
"""

from __future__ import annotations

import json
import plistlib
import re
import subprocess
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CALL_TIMEOUT_S = 20.0
#: The session's safety net: "ask" turns it off (a scenario that tests a prompt, or the project's
#: grants turned off); unset or anything else leaves it on.
ENV = "ORCHA_QA_PERMISSIONS"
ASK = "ask"
GRANT = "grant"

Runner = Callable[[list[str]], tuple[int, str]]


def _run(cmd: list[str]) -> tuple[int, str]:
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=CALL_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, f"{type(e).__name__}: {e}"
    return proc.returncode, proc.stdout or ""


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _unique(items: Iterable[str]) -> list[str]:
    out: list[str] = []
    for item in items:
        if item and item not in out:
            out.append(item)
    return out


@dataclass
class GrantResult:
    """What the permissions step did. `granted`: the plain names granted ("microphone"), once
    each; `failed`: "camera (why)"; `cannot`: what the platform cannot grant ahead, and what happens
    instead; `skipped`: why nothing was granted (an opt-out), or None."""

    granted: list[str] = field(default_factory=list)
    raw: list[str] = field(default_factory=list)  # the platform's own names (android.permission.X, a simctl service)
    failed: list[str] = field(default_factory=list)
    cannot: list[str] = field(default_factory=list)
    skipped: str | None = None
    revoked: list[str] = field(default_factory=list)  # an opt-out run: what an earlier grant left, taken back
    none_requested: bool = False
    took_s: float = 0.0

    @property
    def line(self) -> str:
        """The preparation's line: "Granted 5 permissions: microphone, notifications, ..."."""
        if self.skipped:
            line = f"Permissions not granted: {self.skipped}"
            if self.revoked:
                line += f"; took back {', '.join(self.revoked)} so the app asks as for a new user"
            return line
        parts: list[str] = []
        if self.granted:
            parts.append(f"Granted {_plural(len(self.granted), 'permission')}: {', '.join(self.granted)}")
        elif self.none_requested and not self.failed:
            parts.append("No permissions to grant: the app asks for none")
        if self.failed:
            parts.append(f"could not grant {', '.join(self.failed)}")
        parts += self.cannot
        text = "; ".join(parts) or "No permissions granted"
        return text[0].upper() + text[1:]

    @property
    def ok(self) -> bool:
        return not self.failed


# ---------- Android ----------

#: Runtime (dangerous) permissions and the plain name the timeline gives them.
ANDROID_NAMES: dict[str, str] = {
    "android.permission.RECORD_AUDIO": "microphone",
    "android.permission.CAMERA": "camera",
    "android.permission.ACCESS_FINE_LOCATION": "location",
    "android.permission.ACCESS_COARSE_LOCATION": "location",
    "android.permission.ACCESS_BACKGROUND_LOCATION": "background location",
    "android.permission.POST_NOTIFICATIONS": "notifications",
    "android.permission.READ_MEDIA_IMAGES": "photos",
    "android.permission.READ_MEDIA_VIDEO": "videos",
    "android.permission.READ_MEDIA_VISUAL_USER_SELECTED": "photos",
    "android.permission.READ_MEDIA_AUDIO": "music and audio",
    "android.permission.ACCESS_MEDIA_LOCATION": "photo locations",
    "android.permission.READ_EXTERNAL_STORAGE": "files",
    "android.permission.WRITE_EXTERNAL_STORAGE": "files",
    "android.permission.READ_CONTACTS": "contacts",
    "android.permission.WRITE_CONTACTS": "contacts",
    "android.permission.GET_ACCOUNTS": "contacts",
    "android.permission.READ_CALENDAR": "calendar",
    "android.permission.WRITE_CALENDAR": "calendar",
    "android.permission.READ_PHONE_STATE": "phone",
    "android.permission.READ_PHONE_NUMBERS": "phone",
    "android.permission.CALL_PHONE": "phone",
    "android.permission.ANSWER_PHONE_CALLS": "phone",
    "android.permission.ADD_VOICEMAIL": "phone",
    "android.permission.USE_SIP": "phone",
    "android.permission.READ_CALL_LOG": "call log",
    "android.permission.WRITE_CALL_LOG": "call log",
    "android.permission.PROCESS_OUTGOING_CALLS": "call log",
    "android.permission.SEND_SMS": "SMS",
    "android.permission.RECEIVE_SMS": "SMS",
    "android.permission.READ_SMS": "SMS",
    "android.permission.RECEIVE_MMS": "SMS",
    "android.permission.RECEIVE_WAP_PUSH": "SMS",
    "android.permission.BLUETOOTH_SCAN": "nearby devices",
    "android.permission.BLUETOOTH_CONNECT": "nearby devices",
    "android.permission.BLUETOOTH_ADVERTISE": "nearby devices",
    "android.permission.NEARBY_WIFI_DEVICES": "nearby devices",
    "android.permission.UWB_RANGING": "nearby devices",
    "android.permission.BODY_SENSORS": "body sensors",
    "android.permission.BODY_SENSORS_BACKGROUND": "body sensors in the background",
    "android.permission.ACTIVITY_RECOGNITION": "physical activity",
}
NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"
#: Granted after the rest: Android grants a background permission only beside its foreground one.
_LAST = ("android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.BODY_SENSORS_BACKGROUND")
#: Special permissions granted through `appops` where that is the platform's standard switch:
#: permission -> (app op, plain name).
SPECIAL_APPOPS: dict[str, tuple[str, str]] = {
    "android.permission.SYSTEM_ALERT_WINDOW": ("SYSTEM_ALERT_WINDOW", "draw over other apps"),
    "android.permission.WRITE_SETTINGS": ("WRITE_SETTINGS", "change system settings"),
    "android.permission.SCHEDULE_EXACT_ALARM": ("SCHEDULE_EXACT_ALARM", "exact alarms"),
    "android.permission.MANAGE_EXTERNAL_STORAGE": ("MANAGE_EXTERNAL_STORAGE", "all files"),
    "android.permission.USE_FULL_SCREEN_INTENT": ("USE_FULL_SCREEN_INTENT", "full-screen alerts"),
}

_SECTION = re.compile(r"^(\s*)(requested permissions|runtime permissions|install permissions|declared permissions)\s*:\s*$")
_PERM_LINE = re.compile(r"^\s*([A-Za-z_][\w.]*\.[\w.]+)(?:\s*:\s*(.*))?$")


@dataclass
class AndroidPermissions:
    """What `dumpsys package` says about one app: what it requests, and its runtime permissions
    with whether each is granted now."""

    requested: list[str] = field(default_factory=list)
    runtime: dict[str, bool] = field(default_factory=dict)


def parse_dumpsys(text: str) -> AndroidPermissions:
    """`dumpsys package <pkg>`'s `requested permissions:` and `runtime permissions:` sections."""
    out = AndroidPermissions()
    section: str | None = None
    indent = -1
    for line in text.splitlines():
        m = _SECTION.match(line)
        if m:
            section, indent = m.group(2), len(m.group(1))
            continue
        if section is None:
            continue
        stripped = line.strip()
        if not stripped or len(line) - len(line.lstrip()) <= indent:
            section = None
            continue
        p = _PERM_LINE.match(line)
        if not p:
            continue
        name, rest = p.group(1), p.group(2) or ""
        if section == "requested permissions":
            if name not in out.requested:
                out.requested.append(name)
        elif section == "runtime permissions":
            out.runtime[name] = "granted=true" in rest
    return out


def name_of(permission: str) -> str:
    """The plain name of an Android permission ("microphone"); an unknown one by its own name."""
    if permission in ANDROID_NAMES:
        return ANDROID_NAMES[permission]
    if permission in SPECIAL_APPOPS:
        return SPECIAL_APPOPS[permission][1]
    return permission.rsplit(".", 1)[-1].replace("_", " ").lower()


def runtime_to_grant(perms: AndroidPermissions, sdk: int | None) -> list[str]:
    """The runtime permissions to grant, foreground before background: every requested dangerous
    one, every runtime one dumpsys lists, and notifications on API 33+."""
    wanted = [p for p in perms.requested if p in ANDROID_NAMES]
    wanted += [p for p in perms.runtime if p not in wanted]
    if sdk is not None and sdk >= 33 and NOTIFICATIONS not in wanted:
        wanted.append(NOTIFICATIONS)
    return [p for p in wanted if p not in _LAST] + [p for p in _LAST if p in wanted]


def _sdk(serial: str, run: Runner) -> int | None:
    code, out = run(["adb", "-s", serial, "shell", "getprop", "ro.build.version.sdk"])
    try:
        return int(out.strip()) if code == 0 else None
    except ValueError:
        return None


def _why(out: str) -> str:
    """The short reason in `pm grant`'s exception text."""
    text = " ".join(out.split())
    m = re.search(r"(?:SecurityException|IllegalArgumentException|Exception):\s*(.+)", text)
    return (m.group(1) if m else text)[:120] or "refused"


def android_state(serial: str, package: str, run: Runner = _run) -> AndroidPermissions | None:
    code, out = run(["adb", "-s", serial, "shell", "dumpsys", "package", package])
    if code != 0 or "Unable to find package" in out:
        return None
    return parse_dumpsys(out)


def grant_android(serial: str, package: str, run: Runner = _run) -> GrantResult:
    """Grant `package` every runtime permission it requests (and the safe special ones). Never
    raises."""
    started = time.monotonic()
    perms = android_state(serial, package, run)
    if perms is None:
        return GrantResult(failed=[f"every permission ({package} is not installed on {serial})"], took_s=time.monotonic() - started)
    sdk = _sdk(serial, run)
    result = GrantResult()
    asked_for_notifications = NOTIFICATIONS in perms.requested or NOTIFICATIONS in perms.runtime
    for perm in runtime_to_grant(perms, sdk):
        code, out = run(["adb", "-s", serial, "shell", "pm", "grant", package, perm])
        failed = code != 0 or "Exception" in out
        if not failed:
            result.raw.append(perm)
            result.granted.append(name_of(perm))
        elif perm == NOTIFICATIONS and not asked_for_notifications:
            continue  # an app that never asks for notifications: nothing to say
        else:
            result.failed.append(f"{name_of(perm)} ({_why(out)})")
    if result.raw:
        # `pm grant` of a permission the app does not request exits 0 on some Android versions and
        # changes nothing (POST_NOTIFICATIONS on API 36): only what dumpsys now shows granted counts.
        after = android_state(serial, package, run)
        if after is not None:
            for perm in list(result.raw):
                if after.runtime.get(perm) is True:
                    continue
                result.raw.remove(perm)
                if perm == NOTIFICATIONS and not asked_for_notifications:
                    continue
                result.failed.append(f"{name_of(perm)} (still not granted)")
            result.granted = [name_of(p) for p in result.raw]
    for perm, (op, label) in SPECIAL_APPOPS.items():
        if perm not in perms.requested:
            continue
        code, out = run(["adb", "-s", serial, "shell", "appops", "set", package, op, "allow"])
        if code == 0 and "Error" not in out and "Exception" not in out:
            result.raw.append(perm)
            result.granted.append(label)
        else:
            result.failed.append(f"{label} ({_why(out)})")
    result.granted = _unique(result.granted)
    result.failed = _unique(result.failed)
    result.none_requested = not result.raw and not result.failed
    result.took_s = time.monotonic() - started
    return result




# ---------- iOS simulator ----------

#: Info.plist usage keys and the simctl service each one is: (service, plain name).
IOS_USAGE: dict[str, tuple[str, str]] = {
    "NSMicrophoneUsageDescription": ("microphone", "microphone"),
    "NSPhotoLibraryUsageDescription": ("photos", "photos"),
    "NSPhotoLibraryAddUsageDescription": ("photos-add", "adding photos"),
    "NSLocationWhenInUseUsageDescription": ("location", "location"),
    "NSLocationAlwaysAndWhenInUseUsageDescription": ("location-always", "location"),
    "NSLocationAlwaysUsageDescription": ("location-always", "location"),
    "NSContactsUsageDescription": ("contacts", "contacts"),
    "NSCalendarsUsageDescription": ("calendar", "calendar"),
    "NSCalendarsFullAccessUsageDescription": ("calendar", "calendar"),
    "NSCalendarsWriteOnlyAccessUsageDescription": ("calendar", "calendar"),
    "NSRemindersUsageDescription": ("reminders", "reminders"),
    "NSRemindersFullAccessUsageDescription": ("reminders", "reminders"),
    "NSAppleMusicUsageDescription": ("media-library", "media library"),
    "NSMotionUsageDescription": ("motion", "motion and fitness"),
    "NSSiriUsageDescription": ("siri", "Siri"),
}
#: Every service `simctl privacy grant all` covers, by plain name (when the Info.plist cannot be read).
IOS_ALL = ("calendar", "contacts", "location", "photos", "media library", "microphone", "motion and fitness", "reminders", "Siri")
IOS_NOTIFICATIONS = "notifications cannot be granted ahead on the iOS simulator: Orcha taps Allow when the app asks"
IOS_CAMERA = "the simulator has no camera, so camera access is answered when the app asks"
IOS_PHYSICAL = "permissions cannot be granted ahead on a physical iPhone: Orcha taps Allow when the app asks"


def ios_usage(udid: str, bundle_id: str, run: Runner = _run) -> dict[str, Any] | None:
    """The app's Info.plist (its installed bundle on the simulator), or None."""
    code, out = run(["xcrun", "simctl", "get_app_container", udid, bundle_id, "app"])
    if code != 0 or not out.strip():
        return None
    plist = Path(out.strip().splitlines()[-1].strip()) / "Info.plist"
    try:
        with plist.open("rb") as fh:
            data = plistlib.load(fh)
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None
    return data if isinstance(data, dict) else None


def grant_ios(udid: str, bundle_id: str, run: Runner = _run) -> GrantResult:
    """`simctl privacy <udid> grant all <bundle>`, reported as the services the app declares.
    Notifications (and the camera, which a simulator lacks) cannot be granted ahead: said plainly.
    Never raises."""
    started = time.monotonic()
    info = ios_usage(udid, bundle_id, run)
    code, out = run(["xcrun", "simctl", "privacy", udid, "grant", "all", bundle_id])
    result = GrantResult()
    if code != 0:
        result.failed.append(f"every permission (simctl privacy: {' '.join(out.split())[:120] or f'exit {code}'})")
    elif info is None:
        result.granted = list(IOS_ALL)
        result.raw = ["all"]
    else:
        used = [IOS_USAGE[k] for k in IOS_USAGE if info.get(k)]
        result.raw = _unique(s for s, _ in used)
        result.granted = _unique(n for _, n in used)
        result.none_requested = not used
    result.cannot.append(IOS_NOTIFICATIONS)
    if info is None or info.get("NSCameraUsageDescription"):
        result.cannot.append(IOS_CAMERA)
    result.took_s = time.monotonic() - started
    return result



_PROMPT = re.compile(
    r"\b(?:permission\s+(?:dialog|prompt|request|sheet|alert|popup|pop-up|denied|is\s+denied|refused)"
    r"|(?:asks?|asking|prompts?|prompted|requests?|requesting)\s+(?:for\s+|to\s+)?(?:the\s+user\s+)?(?:(?:microphone|camera|location|notification|photos?|contacts?|calendar|bluetooth)\s+)?(?:permission|access|to\s+allow|allow)"
    r"|asks?\s+to\s+(?:allow|access|use|record|send|post)"
    r"|(?:deny|denies|denied|denying|refuse|refuses|refused|declines?|declined)\s+(?:the\s+)?(?:permission|access|microphone|camera|location|notifications?|photos?)"
    r"|(?:don['’]t|do\s+not)\s+allow"
    r"|allow\s+(?:access|notifications|location|the\s+microphone|microphone|camera|photos)"
    r"|(?:microphone|camera|location|notification|photo|contacts?)\s+(?:permission|access)\s+(?:is\s+)?(?:denied|refused|off|blocked|prompt|dialog|request)"
    r"|without\s+(?:the\s+)?(?:microphone|camera|location|notification|photo|contacts?)\s+(?:permission|access))\b",
    re.IGNORECASE,
)


def infer_ask(scenario: Mapping[str, Any]) -> bool:
    """A scenario about the permission prompt itself ("asks to allow notifications", "permission
    denied shows how to turn it on"): it should say `Permissions: ask`."""
    texts = [str(scenario.get("name") or ""), str(scenario.get("description") or "")]
    for c in scenario.get("criteria") or scenario.get("steps") or []:
        texts.append(str(c.get("text") if isinstance(c, dict) else c))
    return any(_PROMPT.search(t) for t in texts if t)
