"""Run conditions: the state a case needs, set on the device before it runs and put back after.

A person asks for them on a scenario, a run or a finding to reproduce (the portal's
`qa_conditions.py` has the same keys). Orcha sets what it can on the device itself; the agent
sets up the rest with its own tools (an MCP server that fetches a subscribed test account, say).
A condition that is not met is never assumed: the checks it touches are blocked, with why.

| key        | Android                          | iOS simulator              | iOS phone       | Web (Chromium)          |
|------------|----------------------------------|----------------------------|-----------------|-------------------------|
| os         | checked (ro.build.version)       | checked (runtime)          | checked         | -                       |
| locale     | per-app language (Android 13+)   | launch arguments           | launch arguments| locale + Accept-Language|
| text_size  | font_scale                       | content size               | agent           | default font sizes      |
| appearance | night mode                       | appearance                 | agent           | prefers-color-scheme    |
| timezone   | agent                            | agent                      | agent           | timezone                |
| network    | emulator: radio and speed        | agent                      | agent           | offline or slow         |
| account    | agent, with its own tools        | agent                      | agent           | agent                   |
| setup      | agent                            | agent                      | agent           | agent                   |
"""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

KEYS = ("os", "locale", "text_size", "appearance", "timezone", "network", "account", "setup")
#: What a physical phone cannot be put in: Orcha does not change a person's own phone's settings
#: (and cannot, on an iPhone), and the agent has no safe way to. Pick a simulator or an emulator.
PHYSICAL_UNAVAILABLE = {"ios": {"text_size", "appearance", "network", "timezone"}, "android": {"network", "timezone"}}
TEXT_SIZES = ("small", "default", "large", "larger", "largest")
ANDROID_FONT_SCALE = {"small": "0.85", "default": "1.0", "large": "1.15", "larger": "1.3", "largest": "2.0"}
IOS_CONTENT_SIZE = {"small": "small", "default": "large", "large": "extra-large", "larger": "extra-extra-large",
                    "largest": "accessibility-extra-extra-large"}
WEB_FONT_PX = {"small": 13, "default": 16, "large": 19, "larger": 22, "largest": 28}
#: "slow": about a 3G phone.
WEB_SLOW = {"offline": False, "latency": 400, "downloadThroughput": 400 * 1024 // 8, "uploadThroughput": 400 * 1024 // 8}
_LOCALE = re.compile(r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$")
_VERSION = re.compile(r"(\d+(?:\.\d+)*)")
CMD_TIMEOUT_S = 15.0

Undo = Callable[[], Awaitable[Any]]


def normalize(raw: Any) -> dict[str, str]:
    """The asked conditions, cleaned: unknown keys and empty values dropped, enums lower-cased. A
    JSON string is read as the object it holds."""
    if isinstance(raw, str):
        import json

        try:
            raw = json.loads(raw) if raw.strip() else {}
        except ValueError:
            return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key in KEYS:
        value = raw.get(key)
        if value is None or not str(value).strip():
            continue
        value = str(value).strip()
        if key in ("text_size", "appearance", "network"):
            value = value.lower()
        out[key] = value
    if out.get("text_size") not in (None, *TEXT_SIZES):
        out.pop("text_size")
    if out.get("appearance") not in (None, "light", "dark"):
        out.pop("appearance")
    if out.get("network") not in (None, "online", "offline", "slow"):
        out.pop("network")
    if "locale" in out and not _LOCALE.match(out["locale"]):
        out.pop("locale")
    return out


def merge(base: Any, over: Any) -> dict[str, str]:
    """A scenario's conditions with a run's on top, key by key."""
    return {**normalize(base), **normalize(over)}


def version_of(text: Optional[str]) -> Optional[str]:
    found = _VERSION.search(text or "")
    return found.group(1) if found else None


def os_matches(want: str, have: Optional[str]) -> Optional[bool]:
    """Whether the device's OS is the one asked for: "13" matches 13.x; "18.2" matches 18.2.x.
    None when either side has no version."""
    w, h = version_of(want), version_of(have)
    if not w or not h:
        return None
    wp, hp = w.split("."), h.split(".")
    return hp[: len(wp)] == wp


def apple_locale(locale: str) -> list[str]:
    """Launch arguments that run an iOS app in `locale` ("sw-KE"): its language and region."""
    lang = locale.replace("_", "-").split("-")[0]
    return ["-AppleLanguages", f"({lang})", "-AppleLocale", locale.replace("-", "_")]


@dataclass
class Applied:
    """What a run's conditions did on the device: lines for the agent, and what puts it back."""

    lines: list[str] = field(default_factory=list)
    unmet: list[str] = field(default_factory=list)
    undo: list[Undo] = field(default_factory=list)
    agent: list[str] = field(default_factory=list)
    #: The commands that put the device back, kept on disk too (`LEDGER_DIR`): a run that crashes
    #: before `restore` leaves them for the next run on the device to apply first (`recover`).
    ledger: list[dict[str, Any]] = field(default_factory=list)
    device_key: str = ""
    #: What each undo puts back, in words, for the run's log: "text size back to large".
    restore_words: list[str] = field(default_factory=list)

    def log_items(self) -> list[str]:
        """Every condition and what happened to it, for the run's log."""
        return ([f"set: {x}" for x in self.lines] + [f"not met: {x}" for x in self.unmet]
                + [f"agent sets up: {x}" for x in self.agent])

    def text(self) -> str:
        out = [f"conditions: {line}" for line in self.lines]
        if self.unmet:
            out.append("conditions NOT met: " + "; ".join(self.unmet)
                       + ". Give every criterion these touch `blocked` with that reason, never a pass; or end and pick a device that meets them.")
        if self.agent:
            out.append("set these up yourself before the criteria, with your own tools (an MCP server for test accounts, say). "
                       "Never invent an account or a value; if you cannot set one up, give the criteria it touches `blocked` with why: "
                       + "; ".join(self.agent))
        return "\n".join(out)


def _undo_cmd(out: "Applied", cmd: list[str], said: str) -> None:
    """Put back with a command: run at `restore`, and kept in the ledger for `recover`. `said`:
    what it puts back, in words, for the run's log."""
    out.ledger.append({"cmd": list(cmd), "said": said})
    out.restore_words.append(said)
    out.undo.append(lambda c=list(cmd): _run(c))


async def _run(cmd: list[str]) -> tuple[int, str]:
    def go() -> tuple[int, str]:
        try:
            done = subprocess.run(cmd, capture_output=True, text=True, timeout=CMD_TIMEOUT_S)
        except (OSError, subprocess.SubprocessError) as e:
            return 1, str(e)
        return done.returncode, (done.stdout or done.stderr or "").strip()

    return await asyncio.to_thread(go)


def _agent_lines(asked: dict[str, str], handled: set[str]) -> list[str]:
    words = {"os": "OS {}", "locale": "language and region {}", "text_size": "text size {}", "appearance": "{} appearance",
             "timezone": "time zone {}", "network": "network {}", "account": "the account: {}", "setup": "setup: {}"}
    return [words[k].format(v) for k, v in asked.items() if k not in handled]


# ---------------------------------------------------------------- Android

async def _android(dev: Any, asked: dict[str, str], out: Applied) -> set[str]:
    serial, app = dev.serial, dev.app_id
    emulator = str(serial).startswith("emulator-")
    adb = ["adb", "-s", serial]
    done: set[str] = set()
    _, release = await _run([*adb, "shell", "getprop", "ro.build.version.release"])
    _, sdk = await _run([*adb, "shell", "getprop", "ro.build.version.sdk"])
    if "os" in asked:
        done.add("os")
        ok = os_matches(asked["os"], release)
        (out.lines if ok else out.unmet).append(
            f"Android {release} meets {asked['os']}" if ok else f"the case needs {asked['os']}, this device runs Android {release or 'unknown'}")
    if "locale" in asked:
        if (version_of(sdk) or "0").split(".")[0].isdigit() and int((version_of(sdk) or "0").split(".")[0]) >= 33:
            code, said = await _run([*adb, "shell", "cmd", "locale", "set-app-locales", app, "--locales", asked["locale"]])
            if code == 0:
                done.add("locale")
                out.lines.append(f"{app} runs in {asked['locale']}")
                _undo_cmd(out, [*adb, "shell", "cmd", "locale", "set-app-locales", app, "--locales", ""], f"{app} back to the system language")
            else:
                out.unmet.append(f"the app's language could not be set to {asked['locale']} ({said[:120]})")
                done.add("locale")
    if "text_size" in asked:
        _, before = await _run([*adb, "shell", "settings", "get", "system", "font_scale"])
        code, _ = await _run([*adb, "shell", "settings", "put", "system", "font_scale", ANDROID_FONT_SCALE[asked["text_size"]]])
        done.add("text_size")
        if code == 0:
            out.lines.append(f"text size {asked['text_size']} (font scale {ANDROID_FONT_SCALE[asked['text_size']]})")
            prior = before if version_of(before) else "1.0"
            _undo_cmd(out, [*adb, "shell", "settings", "put", "system", "font_scale", prior], f"font scale back to {prior}")
        else:
            out.unmet.append(f"text size {asked['text_size']} could not be set")
    if "appearance" in asked:
        _, before = await _run([*adb, "shell", "cmd", "uimode", "night"])
        code, _ = await _run([*adb, "shell", "cmd", "uimode", "night", "yes" if asked["appearance"] == "dark" else "no"])
        done.add("appearance")
        if code == 0:
            out.lines.append(f"{asked['appearance']} appearance")
            word = before.split(":")[-1].strip().lower() if before else ""
            prior = word if word in ("yes", "no", "auto") else "no"
            _undo_cmd(out, [*adb, "shell", "cmd", "uimode", "night", prior], f"night mode back to {prior}")
        else:
            out.unmet.append(f"{asked['appearance']} appearance could not be set")
    if "network" in asked and emulator:
        done.add("network")
        net = asked["network"]
        if net == "offline":
            await _run([*adb, "shell", "svc", "wifi", "disable"])
            await _run([*adb, "shell", "svc", "data", "disable"])
            out.lines.append("offline (wi-fi and mobile data off)")
            _undo_cmd(out, [*adb, "shell", "svc", "wifi", "enable"], "wi-fi back on")
            _undo_cmd(out, [*adb, "shell", "svc", "data", "enable"], "mobile data back on")
        elif net == "slow":
            await _run([*adb, "emu", "network", "speed", "edge"])
            await _run([*adb, "emu", "network", "delay", "edge"])
            out.lines.append("slow network (EDGE speed and delay)")
            _undo_cmd(out, [*adb, "emu", "network", "speed", "full"], "network speed back to full")
            _undo_cmd(out, [*adb, "emu", "network", "delay", "none"], "network delay back to none")
        else:
            out.lines.append("online")
    return done


async def _both(a: Awaitable[Any], b: Awaitable[Any]) -> None:
    await a
    await b


# ---------------------------------------------------------------- iOS

async def _ios_lacks_language(dev: Any, locale: str) -> Optional[str]:
    """Why the app cannot show `locale`'s language, when its bundle has no translation for it
    (it would fall back to its own language, and the case would be judged in the wrong one)."""
    app = getattr(dev, "app_id", "")
    code, path = await _run(["xcrun", "simctl", "get_app_container", dev.udid, app, "app"])
    if code != 0 or not path.strip():
        return None
    bundle = Path(path.strip().splitlines()[-1])
    have = sorted({p.stem for p in bundle.glob("*.lproj") if p.stem != "Base"})
    lang = locale.replace("_", "-").split("-")[0].lower()
    if not have or any(h.lower().split("-")[0].split("_")[0] == lang for h in have):
        return None
    return f"the app has no {locale} translation (it has {', '.join(have)}), so it would show its default language"


async def _ios(dev: Any, asked: dict[str, str], out: Applied) -> set[str]:
    done: set[str] = set()
    physical = bool(getattr(dev, "phone", None))
    have = (dev.phone.get("os") if physical else getattr(dev, "runtime", "")) or ""
    if "os" in asked:
        done.add("os")
        ok = os_matches(asked["os"], have)
        (out.lines if ok else out.unmet).append(
            f"{have} meets {asked['os']}" if ok else f"the case needs {asked['os']}, this device runs {have or 'an unknown iOS'}")
    if "locale" in asked and not physical:
        missing = await _ios_lacks_language(dev, asked["locale"])
        if missing:
            done.add("locale")
            out.unmet.append(missing)
    if "locale" in asked and "locale" not in done:
        done.add("locale")
        args = apple_locale(asked["locale"])
        holder = dev if physical else getattr(dev, "client", None)
        if holder is not None:
            prior = list(getattr(holder, "launch_args", None) or [])
            holder.launch_args = args

            async def undo_args(h: Any = holder, p: list[str] = prior) -> None:
                h.launch_args = p

            out.undo.append(undo_args)
            out.restore_words.append("the app's language back to the device's")
            out.lines.append(f"the app opens in {asked['locale']} (launch arguments)")
    if physical:
        return done
    udid = dev.udid
    if "text_size" in asked:
        done.add("text_size")
        _, before = await _run(["xcrun", "simctl", "ui", udid, "content_size"])
        code, said = await _run(["xcrun", "simctl", "ui", udid, "content_size", IOS_CONTENT_SIZE[asked["text_size"]]])
        if code == 0:
            out.lines.append(f"text size {asked['text_size']} ({IOS_CONTENT_SIZE[asked['text_size']]})")
            prior = before.strip() or "large"
            _undo_cmd(out, ["xcrun", "simctl", "ui", udid, "content_size", prior], f"text size back to {prior}")
        else:
            out.unmet.append(f"text size {asked['text_size']} could not be set ({said[:120]})")
    if "appearance" in asked:
        done.add("appearance")
        _, before = await _run(["xcrun", "simctl", "ui", udid, "appearance"])
        code, said = await _run(["xcrun", "simctl", "ui", udid, "appearance", asked["appearance"]])
        if code == 0:
            out.lines.append(f"{asked['appearance']} appearance")
            prior = before.strip() if before.strip() in ("light", "dark") else "light"
            _undo_cmd(out, ["xcrun", "simctl", "ui", udid, "appearance", prior], f"appearance back to {prior}")
        else:
            out.unmet.append(f"{asked['appearance']} appearance could not be set ({said[:120]})")
    return done


# ---------------------------------------------------------------- Web

async def _web(dev: Any, asked: dict[str, str], out: Applied) -> set[str]:
    page = getattr(dev, "page", None)
    context = getattr(dev, "context", None)
    if page is None or context is None:
        return set()
    cdp = await context.new_cdp_session(page)
    done: set[str] = set()

    async def send(method: str, params: dict[str, Any]) -> bool:
        try:
            await cdp.send(method, params)
            return True
        except Exception:  # noqa: BLE001 - said as not met
            return False

    if "locale" in asked:
        done.add("locale")
        ok = await send("Emulation.setLocaleOverride", {"locale": asked["locale"].replace("_", "-")})
        await context.set_extra_http_headers({"Accept-Language": asked["locale"].replace("_", "-")})
        (out.lines if ok else out.unmet).append(f"browser language {asked['locale']}" if ok else f"browser language {asked['locale']} could not be set")
        out.undo.append(lambda: _both(send("Emulation.setLocaleOverride", {}), context.set_extra_http_headers({})))
        out.restore_words.append("browser language back to its own")
    if "timezone" in asked:
        done.add("timezone")
        ok = await send("Emulation.setTimezoneOverride", {"timezoneId": asked["timezone"]})
        (out.lines if ok else out.unmet).append(f"time zone {asked['timezone']}" if ok else f"time zone {asked['timezone']} is not one the browser knows")
        out.undo.append(lambda: send("Emulation.setTimezoneOverride", {"timezoneId": ""}))
        out.restore_words.append("time zone back to the browser's own")
    if "appearance" in asked:
        done.add("appearance")
        await page.emulate_media(color_scheme=asked["appearance"])
        out.lines.append(f"{asked['appearance']} appearance (prefers-color-scheme)")
        out.undo.append(lambda: page.emulate_media(color_scheme="no-override"))
        out.restore_words.append("appearance back to the browser's own")
    if "text_size" in asked:
        done.add("text_size")
        px = WEB_FONT_PX[asked["text_size"]]
        ok = await send("Page.setFontSizes", {"fontSizes": {"standard": px, "fixed": max(10, px - 3)}})
        (out.lines if ok else out.unmet).append(f"text size {asked['text_size']} ({px}px default font)" if ok else "text size could not be set")
        out.undo.append(lambda: send("Page.setFontSizes", {"fontSizes": {"standard": 16, "fixed": 13}}))
        out.restore_words.append("text size back to 16px")
    if "network" in asked:
        done.add("network")
        net = asked["network"]
        if net == "offline":
            await context.set_offline(True)
            out.lines.append("offline")
            out.undo.append(lambda: context.set_offline(False))
            out.restore_words.append("back online")
        elif net == "slow":
            ok = await send("Network.emulateNetworkConditions", WEB_SLOW)
            (out.lines if ok else out.unmet).append("slow network (about 3G)" if ok else "slow network could not be set")
            out.undo.append(lambda: send("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1}))
            out.restore_words.append("network speed back to normal")
        else:
            out.lines.append("online")
    if done & {"locale", "timezone", "text_size"}:
        try:
            await page.reload(wait_until="load")
            out.lines.append("the page was reloaded so they take effect")
        except Exception:  # noqa: BLE001 - the next navigation picks them up
            pass
    return done


LEDGER_DIR = Path.home() / ".orcha" / "qa" / "conditions"


def device_key(dev: Any, platform: str) -> str:
    """The device a ledger belongs to: an Android serial, an iOS udid. Web has none (its browser
    goes with the session)."""
    if platform == "android":
        return str(getattr(dev, "serial", "") or "")
    if platform == "ios":
        return str(getattr(dev, "udid", "") or "")
    return ""


def _ledger_path(key: str) -> Optional[Path]:
    return LEDGER_DIR / (re.sub(r"[^A-Za-z0-9._-]", "_", key) + ".json") if key else None


def _save_ledger(key: str, ledger: list[dict[str, Any]]) -> None:
    path = _ledger_path(key)
    if path is None:
        return
    try:
        if ledger:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"device": key, "commands": ledger}))
        else:
            path.unlink(missing_ok=True)
    except OSError:
        pass


async def recover(dev: Any, platform: str) -> tuple[Optional[str], list[str]]:
    """Put back what an earlier run left on this device (it crashed, or was stopped before it
    could). Run before anything else touches the device. Returns a line when it did something,
    and each setting put back in words, for the run's log."""
    key = device_key(dev, platform)
    path = _ledger_path(key)
    if path is None or not path.is_file():
        return None, []
    try:
        entries = json.loads(path.read_text()).get("commands") or []
    except (OSError, ValueError):
        entries = []
    said: list[str] = []
    for entry in reversed(entries):
        cmd = entry.get("cmd") if isinstance(entry, dict) else entry
        if isinstance(cmd, list) and cmd and cmd[0] in ("adb", "xcrun"):
            await _run([str(c) for c in cmd])
            said.append(str(entry.get("said") or " ".join(map(str, cmd[-3:]))) if isinstance(entry, dict) else " ".join(map(str, cmd[-3:])))
    path.unlink(missing_ok=True)
    if not said:
        return None, []
    return f"conditions: put back {len(said)} setting{'s' if len(said) != 1 else ''} an earlier run left on this device", said


async def apply(dev: Any, platform: str, raw: Any) -> Applied:
    """Set `raw`'s conditions on the session's device and say what happened. Never raises: what
    could not be set is `unmet`, what Orcha does not set is the agent's."""
    asked = normalize(raw)
    out = Applied()
    if not asked:
        return out
    try:
        handled = await {"android": _android, "ios": _ios, "web": _web}[platform](dev, asked, out) if platform in ("android", "ios", "web") else set()
    except Exception as e:  # noqa: BLE001 - a device that cannot be read is said, not raised
        handled = set()
        out.unmet.append(f"the device could not be set up ({type(e).__name__}: {str(e)[:160]})")
    if platform == "web" and "os" in asked:
        handled.add("os")
        out.lines.append(f"an OS version ({asked['os']}) does not apply to a browser run")
    physical = bool(getattr(dev, "phone", None)) if platform == "ios" else (
        platform == "android" and not str(getattr(dev, "serial", "")).startswith("emulator-"))
    if physical:
        for key in sorted(PHYSICAL_UNAVAILABLE.get(platform, set()) & set(asked) - handled):
            handled.add(key)
            out.unmet.append(f"{key.replace('_', ' ')} cannot be set on a physical phone: pick a simulator or an emulator for it")
    out.agent = _agent_lines(asked, handled)
    out.device_key = device_key(dev, platform)
    _save_ledger(out.device_key, out.ledger)
    return out


async def restore(applied: Optional[Applied]) -> list[str]:
    """Put the device back as it was, newest first, and say what was put back. Never raises."""
    if applied is None or not applied.undo:
        return []
    said = list(reversed(applied.restore_words))
    for undo in reversed(applied.undo):
        try:
            await undo()
        except Exception:  # noqa: BLE001 - best effort: the next run's conditions set what they need
            pass
    applied.undo.clear()
    applied.ledger.clear()
    applied.restore_words.clear()
    _save_ledger(applied.device_key, [])
    return said
