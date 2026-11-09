"""Native runtime logs: what the app said, alongside what it showed. `LogEntry` is one row of
`qa_session_logs`. `normalize` trims and cleans one raw message; `Dedupe` collapses repeats. Each
platform's driver (`drain_ios_logs`, `drain_android_logs`) is best-effort: a raising or timing-out
subprocess yields no entries, so log capture can never break a session. The web gathers its own in
`web.py`, from the page.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MAX_TEXT_LEN = 2000
SOURCES = ("console", "network", "device", "crash")
LEVELS = ("error", "warn", "info", "debug")
LEVEL_RANK = {"debug": 0, "info": 1, "warn": 2, "error": 3}
DEFAULT_LOG_LEVEL = "warn"

ENV_LOG_LEVEL = "QA_LOG_LEVEL"  # error | warn | info | debug (default: warn)
ENV_LOGS_ENABLED = "QA_LOGS_ENABLED"  # "true" | "false" (default: true)


def log_level_env() -> str:
    """`QA_LOG_LEVEL` from the environment ,
    falling back to `DEFAULT_LOG_LEVEL` when unset or not a recognised level."""
    level = (os.environ.get(ENV_LOG_LEVEL) or DEFAULT_LOG_LEVEL).strip().lower()
    return level if level in LEVELS else DEFAULT_LOG_LEVEL


def logs_enabled_env() -> bool:
    """`QA_LOGS_ENABLED` from the environment; defaults to enabled (`true`) so capture is on
    unless an org has explicitly turned it off."""
    raw = (os.environ.get(ENV_LOGS_ENABLED) or "true").strip().lower()
    return raw not in ("0", "false", "no", "off")

# Noise that is never worth a row even at debug level: empty/whitespace-only messages and a
# handful of simulator/emulator lines that fire on every run regardless of the app under test.
_NOISE_PATTERNS = (
    re.compile(r"^\s*$"),
    re.compile(r"getpwuid_r did not find a match for uid"),
)

# Platform chatter: messages emitted by the OS's own frameworks rather than by the app.
#
# Measured on this machine: of 1,366 device-level errors, **1,045 came from `[com.apple.*]`
# subsystems** — CoreHaptics failing in a simulator that has no haptics, UIKit keyboard
# rendering, CoreSpotlight, Bluetooth. None of it is about the app under test, none of it is
# actionable, and all of it arrived at `error`, so the Logs tab showed "error (33)" where every
# single one was framework noise.
#
# The cost is not just clutter. Six `crash` rows from a genuine launch crash sat at the same
# severity in the same list as 1,364 framework errors — the most valuable signal in the system,
# buried. Reclassifying is the fix, not discarding: these lines still appear at `debug`, so
# nothing is lost for anyone deliberately digging, but they stop competing with the app's own
# output for attention.
_PLATFORM_CHATTER = (
    # Apple subsystem tags: "[com.apple.UIKit:HardwareKeyboard]", and also
    # "[com.apple.Settings.Host:Search Indexing]" — the category after the colon is
    # free text and routinely contains spaces, so match anything up to the closing bracket.
    re.compile(r"\[com\.apple\.[^\]]*\]"),
    # The same frameworks logging without a subsystem tag, e.g. "(CoreHaptics) CHHapticPattern…"
    re.compile(r"\((?:CoreHaptics|CoreAnimation|UIKitCore|Foundation|CFNetwork)\)"),
    # Android platform and Google-app tags. logcat is filtered to the app's pid, but the
    # frameworks *inside* that process log under their own tags, so pid filtering alone does
    # not help. Matched as a leading "Tag:" so a line the app itself logs is untouched.
    re.compile(
        r"^(?:WindowManager|ActivityManager|ActivityTaskManager|InputMethodManager"
        r"|BpTransactionCompletedListener|FeatureFlagsImplExport|DoodleDataLoader"
        r"|ZeroStateWebSuggestDataLoader|SurfaceFlinger|OpenGLRenderer|libEGL"
        r"|DatabaseUtils|BluetoothPowerStatsCollector|OneSearchSuggestProvider"
        r"|TraceManagerImpl|SingleInstanceRemoteListener|PlayCommon"
        r"|VoiceSearchConfigUtils|WifiApControl|IPCThreadState|LocalRepoService"
        r"|chromium|cr_\w+|Choreographer|ViewRootImpl|BufferQueueProducer)\s*:"
    ),
)


def is_platform_chatter(text: str) -> bool:
    """Whether this line came from an OS framework rather than from the app under test."""
    return any(p.search(text) for p in _PLATFORM_CHATTER)


@dataclass
class LogEntry:
    source: str  # 'console' | 'network' | 'device' | 'crash'
    level: str  # 'error' | 'warn' | 'info' | 'debug'
    text: str
    at_ms: int = 0
    step_seq: int | None = None
    detail: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "step_seq": self.step_seq,
            "at_ms": self.at_ms,
            "source": self.source,
            "level": self.level,
            "text": self.text,
            "detail": self.detail,
        }


def _is_noise(text: str) -> bool:
    return any(p.search(text) for p in _NOISE_PATTERNS)


def normalize(
    source: str, level: str, text: str, detail: dict[str, Any] | None = None
) -> LogEntry | None:
    """One cleaned `LogEntry`, or None when `text` is noise. Trims `text` to `MAX_TEXT_LEN`
    (a trailing `…` marks a cut) and normalizes `level`/`source` to a known value (unknown
    levels fall back to `info`; unknown sources are kept as given so a caller can't silently
    lose a mismatched source, but every driver in this module only ever passes a known one)."""
    cleaned = " ".join(text.split())
    if _is_noise(cleaned):
        return None
    if len(cleaned) > MAX_TEXT_LEN:
        cleaned = cleaned[: MAX_TEXT_LEN - 1].rstrip() + "…"
    lvl = level if level in LEVELS else "info"
    # Framework chatter is demoted, never dropped: a `crash` row and a CoreHaptics complaint
    # arriving at the same severity is what made the Logs tab unreadable. `crash` and `console`
    # are exempt — a crash report is about the app by definition, and a web console message is
    # the app's own output even when it names a browser internal.
    if lvl in ("error", "warn") and source not in ("crash", "console") and is_platform_chatter(cleaned):
        lvl = "debug"
    return LogEntry(source=source, level=lvl, text=cleaned, detail=detail)


@dataclass
class Dedupe:
    """Collapses repeats of the same `(source, level, text)` within one run into a single
    entry carrying `detail.count`. Order of first appearance is preserved."""

    _seen: dict[tuple[str, str, str], LogEntry] = field(default_factory=dict)
    _order: list[tuple[str, str, str]] = field(default_factory=list)

    def add(self, entry: LogEntry) -> None:
        key = (entry.source, entry.level, entry.text)
        existing = self._seen.get(key)
        if existing is None:
            self._seen[key] = entry
            self._order.append(key)
            return
        detail = dict(existing.detail or {})
        detail["count"] = int(detail.get("count", 1)) + 1
        existing.detail = detail
        # Keep the earliest step/at_ms (when it happened first) but let a later step_seq fill
        # in when the first occurrence landed between steps (None).
        if existing.step_seq is None and entry.step_seq is not None:
            existing.step_seq = entry.step_seq

    def entries(self) -> list[LogEntry]:
        return [self._seen[k] for k in self._order]


def dedupe_entries(entries: list[LogEntry]) -> list[LogEntry]:
    d = Dedupe()
    for e in entries:
        d.add(e)
    return d.entries()


def filter_by_level(entries: list[LogEntry], min_level: str) -> list[LogEntry]:
    """Keep entries whose level is at or above `min_level` in `LEVEL_RANK` order. An
    unrecognised `min_level` falls back to `DEFAULT_LOG_LEVEL`."""
    threshold = LEVEL_RANK.get(min_level, LEVEL_RANK[DEFAULT_LOG_LEVEL])
    return [e for e in entries if LEVEL_RANK.get(e.level, 1) >= threshold]


# ---------- iOS: `xcrun simctl spawn <udid> log show` ----------

# "2026-09-14 21:39:57.985 E  pairedsyncd[52562:80dc8c] [com.apple.pairedsync:daemon] message"
_IOS_LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+"
    r"(?P<ty>[A-Za-z]{1,2})\s+"
    r"(?P<proc>[^\[]+)\[(?P<pid>\d+):(?P<tid>[0-9a-f]+)\]\s+"
    r"(?P<msg>.*)$"
)
_IOS_TY_LEVEL = {"E": "error", "F": "error", "W": "warn", "Df": "debug", "D": "debug", "A": "info"}
# `log show` looks back at most this far on one drain: a long gap between drains (a slow
# model turn) is read in full up to this bound rather than silently cut at 60s.
IOS_MAX_WINDOW_S = 600


def _ios_ts(text: str) -> float | None:
    """Epoch seconds of a `log show` compact timestamp (host local time; a simulator shares
    the host clock)."""
    try:
        whole, _, frac = text.partition(".")
        base = time.mktime(time.strptime(" ".join(whole.split()), "%Y-%m-%d %H:%M:%S"))
        return base + (float(f"0.{frac}") if frac.isdigit() else 0.0)
    except (ValueError, OverflowError):
        return None


def parse_ios_log_show(
    text: str, *, bundle_id: str | None = None, since_ts: float | None = None, until_ts: float | None = None
) -> list[LogEntry]:
    """Parse `log show --style compact` output into `LogEntry` rows. `Ty` column: `E`/`F` ->
    error, `W` -> warn, `Df`/`D` -> debug, everything else (e.g. `A` activity) -> info. The
    header line and unparsable lines are skipped rather than raising. With `since_ts` /
    `until_ts`, only lines stamped in `[since_ts, until_ts)` are kept: `--start` has
    one-second resolution and `log show` runs a little after `until_ts`, so consecutive
    drains overlap and would otherwise report the same line twice."""
    out: list[LogEntry] = []
    for line in text.splitlines():
        m = _IOS_LINE_RE.match(line)
        if not m:
            continue
        if since_ts is not None or until_ts is not None:
            ts = _ios_ts(m.group("ts"))
            if ts is not None and (
                (since_ts is not None and ts < since_ts) or (until_ts is not None and ts >= until_ts)
            ):
                continue
        ty = m.group("ty")
        level = _IOS_TY_LEVEL.get(ty, "info")
        proc = m.group("proc").strip()
        msg = m.group("msg").strip()
        entry = normalize("device", level, f"{proc}: {msg}")
        if entry is not None:
            out.append(entry)
    return out


def ios_log_show_args(
    udid: str,
    predicate: str,
    *,
    window_s: int = 10,
    since_ts: float | None = None,
    min_level: str = DEFAULT_LOG_LEVEL,
    now: float | None = None,
) -> list[str]:
    """The `log show` command line. `since_ts` (the previous drain) reads from exactly there,
    bounded to `IOS_MAX_WINDOW_S`; without it, the last `window_s` seconds. `log show` omits
    info and debug messages unless asked, so `min_level` info adds `--info` and debug adds
    `--info --debug`."""
    args = ["xcrun", "simctl", "spawn", udid, "log", "show"]
    if since_ts is not None:
        start = max(since_ts, (now if now is not None else time.time()) - IOS_MAX_WINDOW_S)
        args += ["--start", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(start)))]
    else:
        args += ["--last", f"{window_s}s"]
    rank = LEVEL_RANK.get(min_level, LEVEL_RANK[DEFAULT_LOG_LEVEL])
    if rank <= LEVEL_RANK["info"]:
        args.append("--info")
    if rank <= LEVEL_RANK["debug"]:
        args.append("--debug")
    return args + ["--style", "compact", "--predicate", predicate]


async def drain_ios_logs(
    udid: str,
    bundle_id: str,
    *,
    window_s: int = 10,
    since_ts: float | None = None,
    until_ts: float | None = None,
    min_level: str = DEFAULT_LOG_LEVEL,
    timeout_s: float = 15.0,
) -> list[LogEntry]:
    """`xcrun simctl spawn <udid> log show` (`ios_log_show_args`: from `since_ts`, else the
    last `window_s` seconds; lines at or after `until_ts` are left for the next drain)
    filtered to `bundle_id`'s process, parsed and severity-filtered. Best-effort: any subprocess failure, timeout, or parse error yields an empty list rather
    than raising, so a wedged `log show` call can never break a run."""
    predicate = f'processImagePath CONTAINS "{bundle_id}" OR processImagePath CONTAINS "{bundle_id.rsplit(".", 1)[-1]}"'
    try:
        proc = await asyncio.create_subprocess_exec(
            *ios_log_show_args(udid, predicate, window_s=window_s, since_ts=since_ts, min_level=min_level),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except Exception as e:  # noqa: BLE001 - log capture must never break a run
        print(f"ios log capture failed: {type(e).__name__}: {e}", file=sys.stderr)
        return []
    try:
        text = stdout.decode(errors="replace")
        entries = parse_ios_log_show(text, bundle_id=bundle_id, since_ts=since_ts, until_ts=until_ts)
        return filter_by_level(entries, min_level)
    except Exception as e:  # noqa: BLE001
        print(f"ios log parse failed: {type(e).__name__}: {e}", file=sys.stderr)
        return []


_CRASH_APP_HINT = re.compile(r"^Process:\s*(\S+)")


def find_ios_crash_report(bundle_id: str, app_name: str, since_ts: float) -> LogEntry | None:
    """One `crash` entry from `~/Library/Logs/DiagnosticReports` naming `bundle_id`/`app_name`
    and modified at or after `since_ts`, or None when there is none. Best-effort: any
    filesystem error yields None."""
    try:
        reports_dir = Path.home() / "Library" / "Logs" / "DiagnosticReports"
        if not reports_dir.is_dir():
            return None
        candidates = sorted(
            (
                p
                for p in reports_dir.glob("*.ips")
                if p.stat().st_mtime >= since_ts - 2
                and (app_name.split(".")[0] in p.name or bundle_id.rsplit(".", 1)[-1] in p.name)
            ),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not candidates:
            return None
        text = candidates[0].read_text(errors="replace")
        lines = text.splitlines()
        first_frames = "\n".join(lines[:20])
        entry = normalize(
            "crash",
            "error",
            f"crash report: {candidates[0].name}",
            detail={"report": candidates[0].name, "frames": first_frames[:MAX_TEXT_LEN]},
        )
        return entry
    except Exception as e:  # noqa: BLE001
        print(f"ios crash report scan failed: {type(e).__name__}: {e}", file=sys.stderr)
        return None


# ---------- Android: `adb logcat` ----------

# "09-14 21:28:12.270   658   703 W IPCThreadState: message"
_ANDROID_LINE_RE = re.compile(
    r"^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+"
    r"(?P<pid>\d+)\s+(?P<tid>\d+)\s+"
    r"(?P<level>[VDIWEF])\s+"
    r"(?P<tag>[^:]*):\s?(?P<msg>.*)$"
)
_ANDROID_LEVEL = {"V": "debug", "D": "debug", "I": "info", "W": "warn", "E": "error", "F": "error"}


def parse_android_logcat(text: str, *, pid: str | None = None) -> list[LogEntry]:
    """Parse `adb logcat -v threadtime` output into `LogEntry` rows, collapsing a
    `FATAL EXCEPTION` block (the trigger line plus its `AndroidRuntime`-tagged continuation
    lines) into one `crash` entry with the stack in `detail`. `pid` restricts parsing to that
    process's lines when given (mirrors `--pid=<pid>` filtering happening upstream, but is
    applied here too since a caller may hand over an unfiltered dump)."""
    out: list[LogEntry] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        m = _ANDROID_LINE_RE.match(line)
        if not m:
            i += 1
            continue
        if pid is not None and m.group("pid") != str(pid):
            i += 1
            continue
        msg = m.group("msg").strip()
        tag = m.group("tag").strip()
        if "FATAL EXCEPTION" in msg:
            frames = [msg]
            j = i + 1
            while j < len(lines):
                jm = _ANDROID_LINE_RE.match(lines[j])
                if jm and jm.group("tag").strip() == tag and (pid is None or jm.group("pid") == str(pid)):
                    frames.append(jm.group("msg").strip())
                    j += 1
                else:
                    break
            stack = "\n".join(frames)
            entry = normalize(
                "crash", "error", f"{tag}: {frames[0]}", detail={"stack": stack[:MAX_TEXT_LEN]}
            )
            if entry is not None:
                out.append(entry)
            i = j
            continue
        level = _ANDROID_LEVEL.get(m.group("level"), "info")
        entry = normalize("device", level, f"{tag}: {msg}")
        if entry is not None:
            out.append(entry)
        i += 1
    return out


async def _communicate_or_kill(proc: asyncio.subprocess.Process, timeout_s: float) -> tuple[bytes, bytes]:
    """`proc.communicate()` bounded by `timeout_s`; on timeout the child is killed before the
    error propagates. `asyncio.wait_for` alone only abandons the await - the `adb` client keeps
    waiting for a device that never appears (hundreds of `adb -s <serial> logcat` processes were
    found lingering for days after test runs against a fake serial)."""
    try:
        return await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()
        raise


async def _adb_pid_for(serial: str, package: str, timeout_s: float) -> str | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            "adb", "-s", serial, "shell", "pidof", package,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await _communicate_or_kill(proc, timeout_s)
    except Exception:
        return None
    pid = stdout.decode(errors="replace").strip().split()[:1]
    return pid[0] if pid else None


async def logcat_clear(serial: str, timeout_s: float = 10.0) -> None:
    """`adb logcat -c` — call once at session start so each run begins with a clean buffer.
    Best-effort: a failure is swallowed (the run proceeds; entries may include pre-run noise)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "adb", "-s", serial, "logcat", "-c",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await _communicate_or_kill(proc, timeout_s)
    except Exception as e:  # noqa: BLE001
        print(f"android logcat -c failed: {type(e).__name__}: {e}", file=sys.stderr)


# logcat priority letter per min level: V(erbose) and D(ebug) both read as our `debug`.
_LOGCAT_PRIORITY = {"debug": "V", "info": "I", "warn": "W", "error": "E"}


def logcat_filter(min_level: str) -> str:
    """The logcat filterspec for `min_level`: `*:V` debug, `*:I` info, `*:W` (default), `*:E`."""
    return f"*:{_LOGCAT_PRIORITY.get(min_level, _LOGCAT_PRIORITY[DEFAULT_LOG_LEVEL])}"


async def drain_android_logs(
    serial: str,
    package: str,
    *,
    lines: int = 500,
    min_level: str = DEFAULT_LOG_LEVEL,
    timeout_s: float = 15.0,
    clear_after: bool = False,
) -> list[LogEntry]:
    """`adb -s <serial> logcat -d -v threadtime -t <lines> *:<L>` filtered to `package`'s pid
    when `pidof` resolves one, parsed and severity-filtered. `<L>` follows `min_level`
    (`logcat_filter`): `*:V` at debug, so an analytics line logged at debug/info is read.
    `clear_after=True` runs `logcat -c` once the dump succeeds, so a caller polling repeatedly (one `drain_logs` per
    step) sees each line once rather than re-reading the whole buffer every time. Best-effort:
    any subprocess failure, timeout, or parse error yields an empty list rather than raising."""
    try:
        pid = await _adb_pid_for(serial, package, timeout_s=min(timeout_s, 5.0))
        proc = await asyncio.create_subprocess_exec(
            "adb", "-s", serial, "logcat", "-d", "-v", "threadtime", "-t", str(lines), logcat_filter(min_level),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _stderr = await _communicate_or_kill(proc, timeout_s)
    except Exception as e:  # noqa: BLE001 - log capture must never break a run
        print(f"android log capture failed: {type(e).__name__}: {e}", file=sys.stderr)
        return []
    if clear_after:
        await logcat_clear(serial, timeout_s=min(timeout_s, 5.0))
    try:
        text = stdout.decode(errors="replace")
        entries = parse_android_logcat(text, pid=pid)
        return filter_by_level(entries, min_level)
    except Exception as e:  # noqa: BLE001
        print(f"android log parse failed: {type(e).__name__}: {e}", file=sys.stderr)
        return []


def stamp_at_ms(entries: list[LogEntry], started_at: float | None, now: float | None = None) -> list[LogEntry]:
    """Give every entry that has no time yet (`at_ms` 0) its offset from session start (#171).

    A driver that knows when a line happened (a web page event, a stub hit) sets `at_ms`
    itself; the rest (a device log read after a step) are stamped with the drain time, which
    lands within the step they came from. Without this every row of `logs.jsonl` said
    `"at_ms": 0` and the Logs tab showed 0:00 on all of them. An entry already stamped keeps
    its time; a missing `started_at` leaves the batch as it is."""
    if started_at is None:
        return entries
    at_ms = max(0, round(((time.time() if now is None else now) - started_at) * 1000))
    for e in entries:
        if not e.at_ms or e.at_ms < 0:
            e.at_ms = at_ms
    return entries
